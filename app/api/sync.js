// POST /api/sync { marks, settings?, settings_t?, stats, srs, srs_revs }
//   -> 200 { state: { marks, settings, settings_t, stats, updated_at }, srs: { buckets: { "07": { rev, entries } }, more? } }
// Header Authorization: Bearer <session token from /api/login or /api/register>. The account's email
// comes from the token (checked with the accounts service, cached briefly; see _lib/accounts.js); an
// `email` in the body is ignored. Missing, invalid or expired token -> 401 unauthorized. A record or a
// card-state bucket is only ever created after an uncached check, so a deleted account's token cannot
// bring it back.
//
// Marks, settings and statistics: full-state sync, as in the reference project. The browser sends its
// whole marks map (tombstones included) and its statistics; the server merges them into the stored
// record (marks per item, last writer wins; settings as one last-writer-wins value; statistics per day
// and counter, the maximum), saves only when something changed, and returns the merged state, which
// the browser merges back. Merging is idempotent and order independent, so a lost request or a race
// between two devices heals itself on the next sync.
//
// Card states (srs) are too many to send in full every time (up to ~50,000 cards), so they sync as
// deltas: `srs` holds only the entries changed since the browser's last successful sync (at most 3,000
// per request; the browser loops while more remain) and `srs_revs` the rev of every bucket it has merged.
// The entries are merged into their buckets (mergeSrs: per card the later review wins; compare-and-set
// per bucket; rev + 1 only when the bucket changed), then the answer carries every bucket whose rev
// differs from the browser's, read in one round trip (getMany): all of them on a first sync. A bucket
// that only changed because of this very request, while the browser had its previous rev, comes back as
// { rev, entries: {} }: the browser has every entry of it already. Over SRS_ANSWER_BYTES of entries the
// rest waits for the next request (`more: true`; the browser asks again at once), which keeps answers
// far below Vercel's 4.5 MB response limit.

import {
  MAX_CLOCK_SKEW_MS, MAX_ENTRIES, ValidationError, marksEqual, mergeMarks, mergeSettings, validateMarks,
} from '../src/lib/marks.js';
import { DAY, bucketOf, mergeSrs, validateSrs } from '../src/lib/srs.js';
import { cleanStats, mergeStats } from '../src/lib/stats.js';
import { authenticate } from './_lib/accounts.js';
import { HttpError, json, methodNotAllowed, postHandler, readJsonBody } from './_lib/http.js';
import { knownItemIds, onlyKnown, onlyKnownCards } from './_lib/items.js';
import { storeFromEnv } from './_lib/store.js';
import {
  BUCKETS, normalizeBucket, normalizeRecord, publicState, recordKey, sortedStats, srsKey, srsKeys,
} from './_lib/users.js';

/** Card states per request; the browser sends more in further requests. */
export const MAX_SRS_PER_REQUEST = 3000;
/** Bucket entries per answer (JSON characters); the rest follows with the next request (`more`). */
export const SRS_ANSWER_BYTES = 2_000_000;
/** Statistics days the server keeps: from this date to two days after today (UTC), see incomingStats. */
export const FIRST_STATS_DAY = '2020-01-01';
const MAX_DAY_COUNT = 100_000; // answers, new items or "again" answers on one day
const MAX_DAY_MS = DAY; // study time on one day
/** Settings are one flat value (as in the reference), but `activeDecks` lists deck ids, so strings may be
 * longer than the reference's 200 characters. */
export const MAX_SETTING_CHARS = 4000;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

const BUCKET_SET = new Set(BUCKETS);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

function checked(validate) {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ValidationError) throw new HttpError(error.code === 'too_many_marks' ? 413 : 400, error.code);
    throw error;
  }
}

/** Clamp timestamps from the future to the allowed skew instead of rejecting the request: one entry
 * made on a device whose clock ran ahead must not make every later sync of that device fail. */
function clampTimes(map, latest, fields) {
  if (!isObject(map)) return;
  for (const entry of Object.values(map)) {
    if (!isObject(entry)) continue;
    for (const field of fields) if (Number.isSafeInteger(entry[field]) && entry[field] > latest) entry[field] = latest;
  }
}

/** The shape check of marks.js validateSettings (at most 32 keys, primitive values), with longer strings. */
function validSettings(value) {
  if (!isObject(value)) throw new HttpError(400, 'invalid_settings');
  const entries = Object.entries(value);
  if (entries.length > 32) throw new HttpError(400, 'invalid_settings');
  const out = {};
  for (const [key, item] of entries) {
    const ok = item === null || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))
      || (typeof item === 'string' && item.length <= MAX_SETTING_CHARS);
    if (!SETTING_KEY.test(key) || !ok) throw new HttpError(400, 'invalid_settings');
    out[key] = item;
  }
  return out;
}

