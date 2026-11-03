// Run: node --test tests   (or `npm test` from the repository root)
// Times are built in local time (new Date(y, m, d, h)), so the 04:00 day boundary holds in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUEUE, buildQueue, cardIdsOfItem, classify, dayKey, dayStartOf, deckProgress, interleave, pick,
} from '../app/src/lib/queue.js';
import { DAY, MINUTE, State } from '../app/src/lib/srs.js';

const HOUR = 60 * MINUTE;
/** Local time; month 1-12. */
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 2, 12); // noon
const TODAY = at(2026, 11, 2, 4); // start of the study day
const TOMORROW_NOON = at(2026, 11, 3, 12);
const toMin = (t) => Math.round(t / MINUTE);

/** A stored srs entry: compact card [1, due, stability, difficulty, reps, lapses, state, lastReview, steps, scheduled]. */
function entry({ state, due, last, first = last, stability = 10, reps = 3 }) {
  return { s: [1, toMin(due), stability, 5, reps, 0, state, toMin(last), state === State.Learning ? 1 : 0, 0], t: last, f: first };
}
const review = (due, last, opts = {}) => entry({ state: State.Review, due, last, ...opts });
const learning = (due, last, opts = {}) => entry({ state: State.Learning, due, last, reps: 1, stability: 2, ...opts });
const relearning = (due, last, opts = {}) => entry({ state: State.Relearning, due, last, reps: 5, stability: 2, ...opts });

const TYPES = ['listen', 'speak', 'read'];
const items = (...ids) => ids.map((id) => ({ id, types: TYPES }));
/** Items with a single card type (no sibling unlocks), for tests about order and limits. */
const single = (...ids) => ids.map((id) => ({ id, types: ['listen'] }));
const ids = (list) => list.map((x) => x.id);

/** Run `fn` with process.env.TZ set (synchronously), then restore it. */
function withTimeZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

// ---------- Study days ----------

test('dayStartOf: a study day runs from 04:00 to 04:00 local time', () => {
  assert.equal(dayStartOf(at(2026, 11, 2, 3, 59)), at(2026, 11, 1, 4), 'before 4 am: still yesterday');
  assert.equal(dayStartOf(at(2026, 11, 2, 4, 0)), at(2026, 11, 2, 4), 'at 4 am: a new day');
  assert.equal(dayStartOf(at(2026, 11, 2, 23, 59)), at(2026, 11, 2, 4));
  assert.equal(dayStartOf(at(2026, 1, 1, 2)), at(2025, 12, 31, 4), 'across a year boundary');
  assert.equal(dayStartOf(at(2026, 3, 1, 1)), at(2026, 2, 28, 4), 'across a month boundary');
  assert.equal(dayStartOf(at(2026, 11, 2, 0, 30), 0), at(2026, 11, 2, 0), 'other start hours');
  assert.equal(dayStartOf(at(2026, 11, 2, 5, 59), 6), at(2026, 11, 1, 6));
  assert.equal(DEFAULT_QUEUE.dayStartHour, 4);
  assert.equal(dayKey(at(2026, 11, 1, 4)), '2026-11-01');
  assert.equal(dayKey(dayStartOf(at(2026, 11, 2, 3))), '2026-11-01');
});

test('dayStartOf across daylight-saving changes (Europe/Amsterdam)', () => {
  withTimeZone('Europe/Amsterdam', () => {
    // 2026-03-29: clocks go 02:00 -> 03:00. 2026-10-25: clocks go 03:00 -> 02:00.
    assert.equal(dayStartOf(at(2026, 3, 29, 3, 30)), at(2026, 3, 28, 4));
    assert.equal(dayStartOf(at(2026, 3, 29, 4, 0)), at(2026, 3, 29, 4));
    assert.equal(dayStartOf(at(2026, 10, 25, 3, 30)), at(2026, 10, 24, 4));
    assert.equal(dayStartOf(at(2026, 10, 25, 4, 0)), at(2026, 10, 25, 4));
    assert.equal(new Date(dayStartOf(at(2026, 3, 29, 12))).getHours(), 4);
    assert.equal(dayKey(dayStartOf(at(2026, 3, 29, 3, 30))), '2026-03-28');
  });
});

