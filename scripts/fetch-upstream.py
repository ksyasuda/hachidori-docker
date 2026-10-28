"""Fetch immutable, checksum-verified upstream sources and their bundled WASM."""
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / ".upstream"
SOURCES = [
    ("hachidori", "5f986e470053d7e5692644e4da79bc70353cae5d", "d3fd77aa7a9d7b6d030f215a202bce4e610ad4983bad968f87657d194cd713a1"),
    ("hachidori-anki", "beffaca1cab2584608a25c276d81b17b0f27088f", "f88a26430ac5ea92fdacfe452b1b895cd67a8b578e39577b096fd666bb4ba27c"),
]

for repo, revision, checksum in SOURCES:
    destination = ROOT / repo
    marker = destination / ".verified-source"
    if marker.exists() and marker.read_text().strip() == checksum:
        continue
    if destination.exists():
        raise SystemExit(f"Refusing to overwrite unverified source: {destination}")
    url = f"https://codeload.github.com/bee-san/{repo}/tar.gz/{revision}"
    payload = urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(payload).hexdigest() != checksum:
        raise SystemExit(f"Checksum mismatch: {repo}")
    destination.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            parts = Path(member.name).parts
            if member.name.startswith('/') or '..' in parts:
                raise SystemExit(f"Unsafe archive path: {member.name}")
            if len(parts) < 2:
                continue
            target = destination.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as output:
                    import shutil
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)
            else:
                raise SystemExit(f"Unsupported archive entry: {member.name}")
    marker.write_text(checksum + "\n")
    print(f"Fetched {repo}@{revision}")
