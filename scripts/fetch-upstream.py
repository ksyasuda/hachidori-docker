"""Fetch immutable, checksum-verified upstream sources and their bundled WASM."""
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / ".upstream"
SOURCES = [
    ("hachidori", "4be36f5e87ab946574d6c0279c6e7dd6fee36c45", "852a1d73b4f3300453edc4e160a0f733bc261c5a517fb7bf9fd22d7b8fdd184d"),
    ("hachidori-anki", "7766079159a2a76a20a3fd4eb756e1ffe5752c5c", "bb2adfbb84f1bad1b79c1f6d47b3e436d22371184c8d6df69079547b8d5fb8ad"),
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
