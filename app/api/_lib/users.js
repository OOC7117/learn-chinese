// User records and card-state buckets, keyed by a SHA-256 hash of the normalised email (never the
// email itself, so key listings and file names carry no address). Namespaced per app ("learn-chinese:"),
// so this app can share the Redis database of the reference project and its accounts service.
//
//   learn-chinese:user:<sha256 hex>        { email, created_at, updated_at, marks, settings, settings_t, stats }
//   learn-chinese:srs:<sha256 hex>:<bucket> { rev, entries: { [cardId]: { s, t, f } } }   bucket "00" … "31"
//
// Times are ms since the epoch. Card states are split over 32 buckets (bucketOf in src/lib/srs.js), so a
// sync reads and writes only the buckets it touches and no single value grows past a few hundred KB.
// `rev` counts the changes of a bucket: the browser says which revs it has merged and gets back only
// buckets that changed since.

import { createHash } from 'node:crypto';

import { knownItemIds, onlyKnown } from './items.js';
import { HttpError } from './http.js';
import { storeFromEnv } from './store.js';
import { normalizeEmail } from '../../src/lib/marks.js';
import { SRS_BUCKETS } from '../../src/lib/srs.js';
import { cleanStats } from '../../src/lib/stats.js';

// Namespaced per app so other apps of the project can share the same Redis database.
export const KEY_PREFIX = 'learn-chinese:user:';
export const SRS_KEY_PREFIX = 'learn-chinese:srs:';
/** "00" … "31", the card-state buckets of one account. */
export const BUCKETS = Object.freeze(Array.from({ length: SRS_BUCKETS }, (_, i) => String(i).padStart(2, '0')));

const isTime = (t) => Number.isSafeInteger(t) && t >= 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Hashing keeps emails out of key listings and file names; the record itself stores the email. */
export function emailHash(email) {
  return createHash('sha256').update(email, 'utf8').digest('hex');
}

export function recordKey(email) {
  return KEY_PREFIX + emailHash(email);
}

/** Key of one card-state bucket ("00" … "31") of an account. */
export function srsKey(email, bucket) {
  return `${SRS_KEY_PREFIX}${emailHash(email)}:${bucket}`;
}

/** The keys of all 32 buckets of an account, in bucket order. */
export function srsKeys(email) {
  const hash = emailHash(email);
  return BUCKETS.map((bucket) => `${SRS_KEY_PREFIX}${hash}:${bucket}`);
}

/** The normalised email from a request body, or a 400. */
export function requireEmail(value) {
  const email = normalizeEmail(value);
  if (!email) throw new HttpError(400, 'invalid_email');
  return email;
}

/** Statistics with their days in date order: equal statistics serialise identically. */
export function sortedStats(stats) {
  const clean = cleanStats(stats);
  const days = {};
  for (const key of Object.keys(clean.days).sort()) days[key] = clean.days[key];
  return { days };
}

export function newRecord(email, now) {
  return { email, created_at: now, updated_at: now, marks: {}, settings: null, settings_t: 0, stats: { days: {} } };
}

/** Fill in anything missing from a stored record (older or hand-edited data), never failing on it. */
export function normalizeRecord(raw, email, now) {
  if (!isObject(raw)) return newRecord(email, now);
  return {
    email,
    created_at: isTime(raw.created_at) ? raw.created_at : now,
    updated_at: isTime(raw.updated_at) ? raw.updated_at : now,
    marks: isObject(raw.marks) ? raw.marks : {},
    settings: isObject(raw.settings) ? raw.settings : null,
    settings_t: isTime(raw.settings_t) ? raw.settings_t : 0,
    stats: sortedStats(raw.stats),
  };
}

/** What the API returns to the browser (card states come separately, per bucket: see api/sync.js). */
export function publicState(record) {
  return {
    marks: record.marks,
    settings: record.settings,
    settings_t: record.settings_t,
    stats: record.stats,
    updated_at: record.updated_at,
  };
}

/** A stored bucket as { rev, entries }, whatever was stored (missing, older or hand-edited data). */
export function normalizeBucket(raw) {
  return {
    rev: isObject(raw) && isTime(raw.rev) ? raw.rev : 0,
    entries: isObject(raw) && isObject(raw.entries) ? raw.entries : {},
  };
}

/**
 * Open the record of a signed-in email, creating it if needed: { created, state }. Create-if-absent, so
 * two first sign-ins (or a sign-in and a sync from another device) cannot overwrite each other.
 */
export async function openRecord(email, store = storeFromEnv(), now = Date.now()) {
  const key = recordKey(email);
  let stored = await store.get(key);
  let created = false;
  if (stored === null) {
    const fresh = newRecord(email, now);
    if (await store.set(key, fresh, { nx: true })) {
      stored = fresh;
      created = true;
    } else {
      stored = await store.get(key);
    }
  }
  const record = normalizeRecord(stored, email, now);
  record.marks = onlyKnown(record.marks, await knownItemIds()); // see _lib/items.js
  return { created, state: publicState(record) };
}
