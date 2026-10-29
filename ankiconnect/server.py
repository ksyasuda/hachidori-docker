"""A headless AnkiConnect: the AnkiConnect API v6 actions Hachidori mines with
and GameSentenceMiner updates cards with, served from a collection opened with
Anki's own Python library. No Qt, no display and no desktop Anki.

The collection syncs with an Anki sync server at startup, shortly after every
write, on an interval, and on request, so notes mined here reach every other
device.
"""

import base64
import fnmatch
import json
import logging
import math
import os
import signal
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import anki.lang
from anki.collection import Collection
from anki.errors import NotFoundError
from anki.notes import Note, NoteFieldsCheckResult
from anki.sync import SyncAuth, SyncOutput
from anki.utils import field_checksum, ids2str

log = logging.getLogger("ankiconnect")


@dataclass(frozen=True)
class Config:
    collection: str
    bind: str
    port: int
    api_key: str
    cors_origins: frozenset[str]
    sync_endpoint: str
    sync_username: str
    sync_password: str
    sync_delay: float
    sync_interval: float

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        return cls(
            collection=env("ANKI_COLLECTION", "/data/collection.anki2"),
            bind=env("ANKICONNECT_BIND", "127.0.0.1"),
            port=int(env("ANKICONNECT_PORT", "8765")),
            api_key=env("ANKICONNECT_API_KEY", ""),
            cors_origins=frozenset(o for o in env("ANKICONNECT_CORS_ORIGINS", "").split(",") if o),
            sync_endpoint=env("ANKI_SYNC_ENDPOINT", ""),
            sync_username=env("ANKI_SYNC_USERNAME", ""),
            sync_password=env("ANKI_SYNC_PASSWORD", ""),
            sync_delay=float(env("ANKI_SYNC_DELAY", "10")),
            sync_interval=float(env("ANKI_SYNC_INTERVAL", "600")),
        )


class FullSyncRequired(Exception):
    pass


Changes = SyncOutput.ChangesRequired


