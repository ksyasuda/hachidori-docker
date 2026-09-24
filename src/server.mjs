import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import WebSocket from "ws";
import { createSharingHost } from "../.upstream/hachidori/extension/sharing-host.js";
import {
  API_CAPABILITY,
  LINKED_ANKI_CAPABILITY,
  SHARING_CAPABILITIES,
} from "../.upstream/hachidori/extension/sharing-protocol.js";
import { createImports, MAX_IMPORT_BYTES } from "./imports.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.env.DATA_DIR ?? path.join(root, "data"));
const port = portFromEnv("ADMIN_PORT", 8780);
const relayPort = portFromEnv("RELAY_PORT", 8771);
const apiPort = portFromEnv("API_PORT", 19633);
const bind = process.env.LISTEN_ADDRESS ?? "127.0.0.1";
fs.mkdirSync(directory, { recursive: true });

function portFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`Invalid ${name}`);
  return value;
}
function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}
const pending = new Map();
let nextId = 0;
let snapshot = null;
let stopping = false;
let updateProgress = null;
const importDirectory =
  process.env.IMPORT_DIR === ""
    ? null
    : path.resolve(process.env.IMPORT_DIR ?? path.join(root, "imports"));
const imports = createImports({
  directory: importDirectory,
  ready: () => snapshot !== null && !stopping,
  dispatch: request,
});
const allowedHosts = new Set([
  "localhost",
  ...(process.env.ADMIN_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
]);
// Host networking gives the container this machine's hostname.
const machineName = os.hostname().toLowerCase().split(".")[0];
// Guards against DNS rebinding, which needs an attacker-controlled name in
// Host. IP literals, this machine's name and its Tailscale MagicDNS name
// (<machine>.<tailnet>.ts.net) are always accepted; other names such as a
// reverse proxy domain must be listed in ADMIN_HOSTS.
function isAllowedHost(hostname) {
  const labels = hostname.split(".");
  return (
    allowedHosts.has(hostname) ||
    net.isIP(hostname.replace(/^\[(.*)\]$/, "$1")) !== 0 ||
    (labels[0] === machineName &&
      (labels.length === 1 ||
        (labels.length === 4 && hostname.endsWith(".ts.net"))))
  );
}
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);
const worker = new Worker(new URL("./engine-worker.mjs", import.meta.url), {
  workerData: { directory },
});
const relay = spawn(
  process.env.PYTHON ?? "python3",
  [
    path.join(root, ".upstream/hachidori-anki/addon/server.py"),
    "--port",
    String(relayPort),
    "--api-port",
    String(apiPort),
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);

class RelaySocket extends WebSocket {
  constructor(address) {
    super(address, {
      origin: "chrome-extension://hachidori-node-host",
      maxPayload: 2 * 1024 * 1024,
    });
    // ws emits errors separately from close; the sharing host retries on close.
    this.on("error", (error) =>
      log("relay_connection_error", { error: error.message }),
    );
  }
}
// What linked browsers mirror: the extension's shared keys plus lookup-count
// rows. Anki index state and the like stay on the host.
const SHARED_KEYS = new Set([
  "dictionaryState",
  "options",
  "customDictionarySource",
  "dictionaryUpdates",
  "lookupStats",
]);
const sharedKey = (key) => SHARED_KEYS.has(key) || key.startsWith("lookupStats:");
const LINKED_SETTINGS_UPDATE_REQUIRED =
  "Update the linked Hachidori before editing Templates or Custom Buttons.";
const alarms = new Map();
const host = createSharingHost({
  WebSocket: RelaySocket,
  alarms: {
    clear(name) {
      clearTimeout(alarms.get(name));
      alarms.delete(name);
    },
    create(name, { delayInMinutes }) {
      clearTimeout(alarms.get(name));
      alarms.set(
        name,
        setTimeout(() => host.reconnect(), delayInMinutes * 60_000),
      );
    },
  },
  dispatch: async (message, clientId, capabilities = []) => {
    if (typeof message?.type !== "string" || !message.type.startsWith("hd_"))
      return { ok: false, error: "Unsupported shared request." };
    // Template and custom-button writes need a reader that speaks linked Anki v2.
    if (
      message.type === "hd_options_write" &&
      !capabilities.includes(LINKED_ANKI_CAPABILITY) &&
      message.options &&
      typeof message.options === "object" &&
      (Object.hasOwn(message.options, "anki") ||
        Object.hasOwn(message.options, "customButtons"))
    )
      return { ok: false, error: LINKED_SETTINGS_UPDATE_REQUIRED };
    try {
      return await request(message);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  },
  readSnapshot: async () =>
    Object.fromEntries(
      [...SHARED_KEYS].map((key) => [key, snapshot?.[key] ?? null]),
    ),
  sharedKey,
  version: "0.1.5",
  name: "Hachidori Docker host",
  capabilities: [API_CAPABILITY, ...SHARING_CAPABILITIES],
});
function request(message) {
  if (stopping || snapshot === null)
    return Promise.reject(new Error("Dictionary engine is not ready."));
  if (pending.size >= 32)
    return Promise.reject(new Error("Dictionary request queue is full."));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, message });
  });
}
worker.on("message", (event) => {
  if (event.kind === "ready") {
    snapshot = event.snapshot;
    host.enable({
      port: relayPort,
      network: process.env.RELAY_NETWORK === "true",
      dictionaries: snapshot.dictionaryState.dictionaries.length,
    });
    log("engine_ready", {
      dictionaries: snapshot.dictionaryState.dictionaries.length,
    });
    imports.start();
  } else if (event.kind === "storage") {
    if (snapshot === null) return;
    Object.assign(snapshot, event.changes);
    host.setDictionaries(snapshot.dictionaryState.dictionaries.length);
    host.storageChanged(
      Object.fromEntries(
        Object.entries(event.changes).map(([key, newValue]) => [
          key,
          { newValue },
        ]),
      ),
      "local",
    );
  } else if (event.kind === "updates") {
    updateProgress = event.progress;
  } else if (event.kind === "reply") {
    pending.get(event.id)?.resolve(event.response);
    pending.delete(event.id);
  }
});
worker.on("error", (error) => {
  log("engine_error", { error: error.stack });
  void shutdown(1);
});
worker.on("exit", (code) => {
  if (!stopping) {
    log("engine_exited", { code });
    void shutdown(1);
  }
});
relay.on("error", (error) => {
  log("relay_error", { error: error.message });
  void shutdown(1);
});
relay.on("exit", (code) => {
  if (!stopping) {
    log("relay_exited", { code });
    void shutdown(1);
  }
});

