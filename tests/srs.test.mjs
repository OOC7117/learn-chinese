// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_ID, DAY, GRADES, MINUTE, SRS_BUCKETS, State, bucketOf, cardId, createScheduler, decodeCard, encodeCard, intervalLabel,
  isEntry, makeEntry, mergeSrs, splitCardId, srsChanges, validateSrs,
} from '../app/src/lib/srs.js';

const T = Date.UTC(2026, 10, 2, 12, 0); // a fixed "now" on a whole minute

/** Deterministic PRNG (mulberry32) for the property tests. */
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A card that has graduated to Review (two "good" answers, the second one when due). */
function reviewCard(scheduler, now = T) {
  let card = scheduler.review(scheduler.newCard(now), 'good', now);
  card = scheduler.review(card, 'good', card.due.getTime());
  assert.equal(card.state, State.Review);
  return card;
}

// ---------- Compact form ----------

test('encodeCard / decodeCard round trip (minutes, 4 decimals, first review kept)', () => {
  const s = createScheduler({ fuzz: false });
  for (const card of [s.newCard(T), s.review(s.newCard(T), 'good', T), reviewCard(s)]) {
    const encoded = encodeCard(card);
    assert.equal(encoded.length, 10);
    assert.equal(encoded[0], 1, 'format version');
    const decoded = decodeCard(encoded);
    assert.equal(decoded.due.getTime(), Math.round(card.due.getTime() / MINUTE) * MINUTE);
    assert.equal(decoded.stability, Math.round(card.stability * 1e4) / 1e4);
    assert.equal(decoded.difficulty, Math.round(card.difficulty * 1e4) / 1e4);
    for (const key of ['reps', 'lapses', 'state', 'learning_steps', 'scheduled_days']) assert.equal(decoded[key], card[key], key);
    assert.equal(decoded.last_review?.getTime(), card.last_review?.getTime());
    assert.deepEqual(encodeCard(decoded), encoded, 'encode(decode(x)) is stable');
  }
  assert.equal(encodeCard(s.newCard(T))[7], 0, 'never reviewed: lastReview 0');
  assert.equal(decodeCard(encodeCard(s.newCard(T))).last_review, undefined);
});

test('a decoded card schedules exactly like the original (learning, review and relearning cards, every grade)', () => {
  const s = createScheduler({ fuzz: false });
  const learningCard = s.review(s.newCard(T), 'good', T);
  const graduated = reviewCard(s);
  const relearningCard = s.review(graduated, 'again', graduated.due.getTime() + 2 * DAY);
  assert.deepEqual([learningCard.state, graduated.state, relearningCard.state], [State.Learning, State.Review, State.Relearning]);
  for (const card of [learningCard, graduated, relearningCard]) {
    const stored = decodeCard(encodeCard(card));
    for (const at of [card.due.getTime(), card.due.getTime() + 3 * DAY + 7 * MINUTE]) {
      for (const grade of GRADES) {
        const direct = s.review(card, grade, at);
        const viaStorage = s.review(stored, grade, at);
        const what = `state ${card.state}, ${grade} at +${(at - card.due.getTime()) / MINUTE}m`;
        assert.equal(viaStorage.due.getTime(), direct.due.getTime(), what);
        for (const key of ['state', 'reps', 'lapses', 'learning_steps', 'scheduled_days']) assert.equal(viaStorage[key], direct[key], `${what}: ${key}`);
        assert.ok(Math.abs(viaStorage.stability - direct.stability) < 1e-3 && Math.abs(viaStorage.difficulty - direct.difficulty) < 1e-3, what);
      }
    }
  }
});

test('decodeCard rejects arrays that are not a valid state', () => {
  const good = encodeCard(reviewCard(createScheduler({ fuzz: false })));
  assert.ok(decodeCard(good));
  const bad = [
    null, undefined, 'x', {}, [], good.slice(0, 9),
    [2, ...good.slice(1)], // unknown version
    good.map((v, i) => (i === 1 ? '29893690' : v)), // string
    good.map((v, i) => (i === 2 ? Number.NaN : v)),
    good.map((v, i) => (i === 3 ? Infinity : v)),
    good.map((v, i) => (i === 4 ? -1 : v)), // reps
    good.map((v, i) => (i === 5 ? -1 : v)), // lapses
    good.map((v, i) => (i === 6 ? 4 : v)), // state
    good.map((v, i) => (i === 6 ? -1 : v)),
    good.map((v, i) => (i === 2 ? -0.5 : v)), // stability
  ];
  for (const arr of bad) assert.equal(decodeCard(arr), null, JSON.stringify(arr));
});

