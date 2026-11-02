// Run: node --test tests   (or `npm test` from the repository root)
// scripts/lib/cedict.mjs on a tiny dictionary: real CC-CEDICT entries in tests/fixtures/cedict-mini.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkText, compareWord, fmt, indexCedict, lookup, marked, readings, releaseDate, segment } from '../scripts/lib/cedict.mjs';
import { syllablesOf } from '../app/src/lib/pinyin.js';

const dict = indexCedict(JSON.parse(readFileSync(new URL('./fixtures/cedict-mini.json', import.meta.url), 'utf8')));
const compare = (word, pinyin, next = null) => compareWord(dict, word, syllablesOf(pinyin), next);

test('indexCedict: entries by simplified form, parsed readings, release date', () => {
  assert.equal(releaseDate(dict), '2026-05-18');
  assert.equal(releaseDate(indexCedict({ entries: [] })), null);
  assert.deepEqual(lookup(dict, '你').map((e) => e.traditional), ['你', '妳'], 'two traditional forms, one simplified headword');
  assert.deepEqual(lookup(dict, '女儿')[0].syl, [{ base: 'nü', tone: 3 }, { base: 'er', tone: 2 }], 'u: is ü');
  assert.deepEqual(lookup(dict, 'nothing'), []);
  assert.deepEqual(readings(dict, '好').map(fmt), ['hǎo', 'hào']);
  assert.deepEqual(readings(dict, '是').map(fmt), ['shì'], 'distinct readings only');
  assert.equal(fmt([{ base: 'yi', tone: 1 }, { base: 'dian', tone: 3 }, { base: 'r', tone: 5 }]), 'yī diǎn r');
  assert.equal(marked([{ base: 'yi', tone: 1 }, { base: 'dian', tone: 3 }, { base: 'r', tone: 5 }]), 'yīdiǎnr');
  assert.equal(dict.maxLen, 3);
});

test('segment: forward maximum matching into CC-CEDICT words', () => {
  assert.deepEqual(segment(dict, [...'不客气你好一点儿谢谢']), ['不客气', '你好', '一点儿', '谢谢']);
  assert.deepEqual(segment(dict, [...'不太']), ['不', '太'], 'not a headword: single characters');
});

test('compareWord verdict ok: the reading is in CC-CEDICT', () => {
  assert.deepEqual(compare('你好', 'nǐ hǎo'), { verdict: 'ok' });
  assert.deepEqual(compare('好', 'hào'), { verdict: 'ok' }, 'any of several readings');
  assert.deepEqual(compare('一点儿', 'yīdiǎnr'), { verdict: 'ok' }, 'erhua r');
  assert.deepEqual(compare('女儿', "nǚ'ér"), { verdict: 'ok' });
});

test('compareWord verdict sandhi: only 一/不 or a 3+3 pair written with the spoken tone', () => {
  const buyao = compare('不要', 'búyào');
  assert.equal(buyao.verdict, 'sandhi');
  assert.deepEqual(buyao.diffs, [{ index: 0, char: '不', dict: 4, given: 2, kind: 'sandhi' }]);
  assert.equal(buyao.dict, 'bù yào');
  assert.equal(compare('一起', 'yìqǐ').verdict, 'sandhi');
  assert.equal(compare('你好', 'níhǎo').verdict, 'sandhi');
  assert.equal(compare('好', 'háo', { tone: 3 }).verdict, 'sandhi', 'third tone before a third tone in the next word');
  assert.equal(compare('好', 'háo').verdict, 'mismatch', 'without a following third tone it is just wrong');
});

test('compareWord verdict neutral: only neutral vs full tone differs', () => {
  const xialai = compare('下来', 'xiàlái');
  assert.equal(xialai.verdict, 'neutral');
  assert.deepEqual(xialai.diffs, [{ index: 1, char: '来', dict: 5, given: 2, kind: 'neutral' }]);
  assert.equal(xialai.dict, 'xià lai');
  assert.equal(compare('客气', 'kèqì').verdict, 'neutral');
});

test('compareWord verdict mismatch: a different tone than every reading', () => {
  assert.deepEqual(compare('下载', 'xiàzài'), { verdict: 'mismatch', dict: 'xià zǎi' });
  assert.deepEqual(compare('你好', 'nǐ hào'), { verdict: 'mismatch', dict: 'nǐ hǎo' });
  assert.deepEqual(compare('好', 'hāo'), { verdict: 'mismatch', dict: 'hǎo | hào' });
});

