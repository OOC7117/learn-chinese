// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYLLABLES, cedictToMarked, citationPinyin, markIndex, markSyllable, normalize, numberedToMarked, parseCedictPinyin,
  parseSyllable, pinyinProblems, sameSyllables, searchKey, spokenPinyin, spokenTones, splitChunk, stripTones,
  syllablesOf, syllablesToMarked, toNumbered, tokenize, tonedKey, withTones,
} from '../app/src/lib/pinyin.js';

/** [base, tone] pairs of a split, for compact assertions. */
const bt = (parts) => parts.map((p) => [p.base, p.tone]);
const codes = (text) => pinyinProblems(text).map((p) => p.code);

// ---------- Syllables, splitting, tokens ----------

test('the syllable inventory has the erhua r and the syllabic nasals but no tone-less junk', () => {
  for (const s of ['a', 'zhuang', 'lü', 'lüe', 'nü', 'nüe', 'er', 'r', 'n', 'ng', 'm', 'hm', 'hng']) assert.ok(SYLLABLES.has(s), s);
  for (const s of ['lv', 'xx', 'u', 'v', 'hau', 'ten']) assert.ok(!SYLLABLES.has(s), s);
});

test('splitChunk splits written words into syllables with tones and mark counts', () => {
  assert.deepEqual(splitChunk('Shànghǎi'), [
    { text: 'Shàng', base: 'shang', tone: 4, marks: 1 },
    { text: 'hǎi', base: 'hai', tone: 3, marks: 1 },
  ]);
  assert.deepEqual(bt(splitChunk('yīdiǎnr')), [['yi', 1], ['dian', 3], ['r', 5]], 'erhua r is its own pseudo-syllable');
  assert.equal(splitChunk('r'), null, 'erhua r never starts a word');
  assert.equal(splitChunk('WiFi'), null);
});

test("splitChunk never starts a vowel-initial syllable inside a run (Xī'ān, nǚ'ér need their apostrophe)", () => {
  assert.equal(splitChunk("Xī'ān"), null, 'the apostrophe is not a letter: tokenize handles it');
  assert.deepEqual(bt(splitChunk('Xī')), [['xi', 1]]);
  assert.deepEqual(bt(splitChunk('ān')), [['an', 1]]);
  // Without the apostrophe the run reads as one syllable (xiān) carrying two marks: a spelling error.
  assert.deepEqual(splitChunk('Xīān'), [{ text: 'Xīān', base: 'xian', tone: 1, marks: 2 }]);
  assert.deepEqual(bt(splitChunk('nǚ')), [['nü', 3]]);
  assert.deepEqual(bt(splitChunk('ér')), [['er', 2]]);
});

test('splitChunk lenient mode accepts a missing apostrophe (téngài), strict mode does not', () => {
  assert.equal(splitChunk('téngài'), null);
  assert.deepEqual(splitChunk('téngài', { lenient: true }), [
    { text: 'téng', base: 'teng', tone: 2, marks: 1 },
    { text: 'ài', base: 'ai', tone: 4, marks: 1 },
  ]);
  const tokens = tokenize('téngài', { lenient: true });
  assert.deepEqual(tokens.map((t) => t.type), ['syllable', 'sep', 'syllable']);
  assert.deepEqual(tokens[1], { type: 'sep', text: "'", added: true }, 'the apostrophe is restored');
  assert.equal(tokens.map((t) => t.text).join(''), "téng'ài");
});

test('splitChunk uses the standalone interjections (ǹg, ḿ, hm) only as a whole word', () => {
  assert.deepEqual(splitChunk('ǹg'), [{ text: 'ǹg', base: 'ng', tone: 4, marks: 1 }]);
  assert.deepEqual(splitChunk('ńg'), [{ text: 'ńg', base: 'ng', tone: 2, marks: 1 }]);
  assert.deepEqual(splitChunk('ḿ'), [{ text: 'ḿ', base: 'm', tone: 2, marks: 1 }]);
  assert.deepEqual(bt(splitChunk('hm')), [['hm', 5]]);
  assert.equal(splitChunk('nga'), null, 'ng is not used as the first part of a word');
  // Without the rule, strict "téngài" would split as té + n + gài.
  assert.equal(splitChunk('téngài'), null);
});

