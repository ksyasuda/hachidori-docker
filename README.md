# Hachidori Host

A persistent dictionary server for future Hachidori. Node runs
Hachidori's actual WebAssembly engine. The upstream Python relay provides its
WebSocket sharing protocol and Yomitan-compatible HTTP API. No Chrome, Electron,
display server, browser extension process, or Anki process is needed.

## Start

```sh
docker compose up --build -d
curl http://127.0.0.1:8780/health
```

The first build downloads checksum-pinned Hachidori sources and bundled WASM.
The local `dictionaries/` folder is mounted at `/data` in the container and retains
installed dictionary indexes, settings, personal entries and lookup counts.
The process runs as an unprivileged user and locks the data folder to prevent
concurrent writers. Do not run multiple hosts against the same data folder.

An empty library is healthy but does not register with the relay until a
dictionary is imported. No dictionaries are downloaded automatically.

## Import dictionaries

Open **<http://127.0.0.1:8780>**, or this machine's hostname or IP on port 8780. Drop one or more Yomitan dictionary ZIPs on the
page or click **Choose ZIP files**. The page shows upload progress and the
installed dictionaries. Keep the page open until uploads finish. Once a ZIP has
arrived, the server finishes importing it even if the page closes. Sharing needs
no browser.

Each installed dictionary has a **Remove** button. Removal goes through the
engine's own removal path, so the dictionary's files and the shared state are
cleaned up together, and linked clients see the change.

**Check for updates** asks every managed dictionary's update index for a newer
revision. A dictionary is managed when its `index.json` declares `isUpdatable`
with HTTPS `indexUrl` and `downloadUrl`, as Jitendex, JMdict and KANJIDIC do.
Rows with a newer revision show an **Update** button, which downloads the archive
and replaces the dictionary through the engine's ordinary import transaction,
keeping its id, display name and enabled state. **Auto-update** sets the shared
schedule (off, hourly, daily, weekly or monthly); due dictionaries are checked
and installed in the background without a browser. Linked Hachidori Settings can
run the same checks, installs and schedule edits, including per-dictionary
overrides, and see the same results.

**Import settings** applies the reader settings from a backup ZIP exported by
Hachidori Settings. Only the archive's manifest is read: installed dictionaries,
personal entries and lookup counts are left alone, and the dictionary files inside
the backup are ignored. Anki and media capture settings, including the AnkiConnect
URL and API key, are imported; custom page script settings are not. Linked
clients receive the new settings through the usual storage broadcast.

Uploads skip dictionaries whose title or update source is already installed,
even if the ZIP was renamed or the host restarted. To update one, upload the new
ZIP with **Replace installed dictionaries** checked. Replacement uses upstream
import rules and may downgrade an installed version. Only enable it for archives
you intend to replace.

### Headless imports from a folder

For headless installs, copy ZIPs into **`imports/`** beside `compose.yaml`. The
container scans this folder once at startup. There is no background polling and
the page does not show folder status. Files added later wait until the next host
restart or a manual scan request:

```sh
curl -X POST http://127.0.0.1:8780/imports/scan
curl http://127.0.0.1:8780/imports
```

Startup imports need no open browser. The folder is mounted read-only; source
files are preserved. Folder imports never replace installed dictionaries.

Folder scanning checks only regular `.zip` files directly inside the folder.
It ignores subdirectories and symlinks, and waits for unchanged size and timestamps
over a two-second settling window during each scan. For large copies, copy under
a `.partial` name and rename to `.zip` when complete. Failed or changing files
wait for another startup or manual scan. A bad archive does not stop other imports.
Removing an installed dictionary while its ZIP remains in the folder allows it
to be imported again on the next scan. Move the ZIP out first if you want it to stay removed.

Set `IMPORTS_PATH` in `.env` to mount a different host folder. Set `IMPORT_DIR=` to disable
scanning. Restart with `docker compose up -d` after changing these settings.

The command-line importer remains available:

```sh
docker compose exec host node scripts/import.mjs /imports/your-dictionary.zip
```

Or upload directly from the host without Node installed:

```sh
curl --fail-with-body --data-binary @/path/to/dictionary.zip \
  'http://127.0.0.1:8780/import?name=dictionary.zip'
```