const isRealDay = (key) => {
  const date = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
};

/**
 * Statistics from the browser, cleaned (stats.js cleanStats) and bounded: only real days from
 * FIRST_STATS_DAY to two days after today (UTC; study days are local dates), counters capped. Days out of
 * range are dropped, not refused, so a device with a wrong clock keeps syncing; made-up days cannot grow
 * the record past ~2,500 days.
 */
function incomingStats(raw, now) {
  if (raw === undefined || raw === null) return { days: {} };
  if (!isObject(raw) || (raw.days !== undefined && !isObject(raw.days))) throw new HttpError(400, 'invalid_stats');
  const last = new Date(now + 2 * DAY).toISOString().slice(0, 10);
  const clean = cleanStats(raw);
  const days = {};
  for (const key of Object.keys(clean.days).sort()) {
    if (key < FIRST_STATS_DAY || key > last || !isRealDay(key)) continue;
    const { r, n, a, ms } = clean.days[key];
    days[key] = { r: Math.min(r, MAX_DAY_COUNT), n: Math.min(n, MAX_DAY_COUNT), a: Math.min(a, MAX_DAY_COUNT), ms: Math.min(ms, MAX_DAY_MS) };
  }
  return { days };
}

/** Card states from the browser: at most MAX_SRS_PER_REQUEST valid entries (src/lib/srs.js validateSrs). */
function incomingSrs(raw, now, latest) {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new HttpError(400, 'invalid_srs');
  if (Object.keys(raw).length > MAX_SRS_PER_REQUEST) throw new HttpError(413, 'too_many_srs');
  clampTimes(raw, latest, ['t', 'f']);
  try {
    return validateSrs(raw, { maxEntries: MAX_SRS_PER_REQUEST, now, maxSkewMs: MAX_CLOCK_SKEW_MS });
  } catch {
    throw new HttpError(400, 'invalid_srs');
  }
}

/** { bucket: rev } the browser has merged ("00" … "31" -> integer >= 0). */
function incomingRevs(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new HttpError(400, 'invalid_srs_revs');
  const out = {};
  for (const [bucket, rev] of Object.entries(raw)) {
    if (!BUCKET_SET.has(bucket) || !Number.isSafeInteger(rev) || rev < 0) throw new HttpError(400, 'invalid_srs_revs');
    out[bucket] = rev;
  }
  return out;
}

const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
/** Same card state: review time, first review and compact card. */
const sameEntry = (x, y) => isObject(x) && isObject(y) && x.t === y.t && (x.f ?? 0) === (y.f ?? 0) && sameArray(x.s, y.s);

/** True when both srs maps hold exactly the same entries (key order ignored). */
export function srsEqual(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => sameEntry(a[id], own(b, id)));
}

