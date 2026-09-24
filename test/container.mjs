import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFixtureZip,
  buildTitledZip,
} from "../.upstream/hachidori/test/make-fixture.mjs";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}
const project = `hachidori-host-test-${process.pid}`;
const imports = await mkdtemp(
  path.join(os.tmpdir(), "hachidori-container-imports-"),
);
// Override /data explicitly, including when the user's Compose file uses a bind mount.
const data = await mkdtemp(path.join(os.tmpdir(), "hachidori-container-data-"));
const override = path.join(imports, "compose.test.json");
await writeFile(
  override,
  JSON.stringify({
    services: {
      host: {
        // A pinned container_name in compose.yaml must not collide with a
        // running host while the disposable test project starts.
        container_name: `${project}-host`,
        volumes: [{ type: "bind", source: data, target: "/data" }],
      },
    },
  }),
);
const env = {
  ...process.env,
  COMPOSE_FILE: [path.resolve("compose.yaml"), override].join(path.delimiter),
  IMPORTS_PATH: imports,
  IMPORT_DIR: "/imports",
  ADMIN_PORT: await freePort(),
  RELAY_PORT: await freePort(),
  API_PORT: await freePort(),
  // Host networking: keep the disposable relay and management off the network.
  RELAY_NETWORK: "false",
  ADMIN_BIND_ADDRESS: "127.0.0.1",
};
function compose(args, allowed = 0) {
  const result = spawnSync("docker", ["compose", "-p", project, ...args], {
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, allowed, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const base = `http://127.0.0.1:${env.ADMIN_PORT}`;
const api = `http://127.0.0.1:${env.API_PORT}`;
async function lookup() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${api}/termEntries`, {
        method: "POST",
        body: JSON.stringify({ term: "食べたかった" }),
        signal: AbortSignal.timeout(5000),
      });
      const result = await response.json();
      if (response.ok && JSON.stringify(result).includes("食べる")) return;
    } catch {}
    await sleep(100);
  }
  assert.fail(
    "Container did not answer a real lookup through its published HTTP API",
  );
}
const resolved = JSON.parse(compose(["config", "--format", "json"]));
assert.equal(
  resolved.services.host.volumes.find((volume) => volume.target === "/data")
    .source,
  data,
);
try {
  // No browser or import command: startup discovers this mounted ZIP.
  await writeFile(path.join(imports, "fixture.zip"), buildFixtureZip());
  compose(["up", "-d", "--wait", "--wait-timeout", "60", "--no-build"]);
  assert.match(await (await fetch(base)).text(), /Choose ZIP files/);
  await lookup();
  assert.equal(
    (await (await fetch(`${base}/health`)).json()).dictionaryCount,
    1,
  );
  await writeFile(
    path.join(imports, "later.zip"),
    buildTitledZip("Added after startup"),
  );
  await sleep(2200);
  assert.equal(
    (await (await fetch(`${base}/health`)).json()).dictionaryCount,
    1,
  );
  const duplicate = await fetch(`${base}/import?name=renamed.zip`, {
    method: "POST",
    headers: { Origin: base },
    body: buildFixtureZip(),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).skipped, true);
  const observer = await (
    await fetch(`${base}/rpc`, {
      method: "POST",
      body: JSON.stringify({
        target: "hachidori-setup",
        type: "hd_setup_install",
        sourceIds: [],
      }),
    })
  ).json();
  assert.equal(observer.ok, true, JSON.stringify(observer));
  assert.equal(observer.finished, true);
  assert.deepEqual(observer.entries, []);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${env.RELAY_PORT}/link`, {
      origin: "hoshi://hoshidicts",
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket timed out"));
    }, 10000);
    socket.on("error", reject);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          kind: "hello",
          protocol: 1,
          version: "0.1.0",
          name: "SubMiner container test",
          capabilities: [],
        }),
      ),
    );
    socket.on("message", (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.kind === "ping") socket.send('{"kind":"pong"}');
      if (frame.kind === "hello")
        socket.send(
          JSON.stringify({
            kind: "request",
            id: 1,
            message: {
              target: "hoshidicts-offscreen",
              type: "hd_lookup",
              text: "食べたかった",
            },
          }),
        );
      if (frame.kind === "reply") {
        clearTimeout(timer);
        socket.close();
        try {
          assert.equal(frame.response.results[0].term.expression, "食べる");
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  compose(
    ["exec", "-T", "host", "flock", "--nonblock", "/data/host.lock", "true"],
    1,
  );
  compose([
    "up",
    "-d",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "60",
    "--no-build",
  ]);
  await lookup();
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await (await fetch(`${base}/health`)).json()).dictionaryCount === 2)
      break;
    await sleep(100);
  }
  assert.equal(
    (await (await fetch(`${base}/health`)).json()).dictionaryCount,
    2,
  );
  process.stdout.write(
    "PASS: Docker startup imports without a browser, later files wait for restart, import page, duplicate uploads, HTTP API, native WebSocket protocol, exclusive volume lock, and persistence after container recreation.\n",
  );
} finally {
  // This project uses only isolated temporary import/data directories.
  compose(["down", "-v"]);
}
