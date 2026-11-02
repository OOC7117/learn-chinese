// Tests for src/lib/tonedrill.js: rounds, scoring, statistics, adaptive weighting and the pinyin chart,
// plus checks against the real app data (tones.json, audio/s).  Run: node --test app/tests/tonedrill.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DRILLS, MAX_RECENT, ROUND_SIZE, parseSyllableKey, syllableFile, syllableUrl, markedSyllable, emptyToneStats,
  cleanToneStats, recordAnswer, recordRound, confusionMatrix, toneAccuracy, topConfusions, drillAccuracy, toneWeights,
  mulberry32, shuffle, spread, allocate, weightedSample, buildSyllableRound, buildPairRound, differingPositions,
  buildMinimalRound, checkTones, roundSummary, suggestNext, CHART_INITIALS, CHART_FINALS, finalGroup, splitSyllable,
  chartLayout, otherReadings, tonesInDoubt,
} from '../src/lib/tonedrill.js';
import { SYLLABLES, syllablesOf, spokenPinyin } from '../src/lib/pinyin.js';
import { syllableFile as buildSyllableFile } from '../../scripts/build-app-data.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const TONES_JSON = `${APP}data/tones.json`;
const tonesData = existsSync(TONES_JSON) ? JSON.parse(readFileSync(TONES_JSON, 'utf8')) : null;
/** The app's words by id (compact form: i, h, p, sp?, m, a?), from app/data/words-*.json. */
const appWords = new Map();
for (const f of ['1', '2', '3', '4', '5', '6', '7-9', 'other']) {
  const path = `${APP}data/words-${f}.json`;
  if (existsSync(path)) for (const w of JSON.parse(readFileSync(path, 'utf8')).items) appWords.set(w.i, w);
}
const tonesOfPinyin = (p) => syllablesOf(p, { strict: false }).map((s) => s.tone);

