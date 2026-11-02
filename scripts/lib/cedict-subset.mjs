// data/sources/cedict-subset.json: the CC-CEDICT entries this project uses, committed so the validator and
// CI work without the full release in raw/. It must give exactly the same check results as the full
// dictionary, so it holds every entry whose simplified form is an HSK word, a character of one, or ANY
// substring of a Chinese text of the content (the phrase check considers every dictionary word inside a
// run of characters), plus the words listed in data/sources/cedict-needed.txt.
// Written by scripts/import-hsk.mjs and refreshed by scripts/build-app-data.mjs.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Every Chinese text of data/situations, data/reference and data/generated that the validator checks. */
export function contentTexts(root) {
  const texts = [];
  for (const dir of ['situations', 'reference', 'generated']) {
    const path = join(root, 'data', dir);
    if (!existsSync(path)) continue;
    for (const file of readdirSync(path).filter((f) => f.endsWith('.json'))) {
      const doc = readJson(join(path, file));
      for (const scene of doc.scenes ?? []) for (const p of scene.phrases ?? []) texts.push(p.hanzi);
      for (const t of doc.terms ?? []) texts.push(t.hanzi);
      for (const it of doc.items ?? []) for (const ex of it.examples ?? []) texts.push(ex.hanzi);
    }
  }
  return texts.filter(Boolean);
}

/** The entries needed for these words and texts (see the file comment). */
export function subsetEntries(dict, { words = [], texts = [] } = {}) {
  const needed = new Set();
  for (const w of words) {
    needed.add(w);
    for (const ch of w) needed.add(ch);
  }
  for (const text of texts) {
    for (const run of String(text).split(/[^\p{Script=Han}]+/u)) {
      const chars = [...run];
      for (let i = 0; i < chars.length; i += 1) {
        for (let len = 1; len <= Math.min(dict.maxLen, chars.length - i); len += 1) {
          const sub = chars.slice(i, i + len).join('');
          if (dict.bySimplified.has(sub)) needed.add(sub);
        }
      }
    }
  }
  return dict.entries.filter((e) => needed.has(e.simplified));
}

/** Rewrite data/sources/cedict-subset.json from the full dictionary. Returns the number of entries. */
export function writeCedictSubset(dict, root) {
  const words = [];
  const hskDir = join(root, 'data', 'hsk');
  for (const file of readdirSync(hskDir).filter((f) => /^words-.+\.json$/.test(f))) for (const it of readJson(join(hskDir, file)).items) words.push(it.hanzi);
  const extraPath = join(root, 'data', 'sources', 'cedict-needed.txt');
  if (existsSync(extraPath)) words.push(...readFileSync(extraPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  const entries = subsetEntries(dict, { words, texts: contentTexts(root) });
  writeFileSync(join(root, 'data', 'sources', 'cedict-subset.json'), `${JSON.stringify({
    metadata: { ...dict.metadata, subset: 'entries whose simplified form is an HSK word, a character of one, a substring of a Chinese text of the content (data/situations, data/reference, data/generated), or listed in data/sources/cedict-needed.txt' },
    entries,
  }, null, 1)}\n`);
  return entries.length;
}