Add `&replace=true` to the upload URL for an explicit replacement. Imports are
limited to 512 MiB per ZIP and run one at a time. Concurrent uploads receive HTTP
409; retry after the active import finishes. The page uploads selected files
sequentially. Hachidori backup archives and MDX/MDD imports are unsupported here.
`GET /imports` lists the last 40 attempts since the host started; installed
dictionaries persist across restarts.

## Connect clients

| Interface         | Default address            | Use                                                                             |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Sharing WebSocket | `ws://127.0.0.1:8771/link` | Native Hachidori results, media, settings and storage broadcasts                |
| Yomitan HTTP API  | `http://127.0.0.1:19633`   | `/termEntries`, `/kanjiEntries`, `/tokenize`, `/ankiFields`, dictionary exports |
| Management        | `http://127.0.0.1:8780`    | Import page, health, state, imports, runtime requests                           |

An existing Hachidori Chrome installation can link in Settings → Sharing using
`127.0.0.1:8771`. It then uses this host's library. Disable that installation's
own hosting if it competes with another relay. Do not run the Anki relay on the
same ports; change `RELAY_PORT` and `API_PORT` in `.env` if needed.

For future SubMiner integration, send WebSocket Origin `hoshi://hoshidicts` and:

```json
{
  "kind": "hello",
  "protocol": 1,
  "version": "0.1.0",
  "name": "SubMiner",
  "capabilities": []
}
```

The reply includes the host's settings and dictionary inventory. Request a lookup:

```json
{
  "kind": "request",
  "id": 1,
  "message": {
    "target": "hoshidicts-offscreen",
    "type": "hd_lookup",
    "requestId": "lookup-1",
    "text": "食べたかった"
  }
}
```

Match `reply.id` to the request and consume `reply.response`. Handle `storage`
batches, respond to `ping` with `{"kind":"pong"}`, and reconnect after closure.
Results retain upstream `generation`, term, deinflection, frequency, pitch and
glossary fields. Supply that generation when requesting `hd_media`. The integration
test uses the actual upstream sharing client against this host.

For an HTTP lookup using the same runtime envelope:

```sh
curl --json '{"target":"hoshidicts-offscreen","type":"hd_lookup","text":"食べたかった"}' \
  http://127.0.0.1:8780/rpc
curl --json '{"term":"食べたかった"}' http://127.0.0.1:19633/termEntries
```

`GET /state` returns the shared state. `POST /rpc` accepts supported `hd_*`
messages and returns their upstream-style response envelope, including `ok`.
`GET /imports` returns active/recent imports and folder status. `POST /imports/scan`
requests a scan and retries failed files. `POST /rpc` with `hd_remove` and a
dictionary `id` and `title` removes an installed dictionary; the page uses this.
`POST /settings/import` accepts a raw Hachidori backup ZIP and replaces the host's
reader settings with the archive's, returning the stored options. `POST /rpc` with
target `hachidori-updates` accepts `hd_updates_check`, `hd_updates_install` with
`dictionaryIds`, and `hd_updates_schedule` with `baseRevision` and `schedule`;
these return the upstream `outcomes` and `settings` shapes. Update checks and
installs run beside the request queue, so lookups keep working while an archive
downloads; uploads wait until the cycle finishes. `POST /import?name=dictionary.zip`
accepts raw ZIP bytes and returns the upstream report, or `skipped: true` when
already installed. A successful skip also has `report.success: true`.

The management API accepts its own page and native clients. It rejects foreign
browser origins and unrecognized Host headers. It accepts `localhost`, any IP
address, the machine's hostname and its Tailscale MagicDNS name
(`<hostname>.<tailnet>.ts.net`). Other hostnames, such as a reverse proxy domain,
must be listed in the comma-separated `ADMIN_HOSTS` environment variable. No CORS
access is enabled.

## Anki mining from linked browsers

The host advertises `linked-anki-v1` and `linked-anki-v2`, so a linked Hachidori
mines through this host exactly as it would through a sharing browser: Anki
discovery, Template and custom-button edits, duplicate checks, note writes,
overwrite mode and Browse all run here against the host's AnkiConnect settings.
Set the AnkiConnect URL, API key and Templates from any linked browser's
Settings → Anki; they are stored on the host and mirrored to every linked
browser. Pronunciation from URL audio sources is fetched by the host. Browser
text-to-speech is recorded by the reading browser and uploaded by the host, as
are its screenshots and captured media clips when media mining is enabled.

