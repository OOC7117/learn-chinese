// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { indexEntry, queryKind, search } from '../app/src/lib/search.js';

// Real words from app/data/words-*.json (id, characters, pinyin, first meanings, frequency rank), in the
// shape app/src/data.js gives the search view.
const WORDS = [
  ['w.662f.shi4', '是', 'shì', ['to be (followed by substantives only)', 'correct; right; true'], 2],
  ['w.4f60.ni3', '你', 'nǐ', ['you (informal, as opposed to courteous 您 [nín])'], 12],
  ['w.597d.hao3', '好', 'hǎo', ['good', 'appropriate; proper', 'all right!'], 57],
  ['w.65f6.shi2', '时', 'shí', ["o'clock", 'time', 'when', 'hour'], 65],
  ['w.7231.ai4', '爱', 'ài', ['to love; to be fond of; to like', 'affection'], 144],
  ['w.4e8b.shi4', '事', 'shì', ['matter', 'thing', 'item', 'work'], 171],
  ['w.5973.nv3', '女', 'nǚ', ['female', 'woman', 'daughter'], 395],
  ['w.5973-513f.nv3er2', '女儿', 'nǚ’ér', ['daughter'], 728],
  ['w.8c22-8c22.xie4xie5', '谢谢', 'xièxie', ['to thank', 'thanks', 'thank you'], 891],
  ['w.53ef-7231.ke3ai4', '可爱', 'kě’ài', ['adorable', 'cute', 'lovely'], 2026],
  ['w.5341.shi2', '十', 'shí', ['ten', '10'], 2226],
  ['w.8bd5.shi4', '试', 'shì', ['to test', 'to try', 'experiment', 'examination'], 2266],
  ['w.4f60-597d.ni3hao3', '你好', 'nǐ hǎo', ['hello; hi'], 2459],
  ['w.70ed-7231.re4ai4', '热爱', 'rè’ài', ['to love ardently', 'to adore'], 3724],
  ['w.7231-597d.ai4hao4', '爱好', 'àihào', ['to like; to be fond of; to take pleasure in; to be keen on', 'interest; hobby'], 5434],
  ['w.7231-4eba.ai4ren5', '爱人', 'àiren', ['spouse (PRC)', 'lover (non-PRC)'], 6130],
  ['w.597d.hao4', '好', 'hào', ['to be fond of; to have a tendency to; to be prone to'], 57],
  ['w.4e0d-5ba2-6c14.bu4ke4qi5', '不客气', 'bù kèqi', ["you're welcome", "don't mention it"], null],
].map(([id, hanzi, pinyin, meanings, freq]) => ({ kind: 'word', id, hanzi, pinyin, meanings, freq }));
// A phrase (data/situations/travel.json), searched by its English.
const PHRASE = { kind: 'phrase', id: 'travel.greetings.xiexie', hanzi: '谢谢！', pinyin: 'Xièxie!', english: 'Thank you! / Thanks!' };
const INDEX = [...WORDS, PHRASE].map(indexEntry);
const find = (q, options) => search(INDEX, q, options).map((item) => `${item.hanzi} ${item.pinyin}`);

test('indexEntry: toneless and toned keys, English, rank', () => {
  const e = indexEntry(WORDS.find((w) => w.hanzi === '女儿'));
  assert.equal(e.py, 'nver');
  assert.equal(e.pyTone, 'nv3er2', 'the curly apostrophe of the official list is understood');
  assert.equal(e.en, 'daughter');
  assert.equal(e.rank, 728);
  assert.equal(indexEntry(WORDS.find((w) => w.hanzi === '谢谢')).pyTone, 'xie4xie5');
  assert.equal(indexEntry(WORDS.find((w) => w.hanzi === '不客气')).rank, 50_000, 'no frequency: ranked last');
  assert.equal(indexEntry(PHRASE).en, 'thank you! / thanks!');
});

test('queryKind', () => {
  assert.equal(queryKind('你'), 'hanzi');
  assert.equal(queryKind('ni 好'), 'hanzi');
  assert.equal(queryKind('ni3'), 'pinyin-toned');
  assert.equal(queryKind('nǐ'), 'pinyin-toned');
  assert.equal(queryKind('NǏ'), 'pinyin-toned');
  assert.equal(queryKind('ni'), 'latin');
  assert.equal(queryKind('hello'), 'latin');
});