test('tokenize: token types, written-word numbers and a lossless round trip', () => {
  const text = 'Nǐ hǎo, WiFi 3!';
  const tokens = tokenize(text);
  assert.deepEqual(tokens.map((t) => [t.type, t.text]), [
    ['syllable', 'Nǐ'], ['space', ' '], ['syllable', 'hǎo'], ['other', ','], ['space', ' '],
    ['unknown', 'WiFi'], ['space', ' '], ['other', '3'], ['other', '!'],
  ]);
  assert.deepEqual(tokens.filter((t) => 'word' in t).map((t) => t.word), [0, 1, 2]);
  assert.equal(tokens.map((t) => t.text).join(''), text);

  const words = tokenize("Nǐ hǎo, wǒ shì qiántái. Xī'ān, Xī’ān").filter((t) => t.type === 'syllable');
  assert.deepEqual(words.map((t) => [t.text, t.word]), [
    ['Nǐ', 0], ['hǎo', 1], ['wǒ', 2], ['shì', 3], ['qián', 4], ['tái', 4], ['Xī', 5], ['ān', 5], ['Xī', 6], ['ān', 6],
  ], 'syllables written together (or joined by an apostrophe) share a word number');
  const yi = tokenize('yītiān-dàowǎn');
  assert.deepEqual(yi.map((t) => t.type), ['syllable', 'syllable', 'sep', 'syllable', 'syllable']);
  assert.ok(yi.filter((t) => t.type === 'syllable').every((t) => t.word === 0), 'a hyphen joins one written word');
  assert.equal(tokenize('lǜ')[0].base, 'lü');
  assert.equal(tokenize('nu:3')[0].base, 'nü', 'u: is normalised to ü');
});

// ---------- Tone marks ----------

test('markSyllable puts the mark on a/e first, the o of ou, otherwise the last vowel', () => {
  const cases = [
    ['hao', 3, 'hǎo'], ['xie', 4, 'xiè'], ['mei', 2, 'méi'], ['guai', 1, 'guāi'], ['er', 2, 'ér'],
    ['lou', 2, 'lóu'], ['xiong', 2, 'xióng'], // ou -> o; o of iong
    ['liu', 2, 'liú'], ['jiu', 3, 'jiǔ'], // iu -> u
    ['gui', 4, 'guì'], ['dui', 4, 'duì'], // ui -> i
    ['guo', 2, 'guó'],
    ['lü', 4, 'lǜ'], ['nü', 3, 'nǚ'], ['lüe', 4, 'lüè'], // ü, but üe -> e
  ];
  for (const [base, tone, want] of cases) assert.equal(markSyllable(base, tone), want, `${base}${tone}`);
  assert.equal(markIndex('xiong'), 2);
  assert.equal(markIndex('r'), -1);
});

test('markSyllable: syllabic nasals, neutral tone, capitals', () => {
  assert.equal(markSyllable('ng', 4), 'ǹg');
  assert.equal(markSyllable('ng', 3), 'ňg');
  assert.equal(markSyllable('n', 2), 'ń');
  assert.equal(markSyllable('m', 2), 'ḿ');
  assert.equal(markSyllable('ng', 1), 'ng', 'no precomposed first-tone nasal: left unmarked');
  assert.equal(markSyllable('ma', 5), 'ma');
  assert.equal(markSyllable('ma', 0), 'ma', 'pinyin-pro writes the neutral tone as 0');
  assert.equal(markSyllable('r', 4), 'r');
  assert.equal(markSyllable('Zhong', 1), 'Zhōng');
  assert.equal(markSyllable('Ou', 1), 'Ōu');
});

