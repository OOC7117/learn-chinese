// Spaced repetition: a thin wrapper around ts-fsrs (FSRS-6, vendored in ../vendor/ts-fsrs.mjs).
// Pure ES module (no DOM, no storage), shared by the browser and the tests.
//
// Card states are stored and synced in a compact form (see encodeCard): an array of numbers, with times in
// whole minutes since the epoch. One review state per card id ("<item id>.<card type>").
//
// Sync merge (mergeSrs): per card, the entry with the later review time `t` wins; ties go to more reps,
// then to the canonical JSON. Commutative, associative and idempotent, so devices converge in any order.

import { fsrs, generatorParameters, createEmptyCard, Rating, State } from '../vendor/ts-fsrs.mjs';

export { Rating, State };

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const GRADES = Object.freeze(['again', 'hard', 'good', 'easy']);
const RATING_OF = Object.freeze({ again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy });

/** Default scheduler settings. Desired retention 0.9 is the FSRS default (see docs/RESEARCH.md). */
export const DEFAULT_SRS = Object.freeze({
  retention: 0.9,
  maximumInterval: 36500,
  fuzz: true,
  learningSteps: Object.freeze(['1m', '10m']),
  relearningSteps: Object.freeze(['10m']),
});

/** Card ids: "<item id>.<type>", e.g. "w.7231.ai4.read". Same alphabet as marks.js ids. */
export const CARD_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
export const CARD_TYPES = Object.freeze(['read', 'listen', 'speak', 'cloze']);

export function cardId(itemId, type) {
  return `${itemId}.${type}`;
}

/** { itemId, type } from a card id. */
export function splitCardId(id) {
  const at = id.lastIndexOf('.');
  return { itemId: id.slice(0, at), type: id.slice(at + 1) };
}

const toMinutes = (date) => Math.round(new Date(date).getTime() / MINUTE);
const fromMinutes = (m) => new Date(m * MINUTE);
const round4 = (x) => Math.round(x * 10_000) / 10_000;

/**
 * Compact form: [1, due, stability, difficulty, reps, lapses, state, lastReview, learningSteps, scheduledDays]
 * (version 1; times in minutes since the epoch; lastReview 0 = never).
 */
