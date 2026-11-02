#!/usr/bin/env node
// data/ (canonical) -> app/data/*.json (compact files the app loads) and app/audio/ (recordings).
// Run after scripts/import-hsk.mjs and whenever data/ changes:  node scripts/build-app-data.mjs
// The output is committed, so the site itself needs no build step (same convention as the reference
// project's export scripts). Only content with status "verified" (and HSK words whose CC-CEDICT check
// passed or has a recorded decision) reaches the app; everything else is listed in docs/UNVERIFIED.md
// by scripts/validate.mjs.

import { pathToFileURL } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { spokenPinyin, syllablesOf, SYLLABLE_LIST, cedictToMarked } from '../app/src/lib/pinyin.js';
import { ROOT } from './lib/cedict.mjs';
import { buildContent } from './lib/content.mjs';

const DATA = join(ROOT, 'data');
const APP = join(ROOT, 'app');
const OUT = join(APP, 'data');
const AUDIO = join(APP, 'audio');
const RAW_AUDIO = join(ROOT, 'raw', 'audio-cmn');
const LEVELS = ['1', '2', '3', '4', '5', '6', '7-9', 'other'];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeCompact = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  const text = `${JSON.stringify(value)}\n`;
  writeFileSync(path, text);
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
};

/** Audio file names of syllables (audio-cmn writes ü as v and has ju4 only as jv4). */
export function syllableFile(base, tone) {
  const name = `${base.replace(/ü/g, 'v')}${tone}`;
  return name === 'ju4' ? 'jv4' : name;
}

function hskItems() {
  const all = [];
  for (const level of LEVELS) {
    const path = join(DATA, 'hsk', `words-${level}.json`);
    if (!existsSync(path)) continue;
    for (const item of readJson(path).items) all.push({ ...item, file: level });
  }
  return all;
}

/** An HSK item may be shown when its pinyin matches CC-CEDICT, or a recorded decision covers it. */
const usable = (item) => item.cedict.match === 'ok' || (item.resolution && item.resolution !== 'pending' && item.resolution !== 'exclude');

/** CC-CEDICT cross-references for display: "跑堂兒的|跑堂儿的[pao3 tang2 r5 de5]" -> "跑堂儿的 [pǎotángrde]",
 * "皮革的[pi2 ge2 de5]" -> "皮革的 [pígéde]". The canonical data keeps CC-CEDICT's text unchanged. */
export function displayMeaning(def) {
  const toMarked = (py) => cedictToMarked(py);
  return def
    .replace(/[^\s|[\]，,;()（）]+\|([^\s|[\]，,;()（）]+)\[([^\]]+)\]/g, (_, simp, py) => `${simp} [${toMarked(py)}]`)
    .replace(/([\p{Script=Han}]+)\[([a-zA-Z:]+[1-5](?: [a-zA-Z:]+[1-5])*)\]/gu, (_, hz, py) => `${hz} [${toMarked(py)}]`);
}

function compactItem(item) {
  const spoken = spokenPinyin(item.hanzi, item.pinyin);
  const out = {
    i: item.id,
    h: item.hanzi,
    p: item.pinyin,
    m: item.meanings.map(displayMeaning),
    l: [item.levels.exam2025, item.levels.std2021, item.levels.hsk20],
  };
  if (spoken) out.sp = spoken;
  if (item.pinyin_alt?.length) out.alt = item.pinyin_alt;
  if (item.classifiers?.length) out.c = item.classifiers;
  if (item.pos?.length) out.pos = item.pos;
  if (item.freq) out.f = item.freq.rank;
  if (item.audio.kind === 'syllable') out.a = item.audio.file.replace(/^s\//, 's:').replace(/\.mp3$/, '');
  else if (item.audio.kind === 'word') out.a = 'w';
  if (item.cedict.match !== 'ok') out.r = item.resolution; // a recorded decision applies (shown on the detail page)
  return out;
}

function copyAudio(items) {
  const wanted = new Map(); // dest relative path -> source absolute path
  // Every syllable recording (tones 1-4) of the inventory, for the pinyin chart and tone drills.
  const available = new Set(readdirSync(join(RAW_AUDIO, '64k', 'syllabs')));
  const syllables = [];
  for (const base of SYLLABLE_LIST) {
    for (let tone = 1; tone <= 4; tone += 1) {
      const name = syllableFile(base, tone);
      if (available.has(`cmn-${name}.mp3`)) {
        wanted.set(`s/${name}.mp3`, join(RAW_AUDIO, '64k', 'syllabs', `cmn-${name}.mp3`));
        syllables.push(`${base}${tone}`);
      }
    }
  }
  for (const item of items) {
    if (item.audio.kind === 'word') wanted.set(`w/${item.id}.mp3`, join(RAW_AUDIO, '24k-abr', 'hsk', `cmn-${item.hanzi}.mp3`));
  }
  // Mirror: remove files that are no longer wanted, copy new ones.
  for (const sub of ['s', 'w']) {
    const dir = join(AUDIO, sub);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (!wanted.has(`${sub}/${name}`)) rmSync(join(dir, name));
  }
  let bytes = 0;
  for (const [rel, src] of wanted) {
    const dest = join(AUDIO, rel);
    if (!existsSync(dest)) copyFileSync(src, dest);
    bytes += statSync(dest).size;
  }
  return { files: wanted.size, bytes, syllables };
}

/** Tone-drill material: two-syllable words with a verified recording, by tone pattern; minimal pairs. */
function toneData(items, syllables) {
  // Only words pronounced exactly with their citation tones: in 一下 (yíxià) or 你好 (níhǎo) the learner
  // hears a changed tone, which would make "which tones did you hear?" ambiguous.
  const recorded = items.filter((it) => it.audio.kind === 'word' && usable(it) && spokenPinyin(it.hanzi, it.pinyin) === null);
  const pairs = {};
  for (const it of recorded) {
    const syl = syllablesOf(it.pinyin, { strict: false });
    if (syl.length !== 2 || syl.some((s) => s.base === 'r')) continue;
    const key = `${syl[0].tone}${syl[1].tone}`;
    (pairs[key] ??= []).push(it);
  }
  const rankOf = (it) => {
    const lv = it.levels.exam2025;
    const levelRank = lv === null ? 10 : lv === '7-9' ? 7 : Number(lv);
    return levelRank * 1e6 + (it.freq?.rank ?? 999999);
  };
  const pairOut = {};
  for (const [key, list] of Object.entries(pairs)) {
    pairOut[key] = list.sort((a, b) => rankOf(a) - rankOf(b)).slice(0, 24).map((it) => it.id);
  }
  // Minimal pairs: same syllables, different tones, both recorded, both HSK 1-4 (2025) or HSK 2.0 1-3.
  const easy = recorded.filter((it) => ['1', '2', '3', '4'].includes(it.levels.exam2025) || (it.levels.hsk20 !== null && it.levels.hsk20 <= 3));
  const byBases = new Map();
  for (const it of easy) {
    const key = syllablesOf(it.pinyin, { strict: false }).map((s) => s.base).join(' ');
    if (!byBases.has(key)) byBases.set(key, []);
    byBases.get(key).push(it);
  }
  const minimal = [];
  for (const group of byBases.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (group[i].pinyin.toLowerCase() !== group[j].pinyin.toLowerCase() && group[i].hanzi !== group[j].hanzi) minimal.push([group[i].id, group[j].id]);
      }
    }
  }
  return { syllables, pairs: pairOut, minimal: minimal.slice(0, 300) };
}

