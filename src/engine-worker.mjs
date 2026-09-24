import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { JSDOM } from "jsdom";
import cssEscape from "css.escape";
import createHoshidicts from "../.upstream/hachidori/extension/vendor/hoshidicts.mjs";
import {
  configureEngineService,
  startEngine,
  handleEngineMessage,
} from "../.upstream/hachidori/extension/engine-service.js";
import {
  createApiHost,
  API_REQUESTS,
} from "../.upstream/hachidori/extension/api-host.js";
import { buildAnkiResourceFields } from "../.upstream/hachidori/extension/anki-resources.js";
import { createState } from "./state.mjs";
import { createUpdates } from "./updates.mjs";
import { ANKI_WORKER_TYPES, createAnkiHost } from "./anki.mjs";
import { diskFilesystem } from "./disk.mjs";
import {
  ZipReader,
  Uint8ArrayReader,
  TextWriter,
} from "../.upstream/hachidori/extension/vendor/zip.js";
import {
  dictionaryArchiveIdentity,
  dictionaryImportMatches,
  dictionaryImportTarget,
} from "../.upstream/hachidori/extension/dictionary-import.js";

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ event, ...fields }));
let updates = null;
let anki = null;
const store = createState(workerData.directory, (changes) => {
  parentPort.postMessage({ kind: "storage", changes });
  if (changes.dictionaryState || changes.dictionaryUpdates)
    updates?.reconcile();
  if (changes.options) anki?.reconcileIndex();
});
await store.validate();
configureEngineService(store.bridge, {
  createHoshidicts: async () => {
    const module = await createHoshidicts({
      print: (text) => process.stderr.write(`${text}\n`),
    });
    module.IDBFS = diskFilesystem(
      module.FS,
      path.join(workerData.directory, "dicts"),
    );
    return module;
  },
  storageBackend: "idbfs",
  lowRam: true,
  reportProgress: (event) => updates?.progress(event),
});
startEngine();
// The first queued lookup waits for boot and reconciliation to finish.
await handleEngineMessage({ type: "hd_reload" });
const initial = await handleEngineMessage({ type: "hd_status" });
if (!initial.ok || !initial.ready)
  throw new Error(initial.error ?? "Dictionary engine failed to start");
updates = createUpdates({
  store,
  engine: handleEngineMessage,
  log,
  report: (progress) => parentPort.postMessage({ kind: "updates", progress }),
});

async function engine(message) {
  const reply = await handleEngineMessage(message);
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}
const dom = new JSDOM("");
dom.window.CSS ??= {};
dom.window.CSS.escape = cssEscape;
const api = createApiHost({
  engine,
  readDictionaries: async () => store.snapshot().dictionaryState.dictionaries,
  readAudioSources: async () => [],
  version: "0.1.5",
  render: async (message) => {
    if (message.type !== "hd_anki_fields")
      throw new Error("Pronunciation audio is not configured on this host.");
    return buildAnkiResourceFields(message.request, message.templates, {
      document: dom.window.document,
      dictionaryPaths: message.dictionaryPaths,
      audio: "",
      styles: async () => (await engine({ type: "hd_styles" })).styles,
    });
  },
});
anki = createAnkiHost({
  store,
  engine: handleEngineMessage,
  document: dom.window.document,
  log,
});
anki.reconcileIndex();
const engineReads = new Set([
  "hd_lookup",
  "hd_lookup_dictionary",
  "hd_kanji",
  "hd_media",
  "hd_styles",
  "hd_status",
  "hd_reload",
]);
const engineWrites = new Set([
  "hd_custom_append",
  "hd_custom_save",
  "hd_remove",
]);

// Reads only the manifest of a Hachidori backup archive. Dictionary files in the
// archive are ignored; this host imports dictionaries from their own ZIPs.
async function readBackupManifest(bytes) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    checkAmbiguity: true,
  });
  try {
    const entry = (await reader.getEntries()).find(
      (candidate) => candidate.filename === "hachidori-backup.json",
    );
    if (!entry || entry.directory || entry.uncompressedSize > 64 * 1024 * 1024)
      throw new Error("The selected archive is not a Hachidori backup.");
    const manifest = JSON.parse(
      await entry.getData(new TextWriter(), { checkSignature: true }),
    );
    if (
      manifest?.format !== "hachidori-backup" ||
      ![1, 2].includes(manifest.version)
    )
      throw new Error("The selected archive is not a supported Hachidori backup.");
    // Older backups include the retired external corpus integration.
    delete manifest.snapshot?.options?.corpusSeenEnabled;
    delete manifest.snapshot?.options?.corpusSeenUrl;
    return manifest;
  } finally {
    await reader.close();
  }
}

