import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { createAnkiGateway } from "../.upstream/hachidori/extension/anki.js";
import { checkAnkiDuplicate, ankiNoteOptions } from "../.upstream/hachidori/extension/anki-duplicates.js";
import { ankiIndexSource, fetchAnkiIndex } from "../.upstream/hachidori/extension/anki-index.js";
import { createAnkiMediaStore } from "../.upstream/hachidori/extension/anki-media.js";
import { verifyAnkiFields } from "../.upstream/hachidori/extension/anki-mining.js";
import { ankiMediaFilename } from "../.upstream/hachidori/extension/anki-resources.js";
import { verifyAnkiSetup } from "../.upstream/hachidori/extension/anki-setup.js";
import "../.upstream/hachidori/extension/reader-options.js";

// The headless AnkiConnect against Anki's own sync server, driven through the
// upstream modules the host mines with. Needs a Python with the pinned `anki`
// package from ankiconnect/requirements.txt, named by ANKI_PYTHON.
const python = process.env.ANKI_PYTHON;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(run, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const value = await run();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(typeof message === "function" ? message() : message);
}

test(
  "headless AnkiConnect mines like desktop Anki and syncs each note",
  { skip: !python && "set ANKI_PYTHON to a Python with ankiconnect/requirements.txt", timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hachidori-ankiconnect-"));
    const children = [];
    t.after(async () => {
      for (const child of children.reverse()) {
        if (child.exitCode !== null) continue;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    });
    function start(args, env) {
      const child = spawn(python, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      child.logs = "";
      child.stdout.on("data", (bytes) => (child.logs += bytes));
      child.stderr.on("data", (bytes) => (child.logs += bytes));
      children.push(child);
      return child;
    }
    const syncPort = await freePort();
    const syncServer = start(["-m", "anki.syncserver"], {
      SYNC_USER1: "miner:secret",
      SYNC_BASE: path.join(directory, "server"),
      SYNC_HOST: "127.0.0.1",
      SYNC_PORT: String(syncPort),
    });
    await until(() => fetch(`http://127.0.0.1:${syncPort}/`), () => `Sync server failed: ${syncServer.logs}`);

    async function device(name) {
      const port = await freePort();
      const child = start([path.resolve("ankiconnect/server.py")], {
        ANKI_COLLECTION: path.join(directory, name, "collection.anki2"),
        ANKICONNECT_PORT: String(port),
        ANKI_SYNC_ENDPOINT: `http://127.0.0.1:${syncPort}/`,
        ANKI_SYNC_USERNAME: "miner",
        ANKI_SYNC_PASSWORD: "secret",
        ANKI_SYNC_DELAY: "0.2",
      });
      const url = `http://127.0.0.1:${port}`;
      await until(async () => (await fetch(`${url}/health`)).ok, () => `${name} failed: ${child.logs}`);
      const gateway = createAnkiGateway();
      const invoke = (action, params = {}) => gateway.invoke(action, params, "", undefined, url);
      return { url, gateway, invoke, child };
    }
    const miner = await device("miner");
    // The sync server starts empty, and takes a collection only when asked.
    assert.equal(await miner.invoke("fullSync", { direction: "upload" }), null);
    // The Front field holds the bare expression, so the word index keys on it.
    const config = globalThis.HDReaderOptions.normaliseOptions({
      anki: {
        url: miner.url,
        model: "Basic",
        deck: "Default",
        duplicateScope: "deck",
        fieldTemplates: {
          Front: { value: "{expression}", overwriteMode: "overwrite" },
          Back: { value: "{glossary}", overwriteMode: "overwrite" },
        },
      },
    }).anki;

    const discovered = await miner.gateway.discover({ model: "Basic", url: miner.url });
    assert.deepEqual(discovered.errors, []);
    assert.ok(discovered.decks.includes("Default"));
    assert.deepEqual(discovered.fields, ["Front", "Back"]);
    assert.equal((await verifyAnkiSetup(miner.invoke, config)).status, "already-configured");

    const note = {
      deckName: "Default",
      modelName: "Basic",
      fields: { Front: "食べる", Back: "to eat" },
      tags: ["hachidori"],
      options: ankiNoteOptions(config),
    };
    assert.deepEqual(await checkAnkiDuplicate(miner.invoke, note), { duplicate: false, addable: true, error: null });

    const health = async ({ url }) => (await fetch(`${url}/health`)).json();
    const startupSync = (await health(miner)).lastSync;
    const audio = Buffer.from("ID3 pronunciation bytes");
    const filename = await ankiMediaFilename(audio, "mp3");
    const stored = await createAnkiMediaStore().ensure({
      invoke: miner.invoke,
      filename,
      kind: "pronunciation",
      data: audio.toString("base64"),
    });
    assert.equal(stored.status, "stored");

    const noteId = await miner.invoke("addNote", { note });
    assert.ok(Number.isSafeInteger(noteId) && noteId > 0);
    const duplicate = await checkAnkiDuplicate(miner.invoke, note);
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(miner.invoke("addNote", { note }), /same first field already exists/);

    const back = `to eat[sound:${filename}]`;
    assert.equal(await miner.invoke("updateNoteFields", { note: { id: noteId, fields: { Back: back } } }), null);
    await verifyAnkiFields(miner.invoke, noteId, { Front: "食べる", Back: back });

    const source = await ankiIndexSource(config);
    assert.deepEqual(await fetchAnkiIndex(miner.invoke, source), [["食べる", false, [noteId]]]);

    // A second, fresh device downloads the note and its media from the server.
    // Each write schedules a sync shortly after it.
    await until(async () => {
      const status = await health(miner);
      return status.lastSync > startupSync && status.error === null;
    }, () => `Miner did not sync after mining: ${miner.child.logs}`);
    const reader = await device("reader");
    assert.deepEqual(await reader.invoke("findNotes", { query: "Front:食べる" }), [noteId]);
    await until(
      async () => (await reader.invoke("getMediaFilesNames", { pattern: filename })).length === 1,
      "Media did not sync",
    );

    // A note added on the other device reaches the miner on its next sync.
    const readerNote = await reader.invoke("addNote", {
      note: { ...note, fields: { Front: "飲む", Back: "to drink" } },
    });
    assert.equal(await reader.invoke("sync"), null);
    await until(async () => {
      await miner.invoke("sync");
      return (await miner.invoke("findNotes", { query: "Front:飲む" }))[0] === readerNote;
    }, "Miner did not receive the reader's note");

    // After a one-way sync elsewhere, such as a note type edit, a collection
    // with unsynced notes waits for a choice instead of discarding them.
    assert.equal(await reader.invoke("fullSync", { direction: "upload" }), null);
    const pending = await miner.invoke("addNote", { note: { ...note, fields: { Front: "走る", Back: "to run" } } });
    const blocked = await until(async () => {
      const response = await fetch(`${miner.url}/health`);
      return response.status === 503 && (await response.json());
    }, () => `Miner did not report the full sync: ${miner.child.logs}`);
    assert.match(blocked.error, /has changes it has not synced/);
    await assert.rejects(miner.invoke("sync"), /has changes it has not synced/);
    assert.equal(await miner.invoke("fullSync", { direction: "upload" }), null);
    // The reader has nothing unsynced, so it downloads on its own.
    assert.equal(await reader.invoke("sync"), null);
    assert.deepEqual(await reader.invoke("findNotes", { query: "Front:走る" }), [pending]);
  },
);
