const element = (id) => document.getElementById(id);
const files = element("files");
const choose = element("choose");
const settingsFile = element("settings-file");
const importSettings = element("import-settings");
const settingsHint = element("settings-status").textContent;
const schedule = element("schedule");
const checkUpdates = element("check-updates");
const numbers = new Intl.NumberFormat();
const IDLE_STATUS = "Available to linked clients";
let uploading = false;
let removing = false;
let updating = false;
let refreshing = false;
let updateRevision = null;
let statusNotice = null;
let noticeTimer = null;
let activeUpdateId = null;

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function error(message) {
  element("error").textContent = message;
  element("error").hidden = !message;
}
async function get(route) {
  const response = await fetch(route, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Host returned ${response.status}.`);
  return response.json();
}
// Sends an upstream runtime message and throws on a failed reply.
async function rpc(message, timeout = 5 * 60 * 1000) {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.error || `Host returned ${response.status}.`);
  return result;
}
// Summarises what a dictionary contributes, e.g. "424,715 terms · 250 media".
function contents(dictionary) {
  const parts = [
    [dictionary.termCount, "terms"],
    [dictionary.kanjiCount, "kanji"],
    [dictionary.frequencyCount, "frequencies"],
    [dictionary.pitchCount, "pitch accents"],
    [dictionary.mediaCount, "media"],
  ]
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${numbers.format(count)} ${label}`);
  return parts.length ? parts.join(" · ") : "No indexed entries";
}
function busy() {
  return uploading || removing || updating;
}
function setBusy() {
  const locked = busy();
  choose.disabled = locked;
  importSettings.disabled = locked;
  checkUpdates.disabled = locked;
  schedule.disabled = locked || updateRevision === null;
  element("replace").disabled = locked;
  for (const button of document.querySelectorAll(".remove, .update"))
    button.disabled = locked;
}
// Shows a result line under the library heading for a while, then returns to
// the live import status.
function notice(message) {
  statusNotice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    statusNotice = null;
    void refresh();
  }, 20000);
  element("active").textContent = message;
}
// The badge and row detail shown for a managed dictionary's last update check.
function updateState(dictionary) {
  const check = dictionary.lastUpdateCheck;
  if (!check || dictionary.isUpdatable !== true) return null;
  if (check.status === "update-available")
    return {
      pill: "Update available",
      kind: "newer",
      detail: `Newer revision ${check.remoteRevision}`,
    };
  if (check.status === "check-failed")
    return { pill: "Check failed", kind: "off", detail: check.error };
  return null;
}
function renderLibrary(dictionaries) {
  element("count").textContent = dictionaries.length;
  element("empty").hidden = dictionaries.length > 0;
  element("table-wrap").hidden = dictionaries.length === 0;
  element("dictionaries").replaceChildren(
    ...dictionaries.map((dictionary) => {
      const row = node("tr");
      const title = node("td");
      title.append(node("strong", dictionary.displayName || dictionary.title));
      const update = updateState(dictionary);
      const details = [
        dictionary.displayName && dictionary.displayName !== dictionary.title
          ? dictionary.title
          : null,
        dictionary.revision ? `Revision ${dictionary.revision}` : null,
        update?.detail,
      ].filter(Boolean);
      if (details.length) title.append(node("small", details.join(" · ")));
      const status = node("td", undefined, "status");
      status.append(
        node(
          "span",
          dictionary.enabled === false ? "Disabled" : "Ready",
          `pill ${dictionary.enabled === false ? "off" : "on"}`,
        ),
      );
      if (update) status.append(node("span", update.pill, `pill ${update.kind}`));
      const actions = node("td", undefined, "actions");
      if (update?.kind === "newer" || activeUpdateId === dictionary.id) {
        const button = node(
          "button",
          activeUpdateId === dictionary.id ? "Updating…" : "Update",
          "update",
        );
        button.type = "button";
        button.disabled = busy();
        button.addEventListener("click", () => void installUpdate(dictionary));
        actions.append(button);
      }
      const remove = node("button", "Remove", "remove");
      remove.type = "button";
      remove.disabled = busy();
      remove.addEventListener("click", () => void removeDictionary(dictionary));
      actions.append(remove);
      row.append(title, node("td", contents(dictionary)), status, actions);
      return row;
    }),
  );
}
function formatBytes(bytes) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
// Progress of a running update cycle, whether the page or the schedule started it.
function progressLabel(progress) {
  if (progress.phase === "checking") return `Checking ${progress.title}…`;
  if (progress.phase === "installing") return `Installing ${progress.title}…`;
  const received = formatBytes(progress.receivedBytes);
  return progress.totalBytes
    ? `Downloading ${progress.title}: ${received} of ${formatBytes(progress.totalBytes)}`
    : `Downloading ${progress.title}: ${received}`;
}
function renderActive(active, progress) {
  const bar = element("update-progress");
  if (progress) {
    element("active").textContent = progressLabel(progress);
    bar.hidden = false;
    if (progress.phase === "downloading" && progress.totalBytes)
      bar.value = (progress.receivedBytes / progress.totalBytes) * 100;
    else bar.removeAttribute("value");
    return;
  }
  bar.hidden = true;
  if (statusNotice !== null || updating) return;
  element("active").textContent = active
    ? `${active.phase === "reading" ? "Receiving" : "Importing"} ${active.fileName}…`
    : IDLE_STATUS;
}
function renderSchedule(settings) {
  updateRevision = settings.revision;
  if (document.activeElement !== schedule) schedule.value = settings.schedule;
  schedule.disabled = busy();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [state, imports] = await Promise.all([
      get("/state"),
      get("/imports"),
    ]);
    activeUpdateId = imports.updates?.id ?? null;
    renderLibrary(state.dictionaryState.dictionaries);
    renderSchedule(state.dictionaryUpdates);
    renderActive(imports.active, imports.updates);
    const health = await get("/health");
    element("connection").textContent = health.sharing.connected
      ? "Sharing library"
      : "Ready for dictionaries";
    element("connection").className = "connection online";
  } catch {
    element("connection").textContent = "Host unavailable · reconnecting";
    element("connection").className = "connection offline";
  } finally {
    refreshing = false;
  }
}
// Removal goes through the engine's own hd_remove so its files and the shared
// state are cleaned up together, the same way linked Hachidori Settings does it.
async function removeDictionary(dictionary) {
  if (busy()) return;
  const name = dictionary.displayName || dictionary.title;
  if (!window.confirm(`Remove "${name}" from the library?`)) return;
  removing = true;
  setBusy();
  error("");
  try {
    await rpc({
      target: "hoshidicts-offscreen",
      type: "hd_remove",
      id: dictionary.id,
      title: dictionary.title,
    });
  } catch (failure) {
    error(`${name}: ${failure.message}`);
  } finally {
    removing = false;
    setBusy();
    await refresh();
  }
}
function outcomeSummary(outcomes, installing) {
  const failed = outcomes.filter((outcome) => outcome.error).length;
  if (installing) {
    const updated = outcomes.filter((o) => o.status === "updated").length;
    return `Finished ${outcomes.length} update${outcomes.length === 1 ? "" : "s"}: ${updated} updated, ${failed} failed.`;
  }
  const available = outcomes.filter(
    (o) => o.status === "update-available",
  ).length;
  return `Checked ${outcomes.length} managed dictionar${outcomes.length === 1 ? "y" : "ies"}: ${available} update${available === 1 ? "" : "s"} available, ${failed} failed.`;
}
// Runs an update check or install through the same hachidori-updates messages
// a linked browser sends, then reports the outcomes.
async function runUpdates(type, fields, progress) {
  if (busy()) return;
  updating = true;
  setBusy();
  error("");
  statusNotice = null;
  element("active").textContent = progress;
  // Poll faster while the cycle runs so the download bar moves smoothly.
  const ticker = setInterval(() => void refresh(), 400);
  try {
    const result = await rpc(
      { target: "hachidori-updates", type, ...fields },
      15 * 60 * 1000,
    );
    const outcomes = result.outcomes ?? [];
    notice(outcomeSummary(outcomes, type === "hd_updates_install"));
    const failures = outcomes.filter((outcome) => outcome.error);
    if (failures.length)
      error(failures.map((o) => `${o.id}: ${o.error}`).join("\n"));
  } catch (failure) {
    statusNotice = null;
    error(`Dictionary updates failed: ${failure.message}`);
  } finally {
    clearInterval(ticker);
    updating = false;
    setBusy();
    await refresh();
  }
}
function installUpdate(dictionary) {
  const name = dictionary.displayName || dictionary.title;
  return runUpdates(
    "hd_updates_install",
    { dictionaryIds: [dictionary.id] },
    `Updating ${name}…`,
  );
}
async function saveSchedule() {
  if (busy() || updateRevision === null) return;
  const value = schedule.value;
  updating = true;
  setBusy();
  error("");
  try {
    const result = await rpc({
      target: "hachidori-updates",
      type: "hd_updates_schedule",
      baseRevision: updateRevision,
      schedule: value,
    });
    updateRevision = result.settings.revision;
    notice(
      value === "off"
        ? "Automatic updates are off."
        : `Managed dictionaries update ${value}.`,
    );
  } catch (failure) {
    error(`Schedule: ${failure.message}`);
  } finally {
    updating = false;
    setBusy();
    await refresh();
  }
}
// Applies the reader options from a Hachidori backup ZIP. Only the archive's
// manifest is used; the host keeps its installed dictionaries.
async function uploadSettings(file) {
  if (busy() || !file) return;
  uploading = true;
  setBusy();
  error("");
  const status = element("settings-status");
  status.textContent = `Importing settings from ${file.name}…`;
  try {
    if (!/\.zip$/i.test(file.name))
      throw new Error("Choose a Hachidori backup ZIP.");
    if (file.size > 512 * 1024 * 1024)
      throw new Error("ZIP exceeds the 512 MiB limit.");
    const response = await fetch("/settings/import", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new Error(result.error || `Host returned ${response.status}.`);
    status.textContent = `Settings imported from ${file.name}. Linked clients pick them up automatically.`;
  } catch (failure) {
    status.textContent = settingsHint;
    error(`${file.name}: ${failure.message}`);
  } finally {
    uploading = false;
    setBusy();
    settingsFile.value = "";
    await refresh();
  }
}
function upload(file, replace, prefix) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const url = new URL("/import", window.location.origin);
    url.searchParams.set("name", file.name);
    if (replace) url.searchParams.set("replace", "true");
    request.open("POST", url);
    request.timeout = 15 * 60 * 1000;
    request.setRequestHeader("Content-Type", "application/zip");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        element("progress").value = (event.loaded / event.total) * 100;
    };
    request.upload.onload = () => {
      element("upload-message").textContent =
        `${prefix} Importing ${file.name}…`;
      element("progress").removeAttribute("value");
    };
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText);
        if (
          request.status < 200 ||
          request.status >= 300 ||
          !result.ok ||
          !result.report?.success
        )
          throw new Error(
            result.error || result.report?.error || "Import failed.",
          );
        resolve(result);
      } catch (failure) {
        reject(failure);
      }
    };
    request.onerror = () =>
      reject(new Error("Connection lost. Check the library before retrying."));
    request.ontimeout = () =>
      reject(
        new Error("The request timed out. Check the library before retrying."),
      );
    request.send(file);
  });
}
async function uploadFiles(selected) {
  if (busy() || !selected.length) return;
  uploading = true;
  setBusy();
  const replace = element("replace").checked;
  error("");
  element("upload-status").hidden = false;
  let imported = 0,
    skipped = 0;
  const failures = [];
  try {
    for (const [index, file] of selected.entries()) {
      const prefix = `${index + 1}/${selected.length}`;
      element("upload-message").textContent =
        `${prefix} Uploading ${file.name}…`;
      element("progress").value = 0;
      try {
        if (!/\.zip$/i.test(file.name))
          throw new Error("Choose a .zip dictionary.");
        if (file.size > 512 * 1024 * 1024)
          throw new Error("ZIP exceeds the 512 MiB limit.");
        const result = await upload(file, replace, prefix);
        if (result.skipped) skipped++;
        else imported++;
      } catch (failure) {
        failures.push(`${file.name}: ${failure.message}`);
      }
      await refresh();
    }
    element("upload-message").textContent =
      `Finished. ${imported} imported, ${skipped} skipped, ${failures.length} failed.`;
    element("progress").value = 100;
    if (failures.length) error(failures.join("\n"));
  } finally {
    uploading = false;
    setBusy();
    element("replace").checked = false;
    files.value = "";
  }
}
choose.addEventListener("click", () => files.click());
importSettings.addEventListener("click", () => settingsFile.click());
settingsFile.addEventListener("change", () =>
  void uploadSettings(settingsFile.files[0]),
);
checkUpdates.addEventListener("click", () =>
  void runUpdates("hd_updates_check", {}, "Checking for updates…"),
);
schedule.addEventListener("change", () => void saveSchedule());
files.addEventListener("change", () => void uploadFiles([...files.files]));
const drop = element("drop-zone");
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("dragging");
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("dragging");
  void uploadFiles([...event.dataTransfer.files]);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
window.addEventListener("beforeunload", (event) => {
  if (busy()) event.preventDefault();
});
void refresh();
setInterval(() => void refresh(), 2000);