The container uses host networking, so AnkiConnect at its default
`http://127.0.0.1:8765` is reachable with no add-on configuration changes. No
`webCorsOriginList` entry is needed because the host sends no browser origin.

Only custom page scripts stay browser-only. The duplicate index refreshes every
30 minutes while a note type is configured, as in the browser.

## Supported scope

Lookups, kanji, styles, dictionary images, reload, dictionary presentation changes,
removal, personal dictionary edits, ordinary reader settings, lookup statistics,
managed dictionary updates and Anki mining for linked browsers use the host. The relay also supports dictionary downloads in Hachidori backup
format for restoration through Hachidori's own backup UI. `/ankiFields` renders
fields and dictionary media with a DOM library inside Node, not a browser.
Pronunciation audio is not supplied through the HTTP API.

This host advertises `hoshidicts-api-v1`, `linked-anki-v1` and `linked-anki-v2`.
The browser's recommended-install workflow is unsupported and returns an error.
SubMiner can continue owning its own Anki workflow when integration is added.
Linked Hachidori Settings can query recommended-install status without an error.
An empty source list returns the upstream idle snapshot. Requests to install
recommended sources still return an error directing you to this host's import
page; ordinary ZIP imports and startup folder imports are separate operations.
This project does not add Hachidori support to SubMiner itself.

## Storage and operation

The single-threaded upstream WASM build uses in-memory indexes, synchronized to
ordinary files at the engine's existing persistence boundaries. Files are flushed
before metadata is atomically committed. This is a Node replacement for IndexedDB;
there is no browser profile. Expect RAM usage to scale with the loaded library,
including a memory copy of compiled files, and higher peak usage during imports.
The engine runs in a worker so native lookups/imports do not block the HTTP server.

Back up the local `dictionaries/` folder while stopped for a consistent copy,
including its hidden files and directories:

```sh
docker compose stop
# Copy the entire dictionaries/ folder to your backup location.
docker compose start
```

Both `docker compose down` and `docker compose down -v` retain the local
`dictionaries/` and `imports/` folders. Deleting `dictionaries/` removes the
installed library and its saved state.
The container restarts after a crash. Host engine and relay failures stop the
whole container so Docker can restart both together.

The container runs with host networking and listens directly on this machine's
interfaces, configured in `.env`:

| Variable             | Default     | Meaning                                                              |
| -------------------- | ----------- | -------------------------------------------------------------------- |
| `ADMIN_PORT`         | `8780`      | Management page and API                                              |
| `RELAY_PORT`         | `8771`      | Sharing WebSocket relay                                              |
| `API_PORT`           | `19633`     | Yomitan-compatible HTTP API                                          |
| `RELAY_NETWORK`      | `true`      | Relay and API on every interface (LAN, Tailscale); `false` for loopback |
| `ADMIN_BIND_ADDRESS` | `0.0.0.0`   | Where the management listener binds; `127.0.0.1` for loopback        |
| `ADMIN_HOSTS`        | empty       | Extra hostnames the management API accepts, e.g. a reverse proxy domain |

Management, the relay and the API have no authentication or TLS. They are meant
for a trusted LAN or tailnet: do not port forward them or expose them to the
Internet. On a machine with a public address, firewall these ports or set
`ADMIN_BIND_ADDRESS=127.0.0.1` and `RELAY_NETWORK=false`. Restart with
`docker compose up -d` after changing these settings.

## Development and verification

Requires Node 24+, Python 3.11+ and Linux `flock` for exclusive data-folder ownership.

```sh
npm ci
npm run setup
mkdir -p data
flock --no-fork --nonblock data/host.lock npm start
npm test
docker compose build
npm run test:docker
```

Tests launch isolated hosts with temporary data and ports, import real fixture
dictionaries, query both protocols, render fields, read media, check storage
broadcasts and stale writes, validate exported backups, and verify persistence after SIGKILL.
Import coverage includes the web endpoints, origin checks, automatic folder
discovery, duplicate skipping, explicit replacement, invalid archives and retries.
The Docker test uses a separate project and disposable volume, checks both
published dictionary protocols, then recreates the container and checks the data.

Upstream sources are pinned in `scripts/fetch-upstream.py`. See `NOTICE` for
versions and attribution. Review and rerun the integration suite before changing
those pins; arbitrary newer WASM and JavaScript versions must not be mixed.
