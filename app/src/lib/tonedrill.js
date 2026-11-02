// Tone trainer logic. Pure ES module (no DOM, no storage, no network): building drill rounds, checking
// answers, per-tone statistics with confusions, adaptive weighting toward the tones a learner confuses,
// and the layout of the pinyin chart. Used by src/views/tones.js; tested in app/tests/tonedrill.test.mjs.
//
// Design (tone perception research, see the tone trainer notes in docs/RESEARCH.md): identification
// drills in the style of high-variability phonetic training (HVPT): many different syllables, immediate
// feedback after every answer, single syllables before two-syllable words, then minimal pairs. A round
// leans toward the tones the learner confuses but always contains every tone.
//
// Statistics (the view stores them under learn-chinese:v1:tones; local only, never synced):
//   { v: 1,
//     recent: [[drill, target, answer], ...]   the last MAX_RECENT answers, oldest first. drill: 's' single
//                                              syllables, 'p' two-syllable words (one entry per syllable),
//                                              'm' minimal pairs (one entry per syllable whose tone differs);
//                                              target and answer: tones 1-5 (5 = neutral)
//     total: { '1': [answers, correct], ... }  lifetime, per target tone
//     rounds: { s: { n, last: [correct, size], best: [correct, size], at }, p: ..., m: ... } }

import { markSyllable, numberedToMarked, syllablesOf } from './pinyin.js';

export const DRILLS = Object.freeze({ syllables: 's', pairs: 'p', minimal: 'm' });
const DRILL_CODES = Object.freeze(Object.values(DRILLS));
export const TONES = Object.freeze([1, 2, 3, 4, 5]);
export const MAX_RECENT = 400;
export const ROUND_SIZE = Object.freeze({ s: 20, p: 20, m: 12 });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTone = (t) => Number.isInteger(t) && t >= 1 && t <= 5;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const sum = (list) => list.reduce((a, b) => a + b, 0);

// ---------- Syllables and recordings ----------

/** "lü4" -> { base: 'lü', tone: 4 }; also accepts v for ü. null for anything else. */
export function parseSyllableKey(text) {
  const m = /^([a-zü]+)([1-5])$/.exec(String(text ?? '').toLowerCase().replace(/v/g, 'ü'));
  return m ? { base: m[1], tone: Number(m[2]) } : null;
}

/** Recording file name of a syllable: audio-cmn writes ü as v and has ju4 only as jv4 (the same rule as
 * syllableFile() in scripts/build-app-data.mjs, which copies the files). */
export function syllableFile(base, tone) {
  const name = `${base.replace(/ü/g, 'v')}${tone}`;
  return name === 'ju4' ? 'jv4' : name;
}

/** URL of a syllable recording, relative to the app root: ("lü", 4) -> "audio/s/lv4.mp3". */
export const syllableUrl = (base, tone) => `audio/s/${syllableFile(base, tone)}.mp3`;

/** Display form with the tone mark: ("lü", 3) -> "lǚ". */
export const markedSyllable = (base, tone) => markSyllable(base, tone);

// ---------- Words with another pronunciation ----------

/**
 * Other Mainland pronunciations that CC-CEDICT notes in a word's meanings, as tone lists: "also pr.
 * [shang4 mian5]" -> [[4, 5]], "colloquial pr. [nei4]" -> [[4]], "Beijing pr. [zhu2 yi5]" -> [[2, 5]],
 * "also pr. [di4] or [di5] ..." -> [[4], [5]]. "Taiwan pr." readings are not Mainland Mandarin (the
 * recordings are) and are ignored.
 */
export function otherReadings(meanings) {
  const out = [];
  for (const meaning of meanings ?? []) {
    for (const note of String(meaning).matchAll(/\b(?:also|colloquial|Beijing)\s+pr\.\s*((?:\[[^\]]*\]\s*(?:,|or)?\s*)+)/gi)) {
      for (const [, text] of note[1].matchAll(/\[([^\]]*)\]/g)) {
        const tones = syllablesOf(numberedToMarked(text), { strict: false }).map((s) => s.tone);
        if (tones.length) out.push(tones);
      }
    }
  }
  return out;
}