class Syncer:
    """Owns the sync server conversation. Every sync holds the collection lock,
    so it never interleaves with an API action."""

    def __init__(self, col: Collection, lock: threading.Lock, config: Config):
        self.col = col
        self.lock = lock
        self.config = config
        self.enabled = bool(config.sync_endpoint)
        self._auth: SyncAuth | None = None
        self._wake = threading.Condition()
        self._due: float | None = None
        self._stopping = False
        self.last_sync: float | None = None
        self.error: str | None = None
        self.full_sync_required = False

    def has_synced(self) -> bool:
        return bool(self.col.db.scalar("select ls from col"))

    def sync(self, direction: str | None = None) -> None:
        """One sync now. `direction` ("download" or "upload") forces a full
        sync that way, like Anki's "force changes in one direction"."""
        with self.lock:
            try:
                self._sync(direction)
            except Exception as error:
                self.error = str(error)
                self.full_sync_required = isinstance(error, FullSyncRequired)
                # A rejected or expired key is replaced by a fresh login next time.
                self._auth = None
                raise
            self.last_sync = time.time()
            self.error = None
            self.full_sync_required = False

    def _sync(self, direction: str | None) -> None:
        col = self.col
        if self._auth is None:
            login = col.sync_login(self.config.sync_username, self.config.sync_password, self.config.sync_endpoint)
            self._auth = SyncAuth(hkey=login.hkey, endpoint=self.config.sync_endpoint)
        if direction is not None:
            # A new schema makes the server ask for a full sync. It compares
            # modification times first, so that one moves too.
            now = int(time.time() * 1000)
            col.db.execute("update col set scm = ?, mod = ?", now, now)
        out = col.sync_collection(self._auth, sync_media=True)
        if out.server_message:
            log.info("sync server: %s", out.server_message)
        if out.required in (Changes.NO_CHANGES, Changes.NORMAL_SYNC):
            return
        # The schemas differ, after a note type edit or a forced one-way sync
        # elsewhere. Downloading loses nothing when nothing here is unsynced.
        if out.required == Changes.FULL_UPLOAD and direction != "upload":
            raise FullSyncRequired(
                'The sync server\'s collection is empty. Upload this one with the fullSync action and {"direction": "upload"}.'
            )
        if out.required == Changes.FULL_DOWNLOAD and direction == "upload":
            raise Exception("This collection is empty, so it can only download from the sync server.")
        if direction is None and out.required == Changes.FULL_SYNC and self._unsynced_changes():
            raise FullSyncRequired(
                "The sync server needs a one-way sync, and this collection has changes it has not synced. "
                'Run the fullSync action with {"direction": "download"} to discard them, '
                'or {"direction": "upload"} to replace the server\'s collection with this one.'
            )
        upload = direction == "upload" or out.required == Changes.FULL_UPLOAD
        log.info("full sync: %s", "upload" if upload else "download")
        col.close_for_full_sync()
        try:
            col.full_upload_or_download(auth=self._auth, server_usn=out.server_media_usn, upload=upload)
        finally:
            col.reopen(after_full_sync=True)

    def _unsynced_changes(self) -> bool:
        return any(
            self.col.db.scalar(f"select exists(select 1 from {table} where usn = -1)")
            for table in ("notes", "cards", "revlog", "graves")
        )

    def schedule(self) -> None:
        """Debounces a sync after a write: mining one result stores media, adds
        the note and may then add pronunciation, so one sync follows them all."""
        if not self.enabled:
            return
        with self._wake:
            self._due = time.monotonic() + self.config.sync_delay
            self._wake.notify()

    def run(self) -> None:
        periodic = time.monotonic() + self.config.sync_interval
        while True:
            with self._wake:
                while not self._stopping:
                    wait = min(self._due or math.inf, periodic) - time.monotonic()
                    if wait <= 0:
                        break
                    self._wake.wait(wait)
                if self._stopping:
                    return
                self._due = None
            periodic = time.monotonic() + self.config.sync_interval
            self._try_sync()

    def _try_sync(self) -> None:
        try:
            self.sync()
        except Exception:
            log.exception("sync failed")

    def stop(self) -> None:
        """Stops the loop and runs a write's pending sync before shutdown."""
        with self._wake:
            self._stopping = True
            pending = self._due is not None
            self._wake.notify()
        if pending:
            self._try_sync()

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "lastSync": self.last_sync,
            "error": self.error,
            "fullSyncRequired": self.full_sync_required,
        }


ACTIONS: dict[str, Callable[..., Any]] = {}
# Actions after which the collection or its media differ from the server's.
WRITES = {"addNote", "updateNoteFields", "addTags", "removeTags", "deleteNotes", "storeMediaFile", "deleteMediaFile"}


def action(fn: Callable[..., Any]) -> Callable[..., Any]:
    ACTIONS[fn.__name__] = fn
    return fn


