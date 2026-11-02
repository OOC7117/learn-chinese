// Run: node --test tests   (or `npm test` from the repository root)
// Phrases link to the HSK words they contain (scripts/build-app-data.mjs hskWordsIn): matched by characters
// AND reading, longest first, inside runs of Han characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wordIndex, hskWordsIn } from '../scripts/build-app-data.mjs';

// The ids follow docs/DATA.md (w.<hex code points>.<numbered pinyin>); readings as in the HSK lists.
const WORDS = [
  { id: 'w.6211.wo3', hanzi: '我', pinyin: 'wǒ' },
  { id: 'w.5728.zai4', hanzi: '在', pinyin: 'zài' },
  { id: 'w.94f6-884c.yin2hang2', hanzi: '银行', pinyin: 'yínháng' },
  { id: 'w.884c.xing2', hanzi: '行', pinyin: 'xíng' },
  { id: 'w.5de5-4f5c.gong1zuo4', hanzi: '工作', pinyin: 'gōngzuò' },
  { id: 'w.4e00-70b9-513f.yi1dian3r5', hanzi: '一点儿', pinyin: 'yīdiǎnr' },
  { id: 'w.5bf9.dui4', hanzi: '对', pinyin: 'duì' },
  { id: 'w.4e0d.bu4', hanzi: '不', pinyin: 'bù' },
  { id: 'w.5bf9-4e0d-8d77.dui4bu5qi3', hanzi: '对不起', pinyin: 'duìbuqǐ' },
  { id: 'w.597d.hao3', hanzi: '好', pinyin: 'hǎo' },
  { id: 'w.4f60.ni3', hanzi: '你', pinyin: 'nǐ' },
];
const index = wordIndex(WORDS);

test('longest match first, with the reading of the phrase', () => {
  assert.deepEqual(hskWordsIn('我在银行工作。', 'Wǒ zài yínháng gōngzuò.', index), ['w.6211.wo3', 'w.5728.zai4', 'w.94f6-884c.yin2hang2', 'w.5de5-4f5c.gong1zuo4']);
});

test('a character is linked only with a matching reading (行 háng is not 行 xíng)', () => {
  assert.deepEqual(hskWordsIn('行', 'xíng', index), ['w.884c.xing2']);
  assert.deepEqual(hskWordsIn('行', 'háng', index), []);
});

test('erhua and neutral tones', () => {
  assert.deepEqual(hskWordsIn('一点儿', 'yīdiǎnr', index), ['w.4e00-70b9-513f.yi1dian3r5']);
  // 对不起 is listed with a neutral 不; a full-tone spelling still links to the same word.
  assert.deepEqual(hskWordsIn('对不起！', 'Duìbùqǐ!', index), ['w.5bf9-4e0d-8d77.dui4bu5qi3']);
});

test('punctuation separates words; duplicates are dropped', () => {
  assert.deepEqual(hskWordsIn('你好，你好！', 'Nǐ hǎo, nǐ hǎo!', index), ['w.4f60.ni3', 'w.597d.hao3']);
});

test('no links when characters and syllables do not line up', () => {
  assert.deepEqual(hskWordsIn('你好', 'nǐ', index), []);
});
