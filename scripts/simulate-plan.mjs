#!/usr/bin/env node
// Realistic study plan: simulate FSRS-6 (ts-fsrs 5.4.2, default parameters, desired retention R) for a
// learner who adds N new words a day, each word with three card types (listen, speak, characters)
// introduced on successive days, as the app does. A review succeeds with the probability FSRS itself
// predicts (its retrievability at review time), "Good" on success, "Again" on failure; learning steps
// are taken the same day. Output: days to reach each 2025 HSK level and the daily review load.
//
//   node scripts/simulate-plan.mjs [--retention 0.9] [--days 730]
// Deterministic (seeded random). This is a model, not a promise: real recall depends on the learner.

import { createScheduler, State } from '../app/src/lib/srs.js';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const RETENTION = opt('retention', 0.9);
const DAYS = opt('days', 730);
const LEVELS = [['HSK 1', 300], ['HSK 2', 500], ['HSK 3', 1000], ['HSK 4', 2000], ['HSK 5', 3600], ['HSK 6', 5400]];
const TYPES = opt('types', 3);
const DAY = 86_400_000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(newPerDay, { retention = RETENTION, days = DAYS, seed = 7 } = {}) {
  const sched = createScheduler({ retention, fuzz: true });
  const random = rng(seed + newPerDay);
  const cards = []; // { item, type, card, start }
  const start = Date.UTC(2026, 10, 3, 6, 0);
  let items = 0;
  const load = [];
  const reached = {};
  for (let d = 0; d < days; d += 1) {
    const dayStart = start + d * DAY;
    const dayEnd = dayStart + DAY;
    // Unlock: new items' first card today; next card type of items started earlier.
    for (let k = 0; k < newPerDay && items < 5400; k += 1) {
      cards.push({ item: items, type: 0, card: sched.newCard(dayStart), start: d });
      items += 1;
    }
    for (const c of cards.filter((x) => x.type < TYPES - 1 && x.start === d - 1 && !x.unlocked)) {
      c.unlocked = true;
      cards.push({ item: c.item, type: c.type + 1, card: sched.newCard(dayStart), start: d });
    }
    let reviews = 0;
    let t = dayStart + 8 * 3_600_000; // study starts at 8:00
    // Repeat until nothing is due today (learning steps come back within minutes).
    for (let pass = 0; pass < 6; pass += 1) {
      const due = cards.filter((c) => c.card.due.getTime() <= Math.max(t, dayStart) || (c.card.reps === 0 && c.start === d));
      if (!due.length) break;
      for (const c of due) {
        if (c.card.due.getTime() >= dayEnd && c.card.reps > 0) continue;
        const r = c.card.state === State.New ? 0.5 : sched.retrievability(c.card, t);
        const grade = random() < r ? 'good' : 'again';
        c.card = sched.review(c.card, grade, t);
        reviews += 1;
        t += 8_000; // 8 seconds per answer
      }
      t += 11 * 60_000;
    }
    load.push(reviews);
    for (const [name, count] of LEVELS) if (reached[name] === undefined && items >= count) reached[name] = d + 1;
  }
  const avg = (from, to) => Math.round(load.slice(from, to).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(to, load.length) - from));
  return { newPerDay, reached, week1: avg(0, 7), month1: avg(21, 28), month3: avg(84, 91), month6: avg(175, 182), year1: avg(358, 365), peak: Math.max(...load) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`FSRS-6 simulation, desired retention ${RETENTION}, ${TYPES} card types per word, 8 s per answer`);
  console.log('new/day | days to HSK1  HSK2  HSK3  HSK4  HSK5  HSK6 | answers/day: week1 month1 month3 month6 year1 (peak)');
  for (const n of [5, 10, 15, 20, 30]) {
    const r = simulate(n);
    const days = LEVELS.map(([name]) => String(r.reached[name] ?? '>' + DAYS).padStart(5)).join(' ');
    console.log(`${String(n).padStart(7)} | ${days} | ${[r.week1, r.month1, r.month3, r.month6, r.year1].map((x) => String(x).padStart(5)).join(' ')} (${r.peak})`);
  }
}
