// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanStats, dayStats, daysToFinish, emptyStats, mergeStats, newPerDayPace, recordAnswer, shiftKey, streak,
} from '../app/src/lib/stats.js';

const dayStart = (y, mo, d) => new Date(y, mo - 1, d, 4).getTime(); // local 04:00
const TODAY = '2026-11-02';
const days = (obj) => ({ days: Object.fromEntries(Object.entries(obj).map(([k, r]) => [k, { r, n: 0, a: 0, ms: 0 }])) });

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

test('recordAnswer counts answers, new items, "again" and capped study time per study day', () => {
  let stats = emptyStats();
  const start = dayStart(2026, 11, 2);
  stats = recordAnswer(stats, { dayStart: start, isNew: true, grade: 'good', ms: 4000 });
  stats = recordAnswer(stats, { dayStart: start, grade: 'again', ms: 2500.6 });
  stats = recordAnswer(stats, { dayStart: start, ms: 60 * 60_000 }); // left open for an hour: 10 minutes count
  stats = recordAnswer(stats, { dayStart: start, ms: -50 });
  assert.deepEqual(dayStats(stats, '2026-11-02'), { r: 4, n: 1, a: 1, ms: 4000 + 2501 + 600_000 });
  const next = recordAnswer(stats, { dayStart: dayStart(2026, 11, 3) });
  assert.deepEqual(dayStats(next, '2026-11-03'), { r: 1, n: 0, a: 0, ms: 0 });
  assert.deepEqual(dayStats(stats, '2026-11-03'), { r: 0, n: 0, a: 0, ms: 0 }, 'the input is not mutated');
  assert.deepEqual(Object.keys(recordAnswer(null, { dayStart: start }).days), ['2026-11-02'], 'works from nothing');
});

test('streak: consecutive study days ending today, or yesterday while today is not done yet', () => {
  const stats = days({ '2026-10-30': 5, '2026-10-31': 3, '2026-11-01': 12 });
  assert.equal(streak(stats, TODAY), 3, 'today not studied yet: the streak is still alive');
  assert.equal(streak(recordAnswer(stats, { dayStart: dayStart(2026, 11, 2) }), TODAY), 4, 'today counts once studied');
  assert.equal(streak(stats, '2026-11-03'), 0, 'a missed day ends it');
  assert.equal(streak(days({ '2026-11-02': 1, '2026-10-31': 9 }), TODAY), 1);
  assert.equal(streak(emptyStats(), TODAY), 0);
  assert.equal(streak(stats, TODAY, 5), 1, 'minAnswers: only 2026-11-01 reached 5 answers in a row');
  assert.equal(streak(days({ '2026-10-31': 5, '2026-11-01': 5, '2026-11-02': 2 }), TODAY, 5), 2, 'today below the minimum does not break it');
});

test('streak across a month boundary and daylight-saving changes', () => {
  assert.equal(streak(days({ '2026-02-27': 1, '2026-02-28': 1, '2026-03-01': 1 }), '2026-03-01'), 3);
  assert.equal(streak(days({ '2024-02-28': 1, '2024-02-29': 1, '2024-03-01': 1 }), '2024-03-01'), 3, 'leap day');
  withTimeZone('Europe/Amsterdam', () => {
    assert.equal(streak(days({ '2026-03-28': 1, '2026-03-29': 1, '2026-03-30': 1 }), '2026-03-30'), 3, 'clocks forward');
    assert.equal(streak(days({ '2026-10-24': 1, '2026-10-25': 1, '2026-10-26': 1 }), '2026-10-26'), 3, 'clocks back');
  });
});

