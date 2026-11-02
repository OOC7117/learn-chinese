// Study statistics: answers per study day, streak, daily goal and pace. Pure logic.
//
// stats = { days: { 'YYYY-MM-DD': { r: answers, n: new items, a: 'again' answers, ms: time studied } } }
// Days are study days (04:00 to 04:00 local, see queue.dayStartOf). Syncing merges per day and counter
// with the maximum, which is idempotent; if two devices study on the same day the total is
// under-counted, but the streak and "goal met" stay right in the usual case.

import { dayKey } from './queue.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const COUNTERS = ['r', 'n', 'a', 'ms'];
const clean = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

export function emptyStats() {
  return { days: {} };
}

/** Untrusted stats -> clean stats (only valid day keys and non-negative integer counters). */
export function cleanStats(raw) {
  const out = emptyStats();
  if (!isObject(raw) || !isObject(raw.days)) return out;
  for (const [key, day] of Object.entries(raw.days)) {
    if (!DAY_KEY.test(key) || !isObject(day)) continue;
    out.days[key] = Object.fromEntries(COUNTERS.map((c) => [c, clean(day[c])]));
  }
  return out;
}

/** Merge two stats objects: per day and counter, the maximum. */
export function mergeStats(a, b) {
  const x = cleanStats(a);
  const y = cleanStats(b);
  const out = emptyStats();
  for (const key of new Set([...Object.keys(x.days), ...Object.keys(y.days)])) {
    out.days[key] = Object.fromEntries(COUNTERS.map((c) => [c, Math.max(x.days[key]?.[c] ?? 0, y.days[key]?.[c] ?? 0)]));
  }
  return out;
}

/** Record one answer on the study day starting at `dayStart`. Returns new stats. */
export function recordAnswer(stats, { dayStart, isNew = false, grade = 'good', ms = 0 }) {
  const out = cleanStats(stats);
  const key = dayKey(dayStart);
  const day = out.days[key] ?? { r: 0, n: 0, a: 0, ms: 0 };
  out.days[key] = {
    r: day.r + 1,
    n: day.n + (isNew ? 1 : 0),
    a: day.a + (grade === 'again' ? 1 : 0),
    ms: day.ms + Math.max(0, Math.min(Math.round(ms), 10 * 60_000)), // cap: a card left open for an hour is not study time
  };
  return out;
}

export function dayStats(stats, key) {
  return cleanStats(stats).days[key] ?? { r: 0, n: 0, a: 0, ms: 0 };
}

/** The local date key `offset` days before `key` ("2026-11-02", 1 -> "2026-11-01"). */
export function shiftKey(key, offset) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d - offset, 12); // noon: immune to DST jumps
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Consecutive study days with at least `minAnswers` answers, ending today, or ending yesterday when
 * today has not reached it yet (the streak is still alive until the day is over).
 */
export function streak(stats, todayKey, minAnswers = 1) {
  const days = cleanStats(stats).days;
  const ok = (key) => (days[key]?.r ?? 0) >= minAnswers;
  let start = ok(todayKey) ? 0 : 1;
  let count = 0;
  while (ok(shiftKey(todayKey, start + count))) count += 1;
  return count;
}

/** Average new items per day over the last `window` calendar days before today (today excluded so a
 * half-finished day does not lower it). null when nothing was learned in that window. */
export function newPerDayPace(stats, todayKey, window = 14) {
  const days = cleanStats(stats).days;
  let total = 0;
  let studied = 0;
  for (let i = 1; i <= window; i += 1) {
    const day = days[shiftKey(todayKey, i)];
    if (day) {
      total += day.n;
      if (day.r > 0) studied += 1;
    }
  }
  if (total === 0 || studied === 0) return null;
  return total / window;
}

/** Days needed to learn `remaining` items at `perDay` new items per day (Infinity if perDay <= 0). */
export function daysToFinish(remaining, perDay) {
  if (remaining <= 0) return 0;
  if (!(perDay > 0)) return Infinity;
  return Math.ceil(remaining / perDay);
}