// ---------- New items ----------

test('newPerDay counts items, not cards: a new item starts with its first card type only', () => {
  const list = items('a', 'b', 'c', 'd');
  const fresh = buildQueue({ items: list, now: NOW, settings: { newPerDay: 2 } });
  assert.deepEqual(ids(fresh.queue), ['a.listen', 'b.listen']);
  assert.deepEqual(fresh.queue.map((x) => x.kind), ['new', 'new']);
  assert.deepEqual(fresh.counts, { learning: 0, review: 0, new: 2 });
  assert.equal(fresh.newLeft, 2);

  // a was introduced today (its first card is in its learning steps): one new item left.
  const srs = { 'a.listen': learning(NOW + 10 * MINUTE, NOW - 5 * MINUTE) };
  const after = buildQueue({ items: list, srs, now: NOW, settings: { newPerDay: 2 } });
  assert.equal(after.newLeft, 1);
  assert.deepEqual(ids(after.queue), ['b.listen'], 'a.speak is not offered on the day a.listen was introduced');
  assert.deepEqual(ids(after.waiting), ['a.listen'], 'the learning card waits until it is due');
  assert.equal(after.nextDue, NOW + 10 * MINUTE);

  const done = buildQueue({ items: list, srs: { ...srs, 'b.listen': learning(NOW + 10 * MINUTE, NOW - MINUTE) }, now: NOW, settings: { newPerDay: 2 } });
  assert.equal(done.newLeft, 0);
  assert.equal(done.counts.new, 0);
});

test('the next card type unlocks only the day after the previous type was first reviewed', () => {
  const list = items('a');
  // a.listen first reviewed today and already graduated (due in 3 days).
  const srs = { 'a.listen': review(NOW + 3 * DAY, NOW - HOUR, { first: NOW - HOUR }) };
  assert.deepEqual(ids(buildQueue({ items: list, srs, now: NOW }).queue), [], 'not today');
  const tomorrow = buildQueue({ items: list, srs, now: TOMORROW_NOON, settings: { newPerDay: 0 } });
  assert.deepEqual(ids(tomorrow.queue), ['a.speak'], 'tomorrow, and it does not use the new-items allowance');
  assert.equal(tomorrow.queue[0].kind, 'new');
  assert.equal(tomorrow.queue[0].type, 'speak');

  // speak first reviewed tomorrow -> read unlocks the day after.
  const srs2 = { ...srs, 'a.speak': review(TOMORROW_NOON + 3 * DAY, TOMORROW_NOON, { first: TOMORROW_NOON }) };
  assert.deepEqual(ids(buildQueue({ items: list, srs: srs2, now: TOMORROW_NOON + HOUR }).queue), []);
  assert.deepEqual(ids(buildQueue({ items: list, srs: srs2, now: TOMORROW_NOON + DAY }).queue), ['a.read']);

  // The 04:00 boundary, not 24 hours: first reviewed at 23:00, unlocked at 04:00.
  const late = { 'a.listen': review(NOW + 3 * DAY, at(2026, 11, 2, 23), { first: at(2026, 11, 2, 23) }) };
  assert.deepEqual(ids(buildQueue({ items: list, srs: late, now: at(2026, 11, 3, 3, 59) }).queue), []);
  assert.deepEqual(ids(buildQueue({ items: list, srs: late, now: at(2026, 11, 3, 4, 1) }).queue), ['a.speak']);
});

