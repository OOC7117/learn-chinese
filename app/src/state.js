// The app's state on this device: marks (star / skip), spaced-repetition card states, settings and
// statistics. Every change is saved to localStorage at once (local first); listeners re-render views
// and the sync engine sends the change to the account in the background when signed in.

import { cleanStats, mergeStats, recordAnswer } from './lib/stats.js';
import { cleanSettings, sameSettings } from './lib/settings.js';
import { createScheduler, decodeCard, makeEntry, mergeSrs } from './lib/srs.js';
import { mergeMarks, setMark as setMarkIn } from './lib/marks.js';
import { dayStartOf } from './lib/queue.js';
import { loadSettings, saveSettings } from './lib/storage.js';

export function createState({ store, now = () => Date.now() }) {
  let marks = mergeMarks(store.getJSON('marks'), null);
  let srs = mergeSrs(store.getJSON('srs'), null);
  const loaded = loadSettings(store);
  let settings = cleanSettings(loaded.settings);
  let settingsT = loaded.t;
  let stats = cleanStats(store.getJSON('stats'));
  let scheduler = createScheduler({ retention: settings.retention });
  const listeners = new Set();

  const emit = (what) => {
    for (const fn of listeners) {
      try {
        fn(what);
      } catch (error) {
        console.error('[state] listener failed', error);
      }
    }
  };

  const api = {
    get marks() {
      return marks;
    },
    get srs() {
      return srs;
    },
    get settings() {
      return settings;
    },
    get settingsT() {
      return settingsT;
    },
    get stats() {
      return stats;
    },
    get scheduler() {
      return scheduler;
    },
    dayStart(at = now()) {
      return dayStartOf(at, settings.dayStartHour);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    markOf(id) {
      return marks[id]?.m ?? null;
    },
    /** Star ('star'), skip ('skip') or clear (null) an item's mark. */
    setMark(id, m) {
      marks = setMarkIn(marks, id, m, now());
      store.setJSON('marks', marks);
      emit({ type: 'marks', id });
    },
    toggleMark(id, m) {
      api.setMark(id, api.markOf(id) === m ? null : m);
    },
    /** Mark many items at once (e.g. "I know these"). */
    setMarks(ids, m) {
      let next = marks;
      const t = now();
      for (const id of ids) next = setMarkIn(next, id, m, t);
      marks = next;
      store.setJSON('marks', marks);
      emit({ type: 'marks', ids });
    },

    cardOf(cardId) {
      const entry = Object.hasOwn(srs, cardId) ? srs[cardId] : null;
      return entry ? decodeCard(entry.s) : null;
    },
    /** Answer a card: schedule it, save, count it in today's statistics. `newItem`: this is the first
     * review of the item's first card (counts towards "new words today"). */
    answer(cardId, grade, { ms = 0, newItem = false } = {}) {
      const t = now();
      const previous = Object.hasOwn(srs, cardId) ? srs[cardId] : null;
      const card = previous ? decodeCard(previous.s) : null;
      const next = scheduler.review(card, grade, t);
      srs = { ...srs, [cardId]: makeEntry(next, t, previous) };
      stats = recordAnswer(stats, { dayStart: api.dayStart(t), isNew: newItem && (!card || card.reps === 0), grade, ms });
      store.setJSON('srs', srs);
      store.setJSON('stats', stats);
      emit({ type: 'srs', id: cardId });
      return next;
    },
    /** Forget every card of an item (it becomes new again). */
    resetItem(itemId) {
      const next = {};
      for (const [id, entry] of Object.entries(srs)) if (!id.startsWith(`${itemId}.`)) next[id] = entry;
      srs = next;
      store.setJSON('srs', srs);
      emit({ type: 'srs', id: itemId });
    },

    updateSettings(patch) {
      const next = cleanSettings({ ...settings, ...patch });
      if (sameSettings(next, settings)) return;
      const retentionChanged = next.retention !== settings.retention;
      settings = next;
      settingsT = Math.max(now(), settingsT + 1);
      saveSettings(store, settings, settingsT);
      if (retentionChanged) scheduler = createScheduler({ retention: settings.retention });
      emit({ type: 'settings' });
    },

    /** Merge state from another device or tab (sync). Returns true when something changed here. */
    merge(remote) {
      let changed = false;
      if (remote.marks) {
        const next = mergeMarks(marks, remote.marks);
        if (JSON.stringify(next) !== JSON.stringify(marks)) {
          marks = next;
          store.setJSON('marks', marks);
          changed = true;
        }
      }
      if (remote.srs) {
        const next = mergeSrs(srs, remote.srs);
        if (JSON.stringify(next) !== JSON.stringify(srs)) {
          srs = next;
          store.setJSON('srs', srs);
          changed = true;
        }
      }
      if (remote.stats) {
        const next = mergeStats(stats, remote.stats);
        if (JSON.stringify(next) !== JSON.stringify(stats)) {
          stats = next;
          store.setJSON('stats', stats);
          changed = true;
        }
      }
      if (remote.settings && Number.isSafeInteger(remote.settings_t) && remote.settings_t > settingsT) {
        settings = cleanSettings(remote.settings);
        settingsT = remote.settings_t;
        saveSettings(store, settings, settingsT);
        scheduler = createScheduler({ retention: settings.retention });
        changed = true;
      }
      if (changed) emit({ type: 'merge' });
      return changed;
    },

    /** Re-read everything from storage (another tab changed it). */
    reload() {
      marks = mergeMarks(store.getJSON('marks'), null);
      srs = mergeSrs(store.getJSON('srs'), null);
      const s = loadSettings(store);
      settings = cleanSettings(s.settings);
      settingsT = s.t;
      stats = cleanStats(store.getJSON('stats'));
      scheduler = createScheduler({ retention: settings.retention });
      emit({ type: 'reload' });
    },

    /** Everything this device has, for export (a backup file) and for sync. */
    snapshot() {
      return { marks, srs, settings, settings_t: settingsT, stats };
    },
  };
  return api;
}