test('parseSyllable reads marked, numbered, v and u: spellings', () => {
  assert.deepEqual(parseSyllable('zhōng'), { base: 'zhong', tone: 1, marks: 1 });
  assert.deepEqual(parseSyllable('Zhōng'), { base: 'zhong', tone: 1, marks: 1 });
  assert.deepEqual(parseSyllable('hǎǒ'), { base: 'hao', tone: 3, marks: 2 }, 'two marks are counted');
  assert.deepEqual(parseSyllable('ma'), { base: 'ma', tone: 5, marks: 0 });
  assert.deepEqual(parseSyllable('zhong1'), { base: 'zhong', tone: 1, marks: 0 });
  assert.deepEqual(parseSyllable('ma5'), { base: 'ma', tone: 5, marks: 0 });
  assert.deepEqual(parseSyllable('ma0'), { base: 'ma', tone: 5, marks: 0 });
  assert.deepEqual(parseSyllable('lv4'), { base: 'lü', tone: 4, marks: 0 });
  assert.deepEqual(parseSyllable('NV3'), { base: 'nü', tone: 3, marks: 0 });
  assert.deepEqual(parseSyllable('nu:3'), { base: 'nü', tone: 3, marks: 0 });
  assert.deepEqual(parseSyllable('r5'), { base: 'r', tone: 5, marks: 0 });
  assert.deepEqual(parseSyllable('Ǹg'), { base: 'ng', tone: 4, marks: 1 });
  assert.deepEqual(parseSyllable('ài'), { base: 'ai', tone: 4, marks: 1 }, 'combining marks are composed first');
});

test('numberedToMarked converts tone numbers (v and u: for ü) and keeps spacing and capitals', () => {
  assert.equal(numberedToMarked('ni3 hao3'), 'nǐ hǎo');
  assert.equal(numberedToMarked('Ni3hao3'), 'Nǐhǎo');
  assert.equal(numberedToMarked('lv4'), 'lǜ');
  assert.equal(numberedToMarked('Lv4'), 'Lǜ');
  assert.equal(numberedToMarked('nu:3'), 'nǚ');
  assert.equal(numberedToMarked('ma5 ma0'), 'ma ma');
  assert.equal(numberedToMarked('ng4'), 'ǹg');
});

test("numberedToMarked writes the apostrophe a tone number implies before a, o, e (Xi1an1 -> Xī'ān)", () => {
  assert.equal(numberedToMarked('Xi1an1'), "Xī'ān");
  assert.equal(numberedToMarked('nv3er2'), "nǚ'ér");
  assert.equal(numberedToMarked('nv3er'), "nǚ'er", 'also before a syllable typed without its tone');
  assert.equal(numberedToMarked('Xi1 an1'), 'Xī ān', 'not where a space already separates them');
  assert.equal(numberedToMarked('teng2ai4'), "téng'ài");
  assert.equal(numberedToMarked('shang4hai3'), 'shànghǎi');
});

test('stripTones removes marks and keeps ü, apostrophes and capitals', () => {
  assert.equal(stripTones("Nǚ'ér"), "Nü'er");
  assert.equal(stripTones('Shànghǎi'), 'Shanghai');
  assert.equal(stripTones('ǹg'), 'ng');
  assert.equal(stripTones('ḿ'), 'm');
  assert.equal(normalize('nu:3 Nu:'), 'nü3 Nü');
});

// ---------- Validation ----------

test('pinyinProblems: clean pinyin has no problems', () => {
  for (const text of ['Nǐ hǎo!', "Xī'ān", 'yīdiǎnr', 'ǹg', 'Lǜ', 'Bù kèqi.', 'yītiān-dàowǎn', "nǚ'ér"]) assert.deepEqual(pinyinProblems(text), [], text);
});

test('pinyinProblems codes: not-pinyin, multiple-marks, mark-position, tone-number, v-for-u', () => {
  assert.deepEqual(codes('WiFi'), ['not-pinyin']);
  assert.deepEqual(codes('nǐ hǎu'), ['not-pinyin']);
  assert.deepEqual(pinyinProblems('nǐ hǎu')[0].text, 'hǎu');
  assert.deepEqual(codes('hǎǒ'), ['multiple-marks']);
  assert.deepEqual(codes('Xīān'), ['multiple-marks'], 'a missing apostrophe merges two syllables');
  assert.deepEqual(codes('haǒ'), ['mark-position']);
  assert.match(pinyinProblems('haǒ')[0].detail, /expected hǎo/);
  assert.deepEqual(codes('gúi'), ['mark-position'], 'ui: the mark goes on the i');
  assert.deepEqual(codes('lìu'), ['mark-position'], 'iu: the mark goes on the u');
  assert.deepEqual(codes('Hǎo'), [], 'capitals are fine');
  assert.deepEqual(codes('ni3 hao3'), ['tone-number']);
  assert.deepEqual(codes('lv'), ['v-for-u']);
  assert.deepEqual(codes('nu:'), ['v-for-u']);
  assert.deepEqual(codes('m̄'), ['combining-mark'], 'a first-tone m has no precomposed form');
});