/** Statistics with `n` answers of target -> answer in drill d. */
function withAnswers(list, stats = emptyToneStats()) {
  let s = stats;
  for (const [d, t, a, n = 1] of list) for (let i = 0; i < n; i += 1) s = recordAnswer(s, d, t, a);
  return s;
}
const count = (items, fn) => items.reduce((m, it) => m.set(fn(it), (m.get(fn(it)) ?? 0) + 1), new Map());
const maxRun = (items, key) => {
  let best = 0;
  let run = 0;
  items.forEach((it, i) => {
    run = i && key(items[i - 1]) === key(it) ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
};

// ---------- syllables and recordings ----------

test('parseSyllableKey accepts ü and v, rejects everything else', () => {
  assert.deepEqual(parseSyllableKey('lü4'), { base: 'lü', tone: 4 });
  assert.deepEqual(parseSyllableKey('lv4'), { base: 'lü', tone: 4 });
  assert.deepEqual(parseSyllableKey('Zhuang1'), { base: 'zhuang', tone: 1 });
  for (const bad of ['ma', 'ma6', 'ma0', 'mǎ', '3', '', null, 'ma 3']) assert.equal(parseSyllableKey(bad), null, String(bad));
});

test('syllableFile: ü as v, ju4 stored as jv4', () => {
  assert.equal(syllableFile('ma', 3), 'ma3');
  assert.equal(syllableFile('lü', 4), 'lv4');
  assert.equal(syllableFile('nüe', 4), 'nve4');
  assert.equal(syllableFile('ju', 4), 'jv4');
  assert.equal(syllableFile('ju', 3), 'ju3');
  assert.equal(syllableFile('juan', 4), 'juan4');
  assert.equal(syllableUrl('lü', 2), 'audio/s/lv2.mp3');
  assert.equal(markedSyllable('lü', 3), 'lǚ');
  assert.equal(markedSyllable('ju', 3), 'jǔ');
});

test('syllableFile matches the build script for the whole inventory', () => {
  for (const base of SYLLABLES) for (let t = 1; t <= 4; t += 1) assert.equal(syllableFile(base, t), buildSyllableFile(base, t), `${base}${t}`);
});

test('every syllable in app/data/tones.json has its recording', { skip: !tonesData && 'app/data/tones.json not built' }, () => {
  assert.ok(tonesData.syllables.length > 1000);
  for (const s of tonesData.syllables) {
    const p = parseSyllableKey(s);
    assert.ok(p && p.tone >= 1 && p.tone <= 4, s);
    assert.ok(SYLLABLES.has(p.base), `${s} is in the inventory`);
    assert.ok(existsSync(`${APP}${syllableUrl(p.base, p.tone)}`), `${syllableUrl(p.base, p.tone)} exists`);
  }
});

test('tones.json pairs and minimal pairs have the shape the drills expect', { skip: !tonesData && 'app/data/tones.json not built' }, () => {
  for (const [key, ids] of Object.entries(tonesData.pairs)) {
    assert.match(key, /^[1-4][1-5]$/);
    assert.notEqual(key, '33', 'third-tone sandhi pairs are excluded');
    for (const id of ids) {
      assert.ok(existsSync(`${APP}audio/w/${id}.mp3`), `${id} has a recording`);
    }
  }
  for (const [a, b] of tonesData.minimal) {
    assert.notEqual(a, b);
    // Same syllables, different tones (derived from the ids' numbered pinyin, which the build used).
    const strip = (id) => id.split('.').pop().replace(/[1-5]/g, '');
    assert.equal(strip(a), strip(b), `${a} / ${b}`);
    assert.ok(existsSync(`${APP}audio/w/${a}.mp3`) && existsSync(`${APP}audio/w/${b}.mp3`));
  }
});

test('every drill word is an app word with its own recording and exactly the tones the drill asks for', { skip: (!tonesData || !appWords.size) && 'app data not built' }, () => {
  // What the learner hears must be what the drill marks right: the word's current pinyin (not just its id)
  // has the pattern's tones, the recording is the word's own (a: 'w'), and no tone change (sandhi) applies.
  for (const [key, ids] of Object.entries(tonesData.pairs)) {
    for (const id of ids) {
      const w = appWords.get(id);
      assert.ok(w, `${id} is in app/data/words-*.json`);
      assert.equal(w.a, 'w', `${w.h} has a word recording`);
      assert.equal(w.sp, undefined, `${w.h} ${w.p} is said with its citation tones`);
      assert.equal(spokenPinyin(w.h, w.p), null, `${w.h} ${w.p}: no tone sandhi`);
      assert.equal(tonesOfPinyin(w.p).join(''), key, `${w.h} ${w.p} has the tones ${key}`);
    }
  }
  for (const [a, b] of tonesData.minimal) {
    const [wa, wb] = [appWords.get(a), appWords.get(b)];
    assert.ok(wa && wb, `${a} / ${b} are app words`);
    assert.ok(wa.a === 'w' && wb.a === 'w' && !wa.sp && !wb.sp, `${wa.h} / ${wb.h}: recorded, no sandhi`);
    const [sa, sb] = [syllablesOf(wa.p, { strict: false }), syllablesOf(wb.p, { strict: false })];
    assert.deepEqual(sa.map((s) => s.base), sb.map((s) => s.base), `${wa.p} / ${wb.p}: same syllables`);
    assert.notDeepEqual(sa.map((s) => s.tone), sb.map((s) => s.tone), `${wa.p} / ${wb.p}: different tones`);
  }
});

test('words whose tones are in doubt are few enough that every pattern still fills its share of a round', { skip: (!tonesData || !appWords.size) && 'app data not built' }, () => {
  for (const [key, ids] of Object.entries(tonesData.pairs)) {
    const tones = [Number(key[0]), Number(key[1])];
    const clear = ids.filter((id) => !tonesInDoubt(tones, appWords.get(id)?.m));
    assert.ok(clear.length >= 3, `pattern ${key}: ${clear.length} words with certain tones`);
  }
  // 上面 shàngmiàn ("also pr. [shang4 mian5]") is one of them: the speaker may have said shàngmian.
  const shangmian = [...appWords.values()].find((w) => w.h === '上面' && w.a === 'w');
  if (shangmian) assert.equal(tonesInDoubt([4, 4], shangmian.m), true);
});

// ---------- other pronunciations ----------

test('otherReadings reads the Mainland pronunciations CC-CEDICT notes, not the Taiwan ones', () => {
  assert.deepEqual(otherReadings(['on top of', 'above-mentioned', 'also pr. [shang4 mian5]']), [[4, 5]]);
  assert.deepEqual(otherReadings(['to know', 'also pr. [zhi1dao5]']), [[1, 5]], 'syllables written together');
  assert.deepEqual(otherReadings(['also pr. [di4] or [di5] in poetry and songs']), [[4], [5]]);
  assert.deepEqual(otherReadings(['(specifier) that; the; those (colloquial pr. [nei4])']), [[4]]);
  assert.deepEqual(otherReadings(['idea; plan', 'Beijing pr. [zhu2 yi5]']), [[2, 5]]);
  assert.deepEqual(otherReadings(['(joining two nouns) and; together with (Taiwan pr. [han4])']), []);
  assert.deepEqual(otherReadings(['also written 辞典 [cídiǎn]', 'variant of 才 [cái]']), [], 'spelling notes are not readings');
  assert.deepEqual(otherReadings(['also pr. [nǚ]']), [[3]], 'marked pinyin too');
  assert.deepEqual(otherReadings(null), []);
});

test('tonesInDoubt: only other tones (where they matter) make a word doubtful', () => {
  assert.equal(tonesInDoubt([4, 4], ['also pr. [shang4 mian5]']), true);
  assert.equal(tonesInDoubt([1, 4], ['also pr. [zhi1dao5]']), true);
  assert.equal(tonesInDoubt([1, 4], ['also pr. [zhi1dao5]'], [0]), false, 'the first syllable is certain');
  assert.equal(tonesInDoubt([4, 5], ['also pr. [nei4 ge5]']), false, 'another vowel, the same tones');
  assert.equal(tonesInDoubt([3, 5], ['Beijing pr. [zhu2 yi5]'], [0, 1]), true);
  assert.equal(tonesInDoubt([1], ['also pr. [yi1 dian3]']), true, 'another number of syllables');
  assert.equal(tonesInDoubt([1, 5], ['he; she; they']), false);
  assert.equal(tonesInDoubt([1, 5], undefined), false);
});

// ---------- statistics ----------

test('cleanToneStats drops malformed parts and keeps valid ones', () => {
  assert.deepEqual(cleanToneStats(null), emptyToneStats());
  assert.deepEqual(cleanToneStats('x'), emptyToneStats());
  const raw = {
    v: 1,
    recent: [['s', 1, 1], ['x', 1, 1], ['p', 0, 1], ['m', 3, 6], ['p', 2, 3], 'bad', ['s', 1.5, 1]],
    total: { 1: [5, 4], 2: [3, 4], 3: 'no', 9: [1, 1] },
    rounds: { s: { n: 2, last: [15, 20], best: [18, 20], at: 1 }, p: { n: 1, last: [21, 20], best: [1, 20], at: 1 }, x: {} },
  };
  assert.deepEqual(cleanToneStats(raw), {
    v: 1,
    recent: [['s', 1, 1], ['p', 2, 3]],
    total: { 1: [5, 4] },
    rounds: { s: { n: 2, last: [15, 20], best: [18, 20], at: 1 } },
  });
  const long = { recent: Array.from({ length: MAX_RECENT + 50 }, (_, i) => ['s', (i % 4) + 1, 1]) };
  const cleaned = cleanToneStats(long);
  assert.equal(cleaned.recent.length, MAX_RECENT);
  assert.deepEqual(cleaned.recent[MAX_RECENT - 1], long.recent[long.recent.length - 1], 'keeps the newest');
});

test('recordAnswer is immutable, counts totals and caps the recent window', () => {
  const s0 = emptyToneStats();
  const s1 = recordAnswer(s0, 's', 3, 2);
  assert.deepEqual(s0, emptyToneStats());
  assert.deepEqual(s1.recent, [['s', 3, 2]]);
  assert.deepEqual(s1.total, { 3: [1, 0] });
  const s2 = recordAnswer(s1, 'p', 3, 3);
  assert.deepEqual(s2.total, { 3: [2, 1] });
  assert.deepEqual(recordAnswer(s2, 'q', 3, 3), s2, 'unknown drill ignored');
  assert.deepEqual(recordAnswer(s2, 's', 0, 3), s2, 'invalid tone ignored');
  let s = emptyToneStats();
  for (let i = 0; i < MAX_RECENT + 10; i += 1) s = recordAnswer(s, 's', 1, 1);
  assert.equal(s.recent.length, MAX_RECENT);
  assert.deepEqual(s.total[1], [MAX_RECENT + 10, MAX_RECENT + 10], 'lifetime totals are not capped');
});

test('recordRound keeps the count, the last and the best score', () => {
  let s = recordRound(emptyToneStats(), 's', 15, 20, 1000);
  assert.deepEqual(s.rounds.s, { n: 1, last: [15, 20], best: [15, 20], at: 1000 });
  s = recordRound(s, 's', 18, 20, 2000);
  s = recordRound(s, 's', 12, 20, 3000);
  assert.deepEqual(s.rounds.s, { n: 3, last: [12, 20], best: [18, 20], at: 3000 });
  s = recordRound(s, 'm', 12, 12, 4000);
  assert.deepEqual(s.rounds.m.best, [12, 12]);
  assert.deepEqual(recordRound(s, 's', 21, 20), s, 'impossible score ignored');
  assert.deepEqual(recordRound(s, 's', 0, 0), s, 'empty round ignored');
});

test('confusion matrix, accuracy per tone and top confusions', () => {
  const s = withAnswers([['s', 3, 2, 4], ['s', 3, 3, 6], ['s', 2, 3, 2], ['p', 2, 2, 8], ['p', 5, 1, 1], ['m', 1, 1, 3]]);
  const m = confusionMatrix(s);
  assert.equal(m[3][2], 4);
  assert.equal(m[2][3], 2);
  assert.equal(m[5][1], 1);
  const acc = toneAccuracy(s);
  assert.deepEqual(acc[3], { n: 10, correct: 6, rate: 0.6 });
  assert.deepEqual(acc[2], { n: 10, correct: 8, rate: 0.8 });
  assert.deepEqual(acc[4], { n: 0, correct: 0, rate: null });
  assert.deepEqual(toneAccuracy(s, { drills: ['s'] })[2], { n: 2, correct: 0, rate: 0 });
  assert.deepEqual(topConfusions(s), [{ target: 3, answer: 2, count: 4 }, { target: 2, answer: 3, count: 2 }]);
  assert.deepEqual(topConfusions(s, { min: 1, limit: 5 }).at(-1), { target: 5, answer: 1, count: 1 });
  assert.deepEqual(drillAccuracy(s, ['p']), { n: 9, correct: 8, rate: 8 / 9 });
  assert.deepEqual(drillAccuracy(emptyToneStats(), ['p']), { n: 0, correct: 0, rate: null });
});

test('toneWeights: uniform without data, leaning toward both tones of a confusion', () => {
  const uniform = toneWeights(null);
  for (const t of [1, 2, 3, 4]) assert.ok(Math.abs(uniform[t] - 0.25) < 1e-12);
  const confused = withAnswers([['s', 3, 2, 8], ['s', 3, 3, 12], ['s', 2, 2, 20], ['s', 1, 1, 20], ['s', 4, 4, 20]]);
  const w = toneWeights(confused);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-12, 'sums to 1');
  assert.ok(w[3] > w[1] * 2 && w[3] > w[4] * 2, `tone 3 needs more practice: ${JSON.stringify(w)}`);
  assert.ok(w[2] > w[1] * 2, 'tone 2, the tone it is mistaken for, too');
  assert.ok(w[1] > 0.05 && w[4] > 0.05, 'the floor keeps every tone');
  const five = toneWeights(confused, [1, 2, 3, 4, 5]);
  assert.equal(Object.keys(five).length, 5);
});

// ---------- random helpers ----------

test('mulberry32 is deterministic; shuffle is a permutation', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const list = Array.from({ length: 30 }, (_, i) => i);
  const s = shuffle(list, mulberry32(1));
  assert.notDeepEqual(s, list);
  assert.deepEqual([...s].sort((x, y) => x - y), list);
});

