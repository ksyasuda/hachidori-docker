import {
  MANAGED_DICTIONARY_CHANGED,
  httpsUrl,
  managedDictionaryFingerprint,
  managedDictionaryMatches,
  managedUpdateSchedule,
  nextDictionaryUpdateCheck,
  nextManagedUpdateCheck,
  recommendedDictionarySource,
  recommendedIndexUrlMatches,
} from "../.upstream/hachidori/extension/managed-dictionary-source.js";

const INDEX_TIMEOUT_MS = 30_000;
// Timers are re-armed when they fire, so a monthly schedule never needs a
// single timer longer than this.
const MAX_TIMER_MS = 6 * 60 * 60 * 1000;

// Port of the extension's managed dictionary update cycle. Index checks run
// here; the engine downloads and commits archives through its own import
// transaction, exactly as it does for the browser. One cycle runs at a time.
export function createUpdates({ store, engine, log, report = () => {} }) {
  let tail = Promise.resolve();
  let active = false;
  let timer = null;
  let requestCounter = 0;
  // What the running cycle is doing right now, for the management page.
  let current = null;

  function publish(next) {
    current = next;
    report(
      current === null
        ? null
        : {
            id: current.id,
            title: current.title,
            phase: current.phase,
            receivedBytes: current.receivedBytes,
            totalBytes: current.totalBytes,
          },
    );
  }

  function candidates(dictionaryIds) {
    const selected = dictionaryIds === null ? null : new Set(dictionaryIds);
    return store.updatePlan().dictionaries.flatMap((dictionary) => {
      if (selected !== null && !selected.has(dictionary?.id)) return [];
      const fingerprint = managedDictionaryFingerprint(dictionary);
      return fingerprint === null
        ? []
        : [
            {
              id: dictionary.id,
              title: dictionary.displayName || dictionary.title,
              fingerprint,
            },
          ];
    });
  }

  async function remote(candidate) {
    const { source } = candidate.fingerprint;
    const response = await fetch(source.indexUrl, {
      credentials: "omit",
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`update index request failed with HTTP ${response.status}`);
    if (
      source.kind === "recommended" &&
      !recommendedIndexUrlMatches(
        recommendedDictionarySource(source.sourceId),
        response.url,
      )
    )
      throw new Error("update index downloaded from an unexpected final URL");
    if (source.kind === "generic" && httpsUrl(response.url) === null)
      throw new Error("update index redirected to a non-HTTPS URL");
    const index = await response.json();
    if (typeof index?.revision !== "string" || index.revision === "")
      throw new Error("update index did not declare a revision");
    let archiveUrl = source.downloadUrl;
    if (
      source.kind === "generic" &&
      typeof index.downloadUrl === "string" &&
      index.downloadUrl !== ""
    ) {
      archiveUrl = httpsUrl(index.downloadUrl);
      if (archiveUrl === null)
        throw new Error("update index returned a non-HTTPS download URL");
    }
    return { revision: index.revision, archiveUrl };
  }

  async function record(candidate, lastUpdateCheck, outcome) {
    const recorded = await store.recordUpdateCheck(
      candidate.fingerprint,
      lastUpdateCheck,
    );
    return recorded === null
      ? { id: candidate.id, status: "check-failed", error: MANAGED_DICTIONARY_CHANGED }
      : outcome;
  }

  async function check(candidate, checkedAt) {
    let update;
    try {
      update = await remote(candidate);
    } catch (error) {
      const message = error.message;
      return {
        update: null,
        available: null,
        outcome: await record(
          candidate,
          { checkedAt, status: "check-failed", remoteRevision: null, error: message },
          { id: candidate.id, status: "check-failed", error: message },
        ),
      };
    }
    if (update.revision === candidate.fingerprint.revision) {
      return {
        update: null,
        available: null,
        outcome: await record(
          candidate,
          { checkedAt, status: "up-to-date", remoteRevision: update.revision, error: null },
          { id: candidate.id, status: "up-to-date" },
        ),
      };
    }
    const available = {
      checkedAt,
      status: "update-available",
      remoteRevision: update.revision,
      error: null,
    };
    const outcome = await record(candidate, available, {
      id: candidate.id,
      status: "update-available",
    });
    return {
      update: outcome.status === "update-available" ? update : null,
      available,
      outcome,
    };
  }

  async function install(candidate, checked, checkedAt) {
    if (checked.update === null) return checked.outcome;
    const { fingerprint } = candidate;
    const requestId = `managed-update-${++requestCounter}`;
    publish({ ...current, requestId, phase: "downloading" });
    try {
      const reply = await engine({
        type: "hd_import",
        requestId,
        managedFingerprint: fingerprint,
        sourceId:
          fingerprint.source.kind === "recommended"
            ? fingerprint.source.sourceId
            : null,
        archiveUrl: checked.update.archiveUrl,
        expectedRevision: checked.update.revision,
        checkedAt,
        fileName: candidate.title,
      });
      if (!reply?.ok || !reply.report?.success)
        throw new Error(
          reply?.error || reply?.report?.error || "the dictionary update failed",
        );
      return { id: candidate.id, status: "updated" };
    } catch (error) {
      let message = error.message;
      const failed = await store.recordUpdateCheck(fingerprint, {
        ...checked.available,
        error: message,
      });
      if (failed === null) message = MANAGED_DICTIONARY_CHANGED;
      return {
        id: candidate.id,
        status: failed === null ? "check-failed" : "update-available",
        error: message,
      };
    }
  }

  // A later package can be switched off while an earlier fetch is in flight.
  function due(candidate) {
    const { dictionaries, settings } = store.updatePlan();
    const current = dictionaries.find((entry) => entry.id === candidate.id);
    if (!current || !managedDictionaryMatches(current, candidate.fingerprint))
      return false;
    const now = Date.now();
    const when = nextDictionaryUpdateCheck(current, settings.schedule, now);
    return when !== null && when <= now;
  }

  async function cycle({ dictionaryIds = null, install: installing = false, dueOnly = false }) {
    const outcomes = [];
    for (const candidate of candidates(dictionaryIds)) {
      if (dueOnly && !due(candidate)) continue;
      publish({
        requestId: null,
        id: candidate.id,
        title: candidate.title,
        phase: "checking",
        receivedBytes: 0,
        totalBytes: null,
      });
      const checkedAt = new Date().toISOString();
      const checked = await check(candidate, checkedAt);
      outcomes.push(
        installing ? await install(candidate, checked, checkedAt) : checked.outcome,
      );
    }
    log("dictionary_updates", { scheduled: dueOnly, outcomes });
    if (dueOnly && outcomes.length === 0)
      return { outcomes, settings: store.updatePlan().settings };
    const { settings } = await store.writeUpdateSettings((current) => ({
      ...current,
      lastCheckedAt: new Date().toISOString(),
    }));
    return { outcomes, settings };
  }

  function queue(options) {
    const run = tail.then(async () => {
      active = true;
      try {
        return await cycle(options);
      } finally {
        active = false;
        publish(null);
        reconcile();
      }
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // One timer targets the earliest due package. Callers re-run this after any
  // dictionary or schedule change; a running cycle re-arms it when it ends.
  function reconcile() {
    if (active) return;
    clearTimeout(timer);
    timer = null;
    const { dictionaries, settings } = store.updatePlan();
    const now = Date.now();
    const when = nextManagedUpdateCheck(dictionaries, settings.schedule, now);
    if (when === null) return;
    timer = setTimeout(() => {
      queue({ install: true, dueOnly: true }).catch((error) =>
        log("dictionary_updates_failed", { error: error.message }),
      );
    }, Math.min(when - now, MAX_TIMER_MS));
    timer.unref();
  }

  return {
    busy: () => active,
    reconcile,
    // Engine download and install progress for the archive being updated.
    progress(event) {
      if (current === null || event.requestId !== current.requestId) return;
      publish({
        ...current,
        phase: event.phase,
        receivedBytes: event.receivedBytes ?? current.receivedBytes,
        totalBytes: event.totalBytes ?? null,
      });
    },
    async schedule(message) {
      const schedule = managedUpdateSchedule(message?.schedule);
      if (schedule === null)
        throw new Error("the dictionary update schedule is invalid");
      const result = await store.writeUpdateSettings((current) =>
        message.baseRevision === current.revision ? { ...current, schedule } : null,
      );
      if (result.ok !== false) reconcile();
      return result;
    },
    // The browser checks every managed dictionary; the page may narrow the set.
    check(message) {
      return queue({
        dictionaryIds: Array.isArray(message?.dictionaryIds)
          ? message.dictionaryIds
          : null,
        install: false,
      });
    },
    install(message) {
      if (!Array.isArray(message?.dictionaryIds))
        throw new TypeError("the dictionary update request carried no dictionary IDs");
      return queue({ dictionaryIds: message.dictionaryIds, install: true });
    },
  };
}