test('an item started without its first card type (enabled later in settings) still unlocks its other types', () => {
  // Studied while "listen" was switched off: speak was the first type. Then listen is switched on again.
  const srs = { 'a.speak': review(NOW + 5 * DAY, NOW - 10 * DAY, { first: NOW - 30 * DAY }) };
  assert.deepEqual(ids(buildQueue({ items: [{ id: 'a', types: ['speak', 'read'] }], srs, now: NOW }).queue), ['a.read']);
  assert.deepEqual(ids(buildQueue({ items: items('a'), srs, now: NOW }).queue), ['a.listen']);
  // listen first reviewed today: read waits for tomorrow.
  const srs2 = { ...srs, 'a.listen': review(NOW + 5 * DAY, NOW - HOUR, { first: NOW - HOUR }) };
  assert.deepEqual(ids(buildQueue({ items: items('a'), srs: srs2, now: NOW }).queue), []);
  assert.deepEqual(ids(buildQueue({ items: items('a'), srs: srs2, now: TOMORROW_NOON }).queue), ['a.read']);
  // a is not a new item: its listen card does not use up the new-items allowance.
  assert.deepEqual([...classify({ items: items('a'), srs: srs2, now: NOW }).introducedToday], []);
  const withNew = buildQueue({ items: items('a', 'b', 'c'), srs: srs2, now: NOW, settings: { newPerDay: 2 } });
  assert.equal(withNew.newLeft, 2);
  assert.deepEqual(ids(withNew.queue), ['b.listen', 'c.listen']);
});

test('an item introduced today with a later card type (the first one switched off) counts as new today', () => {
  // Listen was off: a started with speak today. Listen is switched on again the same day.
  const srs = { 'a.speak': learning(NOW + 10 * MINUTE, NOW - 5 * MINUTE, { first: NOW - 5 * MINUTE }) };
  const c = classify({ items: items('a', 'b', 'c'), srs, now: NOW });
  assert.deepEqual([...c.introducedToday], ['a']);
  assert.deepEqual(ids(c.siblings), [], 'listen waits for tomorrow');
  const q = buildQueue({ items: items('a', 'b', 'c'), srs, now: NOW, settings: { newPerDay: 2 } });
  assert.equal(q.newLeft, 1);
  assert.deepEqual(ids(q.queue), ['b.listen']);
});

test('siblingPerDay limits the unlocked card types per day', () => {
  const list = items('a', 'b', 'c');
  const srs = {};
  for (const id of ['a', 'b', 'c']) srs[`${id}.listen`] = review(NOW + 5 * DAY, NOW - 2 * DAY);
  const q = buildQueue({ items: list, srs, now: NOW, settings: { siblingPerDay: 2 } });
  assert.deepEqual(ids(q.queue), ['a.speak', 'b.speak']);
});

// ---------- Siblings, skips, order ----------

test('siblings of an item studied today are buried until tomorrow', () => {
  const list = items('a', 'b');
  const srs = {
    'a.listen': review(NOW + 5 * DAY, NOW - 2 * HOUR, { first: NOW - 20 * DAY }), // answered today
    'a.speak': review(NOW - HOUR, NOW - 10 * DAY, { first: NOW - 19 * DAY }), // due today
    'b.listen': review(NOW - HOUR, NOW - 10 * DAY, { first: NOW - 20 * DAY }), // due today, b not studied today
  };
  const today = buildQueue({ items: list, srs, now: NOW, settings: { newPerDay: 0 } });
  assert.deepEqual(ids(today.queue), ['b.listen'], 'a.speak waits: a was already asked today');
  assert.ok(!ids(today.queue).includes('a.read'), 'so does the new a.read');
  const tomorrow = buildQueue({ items: list, srs, now: TOMORROW_NOON, settings: { newPerDay: 0 } });
  assert.ok(ids(tomorrow.queue).includes('a.speak'), 'tomorrow it is shown');
});

test('one review per item per session: the most overdue card of the item', () => {
  const srs = {
    'a.listen': review(NOW - HOUR, NOW - 10 * DAY),
    'a.speak': review(NOW - 2 * DAY, NOW - 12 * DAY),
  };
  const q = buildQueue({ items: items('a'), srs, now: NOW });
  assert.deepEqual(ids(q.queue), ['a.speak']);
  assert.equal(q.counts.review, 1);
});