test('spread breaks long runs where possible', () => {
  const out = spread([1, 1, 1, 1, 2, 2, 2, 3, 3, 3], (x) => x, 2);
  assert.ok(maxRun(out, (x) => x) <= 2, out.join(','));
  assert.deepEqual([...out].sort(), [1, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  const one = spread(['a', 'a', 'b', 'b', 'c'], (x) => x, 1);
  assert.ok(maxRun(one, (x) => x) <= 1, one.join(''));
  assert.deepEqual(spread([5, 5, 5], (x) => x, 1), [5, 5, 5], 'impossible: unchanged');
  const tail = spread([1, 2, 1, 2, 3, 3, 3], (x) => x, 2);
  assert.ok(maxRun(tail, (x) => x) <= 2, `a run at the very end is broken up: ${tail.join(',')}`);
});

test('allocate: proportional, with minimum, maximum and exact total', () => {
  assert.deepEqual(allocate({ a: 1, b: 1, c: 1, d: 1 }, 20), { a: 5, b: 5, c: 5, d: 5 });
  const c = allocate({ a: 0.4, b: 0.4, c: 0.1, d: 0.1 }, 20, { min: 2, max: 10 });
  assert.equal(Object.values(c).reduce((x, y) => x + y, 0), 20);
  assert.ok(c.a >= 7 && c.b >= 7 && c.c >= 2 && c.d >= 2, JSON.stringify(c));
  const capped = allocate({ a: 100, b: 1 }, 20, { min: 2, max: 10 });
  assert.deepEqual(capped, { a: 10, b: 10 });
  const tooMany = allocate({ a: 1, b: 1 }, 30, { max: 10 });
  assert.deepEqual(tooMany, { a: 10, b: 10 }, 'cannot exceed the maxima');
  assert.deepEqual(allocate({ a: 1, b: 0 }, 3), { a: 3, b: 0 });
  assert.deepEqual(allocate({}, 3), {});
  const ties = allocate({ a: 1, b: 1, c: 1 }, 4, { rng: mulberry32(3) });
  assert.equal(Object.values(ties).reduce((x, y) => x + y, 0), 4);
});

test('allocate: a maximum per key moves the slots a small key cannot take to the others', () => {
  const caps = { a: 1, b: 5, c: 5 };
  const c = allocate({ a: 1, b: 1, c: 1 }, 9, { max: (k) => caps[k] });
  assert.deepEqual(c, { a: 1, b: 4, c: 4 });
  const withMin = allocate({ a: 1, b: 1, c: 1 }, 9, { min: 2, max: (k) => caps[k] });
  assert.equal(withMin.a, 1, 'the minimum never exceeds a key\'s maximum');
  assert.equal(Object.values(withMin).reduce((x, y) => x + y, 0), 9);
  assert.deepEqual(allocate({ a: 1, b: 1 }, 10, { max: (k) => (k === 'a' ? 2 : 3) }), { a: 2, b: 3 }, 'cannot exceed the maxima');
});

test('weightedSample draws distinct items and favours heavy ones', () => {
  const items = ['heavy', 'a', 'b', 'c', 'd', 'e'];
  let heavy = 0;
  const rng = mulberry32(9);
  for (let i = 0; i < 400; i += 1) {
    const s = weightedSample(items, (x) => (x === 'heavy' ? 10 : 1), 2, rng);
    assert.equal(new Set(s).size, 2);
    if (s.includes('heavy')) heavy += 1;
  }
  assert.ok(heavy > 330, `heavy drawn in ${heavy} of 400`);
  assert.equal(weightedSample(items, () => 1, 99).length, items.length);
});

// ---------- rounds ----------

const INVENTORY = tonesData?.syllables ?? ['ma', 'ba', 'pa', 'da', 'ta', 'na', 'la', 'ga', 'ka', 'ha', 'zha', 'cha', 'sha', 'za', 'ca', 'sa', 'ya', 'wa', 'lü', 'nü', 'ju', 'qu']
  .flatMap((b) => [1, 2, 3, 4].map((t) => `${b}${t}`));

test('buildSyllableRound: 20 recorded syllables, distinct bases, every tone, no long runs', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const round = buildSyllableRound({ syllables: INVENTORY, rng: mulberry32(seed) });
    assert.equal(round.length, ROUND_SIZE.s);
    const inv = new Set(INVENTORY);
    for (const it of round) {
      assert.ok(inv.has(it.syllable), it.syllable);
      assert.equal(it.syllable, `${it.base}${it.tone}`);
    }
    assert.equal(new Set(round.map((it) => it.base)).size, round.length, 'different bases');
    const perTone = count(round, (it) => it.tone);
    for (const t of [1, 2, 3, 4]) assert.ok((perTone.get(t) ?? 0) >= 2, `tone ${t} at least twice`);
    assert.ok(maxRun(round, (it) => it.tone) <= 2, 'no tone three times in a row');
  }
  assert.deepEqual(buildSyllableRound({ syllables: INVENTORY, rng: mulberry32(7) }), buildSyllableRound({ syllables: INVENTORY, rng: mulberry32(7) }), 'reproducible');
  assert.deepEqual(buildSyllableRound({ syllables: [] }), []);
  assert.equal(buildSyllableRound({ syllables: INVENTORY, size: 8, rng: mulberry32(2) }).length, 8);
});

