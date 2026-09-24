import { randomUUID } from "node:crypto";
import { resolveObjectURL } from "node:buffer";
import { createAnkiGateway } from "../.upstream/hachidori/extension/anki.js";
import { createAnkiOffscreenService } from "../.upstream/hachidori/extension/anki-offscreen.js";
import { createAudioRepository } from "../.upstream/hachidori/extension/audio-repository.js";
import { createAnkiWorkerService } from "../.upstream/hachidori/extension/anki-worker.js";
import { createAnkiDuplicateIndex } from "../.upstream/hachidori/extension/anki-index-cache.js";
import {
  fetchAnkiIndex,
  lookupAnkiIndex,
} from "../.upstream/hachidori/extension/anki-index.js";
import { buildAnkiResourceFields } from "../.upstream/hachidori/extension/anki-resources.js";
import { capabilityAnkiOptions } from "../.upstream/hachidori/extension/setup-state.js";
import {
  detectAnkiSetup,
  verifyAnkiSetup,
} from "../.upstream/hachidori/extension/anki-setup.js";
import {
  allowLinkedAnkiDiscoveryRequest,
  allowLinkedAnkiRequest,
  allowLinkedAnkiSetupRequest,
} from "../.upstream/hachidori/extension/sharing-protocol.js";
import "../.upstream/hachidori/extension/reader-options.js";

export const ANKI_WORKER_TYPES = new Set(["hd_anki_discover", "hd_anki_setup"]);
const MAX_TIMER_MS = 6 * 60 * 60 * 1000;

// The upstream audio export reads blobs with a FileReader and proves a
// candidate decodes by loading it into an Audio element. Node has neither, so
// this stands in: base64 through Buffer, and a load that rejects responses
// which are plainly not audio, such as an HTML error page.
class FileReaderShim {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => {
        this.error = error;
        this.onerror?.();
      },
    );
  }
  abort() {}
}
class AudioShim {
  src = "";
  load() {
    if (!this.src) return;
    const blob = resolveObjectURL(this.src);
    const type = blob?.type.split(";")[0].toLowerCase() ?? "";
    const rejected =
      !blob || blob.size === 0 || type.startsWith("text/") || type === "application/json";
    queueMicrotask(() => (rejected ? this.onerror?.() : this.onloadeddata?.()));
  }
  pause() {}
  removeAttribute() {
    this.src = "";
  }
}
const windowShim = { AbortSignal, URL, atob, FileReader: FileReaderShim, Audio: AudioShim };