test('characters: exact match first, then words starting with it, then words containing it (by frequency)', () => {
  assert.deepEqual(find('爱'), ['爱 ài', '爱好 àihào', '爱人 àiren', '可爱 kě’ài', '热爱 rè’ài']);
  assert.deepEqual(find('你'), ['你 nǐ', '你好 nǐ hǎo']);
  assert.deepEqual(find('好'), ['好 hǎo', '好 hào', '你好 nǐ hǎo', '爱好 àihào']);
  assert.deepEqual(find('谢谢'), ['谢谢 xièxie', '谢谢！ Xièxie!']);
  assert.deepEqual(find('  你好 '), ['你好 nǐ hǎo'], 'trimmed');
});

test('pinyin without tones: exact syllables first (by frequency), then longer words; v and ü both work', () => {
  assert.deepEqual(find('shi'), ['是 shì', '时 shí', '事 shì', '十 shí', '试 shì']);
  assert.deepEqual(find('nihao'), ['你好 nǐ hǎo']);
  assert.deepEqual(find('ni hao'), ['你好 nǐ hǎo'], 'spaces are ignored');
  assert.deepEqual(find('ni'), ['你 nǐ', '你好 nǐ hǎo']);
  assert.deepEqual(find('nver'), ['女儿 nǚ’ér']);
  assert.deepEqual(find("nü'er"), ['女儿 nǚ’ér']);
  assert.deepEqual(find('nv'), ['女 nǚ', '女儿 nǚ’ér']);
  assert.deepEqual(find('xiexie'), ['谢谢 xièxie', '谢谢！ Xièxie!']);
});

test('pinyin with tones: exact first, a syllable typed without its tone matches any tone', () => {
  assert.deepEqual(find('shi4'), ['是 shì', '事 shì', '试 shì']);
  assert.deepEqual(find('shì'), ['是 shì', '事 shì', '试 shì']);
  assert.deepEqual(find('shi2'), ['时 shí', '十 shí']);
  assert.deepEqual(find('hao3'), ['好 hǎo']);
  assert.deepEqual(find('ni3hao'), ['你好 nǐ hǎo'], 'partial tones');
  assert.deepEqual(find('ni3 hao3'), ['你好 nǐ hǎo']);
  assert.deepEqual(find('nǐhǎo'), ['你好 nǐ hǎo']);
  assert.deepEqual(find('ai4'), ['爱 ài', '爱好 àihào', '爱人 àiren']);
  assert.deepEqual(find('xie4xie'), ['谢谢 xièxie', '谢谢！ Xièxie!'], 'a neutral tone is the toneless syllable');
  assert.deepEqual(find('nv3'), ['女 nǚ', '女儿 nǚ’ér']);
  assert.deepEqual(find('nv3er2'), ['女儿 nǚ’ér'], 'the tone number keeps "er" a syllable of its own');
  assert.deepEqual(find('ke3ai4'), ['可爱 kě’ài']);
});

test('a query of tone numbers alone matches nothing (not everything)', () => {
  assert.deepEqual(find('3'), []);
  assert.deepEqual(find('2025'), []);
});

test('English: whole-word prefixes, meanings that start with the query rank first', () => {
  assert.deepEqual(find('hello'), ['你好 nǐ hǎo']);
  assert.deepEqual(find('thank'), ['谢谢 xièxie', '谢谢！ Xièxie!']);
  assert.deepEqual(find('thank you'), ['谢谢 xièxie', '谢谢！ Xièxie!'], 'several words, in order');
  assert.deepEqual(find('daughter'), ['女 nǚ', '女儿 nǚ’ér'], 'a meaning that starts with the query (any meaning), then by frequency');
  assert.deepEqual(find('woman'), ['女 nǚ']);
  assert.deepEqual(find('to be fond of'), ['好 hào', '爱 ài', '爱好 àihào'], 'equal scores: by frequency');
  assert.deepEqual(find('love').sort(), ['可爱 kě’ài', '爱 ài', '爱人 àiren', '热爱 rè’ài'].sort(), 'love, lovely, lover');
  assert.deepEqual(find('ate'), [], 'not inside a word (appropriate)');
  assert.deepEqual(find('you'), ['你 nǐ', '不客气 bù kèqi', '谢谢 xièxie', '谢谢！ Xièxie!'], 'starting a meaning beats "thank you"');
  assert.deepEqual(find('(prc'), ['爱人 àiren'], 'regex characters are matched literally');
  assert.doesNotThrow(() => find('c++ [x'));
});

test('limit and empty queries', () => {
  assert.deepEqual(find('shi', { limit: 2 }), ['是 shì', '时 shí']);
  assert.deepEqual(find(''), []);
  assert.deepEqual(find('   '), []);
  assert.deepEqual(search([], '你'), []);
});
