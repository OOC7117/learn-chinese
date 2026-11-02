// Loading the generated data (app/data/*.json, built by scripts/build-app-data.mjs) and turning it into
// study items. Files are fetched on demand and kept in memory; the service worker keeps them offline.
//
// Item kinds:
//   word    { kind, id, hanzi, pinyin, spoken, meanings, classifiers, pos, levels, freq, audio, alt, resolution }
//   phrase  { kind, id, hanzi, pinyin, spoken, english, literal, usage, register, speaker, scene, sources, audio }
//   term    { kind, id, hanzi, pinyin, spoken, english, usage, ..., audio }     (kinship terms)
// audio = { file: 'audio/...mp3', speaker, source } for a recording, or null (the device's Chinese voice).

import { spokenPinyin } from './lib/pinyin.js';

const cache = new Map(); // url -> Promise
let manifestPromise = null;

function fetchJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    }).catch((error) => {
      cache.delete(url); // allow a retry (e.g. back online)
      throw error;
    }));
  }
  return cache.get(url);
}

export function loadManifest() {
  manifestPromise ??= fetchJson('data/manifest.json').catch((error) => {
    manifestPromise = null;
    throw error;
  });
  return manifestPromise;
}

/** URL of a data file, with its content hash so caches never serve a stale version. */
async function fileUrl(key) {
  const manifest = await loadManifest();
  const entry = manifest.files[key];
  if (!entry) throw new Error(`unknown data file ${key}`);
  return `${entry.file}?v=${entry.hash}`;
}

export const SYSTEMS = Object.freeze(['exam2025', 'std2021', 'hsk20']);
export const SYSTEM_LABEL = Object.freeze({ exam2025: 'HSK 2025', std2021: 'Standard 2021', hsk20: 'HSK 2.0' });
export const WORD_FILES = Object.freeze(['1', '2', '3', '4', '5', '6', '7-9', 'other']);

function expandWord(c) {
  const [exam2025, std2021, hsk20] = c.l;
  let audio = null;
  if (typeof c.a === 'string' && c.a.startsWith('s:')) audio = { file: `audio/s/${c.a.slice(2)}.mp3`, speaker: 'Chen Wang', source: 'audio-cmn' };
  else if (c.a === 'w') audio = { file: `audio/w/${c.i}.mp3`, speaker: 'Yue Tan', source: 'audio-cmn' };
  else if (typeof c.a === 'string' && /^g:[0-9a-f]{16}$/.test(c.a)) audio = { file: `audio/g/${c.a.slice(2)}.mp3`, speaker: 'Generated voice', source: 'Google Cloud Text-to-Speech', synthetic: true };
  return {
    kind: 'word',
    id: c.i,
    hanzi: c.h,
    pinyin: c.p,
    spoken: c.sp ?? null,
    alt: c.alt ?? [],
    meanings: c.m ?? [],
    classifiers: c.c ?? [],
    pos: c.pos ?? [],
    levels: { exam2025, std2021, hsk20 },
    freq: c.f ?? null,
    audio,
    resolution: c.r ?? null,
  };
}

const wordFiles = new Map(); // file key -> Promise<word[]>
const wordsById = new Map();

/** Words of one file ('1' ... '7-9', 'other'), in study order (frequency within the level). */
export function loadWordFile(level) {
  if (!wordFiles.has(level)) {
    wordFiles.set(level, fileUrl(`words-${level}`).then(fetchJson).then((doc) => {
      const words = doc.items.map(expandWord);
      for (const w of words) wordsById.set(w.id, w);
      return words;
    }).catch((error) => {
      wordFiles.delete(level);
      throw error;
    }));
  }
  return wordFiles.get(level);
}

export async function loadAllWords() {
  const parts = await Promise.all(WORD_FILES.map(loadWordFile));
  return parts.flat();
}

export const loadedWordCount = () => wordsById.size;

// ---------- Content: situations, kinship, grammar, pitfalls, facts, dialogues ----------

let contentPromise = null;
const contentById = new Map();

/** { situations: [{ id, title, scenes: [...] }], kinship, grammar, pitfalls, facts, dialogues } (empty parts
 * when not built yet). Phrases and kinship terms become items. */