export const POST = postHandler(async (request) => {
  const auth = await authenticate(request);
  const { email } = auth;
  const body = await readJsonBody(request);
  const now = Date.now();
  const latest = now + MAX_CLOCK_SKEW_MS;

  clampTimes(body.marks, latest, ['t']);
  const ids = await knownItemIds();
  const incoming = onlyKnown(checked(() => validateMarks(body.marks ?? {}, { now })), ids);
  let settings = null;
  let settingsT = 0;
  if (body.settings !== undefined && body.settings !== null) {
    settings = validSettings(body.settings);
    settingsT = Number.isSafeInteger(body.settings_t) ? Math.min(body.settings_t, latest) : body.settings_t;
    if (!Number.isSafeInteger(settingsT) || settingsT < 0) throw new HttpError(400, 'invalid_settings');
  }
  const stats = incomingStats(body.stats, now);
  const srs = onlyKnownCards(incomingSrs(body.srs, now, latest), ids); // unknown card ids are dropped
  const revs = incomingRevs(body.srs_revs);

  const store = storeFromEnv();
  let next;
  // Read, merge, write; update() starts over if another request wrote the record meanwhile.
  await store.update(recordKey(email), async (raw) => {
    const record = normalizeRecord(raw, email, now);
    const stored = onlyKnown(record.marks, ids); // also drops ids stored before this check existed
    const marks = mergeMarks(stored, incoming);
    if (Object.keys(marks).length > MAX_ENTRIES) throw new HttpError(413, 'too_many_marks');
    const merged = mergeSettings(record.settings, record.settings_t, settings, settingsT);
    const mergedStats = sortedStats(mergeStats(record.stats, stats));

    // Pure pulls (nothing new from this device) do not write: keeps the frequent syncs cheap. Nor does
    // a pull for an account without a record: there is nothing to keep. Card states need the record
    // (it anchors the account's data for /api/service), so they create it when it is missing.
    const changed = raw === null
      ? Object.keys(marks).length > 0 || merged.settings !== null || Object.keys(mergedStats.days).length > 0
        || Object.keys(srs).length > 0
      : !marksEqual(marks, record.marks)
        || merged.t !== record.settings_t
        || JSON.stringify(merged.settings) !== JSON.stringify(record.settings)
        || JSON.stringify(mergedStats) !== JSON.stringify(record.stats);
    // No record yet and a cached token check (up to a minute old): the account may just have been
    // deleted (delete-user clears only its own instance's cache), so ask the service again before
    // creating one. A deleted account's token then gets 401 instead of an orphan record.
    if (raw === null && changed && auth.cached) Object.assign(auth, await authenticate(request, process.env, { fresh: true }));
    next = {
      ...record,
      updated_at: changed ? now : record.updated_at,
      marks,
      settings: merged.settings,
      settings_t: merged.t,
      stats: mergedStats,
    };
    return changed ? next : null;
  });

  // Card states, per bucket: merge and write the buckets this request brings entries for (in parallel;
  // each is its own compare-and-set). `ackOnly` = buckets this request moved from the rev the browser
  // had to the next one, with every entry it sent stored as sent: the browser already has all of their
  // entries. (Not when the merge kept something of the stored entry, e.g. an earlier first review `f`:
  // then the browser gets the whole bucket.)
  const byBucket = new Map();
  for (const [id, entry] of Object.entries(srs)) {
    const bucket = bucketOf(id);
    if (!byBucket.has(bucket)) byBucket.set(bucket, {});
    byBucket.get(bucket)[id] = entry;
  }
  const ackOnly = new Map();
  // A missing bucket is created only after an uncached token check too: delete-user (on another
  // instance) may have removed the account's data after the record was read above, and its token may
  // still be cached here. The accounts service deletes the account before it asks the apps to delete
  // their data, so the fresh check answers 401 and no orphan bucket is left. One check per request.
  let recheck = null;
  const freshCheck = () => {
    recheck ??= authenticate(request, process.env, { fresh: true }).then((result) => Object.assign(auth, result));
    return recheck;
  };
  await Promise.all([...byBucket].map(([bucket, entries]) => store.update(srsKey(email, bucket), async (raw) => {
    if (raw === null && auth.cached) await freshCheck();
    const before = normalizeBucket(raw);
    const merged = mergeSrs(onlyKnownCards(before.entries, ids), entries);
    ackOnly.delete(bucket);
    if (raw !== null && srsEqual(merged, before.entries)) return null; // nothing new: no write, same rev
    const exact = Object.entries(entries).every(([id, sent]) => sameEntry(merged[id], sent));
    if (exact && before.rev === (own(revs, bucket) ?? 0)) ackOnly.set(bucket, before.rev + 1);
    return { rev: before.rev + 1, entries: merged };
  })));

  // The answer: every bucket whose rev differs from the browser's (missing buckets have rev 0).
  const values = await store.getMany(srsKeys(email));
  const buckets = {};
  let room = SRS_ANSWER_BYTES;
  let full = 0;
  let more = false;
  BUCKETS.forEach((bucket, i) => {
    const { rev, entries } = normalizeBucket(values[i]);
    if (rev === (own(revs, bucket) ?? 0)) return;
    if (ackOnly.get(bucket) === rev) {
      buckets[bucket] = { rev, entries: {} };
      return;
    }
    const known = onlyKnownCards(entries, ids);
    const size = JSON.stringify(known).length;
    if (full > 0 && size > room) {
      more = true; // sent with the next request: its rev still differs then
      return;
    }
    room -= size;
    full += 1;
    buckets[bucket] = { rev, entries: known };
  });
  return json(200, { state: publicState(next), srs: more ? { buckets, more } : { buckets } });
});

export {
  methodNotAllowed as GET,
  methodNotAllowed as HEAD,
  methodNotAllowed as PUT,
  methodNotAllowed as PATCH,
  methodNotAllowed as DELETE,
  methodNotAllowed as OPTIONS,
};
