// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_PATTERN, MAX_CLOCK_SKEW_MS, ValidationError, idsWith, markOf, marksEqual, mergeMarks, mergeSettings, normalizeEmail,
  setMark, validateMarks, validateSettings,
} from '../app/src/lib/marks.js';

const T = Date.UTC(2026, 10, 2, 12, 0); // a fixed "now"
const W = 'w.7231.ai4'; // an item id (爱 ài)
const P = 'travel.greetings.ni-hao'; // a phrase id

/** Deterministic PRNG (mulberry32) for the property tests. */
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random marks over a small id space with few distinct timestamps, so ties and overlaps are common. */
function randomMarks(random) {
  const marks = {};
  for (let i = 0; i < 8; i += 1) {
    if (random() < 0.4) continue;
    marks[`w.${i}`] = { m: [null, 'star', 'skip'][Math.floor(random() * 3)], t: T + Math.floor(random() * 3) };
  }
  return marks;
}

test('setMark sets, replaces and clears; star and skip are exclusive; clearing leaves a tombstone', () => {
  const empty = {};
  const starred = setMark(empty, W, 'star', T);
  assert.deepEqual(empty, {}, 'the input is not mutated');
  assert.deepEqual(starred, { [W]: { m: 'star', t: T } });
  assert.equal(markOf(starred, W), 'star');

  const skipped = setMark(starred, W, 'skip', T + 5);
  assert.equal(markOf(skipped, W), 'skip');
  assert.deepEqual(idsWith(skipped, 'star'), new Set());
  assert.deepEqual(idsWith(skipped, 'skip'), new Set([W]));

  const cleared = setMark(skipped, W, null, T + 9);
  assert.deepEqual(cleared[W], { m: null, t: T + 9 });
  assert.equal(markOf(cleared, W), null);
  assert.deepEqual(idsWith(cleared, null), new Set([W]), 'tombstones are listed with null');
  assert.equal(markOf(setMark({}, P, undefined, T), P), null, 'undefined clears');
});

test('setMark never goes back in time for an id (a click beats an entry from a clock that runs ahead)', () => {
  const fromFastClock = { [W]: { m: 'star', t: T + 60_000 } };
  const next = setMark(fromFastClock, W, null, T);
  assert.deepEqual(next[W], { m: null, t: T + 60_001 });
  assert.deepEqual(mergeMarks(fromFastClock, next)[W], { m: null, t: T + 60_001 }, 'the click survives the next sync');
  assert.equal(setMark({}, W, 'star', T + 0.9)[W].t, T, 'whole milliseconds');
  assert.equal(setMark({}, W, 'star', -5)[W].t, 0);
});

test('setMark rejects invalid ids and marks', () => {
  assert.throws(() => setMark({}, 'Bad Id', 'star', T), TypeError);
  assert.throws(() => setMark({}, '', 'star', T), TypeError);
  assert.throws(() => setMark({}, 42, 'star', T), TypeError);
  assert.throws(() => setMark({}, W, 'favourite', T), TypeError);
  assert.ok(ID_PATTERN.test('w.4f60-597d.ni3hao3'));
  assert.ok(ID_PATTERN.test(P));
});

test('markOf and idsWith ignore inherited and malformed entries', () => {
  const marks = { [W]: { m: 'star', t: T }, 'w.2': { m: 'bogus', t: T }, 'w.3': 'star', 'w.4': { m: 'skip', t: -1 } };
  assert.equal(markOf(marks, 'constructor'), null);
  assert.equal(markOf(marks, 'w.2'), null);
  assert.equal(markOf(marks, 'w.3'), null);
  assert.equal(markOf(marks, 'w.4'), null);
  assert.equal(markOf(null, W), null);
  assert.deepEqual(idsWith(marks, 'star'), new Set([W]));
  assert.deepEqual(idsWith(undefined, 'star'), new Set());
});

test('mergeMarks: last writer wins per id; a newer tombstone beats an older mark', () => {
  const a = { 'w.1': { m: 'star', t: T + 1 }, 'w.2': { m: 'skip', t: T + 5 }, 'w.3': { m: null, t: T + 9 } };
  const b = { 'w.1': { m: 'skip', t: T + 2 }, 'w.2': { m: null, t: T + 4 }, 'w.3': { m: 'star', t: T + 3 }, 'w.4': { m: 'star', t: T } };
  assert.deepEqual(mergeMarks(a, b), {
    'w.1': { m: 'skip', t: T + 2 },
    'w.2': { m: 'skip', t: T + 5 },
    'w.3': { m: null, t: T + 9 },
    'w.4': { m: 'star', t: T },
  });
});

test('mergeMarks ties at equal t: star > skip > cleared, whatever the argument order', () => {
  for (const [x, y, want] of [['star', 'skip', 'star'], ['skip', null, 'skip'], ['star', null, 'star']]) {
    const a = { [W]: { m: x, t: T } };
    const b = { [W]: { m: y, t: T } };
    assert.equal(mergeMarks(a, b)[W].m, want);
    assert.equal(mergeMarks(b, a)[W].m, want);
  }
});