test('items marked skip are never scheduled', () => {
  const srs = {
    'a.listen': review(NOW - HOUR, NOW - 10 * DAY),
    'a.speak': learning(NOW - MINUTE, NOW - 11 * MINUTE),
  };
  const marks = { a: { m: 'skip', t: NOW - DAY }, c: { m: 'star', t: NOW - DAY } };
  const q = buildQueue({ items: items('a', 'b', 'c'), srs, marks, now: NOW });
  assert.deepEqual(ids(q.queue), ['b.listen', 'c.listen'], 'starred items are scheduled as usual');
  assert.deepEqual(q.counts, { learning: 0, review: 0, new: 2 });
  const cleared = buildQueue({ items: items('a'), srs, marks: { a: { m: null, t: NOW } }, now: NOW });
  assert.ok(ids(cleared.queue).includes('a.speak'), 'a cleared mark (tombstone) does not skip');
});

test('learning cards that are due come first (by due time), then reviews by due time with new cards spread in', () => {
  const srs = {
    'l1.listen': relearning(NOW - 2 * MINUTE, NOW - 12 * MINUTE, { first: NOW - 30 * DAY }),
    'l2.listen': relearning(NOW - 5 * MINUTE, NOW - 15 * MINUTE, { first: NOW - 30 * DAY }),
    'r1.listen': review(NOW - HOUR, NOW - 10 * DAY),
    'r2.listen': review(NOW - 3 * DAY, NOW - 13 * DAY),
    'r3.listen': review(TODAY + 20 * HOUR, NOW - 9 * DAY), // due later in this study day: still today's review
    'r4.listen': review(TODAY + DAY + HOUR, NOW - 9 * DAY), // due tomorrow
  };
  // r2 is overdue (due 3 days ago): with the default pause, new cards would wait (tested below); here the
  // order of a mixed queue is tested, so the pause is off.
  const q = buildQueue({ items: single('n1', 'r1', 'l1', 'r2', 'l2', 'r3', 'r4', 'n2'), srs, now: NOW, settings: { newPerDay: 1, pauseNewWhenOverdue: false } });
  assert.deepEqual(ids(q.queue), ['l2.listen', 'l1.listen', 'r2.listen', 'n1.listen', 'r1.listen', 'r3.listen']);
  assert.deepEqual(q.queue.map((x) => x.kind), ['learning', 'learning', 'review', 'new', 'review', 'review']);
  assert.deepEqual(q.counts, { learning: 2, review: 3, new: 1 });
});

test('reviewLimit caps the reviews (the most overdue are kept)', () => {
  const srs = {};
  const list = single('a', 'b', 'c', 'd', 'e');
  list.forEach((item, i) => { srs[`${item.id}.listen`] = review(NOW - (i + 1) * HOUR, NOW - 10 * DAY); });
  const q = buildQueue({ items: list, srs, now: NOW, settings: { reviewLimit: 2, newPerDay: 0 } });
  assert.deepEqual(ids(q.queue), ['e.listen', 'd.listen']);
  assert.equal(q.counts.review, 2);
  assert.equal(buildQueue({ items: list, srs, now: NOW, settings: { newPerDay: 0 } }).counts.review, 5);
});

test('learning cards due soon are shown early only when nothing else is left', () => {
  const soon = { 'a.listen': learning(NOW + 15 * MINUTE, NOW - 5 * MINUTE) };
  const q = buildQueue({ items: items('a'), srs: soon, now: NOW, settings: { newPerDay: 0 } });
  assert.deepEqual(ids(q.queue), ['a.listen']);
  assert.deepEqual(q.waiting, []);
  assert.equal(q.nextDue, null);
  const later = { 'a.listen': learning(NOW + 30 * MINUTE, NOW - 5 * MINUTE) };
  const w = buildQueue({ items: items('a'), srs: later, now: NOW, settings: { newPerDay: 0 } });
  assert.deepEqual(ids(w.queue), []);
  assert.deepEqual(ids(w.waiting), ['a.listen']);
  assert.equal(w.nextDue, NOW + 30 * MINUTE);
});