// ---------- Scheduler ----------

test('review advances reps and the due date; New -> Learning -> Review', () => {
  const s = createScheduler({ fuzz: false });
  const fresh = s.newCard(T);
  assert.equal(fresh.state, State.New);
  assert.equal(fresh.reps, 0);
  assert.equal(fresh.due.getTime(), T);
  const once = s.review(fresh, 'good', T);
  assert.equal(once.reps, 1);
  assert.equal(once.state, State.Learning);
  assert.ok(once.due.getTime() > T);
  assert.equal(once.last_review.getTime(), T);
  const twice = s.review(once, 'good', once.due.getTime());
  assert.equal(twice.reps, 2);
  assert.equal(twice.state, State.Review);
  assert.ok(twice.due.getTime() >= once.due.getTime() + DAY, 'a graduated card waits at least a day');
  const lapse = s.review(twice, 'again', twice.due.getTime());
  assert.equal(lapse.state, State.Relearning);
  assert.equal(lapse.lapses, 1);
  assert.equal(s.review(null, 'easy', T).reps, 1, 'null is a new card');
  assert.throws(() => s.review(fresh, 'meh', T), TypeError);
  assert.deepEqual(GRADES, ['again', 'hard', 'good', 'easy']);
});

test('preview: four grades, again <= hard <= good <= easy for review cards (with and without fuzz)', () => {
  for (const fuzz of [false, true]) {
    const s = createScheduler({ fuzz });
    let card = reviewCard(s);
    for (let round = 0; round < 6; round += 1) {
      const now = card.due.getTime() + round * DAY; // on time, then increasingly overdue
      const p = s.preview(card, now);
      assert.deepEqual(Object.keys(p), GRADES);
      const due = GRADES.map((g) => p[g].due.getTime());
      for (let i = 1; i < due.length; i += 1) assert.ok(due[i - 1] <= due[i], `fuzz ${fuzz}, round ${round}: ${GRADES[i - 1]} <= ${GRADES[i]}`);
      assert.ok(due[0] > now);
      assert.equal(p.again.card.state, State.Relearning);
      assert.equal(p.good.card.state, State.Review);
      card = s.review(card, 'good', now);
    }
  }
});

test('preview of a new card and retrievability', () => {
  const s = createScheduler({ fuzz: false });
  const p = s.preview(null, T);
  assert.deepEqual(Object.keys(p), GRADES);
  assert.ok(p.again.due.getTime() <= p.good.due.getTime());
  assert.equal(s.retrievability(null, T), 0);
  assert.equal(s.retrievability(s.newCard(T), T), 0);
  const card = reviewCard(s);
  const r = s.retrievability(card, card.due.getTime());
  assert.ok(r > 0.85 && r < 0.95, `about the desired retention (0.9) when due: ${r}`);
  assert.ok(s.retrievability(card, card.due.getTime() + 60 * DAY) < r, 'recall falls over time');
});

test('createScheduler settings: defaults and overrides', () => {
  assert.equal(createScheduler().settings.retention, 0.9);
  assert.equal(createScheduler({ retention: 0.8 }).settings.retention, 0.8);
  const strict = createScheduler({ fuzz: false, retention: 0.95 });
  const loose = createScheduler({ fuzz: false, retention: 0.8 });
  const a = reviewCard(strict);
  const b = reviewCard(loose);
  assert.ok(strict.review(a, 'good', a.due.getTime()).due < loose.review(b, 'good', b.due.getTime()).due, 'higher retention, shorter intervals');
});

test('intervalLabel', () => {
  const at = (minutes) => intervalLabel(T + minutes * MINUTE, T);
  assert.equal(at(-5), '1m', 'overdue');
  assert.equal(at(0), '1m');
  assert.equal(at(10), '10m');
  assert.equal(at(59), '59m');
  assert.equal(at(60), '1h');
  assert.equal(at(23 * 60), '23h');
  assert.equal(at(24 * 60), '1d');
  assert.equal(at(30 * 1440), '30d');
  assert.equal(at(31 * 1440), '1mo');
  assert.equal(at(364 * 1440), '12mo');
  assert.equal(at(365 * 1440), '1y');
  assert.equal(at(547.5 * 1440), '1.5y');
  assert.equal(at(12 * 365 * 1440), '12y');
  assert.equal(intervalLabel(new Date(T + 3 * DAY), T), '3d', 'accepts a Date');
});