test('buildSyllableRound leans toward the confused tones', () => {
  const stats = withAnswers([['s', 3, 2, 10], ['s', 3, 3, 10], ['s', 2, 3, 6], ['s', 2, 2, 14], ['s', 1, 1, 30], ['s', 4, 4, 30]]);
  let confused = 0;
  let easy = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    const round = buildSyllableRound({ syllables: INVENTORY, stats, rng: mulberry32(seed) });
    const perTone = count(round, (it) => it.tone);
    confused += (perTone.get(2) ?? 0) + (perTone.get(3) ?? 0);
    easy += (perTone.get(1) ?? 0) + (perTone.get(4) ?? 0);
    assert.ok((perTone.get(1) ?? 0) >= 2 && (perTone.get(4) ?? 0) >= 2, 'easy tones still appear');
    assert.ok(Math.max(...perTone.values()) <= 10, 'no tone takes more than half the round');
  }
  assert.ok(confused > easy * 2, `confused ${confused} vs easy ${easy}`);
});

const PAIRS = tonesData?.pairs ?? Object.fromEntries(['11', '12', '13', '14', '15', '21', '22', '23', '24', '25', '31', '32', '34', '35', '41', '42', '43', '44', '45']
  .map((k) => [k, Array.from({ length: 24 }, (_, i) => `w.${k}.${i}`)]));