test('classify reports what was introduced and studied today', () => {
  const srs = {
    'a.listen': learning(NOW + 10 * MINUTE, NOW - MINUTE), // introduced today
    'b.listen': review(NOW + DAY, NOW - HOUR, { first: NOW - 9 * DAY }), // studied today, introduced earlier
    'c.listen': review(NOW + DAY, NOW - 2 * DAY),
  };
  const list = items('a', 'b', 'c', 'd');
  const c = classify({ items: list, srs, now: NOW });
  assert.deepEqual([...c.introducedToday], ['a']);
  assert.deepEqual([...c.studiedToday].sort(), ['a', 'b']);
  assert.deepEqual(ids(c.newItems), ['d.listen']);
  assert.deepEqual(ids(c.siblings), ['b.speak', 'c.speak'], 'unlocked: first reviewed before today');
  assert.deepEqual(ids(c.learning), ['a.listen']);
  assert.deepEqual(ids(c.review), [], 'nothing due in this study day');
  assert.deepEqual(ids(buildQueue({ items: list, srs, now: NOW }).queue).sort(), ['c.speak', 'd.listen'], 'b.speak waits: b was studied today');
});

// ---------- interleave ----------

test('interleave spreads b evenly through a and keeps both orders', () => {
  assert.deepEqual(interleave(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'], ['n1', 'n2']), ['r1', 'n1', 'r2', 'r3', 'r4', 'n2', 'r5', 'r6']);
  assert.deepEqual(interleave(['r1', 'r2', 'r3'], ['n1', 'n2', 'n3']), ['n1', 'r1', 'n2', 'r2', 'n3', 'r3']);
  assert.deepEqual(interleave(['r1'], ['n1', 'n2', 'n3']), ['n1', 'n2', 'r1', 'n3']);
  assert.deepEqual(interleave([], ['n1']), ['n1']);
  assert.deepEqual(interleave(['r1'], []), ['r1']);
  const a = ['x'];
  assert.notEqual(interleave(a, []), a, 'a new array');
  for (let na = 0; na <= 12; na += 1) {
    for (let nb = 0; nb <= 12; nb += 1) {
      const A = Array.from({ length: na }, (_, i) => `a${i}`);
      const B = Array.from({ length: nb }, (_, i) => `b${i}`);
      const out = interleave(A, B);
      assert.equal(out.length, na + nb);
      assert.deepEqual(out.filter((x) => x[0] === 'a'), A, 'order of a kept');
      assert.deepEqual(out.filter((x) => x[0] === 'b'), B, 'order of b kept');
      if (nb > 0 && na >= nb) {
        // Evenly spread: no two b's next to each other, and no run of a's longer than ceil(na / nb) + 1.
        const pos = out.map((x, i) => (x[0] === 'b' ? i : -1)).filter((i) => i >= 0);
        for (let k = 1; k < pos.length; k += 1) assert.ok(pos[k] - pos[k - 1] >= 2, `${na}/${nb}: ${out}`);
        const longestRun = Math.max(...out.join(',').split(/b\d+/).map((run) => run.split(',').filter(Boolean).length));
        assert.ok(longestRun <= Math.ceil(na / nb) + 1, `${na}/${nb}: ${out}`);
      }
    }
  }
});

// ---------- Progress and helpers ----------

test('deckProgress counts skipped, unseen, learning, learned and mature items (by the first card type)', () => {
  const list = items('skipped', 'unseen', 'learning', 'young', 'mature', 'other-type-only');
  const srs = {
    'skipped.listen': review(NOW + DAY, NOW - DAY),
    'learning.listen': learning(NOW + 10 * MINUTE, NOW),
    'young.listen': review(NOW + 5 * DAY, NOW - DAY, { stability: 8 }),
    'mature.listen': review(NOW + 30 * DAY, NOW - DAY, { stability: 21 }),
    'other-type-only.speak': review(NOW + 30 * DAY, NOW - DAY, { stability: 30 }),
  };
  const marks = { skipped: { m: 'skip', t: NOW } };
  assert.deepEqual(deckProgress(list, srs, marks), { total: 6, skipped: 1, learning: 1, learned: 2, mature: 1, unseen: 2 });
  assert.deepEqual(deckProgress([], srs, marks), { total: 0, skipped: 0, learning: 0, learned: 0, mature: 0, unseen: 0 });
  assert.deepEqual(deckProgress(items('x')), { total: 1, skipped: 0, learning: 0, learned: 0, mature: 0, unseen: 1 });
});

test('pick and cardIdsOfItem', () => {
  const list = items('a', 'b', 'c');
  assert.deepEqual(ids(pick(list, new Set(['c', 'a']))), ['a', 'c']);
  const srs = { 'w.1.listen': {}, 'w.1.speak': {}, 'w.10.listen': {}, 'w.1.x.read': {} };
  assert.deepEqual(cardIdsOfItem(srs, 'w.1'), ['w.1.listen', 'w.1.speak']);
});

test('a further card type of a started item is marked as a sibling, a never-studied item is not', () => {
  const srs = { 'a.listen': review(TOMORROW_NOON, at(2026, 11, 1, 9)) }; // a was started yesterday
  const q = buildQueue({ items: items('a', 'b'), srs, now: NOW });
  const a = q.queue.find((x) => x.itemId === 'a');
  const b = q.queue.find((x) => x.itemId === 'b');
  assert.equal(a.type, 'speak');
  assert.equal(a.kind, 'new');
  assert.equal(a.sibling, true, 'the study view does not count it as a new word');
  assert.equal(b.type, 'listen');
  assert.equal(b.kind, 'new');
  assert.equal(b.sibling, undefined);
});

test('new words pause while reviews from earlier days are in the queue, and return once they are done', () => {
  const yesterday = at(2026, 11, 1, 9);
  const overdue = review(at(2026, 11, 1, 10), at(2026, 10, 20, 9)); // due yesterday, not done
  const srs = { 'a.listen': overdue };
  let q = buildQueue({ items: single('a', 'b', 'c'), srs, now: NOW });
  assert.equal(q.paused, true);
  assert.equal(q.overdue, 1);
  assert.deepEqual(ids(q.queue), ['a.listen'], 'only the overdue review');
  assert.equal(q.counts.new, 0);
  // Answered today: no longer overdue, new words come back the same day.
  const done = { 'a.listen': review(at(2026, 11, 9, 10), NOW - HOUR) };
  q = buildQueue({ items: single('a', 'b', 'c'), srs: done, now: NOW });
  assert.equal(q.paused, false);
  assert.deepEqual(ids(q.queue), ['b.listen', 'c.listen']);
  // Switched off in settings: new words are mixed in as before.
  q = buildQueue({ items: single('a', 'b', 'c'), srs, now: NOW, settings: { pauseNewWhenOverdue: false } });
  assert.equal(q.paused, false);
  assert.equal(q.counts.new, 2);
  // "Keep learning new words" (bonusNew) still gives new words while paused.
  q = buildQueue({ items: single('a', 'b', 'c'), srs, now: NOW, settings: { bonusNew: 1 } });
  assert.equal(q.paused, true);
  assert.equal(q.counts.new, 1);
  assert.ok(yesterday < TODAY);
});

test('reviews due today are not overdue; a backlog larger than the daily limit keeps new words paused all day', () => {
  const dueToday = { 'a.listen': review(at(2026, 11, 2, 8), at(2026, 10, 25, 9)) };
  assert.equal(buildQueue({ items: single('a', 'b'), srs: dueToday, now: NOW }).paused, false);
  const many = {};
  for (let i = 0; i < 5; i += 1) many[`o${i}.listen`] = review(at(2026, 10, 30, 10), at(2026, 10, 20, 9));
  const items = [...single('o0', 'o1', 'o2', 'o3', 'o4'), ...single('n1')];
  const q = buildQueue({ items, srs: many, now: NOW, settings: { reviewLimit: 2 } });
  assert.equal(q.counts.review, 2);
  assert.equal(q.paused, true);
  assert.equal(q.overdue, 5);
});
