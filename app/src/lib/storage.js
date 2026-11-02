// localStorage for this device. Every access is in try/catch: storage can be missing, blocked (private
// mode) or full, and the app must keep working without it (everything then lives in memory for the
// visit). Pattern and account handling ported from the reference project (flashcards/src/storage.js).
//
// Keys (namespaced per app, version 1):
//   learn-chinese:v1:marks      { [itemId]: { m: 'star' | 'skip' | null, t } }        see marks.js
//   learn-chinese:v1:srs        { [cardId]: { s: [compact card], t, f } }            see srs.js
//   learn-chinese:v1:settings   { ...settings, t }                                     see settings.js
//   learn-chinese:v1:stats      { days: { 'YYYY-MM-DD': { r, n, a, ms } } }            see stats.js
//   learn-chinese:v1:account    { email, token, expires_at } while signed in; { email } once the session ended
//   learn-chinese:v1:synced     last successful sync, ms since epoch (shared by all tabs)
//   learn-chinese:v1:srs-revs   { [bucket]: rev } of the server's srs buckets this device has merged
//   learn-chinese:v1:tones      tone-trainer statistics (local only)

import { normalizeEmail } from './marks.js';

export const APP = 'learn-chinese';
export const PREFIX = `${APP}:v1:`;
export const NAMES = Object.freeze(['marks', 'srs', 'settings', 'stats', 'account', 'synced', 'srs-revs', 'tones']);
/** Full storage keys, for matching `storage` events from other tabs. */
export const KEYS = Object.freeze(Object.fromEntries(NAMES.map((name) => [name, `${PREFIX}${name}`])));

/** `getBackend` returns a Storage-like object; a function because even reading window.localStorage can
 * throw when storage is blocked. */
export function createStore(getBackend = () => globalThis.localStorage) {
  const backend = () => {
    try {
      return getBackend() ?? null;
    } catch {
      return null;
    }
  };
  const memory = new Map(); // fallback when the backend refuses a write (quota, blocked)
  const store = {
    get(name) {
      try {
        const value = backend()?.getItem(PREFIX + name);
        if (value !== null && value !== undefined) return value;
      } catch {
        // fall through to memory
      }
      return memory.has(name) ? memory.get(name) : null;
    },
    /** Returns true when the value reached real storage (false: kept in memory for this visit only). */
    set(name, value) {
      memory.set(name, value);
      try {
        const target = backend();
        if (!target) return false;
        target.setItem(PREFIX + name, value);
        memory.delete(name);
        return true;
      } catch {
        return false;
      }
    },
    remove(name) {
      memory.delete(name);
      try {
        backend()?.removeItem(PREFIX + name);
        return true;
      } catch {
        return false;
      }
    },
    getJSON(name) {
      return parseJSON(store.get(name));
    },
    setJSON(name, value) {
      return store.set(name, JSON.stringify(value));
    },
    /** Approximate bytes used by this app's keys (UTF-16: 2 bytes per code unit). */
    usage() {
      let total = 0;
      for (const name of NAMES) total += (store.get(name)?.length ?? 0) * 2;
      return total;
    },
  };
  return store;
}

export function parseJSON(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (t) => Number.isSafeInteger(t) && t >= 0;

export const loadObject = (store, name) => {
  const value = store.getJSON(name);
  return isObject(value) ? value : null;
};

// ---- Settings ----

/** { settings, t }: the stored settings (unvalidated; settings.js cleans them) and when the user last
 * changed them (0 = never, so settings synced from another device win). */
export function loadSettings(store) {
  const value = store.getJSON('settings');
  if (!isObject(value)) return { settings: null, t: 0 };
  const { t, ...settings } = value;
  return { settings, t: isTime(t) ? t : 0 };
}

export function saveSettings(store, settings, t) {
  return store.setJSON('settings', { ...settings, t });
}

// ---- Account & sync time (same rules as the reference app) ----

/** A token expiry in ms since epoch: values below 10^11 are seconds, larger ones ms. 0 = unknown. */
export const expiryMs = (t) => (t > 0 && t < 1e11 ? t * 1000 : t);

/** The account of this device, or null. { email, token, expires_at } while signed in; token null when the
 * session ended (401 or expired): the page then shows "Signed out · sign in again" and keeps local data. */
export function loadAccount(store, now = Date.now()) {
  const value = store.getJSON('account');
  const email = isObject(value) ? normalizeEmail(value.email) : null;
  if (!email) return null;
  const token = typeof value.token === 'string' && value.token.length > 0 ? value.token : null;
  const expiresAt = isTime(value.expires_at) ? value.expires_at : 0;
  if (!token || (expiresAt > 0 && expiryMs(expiresAt) <= now)) return { email, token: null, expires_at: 0 };
  return { email, token, expires_at: expiresAt };
}

export function saveAccount(store, { email, token = null, expires_at: expiresAt = 0 }) {
  return store.setJSON('account', token ? { email, token, expires_at: expiresAt } : { email });
}

export function loadSynced(store) {
  const t = Number(store.get('synced'));
  return isTime(t) ? t : 0;
}

export const saveSynced = (store, t) => store.set('synced', String(t));

/** Signing out removes everything this app keeps for the person (shared-device safety). */
export function clearPersonalData(store) {
  for (const name of ['account', 'marks', 'srs', 'settings', 'stats', 'synced', 'srs-revs', 'tones']) store.remove(name);
}