test('mergeMarks drops malformed ids and entries and sorts keys', () => {
  const dirty = {
    'w.b': { m: 'star', t: T, extra: 1 },
    'w.a': { m: 'skip', t: T },
    'Not Valid': { m: 'star', t: T },
    'w.c': { m: 'star', t: 1.5 },
    'w.d': { m: 'nope', t: T },
    'w.e': null,
  };
  const merged = mergeMarks(dirty, null);
  assert.deepEqual(merged, { 'w.a': { m: 'skip', t: T }, 'w.b': { m: 'star', t: T } });
  assert.deepEqual(Object.keys(merged), ['w.a', 'w.b']);
  assert.deepEqual(mergeMarks(undefined, 'x'), {});
});

test('mergeMarks is commutative, associative and idempotent (property test)', () => {
  const random = prng(7);
  for (let round = 0; round < 500; round += 1) {
    const a = randomMarks(random);
    const b = randomMarks(random);
    const c = randomMarks(random);
    const ab = mergeMarks(a, b);
    assert.deepEqual(ab, mergeMarks(b, a), 'commutative');
    assert.deepEqual(mergeMarks(ab, c), mergeMarks(a, mergeMarks(b, c)), 'associative');
    assert.deepEqual(mergeMarks(ab, ab), ab, 'idempotent');
    assert.ok(marksEqual(mergeMarks(ab, a), ab), 'merging a part again changes nothing');
    assert.equal(JSON.stringify(ab), JSON.stringify(mergeMarks(b, a)), 'identical serialisation (sorted keys)');
  }
});

test('marksEqual ignores key order and compares entries', () => {
  const a = { 'w.1': { m: 'star', t: T }, 'w.2': { m: null, t: T } };
  const b = { 'w.2': { m: null, t: T }, 'w.1': { m: 'star', t: T } };
  assert.ok(marksEqual(a, b));
  assert.ok(!marksEqual(a, { ...b, 'w.1': { m: 'star', t: T + 1 } }));
  assert.ok(!marksEqual(a, { 'w.1': { m: 'star', t: T } }));
  assert.ok(marksEqual({}, null));
});

test('mergeSettings: last writer wins as one value, a missing side always loses, ties are order-independent', () => {
  const x = { newPerDay: 10 };
  const y = { newPerDay: 20 };
  assert.deepEqual(mergeSettings(x, T, y, T + 1), { settings: y, t: T + 1 });
  assert.deepEqual(mergeSettings(x, T + 2, y, T + 1), { settings: x, t: T + 2 });
  assert.deepEqual(mergeSettings(null, T + 9, y, T), { settings: y, t: T });
  assert.deepEqual(mergeSettings(null, T, null, T + 3), { settings: null, t: T + 3 });
  assert.deepEqual(mergeSettings(x, T, y, T), mergeSettings(y, T, x, T));
  const merged = mergeSettings(x, T, y, T + 1);
  assert.notEqual(merged.settings, y, 'a copy');
});

test('validateMarks returns a clean copy or throws ValidationError with a code', () => {
  assert.deepEqual(validateMarks({ [W]: { m: 'star', t: T, junk: true } }, { now: T }), { [W]: { m: 'star', t: T } });
  const code = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      return error.code;
    }
    return 'no error';
  };
  assert.equal(code(() => validateMarks([], { now: T })), 'invalid_marks');
  assert.equal(code(() => validateMarks({ 'Bad Id': { m: 'star', t: T } }, { now: T })), 'invalid_marks');
  assert.equal(code(() => validateMarks({ [W]: 'star' }, { now: T })), 'invalid_marks');
  assert.equal(code(() => validateMarks({ [W]: { m: 'like', t: T } }, { now: T })), 'invalid_marks');
  assert.equal(code(() => validateMarks({ [W]: { m: 'star', t: T + MAX_CLOCK_SKEW_MS + 1 } }, { now: T })), 'invalid_marks');
  assert.equal(code(() => validateMarks({ 'w.1': { m: null, t: T }, 'w.2': { m: null, t: T } }, { now: T, maxEntries: 1 })), 'too_many_marks');
});

test('validateSettings checks the flat shape only', () => {
  assert.deepEqual(validateSettings({ newPerDay: 10, autoplay: true, ttsVoice: '', x: null }), { newPerDay: 10, autoplay: true, ttsVoice: '', x: null });
  assert.throws(() => validateSettings({ nested: {} }), ValidationError);
  assert.throws(() => validateSettings({ '1bad': 1 }), ValidationError);
  assert.throws(() => validateSettings({ long: 'x'.repeat(201) }), ValidationError);
  assert.throws(() => validateSettings({ n: Number.NaN }), ValidationError);
  assert.throws(() => validateSettings(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))), ValidationError);
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail('  Learner@Example.COM '), 'learner@example.com');
  for (const bad of ['', 'no-at', '@example.com', 'a@b', 'a@@b.com', 'a@b..com', 'a b@c.com', null, 42, `${'x'.repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});