/**
 * True when a noted other pronunciation (otherReadings) has different tones at one of `positions` (default:
 * every syllable), or another number of syllables: the speaker of the recording may have used it, so the
 * tones written in the pinyin are not certain to be the tones heard (上面 shàngmiàn, also shàngmian).
 */
export function tonesInDoubt(tones, meanings, positions = null) {
  const at = positions ?? tones.map((_, i) => i);
  return otherReadings(meanings).some((alt) => alt.length !== tones.length || at.some((i) => alt[i] !== tones[i]));
}

// ---------- Statistics ----------

export function emptyToneStats() {
  return { v: 1, recent: [], total: {}, rounds: {} };
}

/** [answers, correct] with correct <= answers, or null. */
const cleanTotal = (v) => (Array.isArray(v) && v.length === 2 && isCount(v[0]) && isCount(v[1]) && v[1] <= v[0] ? [v[0], v[1]] : null);
/** [correct, size] of a round with 0 < size and correct <= size, or null. */
const cleanScore = (v) => (Array.isArray(v) && v.length === 2 && isCount(v[0]) && isCount(v[1]) && v[1] > 0 && v[0] <= v[1] ? [v[0], v[1]] : null);

/** Untrusted (stored) statistics -> valid statistics; anything malformed is dropped. */
export function cleanToneStats(raw) {
  const out = emptyToneStats();
  if (!isObject(raw)) return out;
  if (Array.isArray(raw.recent)) {
    for (const e of raw.recent) {
      if (Array.isArray(e) && e.length === 3 && DRILL_CODES.includes(e[0]) && isTone(e[1]) && isTone(e[2])) out.recent.push([e[0], e[1], e[2]]);
    }
    out.recent = out.recent.slice(-MAX_RECENT);
  }
  if (isObject(raw.total)) {
    for (const t of TONES) {
      const pair = cleanTotal(raw.total[t]);
      if (pair) out.total[t] = pair;
    }
  }
  if (isObject(raw.rounds)) {
    for (const d of DRILL_CODES) {
      const r = raw.rounds[d];
      if (!isObject(r) || !isCount(r.n) || !isCount(r.at)) continue;
      const last = cleanScore(r.last);
      const best = cleanScore(r.best);
      if (last && best) out.rounds[d] = { n: r.n, last, best, at: r.at };
    }
  }
  return out;
}

/** One answer: `target` is the tone that was played, `answer` the tone the learner chose (1-5). Returns
 * new statistics; invalid input leaves them unchanged. */
export function recordAnswer(stats, drill, target, answer) {
  const out = cleanToneStats(stats);
  if (!DRILL_CODES.includes(drill) || !isTone(target) || !isTone(answer)) return out;
  out.recent.push([drill, target, answer]);
  if (out.recent.length > MAX_RECENT) out.recent.splice(0, out.recent.length - MAX_RECENT);
  const [n, c] = out.total[target] ?? [0, 0];
  out.total[target] = [n + 1, c + (target === answer ? 1 : 0)];
  return out;
}

const ratio = ([correct, size]) => (size > 0 ? correct / size : 0);

/** A finished round of `size` items with `correct` fully right ones. */
export function recordRound(stats, drill, correct, size, at = Date.now()) {
  const out = cleanToneStats(stats);
  if (!DRILL_CODES.includes(drill) || !isCount(correct) || !isCount(size) || correct > size || size === 0) return out;
  const prev = out.rounds[drill];
  const last = [correct, size];
  const better = !prev || ratio(last) > ratio(prev.best) || (ratio(last) === ratio(prev.best) && size > prev.best[1]);
  out.rounds[drill] = { n: (prev?.n ?? 0) + 1, last, best: better ? last : prev.best, at: Math.max(0, Math.round(at)) };
  return out;
}

const pick = (stats, drills) => {
  const list = cleanToneStats(stats).recent;
  return drills ? list.filter(([d]) => drills.includes(d)) : list;
};

/** Counts m[target][answer] (indices 1-5) over the recent answers, optionally of some drills only. */
export function confusionMatrix(stats, { drills = null } = {}) {
  const m = Array.from({ length: 6 }, () => Array(6).fill(0));
  for (const [, t, a] of pick(stats, drills)) m[t][a] += 1;
  return m;
}