test('buildPairRound: 20 distinct words, many patterns, tones from the pattern key', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const round = buildPairRound({ pairs: PAIRS, rng: mulberry32(seed) });
    assert.equal(round.length, ROUND_SIZE.p);
    assert.equal(new Set(round.map((it) => it.id)).size, round.length, 'distinct words');
    for (const it of round) {
      assert.ok(PAIRS[it.key].includes(it.id));
      assert.deepEqual(it.tones, [Number(it.key[0]), Number(it.key[1])]);
    }
    assert.ok(new Set(round.map((it) => it.key)).size >= 15, 'without statistics nearly every pattern appears');
    assert.ok(Math.max(...count(round, (it) => it.key).values()) <= 3);
    assert.ok(maxRun(round, (it) => it.key) <= 1, 'never the same pattern twice in a row');
  }
  assert.equal(buildPairRound({ pairs: { 14: ['a', 'b'] }, rng: mulberry32(1) }).length, 2, 'fewer words than the round size');
  assert.deepEqual(buildPairRound({ pairs: { 33: ['x'], 16: ['y'] } }), [], 'invalid keys ignored');
});

test('buildPairRound fills the round when some patterns have only one or two words', () => {
  const sparse = { 11: ['a'], 12: ['b'], 13: ['c'], 14: ['d', 'e', 'f', 'g', 'h'], 21: ['i'], 22: ['j', 'k', 'j'] };
  // At most 3 per pattern: 1 + 1 + 1 + 3 + 1 + 2 = 9 words can be used.
  for (let seed = 1; seed <= 30; seed += 1) {
    const round = buildPairRound({ pairs: sparse, size: 10, rng: mulberry32(seed) });
    assert.equal(round.length, 9, `seed ${seed}`);
    assert.equal(new Set(round.map((it) => it.id)).size, 9, 'distinct words (duplicates in the data collapse)');
  }
  assert.equal(buildPairRound({ pairs: sparse, size: 6, rng: mulberry32(4) }).length, 6);
});

