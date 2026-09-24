import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function atomicWrite(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}

// Reuse the engine's existing syncfs transaction boundaries, replacing IndexedDB
// with durable files. Loaded indexes stay in MEMFS; no browser APIs are involved.
export function diskFilesystem(FS, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const hashes = new Map();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  function populate(virtual, disk) {
    for (const entry of fs.readdirSync(disk, { withFileTypes: true })) {
      if (entry.name.includes('.tmp-')) continue;
      const target = `${virtual}/${entry.name}`;
      const source = path.join(disk, entry.name);
      if (entry.isDirectory()) {
        FS.mkdirTree(target);
        populate(target, source);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(source);
        FS.writeFile(target, bytes);
        hashes.set(target, digest(bytes));
      } else {
        throw new Error(`Unsupported filesystem entry: ${source}`);
      }
    }
  }
  function persist(virtual, disk) {
    fs.mkdirSync(disk, { recursive: true });
    const names = FS.readdir(virtual).filter(name => name !== '.' && name !== '..');
    for (const name of names) {
      const source = `${virtual}/${name}`;
      const target = path.join(disk, name);
      const stat = FS.stat(source);
      if (FS.isDir(stat.mode)) persist(source, target);
      else if (FS.isFile(stat.mode)) {
        const bytes = FS.readFile(source);
        const hash = digest(bytes);
        if (hashes.get(source) !== hash || !fs.existsSync(target)) {
          atomicWrite(target, bytes);
          hashes.set(source, hash);
        }
      } else throw new Error(`Unsupported engine filesystem entry: ${source}`);
    }
    for (const name of fs.readdirSync(disk)) {
      if (!names.includes(name)) {
        fs.rmSync(path.join(disk, name), { recursive: true, force: true });
        hashes.delete(`${virtual}/${name}`);
      }
    }
    syncDirectory(disk);
  }
  return {
    mount: mount => FS.filesystems.MEMFS.mount(mount),
    syncfs(mount, restore, callback) {
      try {
        if (restore) populate(mount.mountpoint, directory);
        else persist(mount.mountpoint, directory);
        callback(null);
      } catch (error) { callback(error); }
    },
  };
}