// Host-owned Anki mining for linked browsers: the same worker service, gateway
// and duplicate index the extension runs, wired to this host's store and
// engine. The reading browser keeps screenshots and captured media and sends
// their bytes with the submission; this host talks to AnkiConnect.
export function createAnkiHost({ store, engine, document, log }) {
  const gateway = createAnkiGateway();
  // Linked readers see an opaque configuration key per host process, exactly
  // as the extension masks its own.
  const prefix = `linked:${randomUUID()}:`;
  const options = () => globalThis.HDReaderOptions.normaliseOptions(store.snapshot().options);
  // Screenshots, browser speech and captured clips are produced by the reading
  // browser and arrive with the submission; this host stores them in Anki.
  const readOptions = async () =>
    capabilityAnkiOptions(options(), {
      screenshot: true,
      browserSpeech: true,
      mediaCapture: true,
    });
  const repository = createAudioRepository({ window: windowShim, fetch: globalThis.fetch });
  // Pronunciation from URL sources is fetched here. A text-to-speech source is
  // answered with a recording plan that the linked browser fulfils.
  const audioService = createAnkiOffscreenService(windowShim, async () => repository, async () => {
    throw new Error("Browser text-to-speech is recorded by the linked browser, not by this host.");
  });
  const invokeFor = (source) => (action, params, timeoutMs) =>
    gateway.invoke(action, params, source.apiKey, timeoutMs, source.url);

  const timers = new Map();
  const alarms = {
    async get(name) {
      return timers.get(name)?.alarm;
    },
    async clear(name) {
      clearTimeout(timers.get(name)?.timer);
      timers.delete(name);
    },
    async create(name, { when }) {
      await alarms.clear(name);
      const timer = setTimeout(
        () => {
          timers.delete(name);
          void index.reconcile();
        },
        Math.max(0, Math.min(when - Date.now(), MAX_TIMER_MS)),
      );
      timer.unref();
      timers.set(name, { alarm: { name, scheduledTime: when }, timer });
    },
  };
  const index = createAnkiDuplicateIndex({
    fetchRows: (source) => fetchAnkiIndex(invokeFor(source), source),
    lookupLive: (source, expression, invoke) => lookupAnkiIndex(invoke, source, expression),
    readOptions,
    readState: async () => store.snapshot().ankiDuplicateIndex,
    updateState: (update) => store.updateAnkiIndex(update),
    alarms,
    reportError: (error) => log("anki_index_error", { error: error.message }),
  });

  async function offscreen(message) {
    if (message.type === "hd_anki_audio") return audioService(message);
    if (message.type !== "hd_anki_fields")
      throw new Error(`Unsupported Anki rendering request: ${message.type}`);
    return buildAnkiResourceFields(message.request, message.templates, {
      document,
      dictionaryPaths: message.dictionaryPaths,
      audio: message.audio,
      styles: async () => {
        const reply = await engine({ type: "hd_styles" });
        if (!reply.ok || (reply.generation !== undefined && reply.generation !== message.request.generation))
          throw new Error(reply.error || "Dictionary styles changed during Anki preparation.");
        return reply.styles;
      },
    });
  }

  const service = createAnkiWorkerService({
    gateway,
    readOptions,
    readDictionaries: async () => store.snapshot().dictionaryState.dictionaries,
    engine,
    offscreen,
    capture: null,
    duplicateIndex: index,
  });

  function unmask(request) {
    if (typeof request?.configKey !== "string" || !request.configKey.startsWith(prefix))
      throw new Error("Anki configuration changed. Refresh this result before adding a note.");
    return { ...request, configKey: request.configKey.slice(prefix.length) };
  }

  async function checkSetup(anki) {
    const invoke = (action, params) => gateway.invoke(action, params, anki.apiKey, undefined, anki.url);
    try {
      const proposal = anki.model === ""
        ? await detectAnkiSetup(invoke, anki)
        : await verifyAnkiSetup(invoke, anki);
      return {
        proposal,
        outcome: { status: proposal.status, detail: proposal.detail, model: proposal.model, deck: proposal.deck },
      };
    } catch (error) {
      const detail = error.message;
      const unavailable = /Open Anki with the AnkiConnect add-on|timed out/iu.test(detail);
      return {
        proposal: null,
        outcome: { status: unavailable ? "unavailable" : "needs-attention", detail, model: null, deck: null },
      };
    }
  }

  return {
    // Options changed: the index may need a new source or a fresh pull.
    reconcileIndex: () => void index.resume(),
    async handle(message) {
      if (message.target === "hoshidicts-worker") {
        if (message.type === "hd_anki_discover") {
          const allowed = allowLinkedAnkiDiscoveryRequest(message);
          return gateway.discover({ ...(await readOptions()).anki, model: allowed.model });
        }
        if (message.type === "hd_anki_setup") {
          const allowed = allowLinkedAnkiSetupRequest(message);
          const config = globalThis.HDReaderOptions.ankiTemplateConfig(
            (await readOptions()).anki,
            allowed.templateId,
          );
          if (config === null) throw new Error("The selected Anki Template is no longer available.");
          return checkSetup(config);
        }
        throw new Error(`Unsupported Anki request: ${message.type}`);
      }
      // A linked browser is untrusted at this boundary: keep only the fields
      // each operation needs, as the extension does.
      const allowed = allowLinkedAnkiRequest(message);
      switch (allowed.type) {
        case "hd_anki_status": {
          const status = await service.status(allowed.templateId);
          return { ...status, configKey: prefix + status.configKey };
        }
        case "hd_anki_view": {
          const result = await service.view(allowed.request);
          return { ...result, configKey: prefix + result.configKey };
        }
        case "hd_anki_preflight":
          return service.preflightClient(unmask(allowed.request));
        case "hd_anki_submit":
          return service.submitClient(unmask(allowed.request), allowed.clientMedia);
        case "hd_anki_browse":
          return service.browse(unmask(allowed.request));
        default:
          return service.maturity(allowed.request);
      }
    },
  };
}