test('buildPairRound leans toward patterns with the confused tones', () => {
  const stats = withAnswers([['p', 5, 1, 12], ['p', 5, 5, 4], ['p', 1, 1, 40], ['p', 2, 2, 40], ['p', 3, 3, 40], ['p', 4, 4, 40]]);
  let neutral = 0;
  let plain = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    for (const it of buildPairRound({ pairs: PAIRS, stats, rng: mulberry32(seed) })) {
      if (it.tones[1] === 5) neutral += 1;
      else plain += 1;
    }
  }
  // 4 of 19 patterns end in a neutral tone: about 21 % without statistics.
  assert.ok(neutral / (neutral + plain) > 0.35, `neutral share ${neutral / (neutral + plain)}`);
});

const MINIMAL = [['w.a.zhi1dao4', 'w.b.zhi2dao4'], ['w.c.na4xie1', 'w.d.na3xie1'], ['w.e.yan3jing5', 'w.f.yan3jing4'], ['w.g.you2yong3', 'w.h.you3yong4']];
/** Tones from the numbered pinyin at the end of a test id ("w.a.zhi1dao4" -> [1, 4]). */
const tonesFromId = (id) => [...id.split('.').pop().matchAll(/[1-5]/g)].map((m) => Number(m[0]));

test('differingPositions and checkTones', () => {
  assert.deepEqual(differingPositions([1, 4], [2, 4]), [0]);
  assert.deepEqual(differingPositions([2, 3], [3, 4]), [0, 1]);
  assert.deepEqual(checkTones([3], [3]), { correct: true, perSyllable: [true] });
  assert.deepEqual(checkTones([1, 5], [1, 4]), { correct: false, perSyllable: [true, false] });
  assert.deepEqual(checkTones([1, 5], [1]), { correct: false, perSyllable: [true, false] });
  assert.equal(checkTones([], []).correct, false);
});

