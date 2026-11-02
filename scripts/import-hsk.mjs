#!/usr/bin/env node
// Build the canonical HSK vocabulary (data/hsk/) from the upstream sources in raw/ (see
// scripts/fetch-sources.mjs). Run: node scripts/import-hsk.mjs
//
// One item per (simplified characters, citation pinyin), tagged with three independent levels
// (docs/RESEARCH.md, "Which HSK list"):
//   levels.exam2025  the official 2025 HSK exam syllabus (CLEC 2025-11; first regular exam 2026-12-13): PRIMARY
//   levels.std2021   the GF 0025-2021 standard (ivankra/hsk30)
//   levels.hsk20     HSK 2.0 (2012), "not in 2.0" = null (clem109/hsk-vocabulary)
// Every item's pinyin is compared with CC-CEDICT; meanings come from the CC-CEDICT entries of the same
// reading; frequency from wordfreq; audio from audio-cmn where the file name fixes the reading
// unambiguously (otherwise the browser's zh-CN voice: kind "tts").
// Disagreements with CC-CEDICT get an entry in data/hsk/resolutions.json; decisions already there are
// kept. Nothing here is AI-generated.

import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { citationPinyin, markSyllable, syllablesOf, toNumbered, tokenize, normalize } from '../app/src/lib/pinyin.js';
import { compareWord, loadCedict, readings, lookup, fmt, releaseDate, ROOT } from './lib/cedict.mjs';
import { parseCsv } from './lib/csv.mjs';
import { parseSyllabusText } from './lib/syllabus2025.mjs';
import { decodeMsgpack, wordfreqTable } from './lib/msgpack.mjs';

const RAW = join(ROOT, 'raw');
const DATA = join(ROOT, 'data');
const ACCESSED = '2026-11-02';
const writeJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
};
const isHan = (ch) => /\p{Script=Han}/u.test(ch);

// ---------- Sources ----------

export const SOURCE_INFO = {
  exam2025: {
    id: 'hsk2025-syllabus',
    url: 'https://github.com/docrealm/docs-hsk/blob/bdff23362be0ffb4020505b7333a4443bcaa9ec1/HSK%203/HSK%203-2025/%E6%96%B0%E7%89%88HSK%E8%80%83%E8%AF%95%E5%A4%A7%E7%BA%B2.pdf',
    title: '中文水平考试 HSK考试大纲 (CLEC, 2025-11), 词汇大纲',
  },
  std2021: { id: 'hsk2021-ivankra', url: 'https://github.com/ivankra/hsk30/blob/4ff9e3915ce87baaecd7ebe263085573a4ea3192/hsk30-expanded.csv', title: 'GF 0025-2021 word list, cleaned by ivankra/hsk30' },
  hsk20: { id: 'hsk20-clem109', url: 'https://github.com/clem109/hsk-vocabulary/tree/f3dc9d12ae00d04fa3676b0bd4c43cd58de2c264/hsk-vocab-json', title: 'HSK 2.0 word lists, clem109/hsk-vocabulary' },
};

function loadSyllabus() {
  const pdf = join(RAW, 'hsk2025', 'syllabus.pdf');
  const txt = join(RAW, 'hsk2025', 'syllabus.txt');
  if (!existsSync(txt)) execFileSync('pdftotext', ['-layout', pdf, txt], { stdio: ['ignore', 'ignore', 'ignore'] });
  const { rows, problems } = parseSyllabusText(readFileSync(txt, 'utf8'));
  if (problems.length) throw new Error(`syllabus parse problems: ${JSON.stringify(problems.slice(0, 5))}`);
  return rows;
}

function loadStd2021() {
  return parseCsv(readFileSync(join(RAW, 'hsk2021', 'hsk30-expanded.csv'), 'utf8'));
}

function loadHsk20() {
  const out = [];
  for (let level = 1; level <= 6; level += 1) {
    const rows = JSON.parse(readFileSync(join(RAW, 'hsk20', `hsk-level-${level}.json`), 'utf8'));
    for (const r of rows) out.push({ level, id: r.id, hanzi: r.hanzi.trim(), pinyin: r.pinyin.trim() });
  }
  return out;
}

function loadWordfreq() {
  return wordfreqTable(decodeMsgpack(gunzipSync(readFileSync(join(RAW, 'wordfreq', 'large_zh.msgpack.gz')))));
}