/** Recent accuracy per target tone: { 1: { n, correct, rate }, ... 5 }; rate null without answers. */
export function toneAccuracy(stats, { drills = null } = {}) {
  const m = confusionMatrix(stats, { drills });
  const out = {};
  for (const t of TONES) {
    const n = sum(m[t]);
    out[t] = { n, correct: m[t][t], rate: n ? m[t][t] / n : null };
  }
  return out;
}

/** The most frequent mistakes: [{ target, answer, count }], most first (ties: lower tones first). */
export function topConfusions(stats, { drills = null, limit = 3, min = 2 } = {}) {
  const m = confusionMatrix(stats, { drills });
  const out = [];
  for (const target of TONES) for (const answer of TONES) if (target !== answer && m[target][answer] >= min) out.push({ target, answer, count: m[target][answer] });
  out.sort((a, b) => b.count - a.count || a.target - b.target || a.answer - b.answer);
  return out.slice(0, limit);
}

/** Answers and accuracy of some drills over the recent window: { n, correct, rate }. */
export function drillAccuracy(stats, drills) {
  const list = pick(stats, drills);
  const correct = list.filter(([, t, a]) => t === a).length;
  return { n: list.length, correct, rate: list.length ? correct / list.length : null };
}

/**
 * How much practice each tone needs, as weights that sum to 1. A tone's trouble score counts both ways
 * of confusing it: played but answered as another tone (misses), and answered although another tone was
 * played (false alarms), relative to how often it was played, with a prior of one error in four so that
 * a few answers do not swing the weights. `floor` keeps every tone in play. Without answers: uniform.
 */
export function toneWeights(stats, tones = [1, 2, 3, 4], { drills = null, floor = 0.1 } = {}) {
  const m = confusionMatrix(stats, { drills });
  const raw = {};
  for (const t of tones) {
    let heard = 0;
    let miss = 0;
    let falseAlarms = 0;
    for (const a of TONES) {
      heard += m[t][a];
      if (a !== t) miss += m[t][a];
    }
    for (const u of TONES) if (u !== t) falseAlarms += m[u][t];
    raw[t] = floor + Math.min(1, (miss + falseAlarms + 1) / (heard + 4));
  }
  const total = sum(Object.values(raw));
  return Object.fromEntries(Object.entries(raw).map(([t, w]) => [t, w / total]));
}

// ---------- Random helpers (rng: () => [0, 1), e.g. Math.random or mulberry32(seed)) ----------

