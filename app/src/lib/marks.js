// Marks (star / skip), settings and the rules for syncing them between devices.
// Ported unchanged in behaviour from the reference project (Inburgering flashcards, src/marks.js).
// Pure ES module: no DOM, no storage, no network. The browser (src/*.js) and the API (api/*.js) import
// the same file, so both sides always agree on the format and on how conflicts resolve.
// In this app a mark belongs to an item id (an HSK word, a phrase, a kinship term): star = hard
// (practise more), skip = already known (never scheduled, counted as known).
//
// marks = { [cardId]: { m: 'star' | 'skip' | null, t: <ms epoch integer> } }
//   - A card has at most one mark; star and skip are mutually exclusive.
//   - m: null is a tombstone: "this mark was cleared at time t". It is kept so a clear on one device
//     beats an older star/skip still stored on another device.
//   - Conflicts resolve per card, last writer wins (higher t). Merging is commutative, associative and
//     idempotent, so devices can sync in any order, any number of times, and still converge.

export const MARK_VALUES = Object.freeze(['star', 'skip']);
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/;
export const MAX_ENTRIES = 20000; // every HSK 3.0 word (11,092) plus phrases fits
/** How far in the future a timestamp may be (device clocks drift). */
export const MAX_CLOCK_SKEW_MS = 86_400_000;

/** Thrown by the validators. `code` is a stable machine-readable reason (the API returns it). */
export class ValidationError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isMark = (m) => m === null || m === 'star' || m === 'skip';
const isTime = (t) => Number.isSafeInteger(t) && t >= 0;
const isEntry = (entry) => isPlainObject(entry) && isMark(entry.m) && isTime(entry.t);

// Object.hasOwn, not `marks[id]`: ids like "constructor" are valid card ids.
function entryOf(marks, id) {
  return isPlainObject(marks) && Object.hasOwn(marks, id) && isEntry(marks[id]) ? marks[id] : null;
}

/** Tie-break at equal t, so every device picks the same winner: star > skip > cleared. */
function rank(m) {
  return m === 'star' ? 2 : m === 'skip' ? 1 : 0;
}

function beats(x, y) {
  return x.t !== y.t ? x.t > y.t : rank(x.m) > rank(y.m);
}

/** Same entries, keys in sorted order: equal maps serialise identically on every device. */
function sortedMarks(map) {
  const out = {};
  for (const id of Object.keys(map).sort()) out[id] = map[id];
  return out;
}

/**
 * Set (m = 'star' | 'skip') or clear (m = null) one card's mark; returns a new marks object.
 * Setting one mark replaces the other. t is `now`, but never earlier than the entry it replaces
 * (+1 ms): if this device has already seen a newer timestamp from a device whose clock runs ahead,
 * the user's click must still win, not be undone by the next sync.
 */
export function setMark(marks, id, m, now = Date.now()) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError(`setMark: invalid card id ${JSON.stringify(id)}`);
  if (m === undefined) m = null;
  if (!isMark(m)) throw new TypeError(`setMark: invalid mark ${JSON.stringify(m)}`);
  const prev = entryOf(marks, id);
  const time = Math.max(0, Math.floor(now));
  const t = prev ? Math.max(time, prev.t + 1) : time;
  return { ...(isPlainObject(marks) ? marks : {}), [id]: { m, t } };
}

/** 'star' | 'skip' | null for one card. */
export function markOf(marks, id) {
  return entryOf(marks, id)?.m ?? null;
}

/** Ids of all cards with mark `m` ('star' or 'skip'; null gives the tombstones). */
export function idsWith(marks, m) {
  const ids = new Set();
  if (!isPlainObject(marks)) return ids;
  for (const [id, entry] of Object.entries(marks)) if (isEntry(entry) && entry.m === m) ids.add(id);
  return ids;
}

/**
 * Merge two marks maps: per card, the entry with the higher t wins (ties: star > skip > cleared).
 * Malformed ids or entries (e.g. from corrupted storage) are dropped, so the result is always valid.
 * Pure, commutative, associative and idempotent; the result has sorted keys.
 */
export function mergeMarks(a, b) {
  const out = new Map();
  for (const source of [a, b]) {
    if (!isPlainObject(source)) continue;
    for (const [id, entry] of Object.entries(source)) {
      if (!ID_PATTERN.test(id) || !isEntry(entry)) continue;
      const current = out.get(id);
      if (!current || beats(entry, current)) out.set(id, { m: entry.m, t: entry.t });
    }
  }
  return sortedMarks(Object.fromEntries(out));
}

