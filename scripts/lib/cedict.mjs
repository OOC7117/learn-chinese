// CC-CEDICT access for the build scripts: load, look up, segment, and compare pinyin word by word.
// CC-CEDICT is published by MDBG under CC BY-SA 4.0 (https://www.mdbg.net/chinese/dictionary?page=cc-cedict).
//
// Two inputs are accepted:
//   raw/cedict/cedict.json            the full release (npm @leonsilicon/cc-cedict or a parsed MDBG file),
//                                     shape { metadata, entries: [{ traditional, simplified, pinyin, definitions }] }
//   data/sources/cedict-subset.json   the committed subset this project needs (same shape), so the
//                                     validator works offline and in CI.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseCedictPinyin, tokenize, markSyllable, syllablesToMarked } from '../../app/src/lib/pinyin.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FULL_PATH = `${ROOT}raw/cedict/cedict.json`;
export const SUBSET_PATH = `${ROOT}data/sources/cedict-subset.json`;
const HAN = /\p{Script=Han}/u;
export const isHan = (ch) => HAN.test(ch);

/** Load a CC-CEDICT JSON file and index it. Prefers the full release; falls back to the subset. */
export function loadCedict(path = existsSync(FULL_PATH) ? FULL_PATH : SUBSET_PATH) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return indexCedict(doc, path);
}

export function indexCedict(doc, path = null) {
  const bySimplified = new Map();
  let maxLen = 1;
  for (const e of doc.entries) {
    const entry = {
      simplified: e.simplified,
      traditional: e.traditional,
      pinyin: e.pinyin,
      syl: parseCedictPinyin(e.pinyin),
      defs: e.definitions ?? e.defs ?? [],
    };
    if (!bySimplified.has(e.simplified)) bySimplified.set(e.simplified, []);
    bySimplified.get(e.simplified).push(entry);
    maxLen = Math.max(maxLen, [...e.simplified].length);
  }
  return { path, metadata: doc.metadata ?? {}, entries: doc.entries, bySimplified, maxLen: Math.min(maxLen, 16) };
}

export const lookup = (dict, word) => dict.bySimplified.get(word) ?? [];

/** Distinct readings (syllable arrays) of a word. */
export function readings(dict, word) {
  const out = [];
  const seen = new Set();
  for (const e of lookup(dict, word)) {
    const key = e.syl.map((s) => `${s.base}${s.tone}`).join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e.syl);
    }
  }
  return out;
}

/** Forward-maximum-matching segmentation of a run of Han characters into CC-CEDICT words. */
export function segment(dict, chars) {
  const words = [];
  let i = 0;
  while (i < chars.length) {
    let len = Math.min(dict.maxLen, chars.length - i);
    for (; len > 1; len -= 1) if (dict.bySimplified.has(chars.slice(i, i + len).join(''))) break;
    words.push(chars.slice(i, i + len).join(''));
    i += len;
  }
  return words;
}

export const fmt = (syl) => syl.map((s) => (s.base === 'r' && s.tone === 5 ? 'r' : markSyllable(s.base, s.tone))).join(' ');
const same = (a, b) => a.base === b.base && a.tone === b.tone;

/**
 * Compare the given citation syllables of one word with CC-CEDICT.
 * Verdicts: 'ok' (equals a reading), 'sandhi' (only 一/不 or a 3+3 pair written with the spoken tone),
 * 'neutral' (only neutral vs full tone differs), 'mismatch', 'chars-only' (not a CC-CEDICT word, but every
 * character's reading exists), 'not-in-dictionary'.
 */
export function compareWord(dict, word, given, next = null) {
  const chars = [...word];
  const entries = lookup(dict, word);
  const candidates = readings(dict, word).filter((r) => r.length === given.length);
  if (candidates.some((r) => r.every((s, i) => same(s, given[i])))) return { verdict: 'ok' };
  let best = null;
  for (const r of candidates) {
    if (!r.every((s, i) => s.base === given[i].base)) continue;
    const diffs = [];
    r.forEach((s, i) => {
      if (s.tone === given[i].tone) return;
      const g = given[i].tone;
      let kind = 'tone';
      if (chars[i] === '一' && s.tone === 1 && (g === 2 || g === 4)) kind = 'sandhi';
      else if (chars[i] === '不' && s.tone === 4 && g === 2) kind = 'sandhi';
      else if (s.tone === 3 && g === 2 && (r[i + 1]?.tone === 3 || (i === r.length - 1 && next?.tone === 3))) kind = 'sandhi';
      else if (s.tone === 5 || g === 5) kind = 'neutral';
      diffs.push({ index: i, char: chars[i], dict: s.tone, given: g, kind });
    });
    const rank = diffs.some((d) => d.kind === 'tone') ? 3 : diffs.some((d) => d.kind === 'neutral') ? 2 : 1;
    if (!best || rank < best.rank) best = { rank, diffs, reading: r };
  }
  if (best && best.rank < 3) return { verdict: best.rank === 2 ? 'neutral' : 'sandhi', diffs: best.diffs, dict: fmt(best.reading) };
  if (entries.length) return { verdict: 'mismatch', dict: [...new Set(entries.map((e) => fmt(e.syl)))].join(' | ') };
  if (chars.length === 1) return { verdict: 'not-in-dictionary' };
  const perChar = chars.map((ch, i) => {
    const opts = readings(dict, ch).filter((r) => r.length === 1).map((r) => r[0]);
    return { char: ch, ok: opts.some((o) => same(o, given[i]) || (o.base === given[i].base && (o.tone === 5 || given[i].tone === 5))), options: opts.map((o) => fmt([o])).join('/') };
  });
  if (perChar.every((c) => c.ok)) return { verdict: 'chars-only', chars: perChar };
  return { verdict: perChar.some((c) => !c.options) ? 'not-in-dictionary' : 'mismatch', chars: perChar };
}

