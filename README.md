# Hachidori Docker

A headless Hachidori dictionary server. Node runs Hachidori's own WebAssembly
engine, and the upstream Python relay provides the WebSocket sharing protocol and
a Yomitan-compatible HTTP API. You don't need Chrome, Electron, a display server,
a browser extension or a running copy of Anki.

## Start

```sh
docker compose up --build -d
curl http://127.0.0.1:8780/health
```

The first build downloads checksum-pinned Hachidori sources and the bundled WASM.
Compose mounts the local `dictionaries/` folder at `/data`. It holds installed
dictionary indexes, settings, personal entries and lookup counts. The server runs
as an unprivileged user and takes a lock on the data folder, so a second host
pointed at the same folder refuses to start.

No dictionaries are downloaded for you. With an empty library, `/health` reports
ready but the host does not register with the relay. Once dictionaries are
installed, `/health` returns 503 until the relay connection is up.

## Import dictionaries

Open <http://127.0.0.1:8780>, or this machine's hostname or IP on port 8780. Drop
Yomitan dictionary ZIPs on the page or click **Choose ZIP files**. The page
uploads them one at a time, shows progress and lists what's installed. Keep it
open until the uploads finish. After a ZIP arrives, the server finishes importing
it even if you close the page.

Uploads skip a dictionary whose title or update source is already installed. This
holds even if the ZIP was renamed or the host restarted. To update one by hand,
check **Replace installed dictionaries** before uploading. Replacement follows
upstream import rules and can downgrade the installed version, so only check it
for archives you mean to replace.

Linked Hachidori 0.2.3 or later, and apps driving one such as SubMiner, can also
send a ZIP over the link: Settings on the linked browser shows the drop zone again.
These uploads replace a dictionary with the same title or update source, or
install a separate numbered copy when the sender asks for one, and wait while
another import or a dictionary update holds the host.

Each installed dictionary has a **Remove** button. Removal goes through the
engine, which deletes the dictionary's files and updates shared state in one
step. Linked clients see the change.

### Updates

A dictionary is managed when its `index.json` sets `isUpdatable` with HTTPS
`indexUrl` and `downloadUrl`. Jitendex, JMdict and KANJIDIC all do.
**Check for updates** asks each managed dictionary's index for a newer revision.
Rows with one get an **Update** button. It downloads the archive and replaces the
dictionary through the engine's normal import, keeping its id, display name and
enabled state.

**Auto-update** sets the shared schedule: off, hourly, daily, weekly or monthly.
The host checks and installs due updates in the background. Linked Hachidori
Settings pages can run the same checks and installs, edit the schedule and
per-dictionary overrides, and see the same results.

Lookups keep working while an update downloads. Uploads and folder imports fail
until the update finishes, so retry them afterward.

### Reader settings

**Import settings** applies reader settings from a backup ZIP exported by
Hachidori Settings. The host reads only the backup's manifest. It ignores the
dictionary files inside, and leaves installed dictionaries, personal entries and
lookup counts alone. Anki settings come across, including the AnkiConnect URL
and API key. Custom page script settings do not. Linked clients
get the new settings through the usual storage broadcast.

### Folder imports

For headless installs, copy ZIPs into `imports/` next to `compose.yaml`. The
container scans the folder once at startup. It doesn't poll, and the page doesn't
show folder status. Files added later wait for the next restart or a manual scan:

```sh
curl -X POST http://127.0.0.1:8780/imports/scan
curl http://127.0.0.1:8780/imports
```

The folder is mounted read-only, and folder imports never replace an installed
dictionary. A scan only looks at regular `.zip` files at the top level, skipping
subdirectories and symlinks. It waits two seconds and imports only files whose
size and timestamps didn't change in that window. For large files, copy under a
`.partial` name and rename to `.zip` when the copy is done. A bad or still-changing
file doesn't block the others, and the next scan retries it.

If you remove a dictionary whose ZIP is still in the folder, the next scan
installs it again. Move the ZIP out first.

Set `IMPORTS_PATH` in `.env` to mount a different folder, or `IMPORT_DIR=` to turn
scanning off. Run `docker compose up -d` after changing either.

### Command line

The bundled importer posts files to the management API:

```sh
docker compose exec host node scripts/import.mjs /imports/your-dictionary.zip
```

It follows the container's `ADMIN_PORT` and `ADMIN_BIND_ADDRESS`, and
`HOST_URL` overrides the target. It can't replace installed dictionaries.