async function dispatch(message) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    typeof message.type !== "string"
  )
    throw new Error("Expected a runtime message object with a type.");
  if (message.type === "host_snapshot")
    return { ok: true, snapshot: store.snapshot() };
  if (
    message.target === "hachidori-setup" &&
    message.type === "hd_setup_install"
  ) {
    if (
      !Array.isArray(message.sourceIds) ||
      !message.sourceIds.every((sourceId) => typeof sourceId === "string")
    ) {
      throw new Error("The setup install request must include a source list.");
    }
    if (message.sourceIds.length > 0) {
      throw new Error(
        "Installing recommended dictionaries from a linked browser is not supported. Upload ZIPs through this host's import page, or place them in imports/ before startup.",
      );
    }
    // Settings sends an empty list to observe the recommended installer on open.
    // This host has no recommended-install run; regular ZIP imports are separate.
    return {
      ok: true,
      error: null,
      runId: null,
      sequence: 0,
      finished: true,
      entries: [],
    };
  }
  if (message.type === "host_settings_import") {
    const manifest = await readBackupManifest(message.bytes);
    return {
      ok: true,
      options: await store.importOptions(manifest.snapshot?.options),
    };
  }
  if (
    message.target === "hachidori-anki" ||
    (message.target === "hoshidicts-worker" && ANKI_WORKER_TYPES.has(message.type))
  )
    return { ok: true, ...(await anki.handle(message)) };
  if (message.target === "hachidori-updates") {
    if (message.type === "hd_updates_schedule") return updates.schedule(message);
    if (message.type === "hd_updates_check")
      return { ok: true, ...(await updates.check(message)) };
    if (message.type === "hd_updates_install")
      return { ok: true, ...(await updates.install(message)) };
  }
  if (message.type === "host_import") {
    if (updates.busy())
      throw new Error(
        "Dictionary updates are running. Try again when they finish.",
      );
    let importDecision;
    {
      const reader = new ZipReader(new Uint8ArrayReader(message.bytes), {
        useWebWorkers: false,
        checkAmbiguity: true,
      });
      try {
        const entries = await reader.getEntries();
        const indexes = entries.filter(
          (entry) => entry.filename === "index.json",
        );
        if (
          indexes.length !== 1 ||
          indexes[0].directory ||
          indexes[0].uncompressedSize > 1024 * 1024
        )
          throw new Error(
            "Expected one index.json, no larger than 1 MiB, at the ZIP root.",
          );
        const identity = dictionaryArchiveIdentity(
          JSON.parse(
            await indexes[0].getData(new TextWriter(), {
              checkSignature: true,
            }),
          ),
        );
        const matches = dictionaryImportMatches(
          identity,
          store.snapshot().dictionaryState.dictionaries,
        );
        if (matches.length && message.skipExisting)
          return {
            ok: true,
            skipped: true,
            report: { success: true, title: identity.title },
            reason: `Already installed: ${matches[0].dictionary.title}. Use a replacement upload to change it.`,
          };
        if (matches.length > 1)
          throw new Error(
            "Multiple installed dictionaries match this update source. Replacement is ambiguous.",
          );
        importDecision = matches.length
          ? {
              action: "replace",
              identity,
              target: dictionaryImportTarget(matches[0].dictionary),
              matchKind: matches[0].kind,
            }
          : { action: "install", identity, target: null, matchKind: null };
      } finally {
        await reader.close();
      }
    }
    const url = URL.createObjectURL(new Blob([message.bytes]));
    try {
      return await handleEngineMessage({
        type: "hd_import",
        blobUrl: url,
        fileName: message.fileName,
        importDecision,
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (message.target === "hoshidicts-offscreen") {
    if (API_REQUESTS.has(message.type))
      return { ok: true, ...(await api(message)) };
    if (engineReads.has(message.type) || engineWrites.has(message.type)) {
      const result = await handleEngineMessage(message);
      if (message.type === "hd_status") result.storageBackend = "node-disk";
      return result;
    }
    if (message.type === "hd_apply_state") {
      const result = await store.presentation(message);
      if (result.ok) await engine({ type: "hd_reload" });
      return result;
    }
  }
  if (message.target === "hoshidicts-worker") {
    if (message.type === "hd_state_read" || message.type === "hd_custom_read")
      return store.bridge(message);
    if (message.type === "hd_options_write") return store.options(message);
    if (message.type === "hd_state_cas") {
      const result = await store.presentation(message);
      if (result.ok) await engine({ type: "hd_reload" });
      return result;
    }
    if (
      ["hd_lookup_stats_read", "hd_lookup_stats_record"].includes(message.type)
    )
      return store.statistics(message);
  }
  throw new Error(
    `Unsupported operation: ${message.target}/${message.type}. This server hosts dictionaries; host-owned mining and automatic updates are unavailable.`,
  );
}

async function respond(id, message) {
  try {
    const response = await dispatch(message);
    parentPort.postMessage({
      kind: "reply",
      id,
      response: {
        type: `${message.type}_result`,
        requestId: message.requestId ?? null,
        ...response,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      kind: "reply",
      id,
      response: {
        type: `${message?.type ?? "unknown"}_result`,
        requestId: message?.requestId ?? null,
        ok: false,
        error: error.message,
      },
    });
  }
}
// Update cycles download archives over the network, so they run beside the
// queue instead of in it; the engine serialises the import transaction itself
// and lookups keep being answered during the download.
// Anki requests wait on AnkiConnect and own their own mutation queue, so they
// run beside the queue too.
const UNQUEUED = new Set(["hd_updates_check", "hd_updates_install"]);
function queued(message) {
  if (message?.target === "hachidori-anki") return false;
  if (message?.target === "hachidori-updates") return !UNQUEUED.has(message.type);
  return !(message?.target === "hoshidicts-worker" && ANKI_WORKER_TYPES.has(message.type));
}
let tail = Promise.resolve();
parentPort.on("message", ({ id, message }) => {
  if (!queued(message)) {
    void respond(id, message);
    return;
  }
  tail = tail.then(() => respond(id, message));
});
parentPort.postMessage({ kind: "ready", snapshot: store.snapshot() });
updates.reconcile();