function loadAudioIndex() {
  const syl = new Set(readdirSync(join(RAW, 'audio-cmn', '64k', 'syllabs')).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(4, -4)));
  const words = new Set(readdirSync(join(RAW, 'audio-cmn', '24k-abr', 'hsk')).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(4, -4).normalize('NFC')));
  return { syl, words };
}

// ---------- Helpers ----------

/** "爱好" + "ài hào" -> "w.7231-597d.ai4hao4" (stable, ASCII, the same in every list). */
export function itemId(hanzi, pinyin) {
  const hex = [...hanzi].map((ch) => ch.codePointAt(0).toString(16)).join('-');
  const py = syllablesOf(pinyin, { strict: false }).map((s) => `${s.base.replace(/ü/g, 'v')}${s.tone}`).join('');
  return `w.${hex}.${py}`;
}

const tonelessKey = (pinyin) => syllablesOf(pinyin, { strict: false }).map((s) => s.base).join(' ');
const numberedKey = (pinyin) => toNumbered(pinyin);

/** Clean the 2021 / 2.0 pinyin spellings: drop separable-verb marks (∥, //) and the light-tone dot;
 * erhua written as a separate syllable ("yī huì r", "shǐ jìn ér" for 使劲儿) becomes a final r. */
function cleanPinyin(p, hanzi = '') {
  let out = normalize(p).replace(/∥|\/\//g, '').replace(/·/g, '').replace(/\s+/g, ' ').trim();
  out = out.replace(/\s+r(?=$|[\s,.;!?])/g, 'r');
  return out;
}

const VERDICT_RANK = { ok: 0, sandhi: 1, neutral: 1, 'chars-only': 2, mismatch: 3, 'not-in-dictionary': 3 };

/**
 * Pinyin of one list entry, robust to sources that drop the apostrophe ("téngài", "gǎnēn"): the strict
 * reading is used unless a lenient split lines up with the characters and matches CC-CEDICT better, in
 * which case the apostrophe is restored ("téng'ài"). Returns null when nothing lines up.
 */
function wordPinyin(hanzi, text, dict) {
  const chars = [...hanzi].filter(isHan);
  const variants = [];
  // "shǐ jìn ér" may be the erhua 使劲儿 (shǐjìnr) or a real ér (女儿 nǚ'ér): try both, CC-CEDICT decides.
  const texts = [text];
  if (hanzi.endsWith('儿') && / ?ér$/.test(text)) texts.push(text.replace(/ ?ér$/, 'r'));
  for (const [t, lenient] of texts.flatMap((x) => [[x, false], [x, true]])) {
    const tokens = tokenize(t, { lenient });
    if (tokens.some((t) => t.type === 'unknown')) continue;
    const syl = tokens.filter((t) => t.type === 'syllable');
    if (syl.length !== chars.length) continue;
    const display = tokens.map((x) => x.text).join('');
    const verdict = compareWord(dict, hanzi, syl.map((x) => ({ base: x.base, tone: x.tone }))).verdict;
    variants.push({ display, verdict, lenient: lenient || t !== text });
  }
  if (!variants.length) return null;
  variants.sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || Number(a.lenient) - Number(b.lenient));
  return variants[0].display;
}

const CL = /^CL:(.+)$/;
/** CC-CEDICT definitions -> { meanings, classifiers }: measure words split off, variant cross-references
 * dropped when there is a real meaning, surnames moved last. */