// ---------- Tone sandhi hints ----------

test('spokenPinyin: 不 becomes bú before a fourth tone only', () => {
  assert.equal(spokenPinyin('不是', 'bùshì'), 'búshì');
  assert.equal(spokenPinyin('不要', 'bùyào'), 'búyào');
  assert.equal(spokenPinyin('不客气', 'bù kèqi'), 'bú kèqi');
  assert.equal(spokenPinyin('不客气。', 'Bù kèqi.'), 'Bú kèqi.', 'capitals and punctuation are kept');
  assert.equal(spokenPinyin('对不起', 'duìbuqǐ'), null, 'neutral-tone 不 is left alone');
  assert.deepEqual(spokenTones([...'不是'], [4, 4]), [2, 4]);
});

test('spokenPinyin: 一 becomes yí before a fourth tone and yì before tones 1-3', () => {
  assert.equal(spokenPinyin('一个', 'yīgè'), 'yígè');
  assert.equal(spokenPinyin('一下', 'yīxià'), 'yíxià');
  assert.equal(spokenPinyin('一天', 'yītiān'), 'yìtiān');
  assert.equal(spokenPinyin('一起', 'yīqǐ'), 'yìqǐ');
  assert.equal(spokenPinyin('一天到晚', 'yītiān-dàowǎn'), 'yìtiān-dàowǎn', 'the hyphen is kept');
  assert.deepEqual(spokenTones([...'一天'], [1, 1]), [4, 1]);
});

test('spokenPinyin: 一 keeps yī at the end, after 第 or a numeral, before 月/号/日', () => {
  assert.equal(spokenPinyin('第一', 'dìyī'), null);
  assert.equal(spokenPinyin('第一手', 'dìyīshǒu'), null, 'ordinal: 第 + 一');
  assert.equal(spokenPinyin('第一线', 'dìyīxiàn'), null);
  assert.equal(spokenPinyin('一月', 'yīyuè'), null, 'dates keep yī');
  assert.equal(spokenPinyin('十一', 'shíyī'), null);
  assert.equal(spokenPinyin('统一', 'tǒngyī'), null);
});

test('spokenPinyin: exactly two third tones -> second + third; longer runs get no hint', () => {
  assert.equal(spokenPinyin('你好', 'nǐhǎo'), 'níhǎo');
  assert.equal(spokenPinyin('你好！', 'Nǐ hǎo!'), 'Ní hǎo!');
  assert.equal(spokenPinyin('小姐', 'xiǎojiě'), 'xiáojiě');
  assert.equal(spokenPinyin('我很好', 'wǒ hěn hǎo'), null, 'three thirds: depends on grouping');
  assert.equal(spokenPinyin('展览馆', 'zhǎnlǎnguǎn'), null);
  assert.deepEqual(spokenTones([...'我很好'], [3, 3, 3]), [3, 3, 3]);
});

test('spokenPinyin returns null when the syllables do not line up with the characters', () => {
  assert.equal(spokenPinyin('你好', 'nǐ'), null);
  assert.equal(spokenPinyin('', ''), null);
});

test('citationPinyin undoes the printed tone changes of 一 and 不 only', () => {
  assert.equal(citationPinyin('一下', 'yíxià'), 'yīxià');
  assert.equal(citationPinyin('一起', 'yìqǐ'), 'yīqǐ');
  assert.equal(citationPinyin('不要', 'búyào'), 'bùyào');
  assert.equal(citationPinyin('不客气', 'bú kèqi'), 'bù kèqi');
  assert.equal(citationPinyin('一天到晚', 'yìtiān-dàowǎn'), 'yītiān-dàowǎn');
  assert.equal(citationPinyin('看一看', 'kàn yi kàn'), 'kàn yi kàn', 'neutral-tone 一 stays');
  assert.equal(citationPinyin('对不起', 'duìbuqǐ'), 'duìbuqǐ', 'neutral-tone 不 stays');
  assert.equal(citationPinyin('一下', 'yí'), 'yí', 'unchanged when it does not line up');
});