test('buildMinimalRound: distinct pairs, valid targets, tones from tonesOf', () => {
  const round = buildMinimalRound({ minimal: MINIMAL, tonesOf: tonesFromId, rng: mulberry32(5) });
  assert.equal(round.length, MINIMAL.length);
  assert.equal(new Set(round.map((r) => r.ids.join())).size, round.length);
  for (const r of round) {
    assert.ok(r.target === 0 || r.target === 1);
    assert.deepEqual(r.tones, [tonesFromId(r.ids[0]), tonesFromId(r.ids[1])]);
  }
  assert.equal(buildMinimalRound({ minimal: MINIMAL, tonesOf: tonesFromId, size: 2, rng: mulberry32(5) }).length, 2);
  const skipped = buildMinimalRound({
    minimal: [['x', 'x'], ['a', 'b'], ['c', 'd'], ['e', 'f'], ['d', 'c']],
    tonesOf: (id) => ({ a: [1, 4], b: [1, 4], c: [1, 4], d: [2, 4], e: [1], f: null }[id] ?? null),
  });
  assert.deepEqual(skipped.map((r) => r.ids), [['c', 'd']], 'equal tones, unknown tones, duplicates skipped');
  const targets = new Set();
  for (let seed = 1; seed < 20; seed += 1) for (const r of buildMinimalRound({ minimal: MINIMAL, tonesOf: tonesFromId, rng: mulberry32(seed) })) targets.add(r.target);
  assert.deepEqual([...targets].sort(), [0, 1]);
});

test('buildMinimalRound favours pairs that contrast confused tones', () => {
  const stats = withAnswers([['m', 2, 1, 15], ['m', 1, 2, 15], ['s', 3, 3, 40], ['s', 4, 4, 40], ['s', 5, 5, 40]]);
  let first = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const [r] = buildMinimalRound({ minimal: MINIMAL, tonesOf: tonesFromId, stats, size: 1, rng: mulberry32(seed) });
    if (r.ids[0] === 'w.a.zhi1dao4') first += 1; // the only pair contrasting tones 1 and 2
  }
  assert.ok(first > 70, `1-vs-2 pair drawn first in ${first} of 200`);
});

test('roundSummary counts items, tones and confusions', () => {
  const summary = roundSummary([
    { target: [3], answer: [3] },
    { target: [3], answer: [2] },
    { target: [1, 5], answer: [1, 4] },
    { target: [2, 4], answer: [2, 4] },
    { target: [3], answer: [2] },
  ]);
  assert.equal(summary.correct, 2);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.perTone, { 1: { n: 1, correct: 1 }, 2: { n: 1, correct: 1 }, 3: { n: 3, correct: 1 }, 4: { n: 1, correct: 1 }, 5: { n: 1, correct: 0 } });
  assert.deepEqual(summary.confusions, [{ target: 3, answer: 2, count: 2 }, { target: 5, answer: 4, count: 1 }]);
});

test('suggestNext: syllables first, then words, then minimal pairs', () => {
  assert.equal(suggestNext(emptyToneStats()), 'syllables');
  let s = withAnswers([['s', 1, 1, 30], ['s', 2, 3, 10]]);
  assert.equal(suggestNext(s), 'syllables', '75 % is not yet enough');
  s = withAnswers([['s', 1, 1, 36], ['s', 2, 3, 4]]);
  assert.equal(suggestNext(s), 'pairs');
  s = withAnswers([['p', 1, 1, 40]], s);
  assert.equal(suggestNext(s), 'minimal');
});