export function cleanDefinitions(defsList) {
  const meanings = [];
  const classifiers = [];
  const surnames = [];
  for (const def of defsList) {
    const d = def.trim();
    const cl = CL.exec(d);
    if (cl) {
      for (const part of cl[1].split(',')) {
        const m = /(?:[^|[]+\|)?([^[]+)\[/.exec(part.trim());
        const c = m ? m[1].trim() : part.trim();
        if (c && !classifiers.includes(c)) classifiers.push(c);
      }
      continue;
    }
    if (/^surname /i.test(d)) surnames.push(d);
    else if (!meanings.includes(d)) meanings.push(d);
  }
  const real = meanings.filter((d) => !/^(old |archaic |)variant of |^see [^ ]+\[|^erhua variant of /i.test(d));
  const kept = real.length ? real : meanings;
  return { meanings: [...kept, ...surnames].slice(0, 12), classifiers };
}

// ---------- Build ----------

export function buildItems({ syllabus, std2021, hsk20, dict, freq, audio }) {
  const items = new Map(); // id -> item
  const byHanzi = new Map(); // hanzi -> [ids]
  const problems = [];

  function addItem(hanzi, pinyin, origin) {
    const id = itemId(hanzi, pinyin);
    if (!items.has(id)) {
      items.set(id, {
        id,
        hanzi,
        pinyin,
        pinyin_official: null,
        pinyin_alt: [],
        pos: [],
        levels: { exam2025: null, std2021: null, hsk20: null },
        exam2025: [],
        std2021: [],
        hsk20: [],
        source: origin,
      });
      if (!byHanzi.has(hanzi)) byHanzi.set(hanzi, []);
      byHanzi.get(hanzi).push(id);
    }
    return items.get(id);
  }

  /** The existing item a secondary list's row belongs to: same characters and same syllables, tones
   * equal or differing only in neutral vs full tone. */
  function matchExisting(hanzi, pinyin) {
    const ids = byHanzi.get(hanzi) ?? [];
    const key = numberedKey(pinyin);
    const exact = ids.find((id) => numberedKey(items.get(id).pinyin) === key);
    if (exact) return { item: items.get(exact), exact: true };
    const given = syllablesOf(pinyin, { strict: false });
    const loose = ids.find((id) => {
      const have = syllablesOf(items.get(id).pinyin, { strict: false });
      return have.length === given.length && have.every((s, i) => s.base === given[i].base && (s.tone === given[i].tone || s.tone === 5 || given[i].tone === 5));
    });
    return loose ? { item: items.get(loose), exact: false } : null;
  }

  const levelRank = (l) => (l === '7-9' ? 7 : Number(l));
  const minLevel = (a, b) => (a === null ? b : levelRank(b) < levelRank(a) ? b : a);

  // 1. The 2025 syllabus (primary).
  for (const row of syllabus) {
    const [mainPrinted, ...alts] = row.pinyin_as_printed.split('/').map((s) => s.trim());
    const parsed = wordPinyin(row.word, citationPinyin(row.word, cleanPinyin(mainPrinted, row.word)), dict);
    const citation = parsed && citationPinyin(row.word, parsed);
    if (!citation) {
      problems.push({ list: 'exam2025', seq: row.seq, word: row.word, pinyin: row.pinyin_as_printed, why: 'pinyin does not line up with the characters' });
      continue;
    }
    const item = addItem(row.word, citation, 'hsk2025-syllabus');
    item.pinyin_official ??= row.pinyin_as_printed;
    for (const alt of alts) {
      const a = wordPinyin(row.word, citationPinyin(row.word, cleanPinyin(alt, row.word)), dict);
      if (a && !item.pinyin_alt.includes(a)) item.pinyin_alt.push(a);
    }
    item.exam2025.push({ seq: row.seq, level: row.level, extra_levels: row.extra_levels, sense: row.sense, pos: row.pos_as_printed });
    item.levels.exam2025 = minLevel(item.levels.exam2025, row.level);
    for (const p of row.pos) if (!item.pos.includes(p)) item.pos.push(p);
  }

  // 2. The 2021 standard.
  for (const row of std2021) {
    const hanzi = row.Simplified.trim();
    if (!hanzi || ![...hanzi].every(isHan)) {
      problems.push({ list: 'std2021', id: row.ID, word: hanzi, why: 'not plain Han characters' });
      continue;
    }
    const pinyin = wordPinyin(hanzi, cleanPinyin(row.Pinyin, hanzi), dict);
    if (!pinyin) {
      problems.push({ list: 'std2021', id: row.ID, word: hanzi, pinyin: row.Pinyin, why: 'pinyin does not line up with the characters' });
      continue;
    }
    const found = matchExisting(hanzi, pinyin);
    const item = found ? found.item : addItem(hanzi, pinyin, 'hsk2021-ivankra');
    const level = row.Level.trim();
    item.std2021.push({ id: row.ID, level, pinyin: found && !found.exact ? pinyin : undefined, example_only: row.Example ? true : undefined });
    if (!row.Example) item.levels.std2021 = minLevel(item.levels.std2021, level);
  }

  // 3. HSK 2.0.
  for (const row of hsk20) {
    const pinyin = [...row.hanzi].every(isHan) ? wordPinyin(row.hanzi, cleanPinyin(row.pinyin, row.hanzi), dict) : null;
    if (!pinyin) {
      problems.push({ list: 'hsk20', id: row.id, word: row.hanzi, pinyin: row.pinyin, why: 'pinyin does not line up with the characters' });
      continue;
    }
    const found = matchExisting(row.hanzi, pinyin);
    const item = found ? found.item : addItem(row.hanzi, pinyin, 'hsk20-clem109');
    item.hsk20.push({ id: row.id, level: row.level, pinyin: found && !found.exact ? pinyin : undefined });
    item.levels.hsk20 = item.levels.hsk20 === null ? row.level : Math.min(item.levels.hsk20, row.level);
  }

  applyDecisions(items, byHanzi, decisionsFile());
  // 4. Dictionary check, meanings, frequency, audio.
  for (const item of items.values()) {
    const syl = syllablesOf(item.pinyin, { strict: false });
    const res = compareWord(dict, item.hanzi, syl);
    const entries = lookup(dict, item.hanzi);
    const sameReading = entries.filter((e) => e.syl.length === syl.length && e.syl.every((s, i) => s.base === syl[i].base && s.tone === syl[i].tone));
    const looseReading = entries.filter((e) => e.syl.length === syl.length && e.syl.every((s, i) => s.base === syl[i].base && (s.tone === syl[i].tone || s.tone === 5 || syl[i].tone === 5)));
    const used = sameReading.length ? sameReading : looseReading.length ? looseReading : [];
    const { meanings, classifiers } = cleanDefinitions(used.flatMap((e) => e.defs));
    item.meanings = meanings;
    item.classifiers = classifiers;
    item.cedict = {
      match: res.verdict,
      readings: readings(dict, item.hanzi).map((r) => fmt(r)),
      entries: used.map((e) => `${e.traditional}|${e.simplified}[${e.pinyin}]`),
    };
    const f = freq.get(item.hanzi) ?? (item.hanzi.endsWith('儿') ? freq.get(item.hanzi.slice(0, -1)) : null) ?? null;
    item.freq = f ? { zipf: f.zipf, rank: f.rank } : null;
    item.audio = chooseAudio(item, syl, dict, audio);
    item.source_url = SOURCE_INFO[item.exam2025.length ? 'exam2025' : item.std2021.length ? 'std2021' : 'hsk20'].url;
    item.verified_against = `CC-CEDICT ${releaseDate(dict)}`;
  }
  return { items, problems };
}

/** Decisions already recorded in data/hsk/resolutions.json (reviewed or rule-based). */
function decisionsFile() {
  const path = join(DATA, 'hsk', 'resolutions.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')).resolutions.filter((r) => r.decision && r.decision !== 'pending' && r.decision !== 'keep-hsk');
}

/**
 * Apply recorded decisions before the dictionary check: use-cedict replaces the reading (the id stays,
 * so progress survives), alt-of merges a variant reading into its main item, exclude drops the item.
 */
export function applyDecisions(items, byHanzi, decisions) {
  const levelRank = (l) => (l === null ? 99 : l === '7-9' ? 7 : Number(l));
  for (const d of decisions) {
    const item = items.get(d.id);
    if (!item) continue;
    if (d.decision === 'use-cedict' && d.pinyin_used) {
      item.pinyin_source = item.pinyin;
      item.pinyin = d.pinyin_used;
    } else if (d.decision === 'alt-of' && d.alt_of) {
      const [hanzi, ...rest] = d.alt_of.split(' ');
      const key = toNumbered(rest.join(' '));
      const targetId = (byHanzi.get(hanzi) ?? []).find((id) => id !== d.id && toNumbered(items.get(id).pinyin) === key);
      const target = targetId ? items.get(targetId) : null;
      if (!target) throw new Error(`alt-of target ${d.alt_of} not found for ${d.id}`);
      const variant = d.pinyin_used ?? item.pinyin;
      if (!target.pinyin_alt.includes(variant)) target.pinyin_alt.push(variant);
      for (const list of ['exam2025', 'std2021', 'hsk20']) {
        target[list].push(...item[list].map((row) => ({ ...row, variant })));
        const a = target.levels[list];
        const b = item.levels[list];
        if (b !== null && (a === null || levelRank(b) < levelRank(a))) target.levels[list] = b;
      }
      items.delete(d.id);
      byHanzi.set(hanzi, (byHanzi.get(hanzi) ?? []).filter((id) => id !== d.id));
    } else if (d.decision === 'exclude') {
      items.delete(d.id);
      byHanzi.set(d.hanzi, (byHanzi.get(d.hanzi) ?? []).filter((id) => id !== d.id));
    }
  }
}

/**
 * Audio with a guaranteed reading, else the browser voice:
 *  - one syllable with tone 1-4: the syllable recording named by that exact syllable (Chen Wang);
 *  - several syllables: the word recording (Yue Tan) only when CC-CEDICT knows exactly one reading of
 *    these characters and it equals ours (a recording named by characters cannot show which reading it is);
 *  - everything else (neutral-tone particles, polyphonic words, words without recording): "tts".
 */
function chooseAudio(item, syl, dict, audio) {
  if (syl.length === 1 && syl[0].tone >= 1 && syl[0].tone <= 4) {
    const name = `${syl[0].base.replace(/ü/g, 'v')}${syl[0].tone}`;
    if (audio.syl.has(name)) return { kind: 'syllable', file: `s/${name}.mp3`, speaker: 'Chen Wang', source: 'audio-cmn' };
  }
  if (syl.length > 1 && audio.words.has(item.hanzi)) {
    const rs = readings(dict, item.hanzi);
    const unique = rs.length === 1 && rs[0].length === syl.length && rs[0].every((s, i) => s.base === syl[i].base && s.tone === syl[i].tone);
    if (unique) return { kind: 'word', file: `w/${item.id}.mp3`, speaker: 'Yue Tan', source: 'audio-cmn', from: `24k-abr/hsk/cmn-${item.hanzi}.mp3` };
    return { kind: 'tts', reason: rs.length > 1 ? 'recording exists but CC-CEDICT lists more than one reading' : 'recording reading does not match CC-CEDICT' };
  }
  return { kind: 'tts', reason: syl.length === 1 ? (syl[0].tone === 5 ? 'neutral-tone syllable (no verified recording)' : 'no syllable recording') : 'no recording' };
}

// ---------- Resolutions ----------

const AUTO = {
  neutral: 'The official list and CC-CEDICT differ only in a neutral vs full tone. The exam list is the standard the learner is tested on, so its reading is kept; the CC-CEDICT reading is shown as an alternative.',
  'chars-only': 'Not a CC-CEDICT headword (a phrase or compound listed by HSK). Every character\'s reading exists in CC-CEDICT, so the HSK reading is kept.',
  sandhi: 'The source wrote a tone change (tone sandhi). Stored in citation tones; the spoken form is shown as a hint.',
};

function syncResolutions(items, path) {
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { resolutions: [] };
  const byId = new Map(existing.resolutions.map((r) => [r.id, r]));
  // Decisions that removed or changed an item are kept as they are (the item no longer disagrees).
  const out = existing.resolutions.filter((r) => ['use-cedict', 'alt-of', 'exclude'].includes(r.decision));
  const kept = new Set(out.map((r) => r.id));
  for (const item of items.values()) {
    if (item.cedict.match === 'ok' || kept.has(item.id)) continue;
    const prev = byId.get(item.id);
    const base = {
      id: item.id,
      hanzi: item.hanzi,
      pinyin: item.pinyin,
      category: item.cedict.match,
      cedict_readings: item.cedict.readings,
      lists: Object.entries(item.levels).filter(([, v]) => v !== null).map(([k, v]) => `${k}:${v}`),
    };
    if (prev && prev.category === item.cedict.match && prev.decision && prev.decision !== 'pending') out.push({ ...base, decision: prev.decision, pinyin_used: prev.pinyin_used ?? item.pinyin, note: prev.note, sources: prev.sources ?? [], decided_by: prev.decided_by });
    else if (AUTO[item.cedict.match]) out.push({ ...base, decision: 'keep-hsk', pinyin_used: item.pinyin, note: AUTO[item.cedict.match], sources: [], decided_by: 'rule' });
    else out.push({ ...base, decision: 'pending', pinyin_used: item.pinyin, note: 'Needs a decision with a source (validator fails until resolved).', sources: [], decided_by: null });
  }
  writeJson(path, {
    about: 'Every HSK word whose pinyin is not exactly a CC-CEDICT reading, with an explicit decision. decision: keep-hsk | use-cedict | exclude | pending. Rule-based decisions say so in decided_by; reviewed ones name the reviewer and sources.',
    resolutions: out.sort((a, b) => (a.id < b.id ? -1 : 1)),
  });
  return out;
}

// ---------- Main ----------

function main() {
  const dict = loadCedict(join(RAW, 'cedict', 'cedict.json'));
  const syllabus = loadSyllabus();
  const std2021 = loadStd2021();
  const hsk20 = loadHsk20();
  const freq = loadWordfreq();
  const audio = loadAudioIndex();
  const { items, problems } = buildItems({ syllabus, std2021, hsk20, dict, freq, audio });

  // Derived copy of the official 2025 rows (reviewable without the PDF).
  writeJson(join(DATA, 'sources', 'hsk2025-syllabus.json'), {
    source: SOURCE_INFO.exam2025,
    file_sha256: 'ec74ce0439e837bbb15154be13e747ae798903b2fd3a331629df6c3b45504941',
    published: '2025-11 发布, 2026-07 实施; first regular worldwide sitting 2026-12-13',
    accessed: ACCESSED,
    rows: syllabus,
  });

  const resolutions = syncResolutions(items, join(DATA, 'hsk', 'resolutions.json'));
  const decisions = new Map(resolutions.map((r) => [r.id, r]));
  for (const item of items.values()) item.resolution = decisions.get(item.id)?.decision ?? null;

  // Canonical files, one per 2025 level (+ words only in the older lists).
  const groups = new Map();
  for (const item of items.values()) {
    const key = item.levels.exam2025 ?? 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const order = (a, b) => (a.freq?.rank ?? 1e9) - (b.freq?.rank ?? 1e9) || (a.exam2025[0]?.seq ?? 1e9) - (b.exam2025[0]?.seq ?? 1e9) || (a.id < b.id ? -1 : 1);
  const counts = {};
  for (const [key, list] of groups) {
    list.sort(order);
    counts[key] = list.length;
    writeJson(join(DATA, 'hsk', `words-${key}.json`), {
      about: key === 'other'
        ? 'Words of the GF 0025-2021 standard or HSK 2.0 that are not in the 2025 exam syllabus. Sorted by frequency.'
        : `Words whose (first) level in the 2025 HSK exam syllabus is ${key}. Sorted by frequency (wordfreq), then syllabus number.`,
      cedict: { release: releaseDate(dict), licence: 'CC BY-SA 4.0', url: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict' },
      wordfreq: { version: '3.1.1', list: 'zh large', licence: 'CC BY-SA 4.0 (data)' },
      items: list,
    });
  }

  // The CC-CEDICT entries this project uses (offline validation; also every single character).
  const needed = new Set();
  for (const item of items.values()) {
    needed.add(item.hanzi);
    for (const ch of item.hanzi) needed.add(ch);
  }
  const extra = existsSync(join(DATA, 'sources', 'cedict-needed.txt')) ? readFileSync(join(DATA, 'sources', 'cedict-needed.txt'), 'utf8').split('\n').filter(Boolean) : [];
  for (const w of extra) needed.add(w);
  writeJson(join(DATA, 'sources', 'cedict-subset.json'), {
    metadata: { ...dict.metadata, subset: 'entries whose simplified form is an HSK word, a character of one, or listed in data/sources/cedict-needed.txt' },
    entries: dict.entries.filter((e) => needed.has(e.simplified)),
  });

  // Character sets for the validator: characters of CC-CEDICT simplified headwords, and characters that
  // occur only in traditional headwords (a phrase containing one mixes in traditional characters).
  const simp = new Set();
  const trad = new Set();
  for (const e of dict.entries) {
    for (const ch of e.simplified) if (isHan(ch)) simp.add(ch);
    for (const ch of e.traditional) if (isHan(ch)) trad.add(ch);
  }
  const tradOnly = [...trad].filter((ch) => !simp.has(ch));
  writeJson(join(DATA, 'sources', 'charset.json'), {
    about: `From CC-CEDICT ${releaseDate(dict)}: "simplified" = every Han character in a simplified headword; "traditional_only" = characters that appear only in traditional headwords.`,
    simplified: [...simp].sort().join(''),
    traditional_only: tradOnly.sort().join(''),
  });

  const audioCounts = {};
  for (const item of items.values()) audioCounts[item.audio.kind] = (audioCounts[item.audio.kind] ?? 0) + 1;
  const matchCounts = {};
  for (const item of items.values()) matchCounts[item.cedict.match] = (matchCounts[item.cedict.match] ?? 0) + 1;
  const pending = resolutions.filter((r) => r.decision === 'pending').length;
  console.log(`items: ${items.size}; by 2025 level: ${JSON.stringify(counts)}`);
  console.log(`CC-CEDICT check: ${JSON.stringify(matchCounts)}; resolutions: ${resolutions.length} (${pending} pending)`);
  console.log(`audio: ${JSON.stringify(audioCounts)}`);
  console.log(`problems: ${problems.length}`);
  for (const p of problems.slice(0, 30)) console.log('  ', JSON.stringify(p));
  writeJson(join(DATA, 'hsk', 'import-report.json'), { counts, matchCounts, audioCounts, problems });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