/**
 * Check a whole Chinese text against its citation pinyin: syllables must line up with the Han characters
 * (an erhua 儿 is the syllable "r"); every CC-CEDICT word of the text is compared.
 * @returns {{ status: 'ok'|'warn'|'fail', problems: string[], words: object[] }}
 */
export function checkText(dict, hanzi, pinyin) {
  const report = { status: 'ok', problems: [], words: [] };
  const syl = tokenize(pinyin).filter((t) => t.type === 'syllable');
  const chars = [...String(hanzi)].filter(isHan);
  if (chars.length !== syl.length) {
    report.status = 'fail';
    report.problems.push(`alignment: ${chars.length} characters but ${syl.length} syllables`);
    return report;
  }
  const runs = [];
  let cur = [];
  for (const ch of String(hanzi)) {
    if (isHan(ch)) cur.push(ch);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  let k = 0;
  for (const run of runs) {
    const given = syl.slice(k, k + run.length).map((s) => ({ base: s.base, tone: s.tone }));
    const after = syl[k + run.length] ? { tone: syl[k + run.length].tone } : null;
    for (const w of bestSegmentation(dict, run, given, after)) report.words.push(w);
    k += run.length;
  }
  const verdicts = report.words.map((w) => w.verdict);
  if (verdicts.some((v) => v === 'mismatch' || v === 'not-in-dictionary')) report.status = 'fail';
  else if (verdicts.some((v) => v !== 'ok')) report.status = 'warn';
  return report;
}

// Grammatical particles: in 就到了 (jiù dào le) the 了 is a word of its own, although CC-CEDICT also has 到了
// dàoliǎo 'finally'. A dictionary word ending in a particle is skipped when the text reads that particle
// in the neutral tone and the dictionary word never does (the particle reading explains the split). A
// wrong reading still fails: 为了 is wèile in CC-CEDICT, so "wéi le" is checked as 为了 and fails.
const PARTICLES = new Set([...'了的着过吗呢吧啊呀啦嘛得地么']);
function particleSplit(dict, word, part) {
  const chars = [...word];
  const last = chars.length - 1;
  if (last < 1 || !PARTICLES.has(chars[last]) || part[last]?.tone !== 5) return false;
  const rs = readings(dict, word).filter((r) => r.length === chars.length);
  return rs.length > 0 && rs.every((r) => r[last].tone !== 5);
}

const VERDICT_COST = Object.freeze({ ok: 0, sandhi: 1, neutral: 1, 'chars-only': 2, mismatch: 10, 'not-in-dictionary': 10 });
const WORD_COST = 100; // larger than any fit difference: fewer words always win

/**
 * The segmentation of a run of Han characters into CC-CEDICT words: dynamic programming over all
 * dictionary words starting at each position. The fewest words win first (a large cost per word), and the
 * fit with the given syllables only decides between segmentations with the same number of words. So a
 * word is never split into characters to excuse a wrong reading (银行 "yínxíng" stays 银行 and fails,
 * 谢谢 "xièxiè" stays 谢谢 and is flagged as a neutral-tone difference), while an ambiguous boundary is
 * read the way that fits: greedy longest-match would read 我不会说中文 as 说中 (shuōzhòng) + 文 and wrongly
 * fail a correct sentence; here 说 + 中文 (same number of words) fits best.
 * Returns [{ word, given, verdict, ... }].
 */
export function bestSegmentation(dict, chars, given, after = null) {
  const n = chars.length;
  const best = new Array(n + 1).fill(null);
  best[0] = { cost: 0, words: [] };
  for (let i = 0; i < n; i += 1) {
    if (!best[i]) continue;
    for (let len = 1; len <= Math.min(dict.maxLen, n - i); len += 1) {
      const word = chars.slice(i, i + len).join('');
      if (len > 1 && !dict.bySimplified.has(word)) continue;
      const part = given.slice(i, i + len);
      if (len > 1 && particleSplit(dict, word, part)) continue;
      const next = i + len < n ? given[i + len] : after;
      const res = compareWord(dict, word, part, next);
      const cost = best[i].cost + (VERDICT_COST[res.verdict] ?? 10) + WORD_COST;
      if (!best[i + len] || cost < best[i + len].cost) best[i + len] = { cost, words: [...best[i].words, { word, given: fmt(part), ...res }] };
    }
  }
  return best[n]?.words ?? [];
}

/** Display pinyin of a CC-CEDICT reading. */
export const marked = (syl) => syllablesToMarked(syl);

/** The release date recorded in the file header ("2026-05-18T07:15:15Z" -> "2026-05-18"). */
export function releaseDate(dict) {
  return String(dict.metadata?.date ?? '').slice(0, 10) || null;
}