test('shiftKey moves local dates across months, years, leap days and DST changes', () => {
  assert.equal(shiftKey('2026-11-02', 1), '2026-11-01');
  assert.equal(shiftKey('2026-11-02', 0), '2026-11-02');
  assert.equal(shiftKey('2026-11-02', 14), '2026-10-19');
  assert.equal(shiftKey('2026-03-01', 1), '2026-02-28');
  assert.equal(shiftKey('2024-03-01', 1), '2024-02-29');
  assert.equal(shiftKey('2026-01-01', 1), '2025-12-31');
  assert.equal(shiftKey('2026-12-31', -1), '2027-01-01');
  for (const tz of ['Europe/Amsterdam', 'America/New_York', 'America/Santiago', 'Australia/Lord_Howe', 'UTC']) {
    withTimeZone(tz, () => {
      for (const [key, offset, want] of [
        ['2026-03-30', 1, '2026-03-29'], ['2026-03-29', 1, '2026-03-28'], // EU spring forward 2026-03-29
        ['2026-10-26', 1, '2026-10-25'], ['2026-10-25', 1, '2026-10-24'], // EU fall back 2026-10-25
        ['2026-03-09', 1, '2026-03-08'], ['2026-11-02', 1, '2026-11-01'], // US 2026-03-08 / 2026-11-01
        ['2026-09-07', 1, '2026-09-06'], ['2026-04-05', 1, '2026-04-04'], // Chile: changes at midnight
        ['2026-10-04', 1, '2026-10-03'], ['2026-10-03', -1, '2026-10-04'], // Lord Howe: 30-minute change
      ]) assert.equal(shiftKey(key, offset), want, `${tz}: ${key} ${offset}`);
      // Walking back a whole year one day at a time visits every date once.
      let key = '2026-12-31';
      for (let i = 0; i < 365; i += 1) key = shiftKey(key, 1);
      assert.equal(key, '2025-12-31', tz);
    });
  }
});

test('newPerDayPace: average new items over the days before today', () => {
  const stats = { days: {
    '2026-11-02': { r: 50, n: 30, a: 0, ms: 0 }, // today: excluded
    '2026-11-01': { r: 40, n: 10, a: 0, ms: 0 },
    '2026-10-31': { r: 20, n: 4, a: 0, ms: 0 },
    '2026-10-10': { r: 99, n: 99, a: 0, ms: 0 }, // outside the window
  } };
  assert.equal(newPerDayPace(stats, TODAY), 14 / 14);
  assert.equal(newPerDayPace(stats, TODAY, 2), 7);
  assert.equal(newPerDayPace(emptyStats(), TODAY), null);
  assert.equal(newPerDayPace(days({ '2026-11-01': 30 }), TODAY), null, 'reviews only: no pace');
  assert.equal(daysToFinish(100, 7), 15);
  assert.equal(daysToFinish(0, 7), 0);
  assert.equal(daysToFinish(5, 0), Infinity);
  assert.equal(daysToFinish(5, null), Infinity);
});

test('mergeStats takes the maximum per day and counter (commutative, idempotent)', () => {
  const a = { days: { '2026-11-01': { r: 10, n: 2, a: 1, ms: 100 }, '2026-11-02': { r: 1, n: 0, a: 0, ms: 5 } } };
  const b = { days: { '2026-11-01': { r: 7, n: 5, a: 0, ms: 300 }, '2026-10-31': { r: 3, n: 3, a: 3, ms: 3 } } };
  const merged = mergeStats(a, b);
  assert.deepEqual(merged, { days: {
    '2026-11-01': { r: 10, n: 5, a: 1, ms: 300 },
    '2026-11-02': { r: 1, n: 0, a: 0, ms: 5 },
    '2026-10-31': { r: 3, n: 3, a: 3, ms: 3 },
  } });
  assert.deepEqual(mergeStats(b, a).days, merged.days);
  assert.deepEqual(mergeStats(merged, merged), merged);
  assert.deepEqual(mergeStats(merged, a), merged);
  assert.deepEqual(mergeStats(null, undefined), emptyStats());
});

test('cleanStats keeps only valid day keys and non-negative integer counters', () => {
  const raw = { days: {
    '2026-11-02': { r: 3, n: -1, a: 1.5, ms: '9', extra: 1 },
    'yesterday': { r: 1 },
    '2026-11-1': { r: 1 },
    '2026-11-03': null,
  } };
  assert.deepEqual(cleanStats(raw), { days: { '2026-11-02': { r: 3, n: 0, a: 0, ms: 0 } } });
  assert.deepEqual(cleanStats([]), emptyStats());
  assert.deepEqual(cleanStats({ days: [] }), emptyStats());
});
