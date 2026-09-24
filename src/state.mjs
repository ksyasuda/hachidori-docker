import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './disk.mjs';
import '../.upstream/hachidori/extension/reader-options.js';
import '../.upstream/hachidori/extension/dictionary-group-state.js';
import { normaliseCustomDictionaryDocument, parseCustomDictionary, customDictionarySemanticRevision } from '../.upstream/hachidori/extension/custom-dictionary.js';
import { emptyLookupStats, normaliseLookupTerm, lookupStatsKey, incrementLookupStats } from '../.upstream/hachidori/extension/lookup-stats.js';
import { managedDictionaryMatches, normaliseUpdateSettings } from '../.upstream/hachidori/extension/managed-dictionary-source.js';
import { assertBackupSnapshot } from '../.upstream/hachidori/extension/backup-state.js';
import { ankiIndexConfigurationChange } from '../.upstream/hachidori/extension/anki-index-cache.js';

// Custom page scripts run only in a browser. Everything else, including Anki
// and media capture settings, is shared state this host owns and uses.
const HOST_OWNED_OPTIONS = new Set(['customJavaScript']);

export function createState(directory, changed) {
  const filename = path.join(directory, 'state.json');
  let values = {
    dictionaryState: { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] },
    options: { revision: 0 },
    customDictionarySource: normaliseCustomDictionaryDocument(null),
    dictionaryUpdates: normaliseUpdateSettings(null),
    lookupStats: emptyLookupStats(),
  };
  if (fs.existsSync(filename)) {
    values = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const state = values?.dictionaryState;
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision)
        || state.revision < 0 || !Array.isArray(state.dictionaries) || !Array.isArray(state.groups)
        || !values.options || !values.customDictionarySource || !values.lookupStats) {
      throw new Error('Invalid state.json; restore a backup instead of starting with an empty library.');
    }
  }
  function commit(patch) {
    const next = { ...values, ...patch };
    atomicWrite(filename, JSON.stringify(next));
    values = next;
    changed(patch);
  }
  // Writers that check a revision, await validation, then commit run one at a
  // time, so a commit from another caller cannot land between those steps.
  let chain = Promise.resolve();
  function locked(job) {
    const run = chain.then(job, job);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }
  function dictionaryState(message) {
    if (!Array.isArray(message.dictionaries)) throw new Error('Missing dictionaries');
    return { schemaVersion: 1, revision: values.dictionaryState.revision + 1,
      dictionaries: message.dictionaries,
      groups: globalThis.HDDictionaryGroups.pruneGroupMemberships(message.groups ?? values.dictionaryState.groups, message.dictionaries) };
  }
  function backup(state = values.dictionaryState) {
    return { state, options: values.options, document: values.customDictionarySource,
      updates: normaliseUpdateSettings(values.dictionaryUpdates), lookupStats: values.lookupStats };
  }
  // Shared Settings may change presentation and order, but may not invent paths,
  // replace engine-owned inventory, or bypass the engine's import/removal queues.
  function presentation(message) {
    return locked(async () => {
      if (message.baseRevision !== values.dictionaryState.revision) return conflict();
      const current = values.dictionaryState.dictionaries;
      if (!Array.isArray(message.dictionaries) || message.dictionaries.length !== current.length) throw new Error('Use dictionary import or removal to change the library.');
      const mutable = new Set(['enabled', 'favorite', 'displayName', 'frequencyMode', 'updateScheduleOverride']);
      for (const next of message.dictionaries) {
        const previous = current.find(entry => entry.id === next?.id);
        if (!previous || Object.keys({ ...previous, ...next }).some(key => !mutable.has(key) && JSON.stringify(previous[key]) !== JSON.stringify(next[key]))) {
          throw new Error('Dictionary inventory and paths are owned by the engine.');
        }
      }
      const state = dictionaryState(message);
      await assertBackupSnapshot(backup(state));
      commit({ dictionaryState: state });
      return { ok: true, state };
    });
  }
  function updatePlan() {
    return { dictionaries: values.dictionaryState.dictionaries, settings: normaliseUpdateSettings(values.dictionaryUpdates) };
  }
  // Records a check outcome on a managed dictionary, or returns null when the
  // dictionary changed since the check started.
  function recordUpdateCheck(fingerprint, lastUpdateCheck) {
    return locked(async () => {
      const current = values.dictionaryState.dictionaries;
      const index = current.findIndex(entry => entry?.id === fingerprint.id);
      if (index < 0 || !managedDictionaryMatches(current[index], fingerprint)) return null;
      const dictionaries = [...current];
      dictionaries[index] = { ...current[index], lastUpdateCheck };
      commit({ dictionaryState: dictionaryState({ dictionaries }) });
      return dictionaries[index];
    });
  }
  function writeUpdateSettings(update) {
    return locked(async () => {
      const current = normaliseUpdateSettings(values.dictionaryUpdates);
      const next = update(current);
      if (next === null) return { ok: false, error: 'The update settings changed elsewhere. Review the current schedule before retrying.', settings: current };
      if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, settings: current };
      const settings = { ...next, revision: current.revision + 1 };
      commit({ dictionaryUpdates: settings });
      return { ok: true, settings };
    });
  }
  const conflict = () => ({ ok: false, conflict: true, error: 'Dictionary state changed.', state: values.dictionaryState });
  async function bridge(message) {
    switch (message.type) {
      case 'hd_state_read': return { ok: true, state: values.dictionaryState, legacyDictionaries: null };
      case 'hd_state_cas': return locked(async () => {
        if (message.baseRevision !== values.dictionaryState.revision) return conflict();
        const state = dictionaryState(message);
        commit({ dictionaryState: state });
        return { ok: true, state };
      });
      case 'hd_custom_read': return { ok: true, state: values.dictionaryState, document: values.customDictionarySource };
      case 'hd_custom_cas': return locked(async () => {
        if (message.baseRevision !== values.dictionaryState.revision) return conflict();
        const current = values.customDictionarySource;
        if (message.baseDocumentRevision !== current.revision) return { ok: false, stale: true, error: 'Personal entries changed.', document: current, state: values.dictionaryState };
        const revision = await customDictionarySemanticRevision(parseCustomDictionary(message.text).entries);
        if (revision !== message.semanticRevision) throw new Error('Personal dictionary hash mismatch');
        const document = { schemaVersion: 1, revision: current.revision + 1, text: message.text, semanticRevision: revision };
        const state = message.dictionaries ? dictionaryState(message) : values.dictionaryState;
        commit({ dictionaryState: state, customDictionarySource: document });
        return { ok: true, document, state };
      });
      case 'hd_backup_auto_roots': return { ok: true, complete: true, dictionaries: [] };
      case 'hd_backup_read': return { ok: true, snapshot: backup(),
        lookupStatsRows: Object.entries(values).filter(([key]) => key.startsWith('lookupStats:')).map(([, value]) => value) };
      default: throw new Error(`Unsupported internal storage operation: ${message.type}`);
    }
  }
  // An options write that changes the Anki source invalidates the duplicate
  // index in the same commit, as the extension's storage owner does.
  async function ankiIndexPatch(next) {
    const { normaliseOptions } = globalThis.HDReaderOptions;
    const index = await ankiIndexConfigurationChange(normaliseOptions(values.options), normaliseOptions(next), values.ankiDuplicateIndex);
    return index === undefined ? {} : { ankiDuplicateIndex: index };
  }
  function options(message) {
    return locked(async () => {
      if (message.baseRevision !== values.options.revision) return { ok: false, conflict: true, error: 'Settings changed.', options: values.options };
      if (!message.options || typeof message.options !== 'object' || Array.isArray(message.options)) throw new Error('Missing options');
      if (Object.keys(message.options).some(key => HOST_OWNED_OPTIONS.has(key))) {
        throw new Error('Custom page scripts are not supported on this host.');
      }
      const patch = globalThis.HDReaderOptions.validateOptionsPatch(message.options);
      const options = { ...values.options, ...patch, revision: values.options.revision + 1 };
      commit({ options, ...(await ankiIndexPatch(options)) });
      return { ok: true, options };
    });
  }
  // A Hachidori backup carries the browser's complete reader options. They replace
  // this host's options wholesale, minus the host-owned settings writes also reject.
  function importOptions(imported) {
    return locked(async () => {
      if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw new Error('The backup has no reader settings.');
      const portable = Object.fromEntries(Object.entries(imported)
        .filter(([key]) => key !== 'revision' && key !== 'customLinks' && !HOST_OWNED_OPTIONS.has(key)));
      const options = { ...globalThis.HDReaderOptions.validateOptionsPatch(portable), revision: values.options.revision + 1 };
      commit({ options, ...(await ankiIndexPatch(options)) });
      return options;
    });
  }
  // The duplicate index's revisioned cache state, updated under the write lock.
  function updateAnkiIndex(update) {
    return locked(async () => {
      const state = values.ankiDuplicateIndex;
      const next = await update({ options: globalThis.HDReaderOptions.normaliseOptions(values.options), state });
      if (next !== undefined && JSON.stringify(next) !== JSON.stringify(state)) commit({ ankiDuplicateIndex: next });
      return next ?? state;
    });
  }
  function statistics(message) {
    const term = normaliseLookupTerm(message.term, message.reading);
    let descriptor = values.lookupStats;
    if (values.options.showLookupCounts === false) return { ok: true, descriptor, statistics: null };
    const record = message.type === 'hd_lookup_stats_record';
    if (record && descriptor.generation === null) descriptor = { generation: randomUUID(), revision: descriptor.revision };
    const key = lookupStatsKey(descriptor, term);
    let row = values[key];
    if (record) {
      row = incrementLookupStats(row, term, Date.now());
      descriptor = { ...descriptor, revision: descriptor.revision + 1 };
      commit({ lookupStats: descriptor, [key]: row });
    }
    return { ok: true, descriptor, statistics: row ?? { ...term, lookupCount: 0 } };
  }
  return { snapshot: () => structuredClone(values), bridge, options, importOptions, statistics, presentation,
    updatePlan, recordUpdateCheck, writeUpdateSettings, updateAnkiIndex,
    validate: () => assertBackupSnapshot(backup()) };
}