class Api:
    """AnkiConnect's request handling. Errors carry AnkiConnect's own text,
    since Hachidori matches it to explain refusals."""

    def __init__(self, col: Collection, lock: threading.Lock, syncer: Syncer, config: Config):
        self.col = col
        self.lock = lock
        self.syncer = syncer
        self.config = config

    def handle(self, request: Any) -> dict[str, Any]:
        try:
            if not isinstance(request, dict):
                raise Exception("request must be a JSON object")
            if self.config.api_key and request.get("key") != self.config.api_key:
                raise Exception("valid api key must be provided")
            return {"result": self.call(request.get("action"), request.get("params") or {}), "error": None}
        except Exception as error:
            return {"result": None, "error": str(error)}

    def call(self, name: Any, params: dict[str, Any]) -> Any:
        if name == "multi":
            return [self.handle({**entry, "key": self.config.api_key}) for entry in params["actions"]]
        if name == "sync":
            self._require_sync()
            return self.syncer.sync()
        if name == "fullSync":
            self._require_sync()
            if params.get("direction") not in ("download", "upload"):
                raise Exception('fullSync needs "direction": "download" or "upload"')
            return self.syncer.sync(params["direction"])
        fn = ACTIONS.get(name)
        if fn is None:
            raise Exception("unsupported action")
        with self.lock:
            result = fn(self, **params)
        if name in WRITES:
            self.syncer.schedule()
        return result

    def _require_sync(self) -> None:
        if not self.syncer.enabled:
            raise Exception("Sync is not configured. Set ANKI_SYNC_ENDPOINT.")

    def _model(self, name: str) -> dict[str, Any]:
        model = self.col.models.by_name(name)
        if model is None:
            raise Exception(f"model was not found: {name}")
        return model

    def _note(self, nid: int) -> Note:
        try:
            return self.col.get_note(nid)
        except NotFoundError:
            raise Exception(f"note was not found: {nid}") from None

    def _create_note(self, params: dict[str, Any]) -> tuple[Note, int]:
        """AnkiConnect's createNote: the note `params` describes and its deck,
        or the refusal Anki would give for adding it."""
        model = self._model(params["modelName"])
        deck = self.col.decks.by_name(params["deckName"])
        if deck is None:
            raise Exception(f"deck was not found: {params['deckName']}")
        for media in ("audio", "video", "picture"):
            if params.get(media):
                raise Exception(f'"{media}" is not supported in notes here; store media with storeMediaFile')
        note = self.col.new_note(model)
        note.tags = list(params.get("tags") or [])
        names = {name.lower(): name for name in note.keys()}
        for name, value in params["fields"].items():
            if name.lower() in names:
                note[names[name.lower()]] = value
        options = params.get("options") or {}
        state = note.fields_check()
        if state == NoteFieldsCheckResult.EMPTY:
            raise Exception("cannot create note because it is empty")
        if state not in (NoteFieldsCheckResult.NORMAL, NoteFieldsCheckResult.DUPLICATE):
            raise Exception("cannot create note for unknown reason")
        scope = options.get("duplicateScopeOptions") or {}
        if options.get("duplicateScope") == "deck" or scope.get("checkAllModels"):
            duplicate = self._scoped_duplicate(note, deck["id"], options.get("duplicateScope") == "deck", scope)
        else:
            duplicate = state == NoteFieldsCheckResult.DUPLICATE
        if duplicate and not options.get("allowDuplicate", False):
            raise Exception("cannot create note because it is a duplicate")
        return note, deck["id"]

    def _scoped_duplicate(self, note: Note, did: int, deck_scope: bool, scope: dict[str, Any]) -> bool:
        """AnkiConnect's duplicate check for a deck scope or across note types:
        a note with the same first field that has a card in the scoped decks."""
        dids = None
        if deck_scope:
            if scope.get("deckName") is not None:
                deck = self.col.decks.by_name(scope["deckName"])
                if deck is None:
                    return False
                did = deck["id"]
            dids = {did}
            if scope.get("checkChildren"):
                dids.update(child for _, child in self.col.decks.children(did))
        query = "select id from notes where csum = ? and id != ?"
        args: list[Any] = [field_checksum(note.fields[0]), note.id]
        if not scope.get("checkAllModels"):
            query += " and mid = ?"
            args.append(note.mid)
        for nid in self.col.db.list(query, *args):
            if dids is None or dids & set(self.col.db.list("select did from cards where nid = ?", nid)):
                return True
        return False

    @action
    def version(self) -> int:
        return 6

    @action
    def deckNames(self) -> list[str]:
        return [deck.name for deck in self.col.decks.all_names_and_ids()]

    @action
    def getDecks(self, cards: list[int]) -> dict[str, list[int]]:
        decks: dict[str, list[int]] = {}
        for cid in cards:
            did = self.col.db.scalar("select did from cards where id = ?", cid)
            if did is not None:
                decks.setdefault(self.col.decks.name(did), []).append(cid)
        return decks

    @action
    def modelNames(self) -> list[str]:
        return [model.name for model in self.col.models.all_names_and_ids()]

    @action
    def modelNamesAndIds(self) -> dict[str, int]:
        return {model.name: model.id for model in self.col.models.all_names_and_ids()}

    @action
    def modelFieldNames(self, modelName: str) -> list[str]:
        return [field["name"] for field in self._model(modelName)["flds"]]

    @action
    def findModelsByName(self, modelNames: list[str]) -> list[dict[str, Any]]:
        return [self._model(name) for name in modelNames]

    @action
    def findNotes(self, query: str | None = None) -> list[int]:
        return [] if query is None else list(self.col.find_notes(query))

    @action
    def findCards(self, query: str | None = None) -> list[int]:
        return [] if query is None else list(self.col.find_cards(query))

    @action
    def cardsToNotes(self, cards: list[int]) -> list[int]:
        return self.col.db.list(f"select distinct nid from cards where id in {ids2str(cards)}")

    @action
    def notesInfo(self, notes: list[int] | None = None, query: str | None = None) -> list[dict[str, Any]]:
        if notes is None:
            notes = self.findNotes(query)
        result: list[dict[str, Any]] = []
        for nid in notes:
            try:
                note = self.col.get_note(nid)
            except NotFoundError:
                # AnkiConnect keeps replies aligned with the request.
                result.append({})
                continue
            model = note.note_type()
            result.append({
                "noteId": note.id,
                "modelName": model["name"],
                "tags": note.tags,
                "fields": {
                    field["name"]: {"value": note.fields[field["ord"]], "order": field["ord"]}
                    for field in model["flds"]
                },
                "mod": note.mod,
                "cards": self.col.db.list("select id from cards where nid = ? order by ord", note.id),
            })
        return result

    @action
    def cardsInfo(self, cards: list[int]) -> list[dict[str, Any]]:
        """AnkiConnect's card details without the rendered question and answer."""
        result: list[dict[str, Any]] = []
        for cid in cards:
            try:
                card = self.col.get_card(cid)
            except NotFoundError:
                result.append({})
                continue
            result.append({
                "cardId": card.id,
                "note": card.nid,
                "deckName": self.col.decks.name(card.did),
                "modelName": card.note_type()["name"],
                "ord": card.ord,
                "type": card.type,
                "queue": card.queue,
                "due": card.due,
                "interval": card.ivl,
                "factor": card.factor,
                "reps": card.reps,
                "lapses": card.lapses,
                "left": card.left,
                "mod": card.mod,
                "flags": card.flags,
            })
        return result

    @action
    def canAddNotes(self, notes: list[dict[str, Any]]) -> list[bool]:
        return [detail["canAdd"] for detail in self.canAddNotesWithErrorDetail(notes)]

    @action
    def canAddNotesWithErrorDetail(self, notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for params in notes:
            try:
                self._create_note(params)
                result.append({"canAdd": True})
            except Exception as error:
                result.append({"canAdd": False, "error": str(error)})
        return result

    @action
    def addNote(self, note: dict[str, Any]) -> int:
        created, did = self._create_note(note)
        self.col.add_note(created, did)
        return created.id

    @action
    def updateNoteFields(self, note: dict[str, Any]) -> None:
        for media in ("audio", "video", "picture"):
            if note.get(media):
                raise Exception(f'"{media}" is not supported in notes here; store media with storeMediaFile')
        existing = self._note(note["id"])
        for name, value in note["fields"].items():
            if name in existing:
                existing[name] = value
        self.col.update_note(existing)

    @action
    def addTags(self, notes: list[int], tags: str) -> None:
        self.col.tags.bulk_add(notes, tags)

    @action
    def removeTags(self, notes: list[int], tags: str) -> None:
        self.col.tags.bulk_remove(notes, tags)

    @action
    def deleteNotes(self, notes: list[int]) -> None:
        self.col.remove_notes(notes)

    @action
    def getReviewsOfCards(self, cards: list[int]) -> dict[int, list[dict[str, Any]]]:
        columns = ("id", "usn", "ease", "ivl", "lastIvl", "factor", "time", "type")
        return {
            cid: [
                dict(zip(columns, row))
                for row in self.col.db.all(
                    "select id, usn, ease, ivl, lastIvl, factor, time, type from revlog where cid = ?", cid
                )
            ]
            for cid in cards
        }

    @action
    def getMediaFilesNames(self, pattern: str = "*") -> list[str]:
        return fnmatch.filter(os.listdir(self.col.media.dir()), pattern)

    @action
    def storeMediaFile(self, filename: str, data: str, deleteExisting: bool = True) -> str:
        if deleteExisting:
            self.col.media.trash_files([filename])
        return self.col.media.write_data(filename, base64.b64decode(data))

    @action
    def deleteMediaFile(self, filename: str) -> None:
        self.col.media.trash_files([filename])

    @action
    def guiBrowse(self, query: str) -> None:
        raise Exception("This Anki runs without a window, so it cannot open Browse. Search for the note in Anki on another device.")

    @action
    def guiSelectedNotes(self) -> list[int]:
        # No Browse window, so nothing is selected. GameSentenceMiner asks before
        # each card update, to move Browse off the note it's about to edit.
        return []


def serve(config: Config) -> None:
    # As desktop Anki does at startup. Anki's HTML stripping, which duplicate
    # checksums use, and its error messages go through this language.
    anki.lang.set_lang("en")
    os.makedirs(os.path.dirname(os.path.abspath(config.collection)), exist_ok=True)
    col = Collection(config.collection)
    lock = threading.Lock()
    syncer = Syncer(col, lock, config)
    api = Api(col, lock, syncer, config)
    stopping = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.set())

    if syncer.enabled:
        # A collection that never synced lacks the notes Hachidori checks for
        # duplicates, and a note added to it now would collide with the first
        # full download. Wait for that download; afterwards a failed sync only
        # delays the next one.
        while not stopping.is_set():
            try:
                syncer.sync()
                break
            except Exception:
                log.exception("startup sync failed")
                if syncer.has_synced():
                    break
                stopping.wait(30)
        threading.Thread(target=syncer.run, name="sync", daemon=True).start()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            origin = self.headers.get("Origin")
            if origin in config.cors_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()
            self.wfile.write(body)

        def _origin_allowed(self) -> bool:
            # Without this, any web page open in a browser that can reach this
            # port could write to the collection.
            origin = self.headers.get("Origin")
            if origin is None or origin in config.cors_origins:
                return True
            self._send(403, b"Origin not allowed", "text/plain")
            return False

        def do_GET(self) -> None:
            if self.path == "/health":
                status = syncer.status()
                self._send(503 if status["fullSyncRequired"] else 200, json.dumps(status).encode())
            else:
                self._send(200, b"AnkiConnect v.6", "text/plain")

        def do_OPTIONS(self) -> None:
            if self._origin_allowed():
                self._send(204, b"")

        def do_POST(self) -> None:
            if not self._origin_allowed():
                return
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            try:
                request = json.loads(body)
            except ValueError as error:
                reply = {"result": None, "error": f"invalid JSON: {error}"}
            else:
                reply = api.handle(request)
            self._send(200, json.dumps(reply, ensure_ascii=False).encode())

        def log_message(self, format: str, *args: Any) -> None:
            pass

    if not stopping.is_set():
        server = ThreadingHTTPServer((config.bind, config.port), Handler)
        threading.Thread(target=server.serve_forever, name="http", daemon=True).start()
        log.info("listening on %s:%d", config.bind, config.port)
        stopping.wait()
        server.shutdown()
    if syncer.enabled:
        syncer.stop()
    with lock:
        col.close()
    log.info("collection closed")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    serve(Config.from_env())