// ---------- Card ids ----------

test('card ids', () => {
  assert.equal(cardId('w.7231.ai4', 'read'), 'w.7231.ai4.read');
  assert.deepEqual(splitCardId('w.7231.ai4.read'), { itemId: 'w.7231.ai4', type: 'read' });
  assert.deepEqual(splitCardId('travel.station.ticket-to.listen'), { itemId: 'travel.station.ticket-to', type: 'listen' });
  assert.ok(CARD_ID.test('w.7231-597d.ai4hao4.speak'));
  assert.ok(!CARD_ID.test('W.7231.read'));
  assert.ok(!CARD_ID.test(''));
});

// ---------- Stored entries, merge, validation ----------

/** Random srs maps over a small id space with few distinct times, so ties and overlaps are common. */
function randomSrs(random) {
  const out = {};
  for (let i = 0; i < 6; i += 1) {
    if (random() < 0.35) continue;
    const pick = (n) => Math.floor(random() * n);
    const t = T + pick(3) * MINUTE;
    const s = [1, Math.round(t / MINUTE) + pick(3) * 1440, 1 + pick(3), 5, pick(3), pick(2), pick(4), Math.round(t / MINUTE), 0, pick(3)];
    const entry = { s, t };
    const f = [undefined, T - DAY, T - 2 * DAY, 0][pick(4)];
    if (f !== undefined) entry.f = f;
    out[`w.${i}.read`] = entry;
  }
  return out;
}

test('mergeSrs is commutative, associative and idempotent (property test)', () => {
  const random = prng(42);
  for (let round = 0; round < 400; round += 1) {
    const a = randomSrs(random);
    const b = randomSrs(random);
    const c = randomSrs(random);
    const ab = mergeSrs(a, b);
    assert.deepEqual(ab, mergeSrs(b, a), 'commutative');
    assert.deepEqual(mergeSrs(ab, c), mergeSrs(a, mergeSrs(b, c)), 'associative');
    assert.deepEqual(mergeSrs(ab, ab), ab, 'idempotent');
    assert.deepEqual(mergeSrs(ab, {}), ab);
    assert.deepEqual(Object.keys(ab), Object.keys(ab).sort(), 'sorted keys');
  }
});

test('mergeSrs: the later review wins, f is the earliest first review seen on any device', () => {
  const s = createScheduler({ fuzz: false });
  const phone = makeEntry(s.review(null, 'good', T), T);
  const laptop = makeEntry(s.review(null, 'again', T + MINUTE), T + MINUTE, { f: T - DAY });
  const merged = mergeSrs({ 'w.1.read': phone }, { 'w.1.read': laptop });
  assert.deepEqual(merged['w.1.read'].s, laptop.s);
  assert.equal(merged['w.1.read'].t, T + MINUTE);
  assert.equal(merged['w.1.read'].f, T - DAY, 'earliest first review, even from the side that lost');
  const reverse = mergeSrs({ 'w.1.read': { ...laptop, f: T } }, { 'w.1.read': { ...phone, f: T - 5 * DAY } });
  assert.equal(reverse['w.1.read'].f, T - 5 * DAY);
  assert.deepEqual(reverse['w.1.read'].s, laptop.s);
});

test('mergeSrs ties: more reps win, then the canonical JSON; malformed ids and entries are dropped', () => {
  const s = createScheduler({ fuzz: false });
  const one = { s: encodeCard(s.review(null, 'good', T)), t: T };
  const two = { s: [...one.s.slice(0, 4), one.s[4] + 1, ...one.s.slice(5)], t: T };
  assert.deepEqual(mergeSrs({ 'w.1.read': one }, { 'w.1.read': two })['w.1.read'].s, two.s);
  assert.deepEqual(mergeSrs({ 'w.1.read': two }, { 'w.1.read': one })['w.1.read'].s, two.s);
  // 10 reps beat 9 although the JSON of 9 sorts higher ("9" > "1"): reps decide before the JSON.
  const nine = { s: [...one.s.slice(0, 4), 9, ...one.s.slice(5)], t: T };
  const ten = { s: [...one.s.slice(0, 4), 10, ...one.s.slice(5)], t: T };
  assert.ok(JSON.stringify(nine.s) > JSON.stringify(ten.s));
  assert.equal(mergeSrs({ 'w.1.read': nine }, { 'w.1.read': ten })['w.1.read'].s[4], 10);
  assert.equal(mergeSrs({ 'w.1.read': ten }, { 'w.1.read': nine })['w.1.read'].s[4], 10);
  const dirty = { 'Bad Id': one, 'w.2.read': { s: [9], t: T }, 'w.3.read': { s: one.s, t: -1 }, 'w.4.read': one, 'w.5.read': null };
  assert.deepEqual(Object.keys(mergeSrs(dirty, null)), ['w.4.read']);
  assert.deepEqual(mergeSrs(null, undefined), {});
});