Without Node, upload with curl:

```sh
curl --fail-with-body --data-binary @/path/to/dictionary.zip \
  'http://127.0.0.1:8780/import?name=dictionary.zip'
```

Add `&replace=true` to replace an installed dictionary. Each ZIP can be up to
512 MiB. The host runs one import at a time and answers a second upload with HTTP
409 until the first finishes. It doesn't accept Hachidori backup archives or
MDX/MDD dictionaries.

## Connect clients

| Interface         | Default address            | Use                                                                             |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Sharing WebSocket | `ws://127.0.0.1:8771/link` | Native Hachidori results, media, settings and storage broadcasts                |
| Yomitan HTTP API  | `http://127.0.0.1:19633`   | `/termEntries`, `/kanjiEntries`, `/tokenize`, `/ankiFields`, `/ankiCardFormats`, dictionary exports |
| Management        | `http://127.0.0.1:8780`    | Import page, health, state, imports, runtime requests                           |

To use this library from an existing Hachidori install in Chrome, link it in
Settings → Sharing with `127.0.0.1:8771`. Turn off that install's own hosting if
it would compete with this relay. Don't run the Anki relay add-on on the same
ports. Change `RELAY_PORT` and `API_PORT` in `.env` if they collide.

### Native protocol

A native client such as SubMiner connects with WebSocket Origin
`hoshi://hoshidicts` and sends:

```json
{
  "kind": "hello",
  "protocol": 1,
  "version": "0.1.0",
  "name": "SubMiner",
  "capabilities": []
}
```

The reply carries the host's settings and dictionary list. Then request a lookup:

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

Match `reply.id` to the request and read `reply.response`. Handle `storage`
batches, answer `ping` with `{"kind":"pong"}`, and reconnect when the socket
closes. Results keep the upstream `generation`, term, deinflection, frequency,
pitch and glossary fields. Pass that `generation` back when requesting `hd_media`.
The integration tests drive this host with the real upstream sharing client.

### HTTP

The same runtime messages work over HTTP:

```sh
curl --json '{"target":"hoshidicts-offscreen","type":"hd_lookup","text":"食べたかった"}' \
  http://127.0.0.1:8780/rpc
curl --json '{"term":"食べたかった"}' http://127.0.0.1:19633/termEntries
```

Management endpoints:

| Endpoint                    | Does                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /health`               | Readiness, dictionary count and relay status                                                  |
| `GET /state`                | The shared state                                                                              |
| `POST /rpc`                 | Runs a supported `hd_*` message and returns its upstream-style envelope, including `ok`       |
| `POST /import?name=x.zip`   | Imports raw ZIP bytes. Returns the upstream report, or `skipped: true` with `report.success: true` when already installed |
| `GET /imports`              | The active import, the last 40 attempts since startup, folder status and update progress      |
| `POST /imports/scan`        | Scans the import folder and retries failed files                                              |
| `POST /settings/import`     | Takes a raw Hachidori backup ZIP, replaces the reader settings and returns the stored options  |

Through `/rpc`, `hd_remove` with a dictionary `id` and `title` removes that
dictionary. With target `hachidori-updates`, `hd_updates_check`,
`hd_updates_install` (with `dictionaryIds`) and `hd_updates_schedule` (with
`baseRevision` and `schedule`) return the upstream `outcomes` and `settings`
shapes.

The management API accepts its own page and native clients. It rejects requests
from other browser origins and from Host headers it doesn't recognize. It always
accepts `localhost`, IP addresses, the machine's hostname and its Tailscale
MagicDNS name (`<hostname>.<tailnet>.ts.net`). Add any other hostname, such as a
reverse proxy domain, to the comma-separated `ADMIN_HOSTS` variable. CORS is off.

## Anki mining from linked browsers

The host advertises `linked-anki-v1` and `linked-anki-v2`. A linked Hachidori
mines through it the same way it would through a sharing browser. Anki discovery,
Template and custom-button edits, duplicate checks, note writes, overwrite mode
and Browse all run on the host with the host's AnkiConnect settings.

Set the AnkiConnect URL, API key and Templates from any linked browser's
Settings → Anki. The host stores them and mirrors them to every linked browser.
Linked readers too old to speak `linked-anki-v2` can't edit Templates or custom
buttons. The host fetches pronunciation from URL audio sources itself. For
browser text-to-speech and screenshots, the reading browser records them and the
host uploads them to Anki.

The container uses host networking, so it reaches AnkiConnect at the default
`http://127.0.0.1:8765` with no add-on changes. You don't need a
`webCorsOriginList` entry because the host sends no browser origin. While a note
type is configured, the host refreshes its duplicate index every 30 minutes, as
the browser does. Custom page scripts are the only Anki feature that stays in the
browser. With no desktop Anki on this machine, run the [headless Anki](#headless-anki)
service.

Word highlighting in Hachidori 0.3 works the same way: the host segments page
text with its engine and answers each word's status from its duplicate index.
Words marked as known or ignored are stored on the host, mirrored to every linked
browser and kept across restarts. When the index refreshes, linked pages re-read
the words they show.

### Headless Anki

The optional `anki` service answers AnkiConnect at `http://127.0.0.1:8765` from a
collection in `./anki`. It needs no display, Qt or desktop Anki: it opens the
collection with Anki's own Python library, pinned to 26.09.3 in
`ankiconnect/requirements.txt`, and uses about 40 MB of RAM plus the collection. It syncs to an Anki
sync server, such as a self-hosted `anki --syncserver`, so notes mined here reach
your other devices.

Turn it on in `.env`, then run `mkdir -p anki && docker compose up -d --build`:

```sh
COMPOSE_PROFILES=anki
ANKI_SYNC_ENDPOINT=http://sync.example:8080/
ANKI_SYNC_USERNAME=you
ANKI_SYNC_PASSWORD=secret
```

On first start the service downloads your collection before it accepts requests.
It then syncs after each write, waiting until `ANKI_SYNC_DELAY` seconds pass with
no further writes, so a note and its media go in one sync. It also syncs every
`ANKI_SYNC_INTERVAL` seconds to pick up notes from other devices, and on shutdown
if a write hasn't synced yet. To sync right away:

```sh
curl http://127.0.0.1:8765 -d '{"action":"sync","version":6}'
```

A note type edit or a forced one-way sync on another device makes the server ask
for a full sync. If every change here has synced, the service downloads on its own.
Otherwise it keeps the unsynced notes, `/health` returns 503 with the reason and
the container shows unhealthy until you choose a direction:

```sh
# "download" discards unsynced changes here; "upload" replaces the server's collection.
curl http://127.0.0.1:8765 -d '{"action":"fullSync","version":6,"params":{"direction":"download"}}'
```

An empty sync server also needs `"upload"` once, since the service never uploads
over the server on its own.

The service implements the AnkiConnect actions Hachidori uses, plus `version`,
`sync` and `fullSync`. Browse can't open without a window, so **View notes**
reports an error. Notes take media through `storeMediaFile` with `data`. Inline
`audio`, `picture` and `video` and file paths or URLs aren't accepted.

| Variable                   | Default     | Meaning                                                      |
| -------------------------- | ----------- | ------------------------------------------------------------ |
| `ANKI_SYNC_ENDPOINT`       | empty       | Sync server URL; empty keeps the collection local            |
| `ANKI_SYNC_USERNAME`       | empty       | Sync server account                                          |
| `ANKI_SYNC_PASSWORD`       | empty       | Sync server password                                         |
| `ANKI_SYNC_DELAY`          | `10`        | Seconds after the last write before syncing                  |
| `ANKI_SYNC_INTERVAL`       | `600`       | Seconds between syncs without writes                         |
| `ANKICONNECT_BIND`         | `127.0.0.1` | Listener address; `0.0.0.0` for other machines               |
| `ANKICONNECT_PORT`         | `8765`      | Listener port                                                |
| `ANKICONNECT_API_KEY`      | empty       | Key every request must carry, as AnkiConnect's `apiKey`      |
| `ANKICONNECT_CORS_ORIGINS` | empty       | Comma-separated browser origins allowed to call the API      |
| `ANKI_DATA_PATH`           | `./anki`    | Host folder holding the collection and media                 |

Requests from any other browser origin are refused, so web pages can't write to
the collection. Before binding beyond loopback, set an API key and enter it in
Hachidori's Anki settings. Stop the service before backing up `./anki`. Anki's
library is AGPL-3.0-or-later.

## Supported scope

The host handles lookups, kanji, styles, dictionary images, reloads, dictionary
presentation changes, removal, personal dictionary edits, reader settings, lookup
statistics, word highlighting, managed updates and Anki mining for linked browsers. The relay also
serves dictionary downloads in Hachidori backup format, which you can restore
through Hachidori's own backup UI. `/ankiFields` renders fields and dictionary
media with jsdom in Node. The HTTP API doesn't return pronunciation audio.
`POST /ankiCardFormats` returns the saved Anki Templates in Settings order.

Advertised capabilities are `hoshidicts-api-v1`, `linked-anki-v1`,
`linked-anki-v2` and `linked-import-v1`.

The browser's recommended-install flow isn't supported. Linked Settings pages can
still open it, since the host answers a status check with an idle snapshot, but
asking it to install sources returns an error pointing at the import page.

This project doesn't add Hachidori support to SubMiner. When that integration
lands, SubMiner can keep its own Anki workflow.

## Storage and operation

The upstream single-threaded WASM build keeps its indexes in memory. The host
writes them to ordinary files wherever the engine persists state, flushing files
before it atomically commits metadata. This replaces IndexedDB, and there is no
browser profile. RAM use grows with the library, since the host keeps a copy of
the compiled files in memory, and peaks during imports. The engine runs in a
worker thread, so lookups and imports don't block the HTTP server.

For a consistent backup, stop the container and copy the whole `dictionaries/`
folder, hidden files included:

```sh
docker compose stop
# Copy the entire dictionaries/ folder to your backup location.
docker compose start
```

`docker compose down`, with or without `-v`, leaves `dictionaries/` and `imports/`
alone. Deleting `dictionaries/` deletes the library and its saved state.

Docker restarts the container after a crash. If the engine or relay fails, the
whole container exits so both come back together.

The container uses host networking and listens directly on this machine's
interfaces. Configure it in `.env`:

| Variable             | Default     | Meaning                                                                  |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| `ADMIN_PORT`         | `8780`      | Management page and API                                                  |
| `RELAY_PORT`         | `8771`      | Sharing WebSocket relay                                                  |
| `API_PORT`           | `19633`     | Yomitan-compatible HTTP API                                              |
| `RELAY_NETWORK`      | `true`      | Relay and API on every interface (LAN, Tailscale); `false` for loopback  |
| `ADMIN_BIND_ADDRESS` | `0.0.0.0`   | Management listener address; `127.0.0.1` for loopback                    |
| `ADMIN_HOSTS`        | empty       | Extra hostnames the management API accepts, e.g. a reverse proxy domain  |
| `IMPORTS_PATH`       | `./imports` | Host folder mounted read-only at `/imports`                              |
| `IMPORT_DIR`         | `/imports`  | Folder scanned at startup inside the container; empty disables scanning  |

Management, the relay and the API have no authentication or TLS. Keep them on a
trusted LAN or tailnet and never port forward them. On a machine with a public
address, firewall these ports or set `ADMIN_BIND_ADDRESS=127.0.0.1` and
`RELAY_NETWORK=false`. Run `docker compose up -d` after changing any of these.

## Development

Requires Node 24+, Python 3.11+ and Linux `flock`, which guards the data folder.
`npm test` also needs `openssl` to generate a throwaway TLS certificate.

```sh
npm ci
npm run setup
mkdir -p data
flock --no-fork --nonblock data/host.lock npm start
npm test
docker compose build
npm run test:docker
```

Outside Docker the host stores data in `./data`, binds management to `127.0.0.1`
and keeps the relay on loopback unless you set `RELAY_NETWORK=true`.

`npm test` starts isolated hosts with temporary data and ports and imports real
fixture dictionaries. It covers both client protocols, field rendering, media,
storage broadcasts and stale writes, backup export and settings import, Anki
mining from a linked browser, managed updates, removal, and persistence after
SIGKILL. Import tests cover the upload endpoints, origin checks, folder scans,
duplicate skipping, replacement, bad archives and retries.

`npm run test:docker` starts the image under a separate Compose project with
temporary data and import folders. It checks both protocols and the data lock,
then recreates the container and confirms the data survived.

`test/ankiconnect.test.mjs` runs the headless Anki service against Anki's own sync
server and mines through the upstream modules the host uses. It needs a Python
with the service's requirements and skips without one:

```sh
uv venv /tmp/anki-venv && uv pip install --python /tmp/anki-venv -r ankiconnect/requirements.txt
ANKI_PYTHON=/tmp/anki-venv/bin/python node --test test/ankiconnect.test.mjs
```

`scripts/fetch-upstream.py` pins the upstream sources. `NOTICE` lists versions
and attribution. Rerun the integration tests before changing those pins, and
don't mix newer WASM with older JavaScript or the reverse.