export function loadContent() {
  contentPromise ??= (async () => {
    const manifest = await loadManifest();
    if (!manifest.files.content) return { situations: [], kinship: null, grammar: null, pitfalls: null, facts: null, dialogues: [] };
    const doc = await fetchJson(await fileUrl('content'));
    for (const situation of doc.situations ?? []) {
      for (const scene of situation.scenes) {
        scene.situation = situation.id;
        scene.items = scene.phrases.map((p) => {
          const item = { kind: 'phrase', ...p, scene: scene.id, spoken: spokenPinyin(p.hanzi, p.pinyin), audio: p.audio ?? null };
          contentById.set(item.id, item);
          return item;
        });
      }
    }
    if (doc.kinship) {
      doc.kinship.items = doc.kinship.terms.map((t) => {
        const item = { kind: 'term', ...t, spoken: spokenPinyin(t.hanzi, t.pinyin), audio: t.audio ?? null };
        contentById.set(item.id, item);
        return item;
      });
    }
    return doc;
  })().catch((error) => {
    contentPromise = null;
    throw error;
  });
  return contentPromise;
}

export async function loadTones() {
  return fetchJson(await fileUrl('tones'));
}

// ---------- Decks ----------

/**
 * All decks: HSK levels in three systems (from the manifest), one per scene, and kinship.
 * { id, group, title, kind: 'hsk' | 'scene' | 'kinship', system?, level?, count }
 */
export async function loadDecks() {
  const [manifest, content] = await Promise.all([loadManifest(), loadContent().catch(() => null)]);
  const decks = manifest.decks.map((d) => ({ ...d, kind: 'hsk', system: SYSTEMS[d.system] }));
  for (const situation of content?.situations ?? []) {
    for (const scene of situation.scenes) decks.push({ id: scene.id, group: situation.title, title: scene.title, kind: 'scene', count: scene.items.length });
  }
  if (content?.kinship) decks.push({ id: 'kinship', group: 'Family', title: 'Kinship terms', kind: 'kinship', count: content.kinship.items.length });
  return decks;
}

/** Items of a deck, in study order. */
export async function deckItems(deck) {
  if (deck.kind === 'hsk') {
    if (deck.system === 'exam2025') return (await loadWordFile(deck.level)).filter((w) => w.levels.exam2025 === deck.level);
    const all = await loadAllWords();
    const key = deck.system;
    const want = key === 'hsk20' ? Number(deck.level) : deck.level;
    return all.filter((w) => w.levels[key] === want).sort((a, b) => (a.freq ?? 1e9) - (b.freq ?? 1e9));
  }
  const content = await loadContent();
  if (deck.kind === 'scene') {
    for (const s of content.situations) for (const scene of s.scenes) if (scene.id === deck.id) return scene.items;
    return [];
  }
  if (deck.kind === 'kinship') return content.kinship?.items ?? [];
  return [];
}

/** One item by id: words load their file on demand (all files if needed). */
export async function getItem(id) {
  if (wordsById.has(id)) return wordsById.get(id);
  if (contentById.has(id)) return contentById.get(id);
  if (id.startsWith('w.')) {
    await loadAllWords();
    return wordsById.get(id) ?? null;
  }
  await loadContent();
  return contentById.get(id) ?? null;
}

export const cachedItem = (id) => wordsById.get(id) ?? contentById.get(id) ?? null;

/** Phrases that contain a word, for cloze cards and the word page. With the word's id, only phrases
 * the build linked to that word (same characters AND reading: 银行 is not an example of 行 xíng). */
export async function examplesFor(hanzi, { id = null, limit = 6 } = {}) {
  const content = await loadContent().catch(() => null);
  const out = [];
  for (const s of content?.situations ?? []) {
    for (const scene of s.scenes) {
      for (const p of scene.items) {
        if (p.hanzi === hanzi) continue;
        if (id && p.w ? p.w.includes(id) : p.hanzi.includes(hanzi)) out.push(p);
      }
    }
  }
  return out.slice(0, limit);
}

/** Characters of an HSK word id (w.<hex code points>.<numbered pinyin>), without loading the word files. */
export function hanziOfId(id) {
  const hex = String(id).split('.')[1] ?? '';
  try {
    return hex.split('-').map((cp) => String.fromCodePoint(parseInt(cp, 16))).join('');
  } catch {
    return '';
  }
}

/** Display level of a word in a system: "HSK 3", "Std 7-9", "2.0 5", or null. */
export function levelLabel(word, system) {
  const v = word.levels?.[system];
  if (v === null || v === undefined) return null;
  return `${SYSTEM_LABEL[system]} ${v}`;
}
