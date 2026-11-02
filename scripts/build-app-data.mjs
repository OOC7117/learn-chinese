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

import { spokenPinyin, syllablesOf, SYLLABLE_LIST, cedictToMarked, tokenize } from '../app/src/lib/pinyin.js';
import { ROOT, FULL_PATH, loadCedict } from './lib/cedict.mjs';
import { writeCedictSubset } from './lib/cedict-subset.mjs';
import { buildContent } from './lib/content.mjs';
import { tonesInDoubt } from '../app/src/lib/tonedrill.js';

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
    .replace(/([\p{Script=Han}]+)\[([a-zA-Z:]+[1-5](?: [a-zA-Z:]+[1-5])*)\]/gu, (_, hz, py) => `${hz} [${toMarked(py)}]`)
    // A reading on its own ("Taiwan pr. [jie2]", "also pr. [yi1mo2-yi1yang4]"); joined like a word.
    .replace(/\[([a-zA-Z:]+[1-5](?:[ -]?[a-zA-Z:]+[1-5])*)\]/g, (_, py) => `[${py.split('-').map((part) => toMarked(part.match(/[a-zA-Z:]+[1-5]/g).join(' '))).join('-')}]`);
}

// ---------- Pre-generated neural audio (scripts/generate-tts.mjs; optional) ----------

/** The generated clips (data/audio/tts-index.json) that still match the item: same reading, file present. */
export function loadTtsIndex(root = ROOT) {
  const path = join(root, 'data', 'audio', 'tts-index.json');
  if (!existsSync(path)) return null;
  const index = readJson(path);
  return { voice: index.voice ?? null, items: index.items ?? {}, exists: (file) => existsSync(join(root, 'app', 'audio', file)) };
}

/** The generated clip for an item id with this pinyin, or null (stale entries, made for another reading, are ignored). */
export function ttsClip(tts, id, pinyin) {
  const entry = tts?.items?.[id];
  if (!entry?.file || entry.pinyin !== pinyin || !/^g\/[0-9a-f]{16}\.mp3$/.test(entry.file) || !tts.exists(entry.file)) return null;
  return entry;
}

let TTS = null; // set in main()

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
  else {
    const clip = ttsClip(TTS, item.id, item.pinyin);
    if (clip) out.a = `g:${clip.file.slice(2, -4)}`; // pre-generated neural voice, labelled as synthetic
  }
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
  // Also left out: words for which CC-CEDICT notes another Mainland pronunciation ("also pr.", "Beijing pr.",
  // "colloquial pr."), whose recording may use the other tones (the drill filters them too: tonedrill.js).
  const recorded = items.filter((it) => it.audio.kind === 'word' && usable(it) && spokenPinyin(it.hanzi, it.pinyin) === null
    && !tonesInDoubt(syllablesOf(it.pinyin, { strict: false }).map((s) => s.tone), it.meanings));
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

const HAN = /\p{Script=Han}/u;

/** Index of HSK words by characters, each with its syllables, for hskWordsIn(). */
export function wordIndex(items) {
  const byHanzi = new Map();
  let maxLen = 1;
  for (const it of items) {
    const syl = tokenize(it.pinyin).filter((t) => t.type === 'syllable').map((t) => ({ base: t.base, tone: t.tone }));
    if (syl.length !== [...it.hanzi].length) continue;
    if (!byHanzi.has(it.hanzi)) byHanzi.set(it.hanzi, []);
    byHanzi.get(it.hanzi).push({ id: it.id, syl });
    maxLen = Math.max(maxLen, syl.length);
  }
  return { byHanzi, maxLen };
}

/**
 * The HSK words inside a Chinese text, matched by characters AND reading, longest first, inside runs of
 * Han characters (punctuation separates words): 银行 yínháng links to 银行, and its 行 never to xíng.
 * A neutral tone on either side still matches. Returns item ids in order, without duplicates.
 */
export function hskWordsIn(hanzi, pinyin, index) {
  const syl = tokenize(pinyin).filter((t) => t.type === 'syllable');
  const runs = [];
  let cur = [];
  for (const ch of String(hanzi)) {
    if (HAN.test(ch)) cur.push(ch);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  if (runs.reduce((n, r) => n + r.length, 0) !== syl.length) return [];
  const out = [];
  let k = 0;
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      let len = Math.min(index.maxLen, run.length - i);
      for (; len >= 1; len -= 1) {
        const part = syl.slice(k + i, k + i + len);
        const hit = (index.byHanzi.get(run.slice(i, i + len).join('')) ?? [])
          .find((c) => c.syl.every((s, j) => s.base === part[j].base && (s.tone === part[j].tone || s.tone === 5 || part[j].tone === 5)));
        if (hit) {
          out.push(hit.id);
          break;
        }
      }
      i += Math.max(len, 1);
    }
    k += run.length;
  }
  return [...new Set(out)];
}

/** Adds w: [HSK word ids] to every phrase and kinship term of the app content, and the pre-generated
 * audio clip where there is one (recordings of phrases do not exist; the device voice is the fallback). */
function linkWords(content, items) {
  const index = wordIndex(items);
  let links = 0;
  const link = (x) => {
    const clip = x.audio ? null : ttsClip(TTS, x.id, x.pinyin);
    if (clip) x.audio = { file: `audio/${clip.file}`, speaker: `Generated voice (${clip.voice})`, source: 'Google Cloud Text-to-Speech', synthetic: true };
    const w = hskWordsIn(x.hanzi, x.pinyin, index);
    if (!w.length) return;
    x.w = w;
    links += w.length;
  };
  for (const s of content.situations ?? []) for (const scene of s.scenes) scene.phrases.forEach(link);
  (content.kinship?.terms ?? []).forEach(link);
  return links;
}

function main() {
  TTS = loadTtsIndex();
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
    counts.wordLinks = linkWords(content, items);
    files.content = { file: 'data/content.json', hash: writeCompact(join(OUT, 'content.json'), content), ...counts };
  }

  // Keep the committed CC-CEDICT subset complete for the content as it is now (offline validation, CI).
  if (existsSync(FULL_PATH)) console.log(`cedict-subset: ${writeCedictSubset(loadCedict(FULL_PATH), ROOT)} entries`);

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