function main() {
  const all = hskItems();
  const items = all.filter(usable);
  const excluded = all.length - items.length;
  const files = {};
  const decks = [];
  const levelTitle = { other: 'Older lists only' };
  for (const level of LEVELS) {
    const list = items.filter((it) => it.file === level);
    if (!list.length) continue;
    const hash = writeCompact(join(OUT, `words-${level}.json`), { level, items: list.map(compactItem) });
    files[`words-${level}`] = { file: `data/words-${level}.json`, hash, count: list.length };
  }
  // Deck definitions: the 2025 exam levels (primary), plus the 2021 standard and HSK 2.0 levels as views.
  for (const level of ['1', '2', '3', '4', '5', '6', '7-9']) {
    decks.push({ id: `exam2025-${level}`, group: 'HSK (2025 exam syllabus)', title: `HSK ${level}`, system: 0, level, count: items.filter((it) => it.levels.exam2025 === level).length });
  }
  for (const level of ['1', '2', '3', '4', '5', '6', '7-9']) {
    decks.push({ id: `std2021-${level}`, group: 'HSK 3.0 standard (2021)', title: `Level ${level}`, system: 1, level, count: items.filter((it) => it.levels.std2021 === level).length });
  }
  for (const level of [1, 2, 3, 4, 5, 6]) {
    decks.push({ id: `hsk20-${level}`, group: 'HSK 2.0 (2012)', title: `HSK ${level}`, system: 2, level, count: items.filter((it) => it.levels.hsk20 === level).length });
  }
  const audio = copyAudio(items);
  const tones = toneData(items, audio.syllables);
  files.tones = { file: 'data/tones.json', hash: writeCompact(join(OUT, 'tones.json'), tones) };

  // Situations, kinship, grammar, pitfalls, facts and dialogues (verified items only).
  if (existsSync(join(DATA, 'situations')) || existsSync(join(DATA, 'reference'))) {
    const includeUnverified = process.env.BUILD_INCLUDE_UNVERIFIED === '1';
    if (includeUnverified) console.warn('WARNING: BUILD_INCLUDE_UNVERIFIED=1: content.json includes unverified items (local UI work only; the validator fails on it).');
    const { content, counts } = buildContent(ROOT, { includeUnverified });
    files.content = { file: 'data/content.json', hash: writeCompact(join(OUT, 'content.json'), content), ...counts };
  }

  const lock = readJson(join(DATA, 'sources.lock.json'));
  const manifest = {
    version: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12),
    decks,
    files,
    counts: { words: items.length, excluded, audioFiles: audio.files, audioMB: Math.round(audio.bytes / 1e5) / 10 },
    sources: Object.fromEntries(Object.entries(lock).map(([id, v]) => [id, v.what])),
  };
  writeCompact(join(OUT, 'manifest.json'), manifest);
  console.log(`words: ${items.length} (excluded ${excluded}); audio files: ${audio.files} (${manifest.counts.audioMB} MB); tone pairs: ${Object.keys(tones.pairs).length}; minimal pairs: ${tones.minimal.length}`);
  for (const [k, v] of Object.entries(files)) console.log(`  ${k}: ${v.count ?? ''} ${v.hash}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