test('compareWord verdict chars-only: not a headword, but every character has that reading', () => {
  const butai = compare('不太', 'bù tài');
  assert.equal(butai.verdict, 'chars-only');
  assert.deepEqual(butai.chars, [{ char: '不', ok: true, options: 'bù' }, { char: '太', ok: true, options: 'tài' }]);
  assert.equal(compare('不太', 'bù tāi').verdict, 'mismatch', 'a character reading that does not exist');
  assert.equal(compare('谢', 'xiè').verdict, 'ok');
  assert.deepEqual(compare('謝', 'xiè'), { verdict: 'not-in-dictionary' }, 'a traditional character is not a simplified headword');
  assert.equal(compare('謝謝', 'xièxie').verdict, 'not-in-dictionary');
});

test('checkText: ok, warn (spoken tones written) and fail', () => {
  assert.deepEqual(checkText(dict, '你好！', 'Nǐ hǎo!'), { status: 'ok', problems: [], words: [{ word: '你好', given: 'nǐ hǎo', verdict: 'ok' }] });
  assert.equal(checkText(dict, '谢谢！', 'Xièxie!').status, 'ok');
  assert.equal(checkText(dict, '一点儿', 'yīdiǎnr').status, 'ok', 'erhua 儿 lines up with r');
  const warn = checkText(dict, '不客气。', 'Bú kèqi.');
  assert.equal(warn.status, 'warn');
  assert.equal(warn.words[0].verdict, 'sandhi');
  assert.equal(checkText(dict, '下来', 'xiàlái').status, 'warn', 'neutral-tone difference');
  const fail = checkText(dict, '你好！', 'Nǐ hào!');
  assert.equal(fail.status, 'fail');
  assert.deepEqual(fail.words, [{ word: '你好', given: 'nǐ hào', verdict: 'mismatch', dict: 'nǐ hǎo' }]);
  assert.equal(checkText(dict, '你好，谢谢！', 'Nǐ hǎo, xièxie!').words.length, 2, 'punctuation splits runs');
});

test('checkText compares whole CC-CEDICT words: splitting a word into characters never excuses its reading', () => {
  // 好 alone can be hào and 谢 alone is xiè, so a character-by-character reading would pass both texts.
  const wrong = checkText(dict, '你好', 'nǐ hào');
  assert.equal(wrong.status, 'fail', '你好 is nǐ hǎo');
  assert.deepEqual(wrong.words.map((w) => [w.word, w.verdict]), [['你好', 'mismatch']]);
  const neutral = checkText(dict, '谢谢', 'xièxiè');
  assert.equal(neutral.status, 'warn', '谢谢 is xièxie (neutral second syllable)');
  assert.deepEqual(neutral.words.map((w) => [w.word, w.verdict]), [['谢谢', 'neutral']]);
});

test('checkText: alignment failure when syllables and characters do not line up', () => {
  assert.deepEqual(checkText(dict, '你好', 'nǐ'), { status: 'fail', problems: ['alignment: 2 characters but 1 syllables'], words: [] });
  assert.deepEqual(checkText(dict, '你', 'nǐ hǎo').problems, ['alignment: 1 characters but 2 syllables']);
  assert.equal(checkText(dict, '一点儿', 'yīdiǎn').status, 'fail', 'the erhua r must be written');
});

test('checkText: a neutral-tone particle is its own word when the dictionary word reads it otherwise (到了 dàoliǎo vs 到 + 了)', () => {
  // CC-CEDICT has 到了 dào liǎo 'finally'; in 就到了 the 了 is the particle le.
  assert.equal(checkText(dict, '就到了。', 'Jiù dào le.').status, 'ok');
  // The particle rule never excuses a wrong reading: CC-CEDICT reads 为了 wèi le, so "wéi le" is checked as 为了.
  assert.equal(checkText(dict, '为了', 'wéi le').status, 'fail');
  assert.equal(checkText(dict, '为了', 'wèi le').status, 'ok');
  // Nor does it apply to other words: 银行 stays one word.
  assert.equal(checkText(dict, '银行', 'yínxíng').status, 'fail');
});
