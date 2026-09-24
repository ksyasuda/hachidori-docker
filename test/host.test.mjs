import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  mkdir,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import {
  buildFixtureZip,
  buildTitledZip,
  TITLE,
  MEDIA_PATH,
} from "../.upstream/hachidori/test/make-fixture.mjs";
import { createSharingClient } from "../.upstream/hachidori/extension/sharing-client.js";
import { createRecommendedInstallClient } from "../.upstream/hachidori/extension/recommended-install-client.js";
import {
  createBackupArchive,
  openBackupArchive,
} from "../.upstream/hachidori/extension/backup-archive.js";
import { assertBackupSnapshot } from "../.upstream/hachidori/extension/backup-state.js";
import { answerAnkiConnect } from "../.upstream/hachidori/test/anki-connect-fake.mjs";
import { ankiMediaFilename } from "../.upstream/hachidori/extension/anki-resources.js";
import "../.upstream/hachidori/extension/reader-options.js";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(run, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const value = await run();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(message);
}

test(
  "real dictionary engine, relay, client protocol and durable restarts",
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hachidori-host-test-"),
    );
    const importDirectory = path.join(directory, "imports");
    await mkdir(importDirectory);
    const admin = await freePort(),
      relay = await freePort(),
      api = await freePort();
    const base = `http://127.0.0.1:${admin}`;
    const apiBase = `http://127.0.0.1:${api}`;
    let processHandle;
    let logs = "";
    async function start() {
      processHandle = spawn(process.execPath, ["src/server.mjs"], {
        detached: true,
        env: {
          ...process.env,
          DATA_DIR: directory,
          IMPORT_DIR: importDirectory,
          ADMIN_PORT: String(admin),
          RELAY_PORT: String(relay),
          API_PORT: String(api),
          RELAY_NETWORK: "false",
          // The update test serves its index and archive over local HTTPS.
          NODE_EXTRA_CA_CERTS: path.resolve("test/fixtures/localhost.pem"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      processHandle.stdout.on("data", (bytes) => {
        logs += bytes;
      });
      processHandle.stderr.on("data", (bytes) => {
        logs += bytes;
      });
      await until(
        async () => (await fetch(`${base}/health`)).ok,
        `Host failed to start: ${logs}`,
      );
      await until(async () => {
        const { folder } = await (await fetch(`${base}/imports`)).json();
        return folder.lastScan && !folder.scanning;
      }, "Startup scan did not finish");
    }
    async function stop(signal = "SIGTERM") {
      if (!processHandle || processHandle.exitCode !== null) return;
      const exited = once(processHandle, "exit");
      process.kill(-processHandle.pid, signal);
      await exited;
    }
    t.after(async () => {
      await stop();
    });
    const rpc = async (message) =>
      (
        await fetch(`${base}/rpc`, {
          method: "POST",
          body: JSON.stringify(message),
        })
      ).json();
    const lookup = () =>
      rpc({
        target: "hoshidicts-offscreen",
        type: "hd_lookup",
        text: "食べたかった",
      });
    await start();
    await t.test("imports a real Yomitan archive", async () => {
      const response = await fetch(`${base}/import?name=fixture.zip`, {
        method: "POST",
        body: buildFixtureZip(),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.report.success, true);
      assert.equal(result.report.title, TITLE);
      const found = await lookup();
      assert.equal(found.ok, true, JSON.stringify(found));
      assert.equal(found.results[0].term.expression, "食べる");
    });
    await t.test("imports reader settings from a Hachidori backup", async () => {
      const archive = await createBackupArchive(
        {
          state: { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] },
          options: {
            revision: 9,
            popupWidthPx: 800,
            anki: globalThis.HDReaderOptions.normaliseOptions({
              anki: { url: "http://anki.example" },
            }).anki,
          },
          document: null,
          updates: null,
          lookupStats: { generation: null, revision: 0 },
        },
        [],
        [],
      );
      const imported = await fetch(`${base}/settings/import`, {
        method: "POST",
        body: Buffer.from(await archive.arrayBuffer()),
      });
      const result = await imported.json();
      assert.equal(imported.status, 200, JSON.stringify(result));
      const { options } = await (await fetch(`${base}/state`)).json();
      assert.equal(options.popupWidthPx, 800);
      assert.equal(options.revision, 1);
      assert.equal(options.anki.url, "http://anki.example");
      const rejected = await fetch(`${base}/settings/import`, {
        method: "POST",
        body: buildFixtureZip(),
      });
      assert.equal(rejected.status, 422);
      assert.match((await rejected.json()).error, /not a Hachidori backup/);
    });
    await t.test(
      "Yomitan API returns terms, kanji, tokenization and fields",
      async () => {
        await until(
          async () => (await fetch(`${apiBase}/dictionaries`)).ok,
          "Relay did not connect",
        );
        const post = async (route, body) => {
          const response = await fetch(`${apiBase}/${route}`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          const value = await response.json();
          assert.equal(response.status, 200, JSON.stringify(value));
          return value;
        };
        const terms = await post("termEntries", { term: "食べたかった" });
        assert.ok(JSON.stringify(terms).includes("食べる"));
        assert.ok(
          JSON.stringify(
            await post("kanjiEntries", { character: "食" }),
          ).includes("食"),
        );
        assert.ok(
          JSON.stringify(
            await post("tokenize", {
              text: "食べたかった",
              scanLength: 16,
              parser: "scan",
            }),
          ).includes("た"),
        );
        const fields = await post("ankiFields", {
          text: "食べたかった",
          type: "term",
          markers: ["expression", "glossary"],
          maxEntries: 1,
          includeMedia: true,
        });
        assert.ok(JSON.stringify(fields).includes("食べる"));
      },
    );
    await t.test(
      "actual upstream sharing client receives results and storage changes",
      async () => {
        class Socket extends WebSocket {
          constructor(url) {
            super(url, { origin: "hoshi://hoshidicts" });
            this.on("error", () => {});
          }
        }
        const mirrored = {};
        const client = createSharingClient({
          WebSocket: Socket,
          version: "0.1.5",
          name: "SubMiner test",
          capabilities: [],
          applyBatch: async (changes) => Object.assign(mirrored, changes),
        });
        try {
          client.link(`ws://127.0.0.1:${relay}/link`);
          await until(() => client.status().connected, "Client did not link");
          assert.equal(
            client.status().host.capabilities.includes("linked-anki-v2"),
            true,
          );
          const reply = await client.forward({
            target: "hoshidicts-offscreen",
            type: "hd_lookup",
            text: "食べたかった",
          });
          assert.equal(reply.results[0].term.expression, "食べる");
          const errors = [];
          const installation = createRecommendedInstallClient({
            send: (sourceIds) =>
              client.forward({
                target: "hachidori-setup",
                type: "hd_setup_install",
                sourceIds,
              }),
            onChange() {},
            onError(error) {
              errors.push(error.message);
            },
          });
          try {
            // Settings observes with an empty source list whenever it opens.
            await installation.request();
            assert.deepEqual(
              errors,
              [],
              "Linked Settings must not show an installation-observer error",
            );
            assert.equal(installation.failed, false);
            assert.deepEqual(installation.run, {
              runId: null,
              sequence: 0,
              finished: true,
              entries: [],
            });
            const before = await (await fetch(`${base}/state`)).json();
            const rejected = await client.forward({
              target: "hachidori-setup",
              type: "hd_setup_install",
              sourceIds: ["jitendex"],
            });
            assert.equal(rejected.ok, false);
            assert.match(rejected.error, /host's import page/);
            for (const sourceIds of [undefined, null, "jitendex", [1]]) {
              const invalid = await client.forward({
                target: "hachidori-setup",
                type: "hd_setup_install",
                sourceIds,
              });
              assert.equal(invalid.ok, false);
            }
            await installation.request();
            assert.deepEqual(errors, []);
            assert.deepEqual(
              await (await fetch(`${base}/state`)).json(),
              before,
            );
          } finally {
            installation.stop();
          }
          const options = await client.forward({
            target: "hoshidicts-worker",
            type: "hd_options_write",
            baseRevision: mirrored.options.revision,
            options: { popupWidthPx: 640 },
          });
          assert.equal(options.ok, true, JSON.stringify(options));
          await until(
            () => mirrored.options.popupWidthPx === 640,
            "Settings were not broadcast",
          );
          const stale = await client.forward({
            target: "hoshidicts-worker",
            type: "hd_options_write",
            baseRevision: 0,
            options: { popupWidthPx: 700 },
          });
          assert.equal(stale.conflict, true);
          const media = await client.forward({
            target: "hoshidicts-offscreen",
            type: "hd_media",
            dictionary: TITLE,
            path: MEDIA_PATH,
            generation: reply.generation,
          });
          assert.equal(media.ok, true, JSON.stringify(media));
          assert.match(media.dataUrl, /^data:image\/png;base64,/);
        } finally {
          client.unlink();
        }
      },
    );
    await t.test(
      "mines to Anki from a linked browser through the host",
      async () => {
        // A fake AnkiConnect answering the way the add-on does.
        const notes = new Map();
        const mediaFiles = new Set();
        const MP3 = Buffer.from("ID3fake pronunciation bytes");
        const anki = http.createServer(async (incoming, outgoing) => {
          if (incoming.method === "GET") {
            // Doubles as a custom pronunciation provider.
            outgoing.setHeader("Content-Type", "audio/mpeg");
            return outgoing.end(MP3);
          }
          const chunks = [];
          for await (const chunk of incoming) chunks.push(chunk);
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const reply = await answerAnkiConnect(request, (action, params) => {
            switch (action) {
              case "deckNames": return ["Default"];
              case "modelNames": return ["Basic"];
              case "modelNamesAndIds": return { Basic: 1 };
              case "modelFieldNames": return ["Front", "Back"];
              case "canAddNotesWithErrorDetail":
                return params.notes.map(() => ({ canAdd: true, error: null }));
              case "findNotes": return [...notes.keys()];
              case "notesInfo":
                return params.notes.filter((id) => notes.has(id)).map((id) => ({
                  noteId: id,
                  modelName: "Basic",
                  fields: Object.fromEntries(
                    Object.entries(notes.get(id)).map(([field, value]) => [field, { value }]),
                  ),
                }));
              case "addNote": {
                const noteId = 42 + notes.size;
                notes.set(noteId, { ...params.note.fields });
                return noteId;
              }
              case "getMediaFilesNames":
                return mediaFiles.has(params.pattern) ? [params.pattern] : [];
              case "storeMediaFile": mediaFiles.add(params.filename); return params.filename;
              case "cardsInfo": return [];
              case "guiBrowse": return [];
              case "updateNoteFields": {
                notes.set(params.note.id, { ...notes.get(params.note.id), ...params.note.fields });
                return null;
              }
              default: throw new Error(`Unexpected AnkiConnect action ${action}`);
            }
          });
          outgoing.setHeader("Content-Type", "application/json");
          outgoing.end(JSON.stringify(reply));
        });
        anki.listen(0, "127.0.0.1");
        await once(anki, "listening");
        class Socket extends WebSocket {
          constructor(url) {
            super(url, { origin: "hoshi://hoshidicts" });
            this.on("error", () => {});
          }
        }
        const client = createSharingClient({
          WebSocket: Socket,
          version: "0.1.5",
          name: "Linked browser test",
          capabilities: ["linked-anki-v2"],
          applyBatch: async () => {},
        });
        const ankiUrl = `http://127.0.0.1:${anki.address().port}`;
        let written;
        // Writes a Template and other options as a linked Settings page would,
        // then returns the masked configuration key readers must echo.
        async function configure(back, extra = {}) {
          const { options } = await (await fetch(`${base}/state`)).json();
          const canonical = globalThis.HDReaderOptions.normaliseOptions({
            ...extra,
            anki: {
              url: ankiUrl,
              model: "Basic",
              deck: "Default",
              fieldTemplates: {
                Front: { value: "{expression}", overwriteMode: "overwrite" },
                Back: { value: back, overwriteMode: "overwrite" },
              },
            },
          });
          written = await rpc({
            target: "hoshidicts-worker",
            type: "hd_options_write",
            baseRevision: options.revision,
            options: {
              anki: canonical.anki,
              ...Object.fromEntries(Object.keys(extra).map((key) => [key, canonical[key]])),
            },
          });
          assert.equal(written.ok, true, JSON.stringify(written));
          const status = await client.forward({
            target: "hachidori-anki",
            type: "hd_anki_status",
          });
          assert.equal(status.ok, true, JSON.stringify(status));
          assert.equal(status.available, true, status.error);
          assert.match(status.configKey, /^linked:/);
          return status.configKey;
        }
        const submit = async (request, clientMedia = {}) => {
          const preflight = await client.forward({
            target: "hachidori-anki",
            type: "hd_anki_preflight",
            request,
          });
          assert.equal(preflight.ok, true, JSON.stringify(preflight));
          assert.equal(preflight.state, "addable", JSON.stringify(preflight));
          const submitted = await client.forward({
            target: "hachidori-anki",
            type: "hd_anki_submit",
            request,
            clientMedia,
          });
          assert.equal(submitted.ok, true, JSON.stringify(submitted));
          assert.equal(submitted.state, "added", JSON.stringify(submitted));
          return { preflight, submitted };
        };
        try {
          client.link(`ws://127.0.0.1:${relay}/link`);
          await until(() => client.status().connected, "Client did not link");
          const configKey = await configure("{glossary}");
          const discovered = await client.forward({
            target: "hoshidicts-worker",
            type: "hd_anki_discover",
            model: "Basic",
          });
          assert.equal(discovered.connected, true, JSON.stringify(discovered));
          assert.deepEqual(discovered.fields, ["Front", "Back"]);
          const found = await client.forward({
            target: "hoshidicts-offscreen",
            type: "hd_lookup",
            text: "食べたかった",
          });
          const result = found.results[0];
          const request = {
            term: result.term,
            trace: result.trace,
            generation: found.generation,
            sentence: "食べたかった",
            matched: result.matched,
            matchOffset: 0,
            popupSelectionText: "",
            searchQuery: "食べたかった",
            documentTitle: "Test page",
            dictionaryAliases: {},
            dictionaryIds: {},
            frequencyDictionaries: [],
            configKey,
          };
          const { submitted } = await submit(request);
          const saved = notes.get(submitted.noteId);
          assert.equal(saved.Front, "食べる");
          assert.ok(saved.Back.length > 0, "glossary rendered");

          // Pronunciation from a URL source is fetched by the host and stored.
          const withAudio = {
            ...request,
            term: { ...request.term, expression: "食べる音" },
            configKey: await configure("{audio}", {
              audioSources: [{ id: "local", type: "custom", enabled: true, url: `${ankiUrl}/audio/{term}.mp3`, voice: "" }],
            }),
          };
          const audioNote = notes.get((await submit(withAudio)).submitted.noteId);
          const mp3Name = await ankiMediaFilename(MP3, "mp3");
          assert.equal(audioNote.Back, `[sound:${mp3Name}]`);
          assert.ok(mediaFiles.has(mp3Name), "pronunciation uploaded");

          // Browser speech: the host plans it, the reader records it and sends the WAV.
          const speechKey = await configure("{audio}", {
            audioSources: [{ id: "tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" }],
          });
          const speechRequest = { ...request, term: { ...request.term, expression: "食べる声" }, configKey: speechKey };
          const planned = await client.forward({
            target: "hachidori-anki",
            type: "hd_anki_preflight",
            request: speechRequest,
          });
          assert.equal(planned.ok, true, JSON.stringify(planned));
          assert.equal(planned.clientSpeech?.sourceId, "tts", JSON.stringify(planned));
          const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(44, 1)]);
          const wavName = await ankiMediaFilename(wav, "wav");
          const spoken = await submit(
            { ...speechRequest, clientSpeech: planned.clientSpeech },
            { speech: { ...planned.clientSpeech, filename: wavName, byteLength: wav.length, data: wav.toString("base64") } },
          );
          assert.equal(notes.get(spoken.submitted.noteId).Back, `[sound:${wavName}]`);
          assert.ok(mediaFiles.has(wavName), "speech uploaded");

          // Captured sentence audio encoded by the reader is uploaded by the host.
          const captureKey = await configure("{capture-audio}", {
            audioSources: [],
            mediaCapture: { enabled: true },
            experimental: { mediaMining: true, longKeyScan: false, mdxImport: false },
          });
          const clip = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60, 2)]);
          const captured = await submit(
            {
              ...request,
              term: { ...request.term, expression: "食べる録" },
              configKey: captureKey,
              captureJobId: "job-1",
              capturePin: {
                token: "pin-1", captureSessionId: "session-1", sourceKind: "cue", sourceLabel: "Subtitle",
                partial: false, readyAtMs: 1000, animationFilename: "hachidori-abc123.avif", audioFilename: "hachidori-abc123.wav",
              },
            },
            { capture: { jobId: "job-1", warnings: [], assets: {
              audio: { filename: "hachidori-abc123.wav", byteLength: clip.length, data: clip.toString("base64") },
            } } },
          );
          assert.match(notes.get(captured.submitted.noteId).Back, /hachidori-abc123\.wav/);
          assert.ok(mediaFiles.has("hachidori-abc123.wav"), "captured audio uploaded");
          const maturity = await client.forward({
            target: "hachidori-anki",
            type: "hd_anki_maturity",
            request: { term: { expression: "食べる", reading: "たべる" } },
          });
          assert.equal(maturity.mature, false);
          // A reader without linked Anki v2 cannot rewrite Templates.
          const legacy = createSharingClient({
            WebSocket: Socket,
            version: "0.1.5",
            name: "Legacy reader",
            capabilities: [],
            applyBatch: async () => {},
          });
          try {
            legacy.link(`ws://127.0.0.1:${relay}/link`);
            await until(() => legacy.status().connected, "Legacy client did not link");
            const refused = await legacy.forward({
              target: "hoshidicts-worker",
              type: "hd_options_write",
              baseRevision: written.options.revision,
              options: { anki: written.options.anki },
            });
            assert.equal(refused.ok, false);
            assert.match(refused.error, /Update the linked Hachidori/);
          } finally {
            legacy.unlink();
          }
        } finally {
          client.unlink();
          anki.close();
        }
      },
    );
    await t.test(
      "rejects unsupported mining, invalid imports and website management",
      async () => {
        assert.equal(
          (await rpc({ target: "hachidori-anki", type: "hd_anki_submit" })).ok,
          false,
        );
        assert.equal(
          (
            await fetch(`${base}/rpc`, {
              method: "POST",
              headers: { Origin: "https://example.com" },
              body: "{}",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await fetch(`${base}/import?name=invalid.zip`, {
              method: "POST",
              body: "bad zip",
            })
          ).status,
          422,
        );
        assert.equal((await lookup()).results[0].term.expression, "食べる");
      },
    );
    await t.test(
      "serves the import page and accepts only the local browser origin",
      async () => {
        const page = await fetch(base);
        assert.match(await page.text(), /Choose ZIP files/);
        assert.match(
          page.headers.get("content-security-policy"),
          /frame-ancestors 'none'/,
        );
        assert.equal((await fetch(`${base}/app.js`)).status, 200);
        assert.equal(
          (
            await fetch(`${base}/imports/scan`, {
              method: "POST",
              headers: { Origin: base },
            })
          ).status,
          202,
        );
        assert.equal(
          (
            await fetch(`${base}/imports/scan`, {
              method: "POST",
              headers: { Origin: "null" },
            })
          ).status,
          403,
        );
        const hostStatus = (host) =>
          new Promise((resolve, reject) => {
            http
              .get(`${base}/state`, { headers: { Host: host } }, (response) => {
                response.resume();
                resolve(response.statusCode);
              })
              .on("error", reject);
          });
        assert.equal(await hostStatus("attacker.example"), 403);
        assert.equal(await hostStatus(`192.0.2.1:${admin}`), 200);
        assert.equal(await hostStatus(`[fd7a:115c:a1e0::1]:${admin}`), 200);
        const machine = os.hostname().toLowerCase().split(".")[0];
        assert.equal(await hostStatus(`${machine}:${admin}`), 200);
        assert.equal(await hostStatus(`${machine}.tail1234.ts.net:${admin}`), 200);
        assert.equal(await hostStatus(`${machine}.attacker.example:${admin}`), 403);
        assert.equal(
          (
            await fetch(`${base}/rpc`, {
              method: "POST",
              headers: { "Sec-Fetch-Site": "cross-site" },
              body: "{}",
            })
          ).status,
          403,
        );
        const duplicate = await fetch(`${base}/import?name=renamed.zip`, {
          method: "POST",
          headers: { Origin: base },
          body: buildFixtureZip(),
        });
        assert.equal((await duplicate.json()).skipped, true);
      },
    );
    const scanFolder = async () => {
      await fetch(`${base}/imports/scan`, { method: "POST" });
      await until(
        async () =>
          !(await (await fetch(`${base}/imports`)).json()).folder.scanning,
        "Manual scan did not finish",
      );
    };
    await t.test(
      "leaves later ZIPs for a manual scan, skips installed identities and supports deliberate replacement",
      async () => {
        const title = "Folder dictionary";
        const archive = buildTitledZip(title, { revision: "1" });
        await writeFile(
          path.join(importDirectory, "dictionary.partial"),
          archive,
        );
        await symlink(
          path.join(importDirectory, "dictionary.partial"),
          path.join(importDirectory, "symlink.zip"),
        );
        await scanFolder();
        const ignored = await (await fetch(`${base}/imports`)).json();
        assert.equal(ignored.folder.files.length, 0);
        await rename(
          path.join(importDirectory, "dictionary.partial"),
          path.join(importDirectory, "dictionary.zip"),
        );
        const lastScan = ignored.folder.lastScan;
        await sleep(2200);
        const idle = await (await fetch(`${base}/imports`)).json();
        assert.equal(idle.folder.automatic, "startup");
        assert.equal(idle.folder.lastScan, lastScan);
        assert.equal(idle.folder.files.length, 0);
        assert.equal(
          (
            await (await fetch(`${base}/state`)).json()
          ).dictionaryState.dictionaries.some((d) => d.title === title),
          false,
        );
        await fetch(`${base}/imports/scan`, { method: "POST" });
        assert.equal(
          (
            await (await fetch(`${base}/state`)).json()
          ).dictionaryState.dictionaries.some((d) => d.title === title),
          false,
        );
        const state = await until(async () => {
          const value = await (await fetch(`${base}/state`)).json();
          return (
            value.dictionaryState.dictionaries.some((d) => d.title === title) &&
            value
          );
        }, "Folder dictionary was not imported");
        const installed = state.dictionaryState.dictionaries.find(
          (d) => d.title === title,
        );
        const replacement = buildTitledZip(title, { revision: "2" });
        await writeFile(path.join(importDirectory, "renamed.zip"), replacement);
        await scanFolder();
        await until(
          async () =>
            (await (await fetch(`${base}/imports`)).json()).folder.files.some(
              (f) => f.fileName === "renamed.zip" && f.status === "skipped",
            ),
          "Duplicate folder dictionary was not skipped",
        );
        const unchanged = (
          await (await fetch(`${base}/state`)).json()
        ).dictionaryState.dictionaries.find((d) => d.title === title);
        assert.equal(unchanged.path, installed.path);
        assert.equal(unchanged.revision, "1");
        const result = await fetch(
          `${base}/import?name=replacement.zip&replace=true`,
          { method: "POST", headers: { Origin: base }, body: replacement },
        );
        assert.equal(result.status, 200, await result.text());
        assert.equal(
          (
            await (await fetch(`${base}/state`)).json()
          ).dictionaryState.dictionaries.find((d) => d.title === title)
            .revision,
          "2",
        );
        await writeFile(path.join(importDirectory, "broken.zip"), "bad ZIP");
        await scanFolder();
        await until(
          async () =>
            (await (await fetch(`${base}/imports`)).json()).folder.files.some(
              (f) => f.fileName === "broken.zip" && f.status === "failed",
            ),
          "Bad ZIP was not reported",
        );
        await writeFile(
          path.join(importDirectory, "broken.zip"),
          buildTitledZip("Repaired archive"),
        );
        await scanFolder();
        await until(
          async () =>
            (
              await (await fetch(`${base}/state`)).json()
            ).dictionaryState.dictionaries.some(
              (d) => d.title === "Repaired archive",
            ),
          "Changed failed archive was not retried",
        );
      },
    );
    await t.test(
      "checks, installs and schedules managed dictionary updates",
      async () => {
        const title = "Managed dictionary";
        let revision = "1";
        const source = https.createServer(
          {
            key: await readFile("test/fixtures/localhost-key.pem"),
            cert: await readFile("test/fixtures/localhost.pem"),
          },
          (request, response) => {
            if (request.url === "/index.json") {
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ revision }));
            } else if (request.url === "/dictionary.zip") {
              response.end(buildTitledZip(title, archiveOptions()));
            } else {
              response.statusCode = 404;
              response.end();
            }
          },
        );
        source.listen(0, "127.0.0.1");
        await once(source, "listening");
        const origin = `https://127.0.0.1:${source.address().port}`;
        const archiveOptions = () => ({
          revision,
          indexUrl: `${origin}/index.json`,
          downloadUrl: `${origin}/dictionary.zip`,
          indexOverrides: { isUpdatable: true },
        });
        const find = async () =>
          (
            await (await fetch(`${base}/state`)).json()
          ).dictionaryState.dictionaries.find((d) => d.title === title);
        const updates = (type, fields = {}) =>
          rpc({ target: "hachidori-updates", type, ...fields });
        try {
          const imported = await fetch(`${base}/import?name=managed.zip`, {
            method: "POST",
            body: buildTitledZip(title, archiveOptions()),
          });
          assert.equal(imported.status, 200, await imported.text());
          const { id } = await find();
          let checked = await updates("hd_updates_check");
          assert.equal(checked.ok, true, JSON.stringify(checked));
          assert.deepEqual(
            checked.outcomes.find((outcome) => outcome.id === id),
            { id, status: "up-to-date" },
          );
          assert.equal((await find()).lastUpdateCheck.status, "up-to-date");
          revision = "2";
          checked = await updates("hd_updates_check", { dictionaryIds: [id] });
          assert.deepEqual(checked.outcomes, [{ id, status: "update-available" }]);
          assert.equal((await find()).lastUpdateCheck.remoteRevision, "2");
          const installed = await updates("hd_updates_install", {
            dictionaryIds: [id],
          });
          assert.equal(installed.ok, true, JSON.stringify(installed));
          assert.deepEqual(installed.outcomes, [{ id, status: "updated" }]);
          const updated = await find();
          assert.equal(updated.id, id);
          assert.equal(updated.revision, "2");
          assert.equal(updated.lastUpdateCheck.status, "up-to-date");
          assert.equal(typeof installed.settings.lastCheckedAt, "string");
          const scheduled = await updates("hd_updates_schedule", {
            baseRevision: installed.settings.revision,
            schedule: "daily",
          });
          assert.equal(scheduled.ok, true, JSON.stringify(scheduled));
          assert.equal(
            (await (await fetch(`${base}/state`)).json()).dictionaryUpdates
              .schedule,
            "daily",
          );
          const stale = await updates("hd_updates_schedule", {
            baseRevision: 0,
            schedule: "off",
          });
          assert.equal(stale.ok, false);
          const cleared = await updates("hd_updates_schedule", {
            baseRevision: scheduled.settings.revision,
            schedule: "off",
          });
          assert.equal(cleared.ok, true, JSON.stringify(cleared));
          assert.equal((await lookup()).results[0].term.expression, "食べる");
        } finally {
          source.close();
        }
      },
    );
    await t.test(
      "matches replacements by update source when a dictionary changes its title",
      async () => {
        const options = {
          revision: "1",
          indexUrl: "https://example.test/index.json",
          downloadUrl: "https://example.test/dictionary.zip",
          indexOverrides: { isUpdatable: true },
        };
        const before = await fetch(`${base}/import?name=source.zip`, {
          method: "POST",
          body: buildTitledZip("Original title", options),
        });
        assert.equal(before.status, 200, await before.text());
        const renamed = buildTitledZip("New title", {
          ...options,
          revision: "2",
        });
        const duplicate = await fetch(`${base}/import?name=new.zip`, {
          method: "POST",
          body: renamed,
        });
        assert.equal((await duplicate.json()).skipped, true);
        const replaced = await fetch(
          `${base}/import?name=new.zip&replace=true`,
          { method: "POST", body: renamed },
        );
        assert.equal(replaced.status, 200, await replaced.text());
        const dictionaries = (await (await fetch(`${base}/state`)).json())
          .dictionaryState.dictionaries;
        assert.equal(
          dictionaries.some((d) => d.title === "Original title"),
          false,
        );
        assert.equal(
          dictionaries.filter((d) => d.title === "New title").length,
          1,
        );
      },
    );
    await t.test("removes an installed dictionary through the engine", async () => {
      const title = "Removable dictionary";
      const imported = await fetch(`${base}/import?name=removable.zip`, {
        method: "POST",
        body: buildTitledZip(title),
      });
      assert.equal(imported.status, 200, await imported.text());
      const before = (await (await fetch(`${base}/state`)).json())
        .dictionaryState.dictionaries.find((d) => d.title === title);
      const removed = await rpc({
        target: "hoshidicts-offscreen",
        type: "hd_remove",
        id: before.id,
        title,
      });
      assert.equal(removed.ok, true, JSON.stringify(removed));
      const dictionaries = (await (await fetch(`${base}/state`)).json())
        .dictionaryState.dictionaries;
      assert.equal(
        dictionaries.some((d) => d.title === title),
        false,
      );
      assert.equal((await lookup()).results[0].term.expression, "食べる");
    });
    await t.test(
      "persists personal entries, lookup counts and dictionary presentation",
      async () => {
        const saved = await rpc({
          target: "hoshidicts-offscreen",
          type: "hd_custom_save",
          baseDocumentRevision: 0,
          text: "共有語, きょうゆうご, saved through the host\n",
        });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        const found = await rpc({
          target: "hoshidicts-offscreen",
          type: "hd_lookup",
          text: "共有語",
        });
        assert.equal(found.results[0].term.expression, "共有語");
        for (let count = 1; count <= 2; count++) {
          const recorded = await rpc({
            target: "hoshidicts-worker",
            type: "hd_lookup_stats_record",
            term: "食べる",
            reading: "たべる",
          });
          assert.equal(
            recorded.statistics.lookupCount,
            count,
            JSON.stringify(recorded),
          );
        }
        const { state } = await rpc({
          target: "hoshidicts-worker",
          type: "hd_state_read",
        });
        const renamed = await rpc({
          target: "hoshidicts-worker",
          type: "hd_state_cas",
          baseRevision: state.revision,
          dictionaries: state.dictionaries.map((entry) =>
            entry.title === TITLE
              ? { ...entry, displayName: "Test dictionary" }
              : entry,
          ),
        });
        assert.equal(renamed.ok, true, JSON.stringify(renamed));
        const invalid = await rpc({
          target: "hoshidicts-worker",
          type: "hd_state_cas",
          baseRevision: renamed.state.revision,
          dictionaries: renamed.state.dictionaries.map((entry) => ({
            ...entry,
            path: "/etc/passwd",
          })),
        });
        assert.equal(invalid.ok, false);
      },
    );
    await t.test(
      "retains indexes and preferences after an abrupt process exit",
      async () => {
        await stop("SIGKILL");
        await start();
        const found = await lookup();
        assert.equal(found.results[0].term.expression, "食べる");
        const state = JSON.parse(
          await readFile(path.join(directory, "state.json"), "utf8"),
        );
        assert.equal(state.options.popupWidthPx, 640);
        assert.equal(
          state.dictionaryState.dictionaries.find(
            (entry) => entry.title === TITLE,
          ).displayName,
          "Test dictionary",
        );
        const personal = await rpc({
          target: "hoshidicts-offscreen",
          type: "hd_lookup",
          text: "共有語",
        });
        assert.equal(personal.results[0].term.expression, "共有語");
        const counts = await rpc({
          target: "hoshidicts-worker",
          type: "hd_lookup_stats_read",
          term: "食べる",
          reading: "たべる",
        });
        assert.equal(counts.statistics.lookupCount, 2);
        await until(
          async () =>
            (await (await fetch(`${base}/imports`)).json()).folder.files.some(
              (f) => f.fileName === "dictionary.zip" && f.status === "skipped",
            ),
          "Restart did not skip already installed dictionaries",
        );
        assert.equal(
          (
            await (await fetch(`${base}/state`)).json()
          ).dictionaryState.dictionaries.find(
            (d) => d.title === "Folder dictionary",
          ).revision,
          "2",
        );
      },
    );
    await t.test(
      "exports an archive accepted by the upstream backup validator",
      async () => {
        await until(
          async () => (await fetch(`${apiBase}/dictionaries`)).ok,
          "Relay did not reconnect",
        );
        const list = await (await fetch(`${apiBase}/dictionaries`)).json();
        const dictionary = (
          Array.isArray(list) ? list : list.dictionaries
        ).find((entry) => entry.title === TITLE);
        const response = await fetch(
          `${apiBase}/dictionaries/${encodeURIComponent(dictionary.id)}`,
        );
        if (response.status !== 200) assert.fail(await response.text());
        const bytes = await response.arrayBuffer();
        assert.ok(bytes.byteLength > 100);
        const archive = await openBackupArchive(new Blob([bytes]));
        await assertBackupSnapshot(archive.snapshot);
        assert.equal(archive.snapshot.state.dictionaries[0].title, TITLE);
        assert.ok(archive.files.length > 0);
      },
    );
  },
);