// ---------- pinyin chart ----------

test('splitSyllable follows standard spelling', () => {
  const cases = {
    ma: ['m', 'a'], zhuang: ['zh', 'uang'], ju: ['j', 'ü'], juan: ['j', 'üan'], jue: ['j', 'üe'], xun: ['x', 'ün'], qiong: ['q', 'iong'],
    lü: ['l', 'ü'], lüe: ['l', 'üe'], lu: ['l', 'u'], nü: ['n', 'ü'], yu: ['', 'ü'], yue: ['', 'üe'], yuan: ['', 'üan'], yun: ['', 'ün'],
    yi: ['', 'i'], you: ['', 'iu'], ye: ['', 'ie'], wu: ['', 'u'], wei: ['', 'ui'], wen: ['', 'un'], weng: ['', 'ueng'], wo: ['', 'uo'],
    zhi: ['zh', '-i'], ri: ['r', '-i'], si: ['s', '-i'], ci: ['c', '-i'], ji: ['j', 'i'], er: ['', 'er'], a: ['', 'a'], o: ['', 'o'],
    eng: ['', 'eng'], ou: ['', 'ou'], diu: ['d', 'iu'], gui: ['g', 'ui'], dun: ['d', 'un'], lo: ['l', 'o'], dia: ['d', 'ia'],
  };
  for (const [base, [initial, final]] of Object.entries(cases)) assert.deepEqual(splitSyllable(base), { initial, final }, base);
  for (const base of ['m', 'n', 'ng', 'hm', 'hng', 'r', '', 'xyz', 'v']) assert.equal(splitSyllable(base), null, base);
});

test('finalGroup groups rows by medial', () => {
  assert.equal(finalGroup('-i'), '');
  assert.equal(finalGroup('er'), '');
  assert.equal(finalGroup('i'), 'i');
  assert.equal(finalGroup('iong'), 'i');
  assert.equal(finalGroup('u'), 'u');
  assert.equal(finalGroup('ueng'), 'u');
  assert.equal(finalGroup('ü'), 'ü');
  assert.equal(finalGroup('ün'), 'ü');
  assert.equal(finalGroup('x'), null);
  assert.equal(CHART_FINALS.length, 38);
  assert.equal(CHART_INITIALS.length, 22);
});

test('chartLayout places every recorded syllable exactly once', () => {
  const layout = chartLayout(INVENTORY);
  const bases = new Set(INVENTORY.map((s) => parseSyllableKey(s).base));
  assert.equal(layout.count, bases.size);
  assert.deepEqual(layout.other, [], 'nothing outside the table');
  const placed = [];
  for (const f of layout.finals) for (const i of layout.initials) {
    const cell = layout.cell(f, i);
    if (cell) {
      placed.push(cell.base);
      assert.deepEqual(splitSyllable(cell.base), { initial: i, final: f });
      assert.deepEqual(cell.tones, [1, 2, 3, 4]);
    }
  }
  assert.equal(placed.length, bases.size);
  assert.equal(new Set(placed).size, placed.length);
  assert.equal(layout.cell('ü', 'j').base, 'ju');
  assert.equal(layout.cell('ü', '').base, 'yu');
  assert.equal(layout.cell('ü', 'l').base, 'lü');
  assert.equal(layout.cell('a', 'zz'), null);
  assert.ok(layout.initials[0] === '' && layout.finals.includes('-i'));
});

test('chartLayout keeps rows and columns in table order and drops empty ones', () => {
  const layout = chartLayout(['ma1', 'ma2', 'yu3', 'ju4', 'hm1', 'zhi1', 'bad', 'ma5']);
  assert.deepEqual(layout.initials, ['', 'm', 'j', 'zh']);
  assert.deepEqual(layout.finals, ['-i', 'a', 'ü']);
  assert.deepEqual(layout.cell('a', 'm'), { base: 'ma', tones: [1, 2] });
  assert.deepEqual(layout.other, ['hm']);
  assert.equal(layout.count, 5);
});

test('DRILLS codes are the ones stored', () => {
  assert.deepEqual(DRILLS, { syllables: 's', pairs: 'p', minimal: 'm' });
});
