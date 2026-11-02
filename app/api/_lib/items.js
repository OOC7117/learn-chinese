// The items the site actually has: the HSK words of data/words-*.json (field "i") and, once built, the
// phrases and kinship terms of data/content.json. Both are deployed with the functions (vercel.json
// "includeFiles": "data/**"); the file names come from data/manifest.json, like in the browser.
// (Replaces the reference project's cards.js, which read one data/vocab.json.)
//
// The API keeps marks and card states of these items only, so made-up ids cannot grow a record or a
// card-state bucket until every later sync of that account fails (too many entries, or a request over
// the body limit). With real ids a record stays below ~1 MB of marks and the 32 buckets below ~6 MB
// together, even for someone who studied every card. /api/service also uses the items (hanzi, pinyin,
// first meaning) for its "most starred / skipped" lists.

import { readFile } from 'node:fs/promises';

import { ID_PATTERN } from '../../src/lib/marks.js';
import { CARD_TYPES } from '../../src/lib/srs.js';

const DATA_DIR = new URL('../../data/', import.meta.url);
/** Data file names as the manifest lists them ("data/words-1.json"): one level, no traversal. */
const DATA_FILE = /^data\/([a-z0-9][a-z0-9._-]{0,80}\.json)$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

let loading = null;

/**
 * Read the catalog from a data folder (a file: URL ending in "/"): { ids: Set of item ids, items: Map
 * id -> { id, hanzi, pinyin, meaning } }. Words come from the manifest's "words-*" files; phrases and
 * kinship terms from content.json (as the manifest names it, else data/content.json; none until built).
 */
export async function readCatalog(dir = DATA_DIR) {
  const readData = async (name) => JSON.parse(await readFile(new URL(name, dir), 'utf8'));
  const manifest = await readData('manifest.json');
  const items = new Map();
  const add = (id, hanzi, pinyin, meaning) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return;
    items.set(id, { id, hanzi: String(hanzi ?? ''), pinyin: String(pinyin ?? ''), meaning: String(meaning ?? '') });
  };
  for (const [key, entry] of Object.entries(manifest.files ?? {})) {
    const name = key.startsWith('words-') ? DATA_FILE.exec(entry?.file ?? '')?.[1] : null;
    if (!name) continue;
    const doc = await readData(name);
    for (const word of doc.items ?? []) add(word.i, word.h, word.p, Array.isArray(word.m) ? word.m[0] : '');
  }
  let content = null;
  try {
    content = await readData(DATA_FILE.exec(manifest.files?.content?.file ?? '')?.[1] ?? 'content.json');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const situation of content?.situations ?? []) {
    for (const scene of situation?.scenes ?? []) {
      for (const phrase of scene?.phrases ?? []) add(phrase?.id, phrase?.hanzi, phrase?.pinyin, phrase?.english);
    }
  }
  for (const term of content?.kinship?.terms ?? []) add(term?.id, term?.hanzi, term?.pinyin, term?.english);
  return { ids: new Set(items.keys()), items };
}

/** The catalog of this deployment, read once per function instance. */
function catalog() {
  loading ??= readCatalog().catch((error) => {
    loading = null; // try again on the next request
    throw error;
  });
  return loading;
}

/** Set of item ids. */
export async function knownItemIds() {
  return (await catalog()).ids;
}

/** Map of item id -> { id, hanzi, pinyin, meaning } (meaning: the first dictionary sense, or the
 * phrase's English). */
export async function itemInfo() {
  return (await catalog()).items;
}

/** The entries of `marks` whose item id is in `ids`. */
export function onlyKnown(marks, ids) {
  const out = {};
  if (!isObject(marks)) return out;
  for (const [id, entry] of Object.entries(marks)) if (ids.has(id)) out[id] = entry;
  return out;
}

/** A card id "<item id>.<type>" of a known item and one of the card types (read, listen, speak, cloze). */
export function isKnownCard(id, ids) {
  const at = id.lastIndexOf('.');
  return at > 0 && CARD_TYPES.includes(id.slice(at + 1)) && ids.has(id.slice(0, at));
}

/** The entries of an srs map whose card id is a known card. */
export function onlyKnownCards(srs, ids) {
  const out = {};
  if (!isObject(srs)) return out;
  for (const [id, entry] of Object.entries(srs)) if (isKnownCard(id, ids)) out[id] = entry;
  return out;
}
