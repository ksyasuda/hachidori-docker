import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

// Both entry points share one slot, including the time spent receiving a ZIP.
export function createImports({ directory, ready, dispatch }) {
  let active = null;
  let scanning = false;
  let closed = false;
  let directoryError = null;
  let lastScan = null;
  const recent = [];
  const files = new Map();
  const fingerprint = (stat) =>
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

  async function run(fileName, source, read, replace = false) {
    if (active)
      throw new Error(
        "Another import is in progress. Try again when it finishes.",
      );
    if (closed || !ready()) throw new Error("Dictionary engine is not ready.");
    active = {
      fileName,
      source,
      phase: "reading",
      startedAt: new Date().toISOString(),
    };
    let entry;
    try {
      const bytes = await read();
      if (bytes.length > MAX_IMPORT_BYTES)
        throw new Error("ZIP exceeds the 512 MiB limit.");
      active.phase = "importing";
      const result = await dispatch({
        type: "host_import",
        fileName,
        bytes,
        skipExisting: !replace,
      });
      const success = result.ok && result.report?.success;
      entry = {
        ...active,
        status: success ? (result.skipped ? "skipped" : "imported") : "failed",
        title: result.report?.title,
        detail:
          result.reason ??
          result.error ??
          result.report?.error ??
          (success ? "" : JSON.stringify(result.report)),
      };
      return result;
    } catch (error) {
      entry = { ...active, status: "failed", detail: error.message };
      throw error;
    } finally {
      recent.unshift({ ...entry, finishedAt: new Date().toISOString() });
      recent.splice(40);
      active = null;
    }
  }

  async function scan() {
    if (!directory || closed || scanning || !ready()) return;
    scanning = true;
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      directoryError = null;
      const names = new Set(
        entries
          .filter((entry) => entry.isFile() && /\.zip$/i.test(entry.name))
          .map((entry) => entry.name),
      );
      files.clear();
      // Take one inventory, then give every candidate the same settling window.
      // Files added after this point wait for the next startup or manual scan.
      for (const fileName of [...names].sort()) {
        try {
          const stat = await fs.lstat(path.join(directory, fileName));
          if (!stat.isFile()) continue;
          files.set(fileName, {
            fileName,
            fingerprint: fingerprint(stat),
            status: "waiting",
            detail: "Checking that the file has finished copying.",
          });
        } catch (error) {
          files.set(fileName, {
            fileName,
            status: "failed",
            detail: error.message,
          });
        }
      }
      if (files.size) await sleep(2000);
      for (const fileName of [...names].sort()) {
        if (closed) break;
        const record = files.get(fileName);
        if (!record || record.status === "failed") continue;
        const filename = path.join(directory, fileName);
        try {
          const stat = await fs.lstat(filename);
          const key = fingerprint(stat);
          if (!stat.isFile() || record.fingerprint !== key)
            throw new Error(
              "File changed during the scan. Scan again after copying finishes.",
            );
          const result = await run(fileName, "folder", async () => {
            if (stat.size > MAX_IMPORT_BYTES)
              throw new Error("ZIP exceeds the 512 MiB limit.");
            const handle = await fs.open(
              filename,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const before = await handle.stat();
              if (!before.isFile() || fingerprint(before) !== key)
                throw new Error("File changed while preparing import.");
              // Read a bounded snapshot, even if another process is still growing the file.
              const chunks = [];
              let size = 0;
              for await (const chunk of handle.createReadStream({
                autoClose: false,
              })) {
                size += chunk.length;
                if (size > MAX_IMPORT_BYTES)
                  throw new Error("ZIP exceeds the 512 MiB limit.");
                chunks.push(chunk);
              }
              if (
                fingerprint(await handle.stat()) !== key ||
                fingerprint(await fs.lstat(filename)) !== key
              )
                throw new Error(
                  "File changed while reading. Scan again after copying finishes.",
                );
              return Buffer.concat(chunks);
            } finally {
              await handle.close();
            }
          });
          record.status =
            result.ok && result.report?.success
              ? result.skipped
                ? "skipped"
                : "imported"
              : "failed";
          record.detail =
            result.reason ?? result.error ?? result.report?.error ?? "";
        } catch (error) {
          const record = files.get(fileName) ?? { fileName };
          Object.assign(record, {
            status: "failed",
            detail: error.message,
          });
          files.set(fileName, record);
        }
      }
      lastScan = new Date().toISOString();
    } catch (error) {
      directoryError = error.message;
    } finally {
      scanning = false;
    }
  }

  return {
    run,
    scan,
    busy: () => active !== null,
    start() {
      void scan();
    },
    close() {
      closed = true;
    },
    status: () => ({
      active,
      recent,
      folder: {
        enabled: Boolean(directory),
        directory,
        automatic: "startup",
        scanning,
        lastScan,
        error: directoryError,
        files: [...files.values()].map(({ fileName, status, detail }) => ({
          fileName,
          status,
          detail,
        })),
      },
    }),
  };
}