test('withTones rewrites tones and keeps the text around them', () => {
  assert.equal(withTones('Nǐ hǎo!', [2, 3]), 'Ní hǎo!');
  assert.equal(withTones('Nǐ hǎo!', [2]), null);
});

// ---------- Search keys and CC-CEDICT pinyin ----------

test('searchKey: toneless, spaceless, ü as v (nv / nü / nu: all match)', () => {
  for (const text of ["Nǚ'ér", 'nv er', 'nu:3er2', 'nü er', 'NV ER']) assert.equal(searchKey(text), 'nver', text);
  assert.equal(searchKey('ni3hao3'), 'nihao');
  assert.equal(searchKey('nǐ hǎo'), 'nihao');
  assert.equal(searchKey('Nǐ hǎo!'), 'nihao');
});

test('tonedKey: numbered or marked input, neutral tone 5, ü as v', () => {
  assert.equal(tonedKey('Nǐ hǎo ma'), 'ni3hao3ma5');
  assert.equal(tonedKey('ni3hao3 ma'), 'ni3hao3ma5');
  assert.equal(tonedKey('nǐ hǎo'), 'ni3hao3');
  assert.equal(tonedKey('ni3hao'), 'ni3hao5', 'a syllable typed without a tone is neutral (search widens it)');
  for (const text of ['nv3', 'nü3', 'nu:3', 'nǚ']) assert.equal(tonedKey(text), 'nv3', text);
  assert.equal(tonedKey("nǚ'ér"), 'nv3er2');
  assert.equal(tonedKey('nv3er2'), 'nv3er2', 'numbered input keeps the syllable boundary of the tone number');
  assert.equal(tonedKey('Xi1an1'), 'xi1an1');
});

test('cedictToMarked joins syllables with apostrophes and erhua (yīdiǎnr, xī\'ān)', () => {
  assert.equal(cedictToMarked('yi1 dian3 r5'), 'yīdiǎnr');
  assert.equal(cedictToMarked('Xi1 an1'), "xī'ān");
  assert.equal(cedictToMarked('nu:3 er2'), "nǚ'ér");
  assert.equal(cedictToMarked('ni3 hao3', { join: false }), 'nǐ hǎo');
  assert.deepEqual(parseCedictPinyin('Bei3 jing1 , · lu:4 A'), [{ base: 'bei', tone: 3 }, { base: 'jing', tone: 1 }, { base: 'lü', tone: 4 }]);
  assert.equal(syllablesToMarked([{ base: 'pao', tone: 3 }, { base: 'tang', tone: 2 }, { base: 'r', tone: 5 }, { base: 'de', tone: 5 }]), 'pǎotángrde');
});

test('syllablesOf / toNumbered / sameSyllables', () => {
  assert.deepEqual(syllablesOf('Nǐ hǎo!'), [{ base: 'ni', tone: 3 }, { base: 'hao', tone: 3 }]);
  assert.throws(() => syllablesOf('WiFi'), /not pinyin/);
  assert.deepEqual(syllablesOf('WiFi hǎo', { strict: false }), [{ base: 'hao', tone: 3 }]);
  assert.equal(toNumbered('Nǐ hǎo!'), 'ni3 hao3');
  assert.equal(toNumbered("Nǚ'ér"), 'nü3 er2');
  assert.ok(sameSyllables(syllablesOf('nǐ hǎo'), parseCedictPinyin('ni3 hao3')));
  assert.ok(!sameSyllables(syllablesOf('ní hǎo'), parseCedictPinyin('ni3 hao3')));
  assert.ok(!sameSyllables(syllablesOf('nǐ'), parseCedictPinyin('ni3 hao3')));
});