/** True when both maps hold exactly the same entries (key order ignored). */
export function marksEqual(a, b) {
  const keysA = isPlainObject(a) ? Object.keys(a) : [];
  const keysB = isPlainObject(b) ? Object.keys(b) : [];
  if (keysA.length !== keysB.length) return false;
  for (const id of keysA) {
    const x = entryOf(a, id);
    const y = entryOf(b, id);
    if (!x || !y || x.m !== y.m || x.t !== y.t) return false;
  }
  return true;
}

/** JSON with sorted keys, for a deterministic settings tie-break. */
function canonical(value) {
  if (!isPlainObject(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/**
 * Settings sync as one value, last writer wins: returns { settings, t } of the newer side.
 * A side without settings (null) always loses; equal t falls back to comparing the canonical JSON so
 * the result does not depend on argument order.
 */
export function mergeSettings(a, aT, b, bT) {
  const x = { settings: isPlainObject(a) ? a : null, t: isTime(aT) ? aT : 0 };
  const y = { settings: isPlainObject(b) ? b : null, t: isTime(bT) ? bT : 0 };
  let winner;
  if (!x.settings && !y.settings) return { settings: null, t: Math.max(x.t, y.t) };
  if (!x.settings) winner = y;
  else if (!y.settings) winner = x;
  else if (x.t !== y.t) winner = x.t > y.t ? x : y;
  else winner = canonical(x.settings) >= canonical(y.settings) ? x : y;
  return { settings: { ...winner.settings }, t: winner.t };
}

/**
 * Check untrusted marks (an API body, a server response, storage) and return a clean copy with only
 * { m, t } per entry. Throws ValidationError (code 'invalid_marks' or 'too_many_marks').
 */
export function validateMarks(obj, { maxEntries = MAX_ENTRIES, now = Date.now() } = {}) {
  if (!isPlainObject(obj)) throw new ValidationError('marks must be an object', 'invalid_marks');
  const entries = Object.entries(obj);
  if (entries.length > maxEntries) throw new ValidationError(`too many marks (max ${maxEntries})`, 'too_many_marks');
  const latest = now + MAX_CLOCK_SKEW_MS;
  const out = {};
  for (const [id, entry] of entries) {
    const where = JSON.stringify(id.slice(0, 60));
    if (!ID_PATTERN.test(id)) throw new ValidationError(`invalid card id ${where}`, 'invalid_marks');
    if (!isPlainObject(entry)) throw new ValidationError(`mark ${where} must be an object`, 'invalid_marks');
    if (!isMark(entry.m)) throw new ValidationError(`mark ${where}: m must be "star", "skip" or null`, 'invalid_marks');
    if (!isTime(entry.t) || entry.t > latest) throw new ValidationError(`mark ${where}: t must be an integer timestamp, not in the future`, 'invalid_marks');
    out[id] = { m: entry.m, t: entry.t };
  }
  return out;
}

const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/**
 * Settings are stored as an opaque flat object (the browser decides what it means and drops what it
 * does not know), so the server only checks the shape: at most 32 keys, primitive values, strings of
 * at most 200 characters. Throws ValidationError (code 'invalid_settings').
 */
export function validateSettings(obj) {
  if (!isPlainObject(obj)) throw new ValidationError('settings must be an object', 'invalid_settings');
  const entries = Object.entries(obj);
  if (entries.length > 32) throw new ValidationError('too many settings', 'invalid_settings');
  const out = {};
  for (const [key, value] of entries) {
    const ok = value === null || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 200);
    if (!SETTING_KEY.test(key) || !ok) throw new ValidationError(`invalid setting ${JSON.stringify(key.slice(0, 64))}`, 'invalid_settings');
    out[key] = value;
  }
  return out;
}

/**
 * Trimmed, lower-cased email, or null when it does not look like one. Deliberately simple (there is no
 * verification yet): one @, something before it, a dotted domain without empty labels, no spaces or
 * control characters, at most 254 characters.
 */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().normalize('NFC').toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  const labels = email.slice(at + 1).split('.');
  if (labels.length < 2 || labels.some((label) => label === '')) return null;
  return email;
}