export function encodeCard(card) {
  return [
    1,
    toMinutes(card.due),
    round4(card.stability),
    round4(card.difficulty),
    card.reps,
    card.lapses,
    card.state,
    card.last_review ? toMinutes(card.last_review) : 0,
    card.learning_steps ?? 0,
    card.scheduled_days ?? 0,
  ];
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** A ts-fsrs card from the compact form, or null when the array is not a valid state. */
export function decodeCard(arr) {
  if (!Array.isArray(arr) || arr[0] !== 1 || arr.length < 10) return null;
  const [, due, stability, difficulty, reps, lapses, state, last, steps, scheduled] = arr;
  if (![due, stability, difficulty, reps, lapses, state, last, steps, scheduled].every(isNum)) return null;
  if (state < 0 || state > 3 || reps < 0 || lapses < 0 || stability < 0) return null;
  return {
    due: fromMinutes(due),
    stability,
    difficulty,
    elapsed_days: 0,
    scheduled_days: scheduled,
    learning_steps: steps,
    reps,
    lapses,
    state,
    last_review: last > 0 ? fromMinutes(last) : undefined,
  };
}

/** A scheduler with the given settings. */
export function createScheduler(options = {}) {
  const cfg = { ...DEFAULT_SRS, ...options };
  const engine = fsrs(generatorParameters({
    request_retention: cfg.retention,
    maximum_interval: cfg.maximumInterval,
    enable_fuzz: cfg.fuzz,
    enable_short_term: true,
    learning_steps: [...cfg.learningSteps],
    relearning_steps: [...cfg.relearningSteps],
  }));
  return {
    settings: cfg,
    /** A fresh card (never reviewed), due now. */
    newCard(now = Date.now()) {
      return createEmptyCard(new Date(now));
    },
    /** The card after answering `grade` ('again' | 'hard' | 'good' | 'easy') at `now`. */
    review(card, grade, now = Date.now()) {
      const rating = RATING_OF[grade];
      if (!rating) throw new TypeError(`unknown grade ${JSON.stringify(grade)}`);
      return engine.next(card ?? createEmptyCard(new Date(now)), new Date(now), rating).card;
    },
    /** What each grade would do: { again: { due, card }, hard, good, easy } (for the button labels). */
    preview(card, now = Date.now()) {
      const result = engine.repeat(card ?? createEmptyCard(new Date(now)), new Date(now));
      const out = {};
      for (const grade of GRADES) out[grade] = { due: result[RATING_OF[grade]].card.due, card: result[RATING_OF[grade]].card };
      return out;
    },
    /** Probability (0-1) of recalling the card now. 0 for new cards. */
    retrievability(card, now = Date.now()) {
      if (!card || card.state === State.New) return 0;
      return engine.get_retrievability(card, new Date(now), false);
    },
  };
}

/** "10m", "1h", "3d", "2mo", "1.2y": a short label for the time from `now` until `due`. */
export function intervalLabel(due, now = Date.now()) {
  const ms = Math.max(0, new Date(due).getTime() - now);
  const minutes = ms / MINUTE;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 31) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30.4)}mo`;
  const years = days / 365;
  return `${years < 10 ? Math.round(years * 10) / 10 : Math.round(years)}y`;
}

// ---------- Stored entries and sync merge ----------
//
// srs = { [cardId]: { s: <compact card>, t: <ms of the review that produced it>, f: <ms of the card's first
//         review> } }    f is kept as the earliest value seen on any device.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isTime = (t) => Number.isSafeInteger(t) && t >= 0;

export function isEntry(entry) {
  return isPlainObject(entry) && isTime(entry.t) && (entry.f === undefined || isTime(entry.f)) && decodeCard(entry.s) !== null;
}

/** A stored entry for a card just reviewed at `now` (keeps the first-review time of `previous`). */
export function makeEntry(card, now, previous = null) {
  const f = previous && isTime(previous.f) && previous.f > 0 ? previous.f : now;
  return { s: encodeCard(card), t: now, f };
}

const earliest = (a, b) => {
  const xs = [a, b].filter((v) => isTime(v) && v > 0);
  return xs.length ? Math.min(...xs) : undefined;
};

function beats(x, y) {
  if (x.t !== y.t) return x.t > y.t;
  if (x.s[4] !== y.s[4]) return x.s[4] > y.s[4]; // reps
  return JSON.stringify(x.s) > JSON.stringify(y.s);
}

/** Merge two srs maps (per card: later review wins). Drops malformed ids and entries. Sorted keys. */
export function mergeSrs(a, b) {
  const out = new Map();
  for (const source of [a, b]) {
    if (!isPlainObject(source)) continue;
    for (const [id, entry] of Object.entries(source)) {
      if (!CARD_ID.test(id) || !isEntry(entry)) continue;
      const current = out.get(id);
      const f = earliest(entry.f, current?.f);
      if (!current || beats(entry, current)) out.set(id, { s: [...entry.s], t: entry.t, ...(f ? { f } : {}) });
      else if (f && f !== current.f) out.set(id, { ...current, f });
    }
  }
  const sorted = {};
  for (const id of [...out.keys()].sort()) sorted[id] = out.get(id);
  return sorted;
}

/** Entries of `next` that differ from `base` (what changed since a known state). */
export function srsChanges(base, next) {
  const out = {};
  for (const [id, entry] of Object.entries(next ?? {})) {
    const was = base && Object.hasOwn(base, id) ? base[id] : null;
    if (!was || was.t !== entry.t || was.f !== entry.f || JSON.stringify(was.s) !== JSON.stringify(entry.s)) out[id] = entry;
  }
  return out;
}

/** Validate an untrusted srs map (API body, server answer). Throws on anything malformed. */
export function validateSrs(obj, { maxEntries = 60_000, now = Date.now(), maxSkewMs = DAY } = {}) {
  if (!isPlainObject(obj)) throw new TypeError('srs must be an object');
  const entries = Object.entries(obj);
  if (entries.length > maxEntries) throw new RangeError(`too many srs entries (max ${maxEntries})`);
  const out = {};
  for (const [id, entry] of entries) {
    if (!CARD_ID.test(id)) throw new TypeError(`invalid card id ${JSON.stringify(id.slice(0, 60))}`);
    if (!isEntry(entry)) throw new TypeError(`invalid srs entry for ${JSON.stringify(id.slice(0, 60))}`);
    if (entry.t > now + maxSkewMs) throw new RangeError(`srs entry ${JSON.stringify(id.slice(0, 60))} is in the future`);
    out[id] = { s: [...entry.s], t: entry.t, ...(entry.f ? { f: entry.f } : {}) };
  }
  return out;
}

/** The 32 sync buckets a card id falls into (FNV-1a of the id, mod 32), as a two-character key. */
export const SRS_BUCKETS = 32;
export function bucketOf(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(h % SRS_BUCKETS).padStart(2, '0');
}