/** Small seeded generator for reproducible rounds and tests. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of a copy. */
export function shuffle(list, rng = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Reorder so that no more than `maxRun` neighbours share a key, where the list allows it: an item that
 * would extend a run is swapped with the next item of another key, or, near the end of the list, moved
 * back into a gap between two items of other keys. */
export function spread(list, keyOf, maxRun = 2) {
  const out = list.slice();
  const endsRun = (i) => {
    const k = keyOf(out[i]);
    for (let j = 1; j <= maxRun; j += 1) if (i - j < 0 || keyOf(out[i - j]) !== k) return false;
    return true;
  };
  for (let i = maxRun; i < out.length; i += 1) {
    if (!endsRun(i)) continue;
    const k = keyOf(out[i]);
    let j = i + 1;
    while (j < out.length && keyOf(out[j]) === k) j += 1;
    if (j < out.length) {
      [out[i], out[j]] = [out[j], out[i]];
      continue;
    }
    for (let p = 0; p < i; p += 1) {
      if ((p === 0 || keyOf(out[p - 1]) !== k) && keyOf(out[p]) !== k) {
        out.splice(p, 0, ...out.splice(i, 1));
        break;
      }
    }
  }
  return out;
}

/**
 * Split `size` slots between keys in proportion to their weights (largest remainder; ties broken by
 * `rng`), with at least `min` and at most `max` per key (`max`: a number, or a function key -> number for
 * keys that cannot take as many, e.g. a tone pattern with only two words). Returns { key: count }; the
 * counts sum to `size` unless the maxima make that impossible.
 */
export function allocate(weights, size, { min = 0, max = Infinity, rng = Math.random } = {}) {
  const keys = Object.keys(weights).filter((k) => weights[k] > 0);
  const counts = Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  if (!keys.length || size <= 0) return counts;
  const caps = Object.fromEntries(keys.map((k) => [k, Math.max(0, typeof max === 'function' ? max(k) : max)]));
  const floorEach = Math.min(min, Math.floor(size / keys.length));
  for (const k of keys) counts[k] = Math.min(floorEach, caps[k]);
  let left = size - sum(keys.map((k) => counts[k]));
  const tie = Object.fromEntries(keys.map((k) => [k, rng()]));
  while (left > 0) {
    const open = keys.filter((k) => counts[k] < caps[k]);
    if (!open.length) break;
    const total = sum(open.map((k) => weights[k]));
    const shares = open.map((k) => {
      const exact = (left * weights[k]) / total;
      return { k, whole: Math.min(caps[k] - counts[k], Math.floor(exact)), rem: exact - Math.floor(exact) };
    });
    let placed = 0;
    for (const s of shares) {
      counts[s.k] += s.whole;
      placed += s.whole;
    }
    left -= placed;
    if (left <= 0) break;
    shares.sort((a, b) => b.rem - a.rem || tie[b.k] - tie[a.k]);
    for (const s of shares) {
      if (left <= 0) break;
      if (counts[s.k] < caps[s.k]) {
        counts[s.k] += 1;
        left -= 1;
        placed += 1;
      }
    }
    if (!placed) break;
  }
  return counts;
}

/** Weighted sample of `n` distinct items without replacement (Efraimidis-Spirakis keys). */
export function weightedSample(items, weightOf, n, rng = Math.random) {
  return items
    .map((item) => ({ item, key: rng() ** (1 / Math.max(1e-9, weightOf(item))) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, n)
    .map((x) => x.item);
}

// ---------- Rounds ----------

/**
 * Single-syllable round: [{ syllable: 'ma3', base: 'ma', tone: 3 }]. Tones 1-4 in proportion to
 * toneWeights (at least 2 each in a round of 20, at most half the round), every syllable a different
 * base, no tone more than twice in a row.
 */
export function buildSyllableRound({ syllables, stats = null, size = ROUND_SIZE.s, rng = Math.random }) {
  const byTone = new Map([[1, []], [2, []], [3, []], [4, []]]);
  for (const s of syllables ?? []) {
    const p = parseSyllableKey(s);
    if (p && p.tone <= 4) byTone.get(p.tone).push(p.base);
  }
  const tones = [1, 2, 3, 4].filter((t) => byTone.get(t).length);
  if (!tones.length || size <= 0) return [];
  const counts = allocate(toneWeights(stats, tones), size, { min: 2, max: Math.ceil(size / 2), rng });
  const used = new Set();
  const items = [];
  for (const t of tones) {
    for (let k = 0; k < counts[t]; k += 1) {
      const fresh = byTone.get(t).filter((b) => !used.has(b));
      const pool = fresh.length ? fresh : byTone.get(t);
      const base = pool[Math.floor(rng() * pool.length)];
      used.add(base);
      items.push({ syllable: `${base}${t}`, base, tone: t });
    }
  }
  return spread(shuffle(items, rng), (it) => it.tone, 2);
}

/**
 * Two-syllable round from tones.json `pairs` ({ "14": [word ids] }, first tone 1-4, second 1-5):
 * [{ id, key, tones: [t1, t2] }]. Patterns weighted by the trouble of their two tones (at most 3 words
 * of one pattern), distinct words, never the same pattern twice in a row (where possible). "33" is never
 * used: two third tones are spoken 2 + 3, so the citation tones would not be what the learner hears.
 */
export function buildPairRound({ pairs, stats = null, size = ROUND_SIZE.p, rng = Math.random }) {
  const words = {};
  for (const [k, ids] of Object.entries(pairs ?? {})) {
    if (/^[1-4][1-5]$/.test(k) && k !== '33' && Array.isArray(ids) && ids.length) words[k] = [...new Set(ids)];
  }
  const keys = Object.keys(words);
  if (!keys.length || size <= 0) return [];
  const w = toneWeights(stats, TONES);
  const weights = Object.fromEntries(keys.map((k) => [k, (w[k[0]] + w[k[1]]) / 2]));
  const cap = (k) => Math.min(3, words[k].length); // a pattern with fewer words cannot take its full share
  const counts = allocate(weights, Math.min(size, sum(keys.map(cap))), { max: cap, rng });
  const items = [];
  for (const k of keys) {
    for (const id of shuffle(words[k], rng).slice(0, counts[k])) items.push({ id, key: k, tones: [Number(k[0]), Number(k[1])] });
  }
  return spread(shuffle(items, rng), (it) => it.key, 1);
}

/** Positions where two tone lists differ. */
export const differingPositions = (a, b) => a.map((t, i) => (t !== b[i] ? i : -1)).filter((i) => i >= 0);

/**
 * Minimal-pair round from tones.json `minimal` ([[id, id], ...]): [{ ids: [a, b], tones: [[...], [...]],
 * target: 0 | 1 }]. `tonesOf(id)` gives a word's tones (from its current pinyin) or null; pairs whose
 * tones are unknown, of different lengths or equal are skipped, and so are pairs where `inDoubt(id,
 * positions)` says a word may be pronounced with other tones where the two differ (see tonesInDoubt).
 * Pairs are drawn without replacement, weighted by the trouble of the tones that tell them apart.
 */
export function buildMinimalRound({ minimal, tonesOf, inDoubt = null, stats = null, size = ROUND_SIZE.m, rng = Math.random }) {
  const w = toneWeights(stats, TONES);
  const candidates = [];
  const seen = new Set();
  for (const pair of minimal ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1]) continue;
    const key = [...pair].sort().join('|');
    if (seen.has(key)) continue;
    const ta = tonesOf(pair[0]);
    const tb = tonesOf(pair[1]);
    if (!ta || !tb || ta.length !== tb.length) continue;
    const diff = differingPositions(ta, tb);
    if (!diff.length || inDoubt?.(pair[0], diff) || inDoubt?.(pair[1], diff)) continue;
    seen.add(key);
    candidates.push({ ids: [pair[0], pair[1]], tones: [ta, tb], weight: sum(diff.map((i) => (w[ta[i]] + w[tb[i]]) / 2)) / diff.length });
  }
  return weightedSample(candidates, (c) => c.weight, Math.min(size, candidates.length), rng)
    .map(({ ids, tones }) => ({ ids, tones, target: rng() < 0.5 ? 0 : 1 }));
}

// ---------- Answers ----------

/** Compare tone lists: { correct (all right), perSyllable: [bool] }. */
export function checkTones(target, answer) {
  const perSyllable = target.map((t, i) => t === answer[i]);
  return { correct: perSyllable.length > 0 && perSyllable.every(Boolean) && answer.length === target.length, perSyllable };
}

/** Summary of a round: results = [{ target: [tones], answer: [tones] }] -> { correct, total, perTone:
 * { t: { n, correct } }, confusions: [{ target, answer, count }] }. */
export function roundSummary(results) {
  const perTone = {};
  const confusion = new Map();
  let correct = 0;
  for (const { target, answer } of results) {
    if (checkTones(target, answer).correct) correct += 1;
    target.forEach((t, i) => {
      perTone[t] ??= { n: 0, correct: 0 };
      perTone[t].n += 1;
      if (answer[i] === t) perTone[t].correct += 1;
      else if (isTone(answer[i])) {
        const key = `${t}>${answer[i]}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
    });
  }
  const confusions = [...confusion].map(([k, count]) => ({ target: Number(k[0]), answer: Number(k[2]), count }))
    .sort((a, b) => b.count - a.count || a.target - b.target);
  return { correct, total: results.length, perTone, confusions };
}

/** Which drill to suggest next: single syllables until 40 answers at 80 %, then words the same way,
 * then minimal pairs. */
export function suggestNext(stats) {
  const s = drillAccuracy(stats, [DRILLS.syllables]);
  if (s.n < 40 || s.rate < 0.8) return 'syllables';
  const p = drillAccuracy(stats, [DRILLS.pairs]);
  if (p.n < 40 || p.rate < 0.8) return 'pairs';
  return 'minimal';
}

// ---------- Pinyin chart ----------

/** Columns: no initial first, then the initials in the usual teaching order. */
export const CHART_INITIALS = Object.freeze(['', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'zh', 'ch', 'sh', 'r', 'z', 'c', 's']);
/** Rows: finals grouped by medial (none, i, u, ü), written as in the standard tables. "-i" is the vowel of
 * zhi chi shi ri zi ci si; iu, ui, un stand for iou, uei, uen. */
export const CHART_FINALS = Object.freeze([
  '-i', 'a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'ong', 'er',
  'i', 'ia', 'io', 'ie', 'iao', 'iu', 'ian', 'in', 'iang', 'ing', 'iong',
  'u', 'ua', 'uo', 'uai', 'ui', 'uan', 'un', 'uang', 'ueng',
  'ü', 'üe', 'üan', 'ün',
]);
/** Medial group of a final, for row grouping: '' | 'i' | 'u' | 'ü'. */
export function finalGroup(final) {
  const at = CHART_FINALS.indexOf(final);
  if (at < 0) return null;
  if (at < 14) return '';
  if (at < 25) return 'i';
  if (at < 34) return 'u';
  return 'ü';
}

/** Spellings without an initial: y and w stand for the medials i, u, ü (standard orthography). */
const ZERO_INITIAL = Object.freeze({
  yi: 'i', ya: 'ia', yo: 'io', ye: 'ie', yao: 'iao', you: 'iu', yan: 'ian', yin: 'in', yang: 'iang', ying: 'ing', yong: 'iong',
  wu: 'u', wa: 'ua', wo: 'uo', wai: 'uai', wei: 'ui', wan: 'uan', wen: 'un', wang: 'uang', weng: 'ueng',
  yu: 'ü', yue: 'üe', yuan: 'üan', yun: 'ün',
});
const APICAL = new Set(['zh', 'ch', 'sh', 'r', 'z', 'c', 's']);

/**
 * Chart position of a syllable in standard spelling: { initial ('' = none), final }, or null for
 * syllables outside the table (m, n, ng, hm, hng, r). After j, q, x the written u is ü (ju = jü).
 */
export function splitSyllable(base) {
  const b = String(base ?? '').toLowerCase();
  if (Object.hasOwn(ZERO_INITIAL, b)) return { initial: '', final: ZERO_INITIAL[b] };
  if (/^[aoe]/.test(b)) return CHART_FINALS.includes(b) ? { initial: '', final: b } : null;
  const initial = ['zh', 'ch', 'sh'].find((i) => b.startsWith(i)) ?? (b && CHART_INITIALS.includes(b[0]) ? b[0] : null);
  if (!initial) return null;
  let final = b.slice(initial.length);
  if (!final) return null;
  if ('jqx'.includes(initial) && final.startsWith('u')) final = `ü${final.slice(1)}`;
  if (final === 'i' && APICAL.has(initial)) final = '-i';
  return CHART_FINALS.includes(final) ? { initial, final } : null;
}

/**
 * The chart for the recorded syllables (tones.json `syllables`, e.g. ["ma1", ...]):
 * { initials, finals (only those with at least one syllable), cell(final, initial) -> { base, tones } |
 * null, other: bases outside the table, count: number of bases }.
 */
export function chartLayout(syllables) {
  const tonesByBase = new Map();
  for (const s of syllables ?? []) {
    const p = parseSyllableKey(s);
    if (!p || p.tone > 4) continue;
    if (!tonesByBase.has(p.base)) tonesByBase.set(p.base, new Set());
    tonesByBase.get(p.base).add(p.tone);
  }
  const cells = new Map();
  const other = [];
  for (const [base, tones] of tonesByBase) {
    const pos = splitSyllable(base);
    const key = pos && `${pos.final}|${pos.initial}`;
    if (!pos || cells.has(key)) {
      other.push(base);
      continue;
    }
    cells.set(key, { base, tones: [...tones].sort() });
  }
  const finals = CHART_FINALS.filter((f) => CHART_INITIALS.some((i) => cells.has(`${f}|${i}`)));
  const initials = CHART_INITIALS.filter((i) => CHART_FINALS.some((f) => cells.has(`${f}|${i}`)));
  return { initials, finals, cell: (final, initial) => cells.get(`${final}|${initial}`) ?? null, other: other.sort(), count: tonesByBase.size };
}