async function body(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, "http://localhost");
    const origin = `http://${incoming.headers.host}`;
    if (
      !isAllowedHost(new URL(origin).hostname) ||
      (incoming.headers.origin && incoming.headers.origin !== origin) ||
      incoming.headers["sec-fetch-site"] === "cross-site"
    )
      return json(outgoing, 403, {
        error: "Management requests must come from this host.",
      });
    outgoing.setHeader("X-Content-Type-Options", "nosniff");
    outgoing.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    outgoing.setHeader("Referrer-Policy", "no-referrer");
    if (incoming.method === "GET" && assets.has(url.pathname)) {
      const [name, type] = assets.get(url.pathname);
      outgoing.writeHead(200, {
        "Content-Type": `${type}; charset=utf-8`,
        "Cache-Control": "no-cache",
      });
      return outgoing.end(fs.readFileSync(path.join(root, "public", name)));
    }
    if (incoming.method === "GET" && url.pathname === "/health") {
      const sharing = host.status();
      const ready =
        snapshot !== null &&
        !stopping &&
        (snapshot.dictionaryState.dictionaries.length === 0 ||
          sharing.connected);
      return json(outgoing, ready ? 200 : 503, {
        ready,
        engine: "node-wasm",
        storage: "node-disk",
        dictionaryCount: snapshot?.dictionaryState.dictionaries.length ?? 0,
        sharing,
        capabilities: [
          "dictionary-sharing",
          API_CAPABILITY,
          ...SHARING_CAPABILITIES,
        ],
        mining: true,
      });
    }
    if (incoming.method === "GET" && url.pathname === "/imports")
      return json(outgoing, 200, {
        ...imports.status(),
        updates: updateProgress,
      });
    if (incoming.method === "POST" && url.pathname === "/imports/scan") {
      void imports.scan();
      return json(outgoing, 202, { ok: true });
    }
    if (incoming.method === "GET" && url.pathname === "/state")
      return json(
        outgoing,
        snapshot ? 200 : 503,
        snapshot ?? { error: "Starting" },
      );
    if (incoming.method === "POST" && url.pathname === "/rpc") {
      const message = JSON.parse(
        (await body(incoming, 1024 * 1024)).toString("utf8"),
      );
      if (typeof message?.type !== "string" || !message.type.startsWith("hd_"))
        throw new Error("Expected an hd_ runtime message.");
      return json(outgoing, 200, await request(message));
    }
    if (incoming.method === "POST" && url.pathname === "/settings/import") {
      const result = await request({
        type: "host_settings_import",
        bytes: await body(incoming, MAX_IMPORT_BYTES),
      });
      return json(outgoing, result.ok ? 200 : 422, result);
    }
    if (incoming.method === "POST" && url.pathname === "/import") {
      if (imports.busy())
        return json(outgoing, 409, {
          error: "Another import is in progress. Try again when it finishes.",
        });
      const fileName = url.searchParams.get("name") ?? "dictionary.zip";
      if (path.basename(fileName) !== fileName || !/\.zip$/i.test(fileName))
        throw new Error("Expected a .zip dictionary filename.");
      const result = await imports.run(
        fileName,
        "upload",
        () => body(incoming, MAX_IMPORT_BYTES),
        url.searchParams.get("replace") === "true",
      );
      return json(
        outgoing,
        result.ok && result.report?.success ? 200 : 422,
        result,
      );
    }
    return json(outgoing, 404, { error: "Unknown endpoint" });
  } catch (error) {
    if (!outgoing.headersSent) json(outgoing, 400, { error: error.message });
  }
});
server.requestTimeout = 15 * 60_000;
server.on("error", (error) => {
  log("http_error", { error: error.message });
  void shutdown(1);
});
server.listen(port, bind, () =>
  log("listening", { address: bind, port, relayPort, apiPort }),
);

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log("stopping", { code });
  imports.close();
  server.close();
  host.disable();
  for (const timer of alarms.values()) clearTimeout(timer);
  for (const entry of pending.values())
    entry.reject(new Error("Host is stopping."));
  pending.clear();
  relay.kill("SIGTERM");
  await worker.terminate();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