test('makeEntry keeps the first-review time; isEntry; srsChanges', () => {
  const s = createScheduler({ fuzz: false });
  const first = makeEntry(s.review(null, 'good', T), T);
  assert.equal(first.f, T);
  const later = makeEntry(s.review(decodeCard(first.s), 'good', T + DAY), T + DAY, first);
  assert.equal(later.f, T, 'first review stays');
  assert.equal(later.t, T + DAY);
  assert.ok(isEntry(first));
  assert.ok(!isEntry({ s: first.s, t: 'now' }));
  assert.ok(!isEntry({ s: first.s, t: T, f: -1 }));
  assert.ok(!isEntry([first.s, T]));
  const base = { 'w.1.read': first, 'w.2.read': first };
  const next = { 'w.1.read': first, 'w.2.read': later, 'w.3.read': first };
  assert.deepEqual(srsChanges(base, next), { 'w.2.read': later, 'w.3.read': first });
  assert.deepEqual(srsChanges(null, { 'w.1.read': first }), { 'w.1.read': first });
});

test('validateSrs: clean copy, or an error for anything malformed', () => {
  const s = createScheduler({ fuzz: false });
  const entry = makeEntry(s.review(null, 'good', T), T);
  assert.deepEqual(validateSrs({ 'w.1.read': { ...entry, extra: 1 } }, { now: T }), { 'w.1.read': entry }, 'unknown fields dropped');
  const { f, ...noF } = entry;
  assert.equal(f, T);
  assert.deepEqual(validateSrs({ 'w.1.read': noF }, { now: T }), { 'w.1.read': noF });
  assert.throws(() => validateSrs(null), TypeError);
  assert.throws(() => validateSrs([]), TypeError);
  assert.throws(() => validateSrs({ 'Not An Id': entry }, { now: T }), /invalid card id/);
  assert.throws(() => validateSrs({ 'w.1.read': { s: [1, 2, 3], t: T } }, { now: T }), /invalid srs entry/);
  assert.throws(() => validateSrs({ 'w.1.read': { ...entry, t: T + 2 * DAY } }, { now: T }), RangeError, 'too far in the future');
  assert.doesNotThrow(() => validateSrs({ 'w.1.read': { ...entry, t: T + DAY / 2 } }, { now: T }), 'clock skew within a day is fine');
  assert.throws(() => validateSrs({ 'w.1.read': entry, 'w.2.read': entry }, { now: T, maxEntries: 1 }), RangeError);
});

test('bucketOf: FNV-1a mod 32, stable and in range', () => {
  // Published FNV-1a 32-bit test vectors: "" 0x811c9dc5, "a" 0xe40c292c, "foobar" 0xbf9cf968.
  assert.equal(bucketOf(''), String(0x811c9dc5 % 32).padStart(2, '0'));
  assert.equal(bucketOf('a'), String(0xe40c292c % 32).padStart(2, '0'));
  assert.equal(bucketOf('foobar'), String(0xbf9cf968 % 32).padStart(2, '0'));
  assert.equal(bucketOf('w.7231.ai4.read'), '21', 'the server bucket of a card must never change');
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const id = `w.${i.toString(16)}.x${i % 7}.${['read', 'listen', 'speak', 'cloze'][i % 4]}`;
    const b = bucketOf(id);
    assert.match(b, /^[0-3]\d$/);
    assert.ok(Number(b) < SRS_BUCKETS);
    assert.equal(bucketOf(id), b);
    seen.add(b);
  }
  assert.equal(seen.size, SRS_BUCKETS, 'every bucket is used');
});
