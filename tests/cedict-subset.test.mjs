// Run: node --test tests   (or `npm test` from the repository root)
// scripts/lib/cedict-subset.mjs: the committed CC-CEDICT subset must check texts exactly like the full
// dictionary, so it keeps every entry that occurs inside a text. Entries: tests/fixtures/cedict-mini.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { indexCedict, checkText } from '../scripts/lib/cedict.mjs';
import { subsetEntries } from '../scripts/lib/cedict-subset.mjs';

const FULL = indexCedict(JSON.parse(readFileSync(new URL('./fixtures/cedict-mini.json', import.meta.url), 'utf8')));

test('the subset keeps the words of the list, their characters and every dictionary word inside a text', () => {
  const entries = subsetEntries(FULL, { words: ['你好'], texts: ['我不会说中文。'] });
  const kept = new Set(entries.map((e) => e.simplified));
  for (const w of ['你好', '你', '好']) assert.ok(kept.has(w), w);
  for (const w of [...'我不会说中文'].concat(['不会', '中文']).filter((x) => FULL.bySimplified.has(x))) assert.ok(kept.has(w), w);
  assert.ok(!kept.has('银行'), 'nothing that does not occur');
});

test('checking with the subset gives the same result as with the full dictionary', () => {
  const texts = ['我不会说中文。', '你好！'];
  const subset = indexCedict({ metadata: {}, entries: subsetEntries(FULL, { texts }) });
  for (const [text, pinyin] of [['我不会说中文。', 'Wǒ bù huì shuō Zhōngwén.'], ['你好！', 'Nǐ hǎo!']]) {
    assert.deepEqual(checkText(subset, text, pinyin), checkText(FULL, text, pinyin), text);
  }
});
