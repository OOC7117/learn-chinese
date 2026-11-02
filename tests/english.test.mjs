// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { englishGlosses, englishMeanings, englishOnly, referencedWords } from '../app/src/lib/english.js';

test('englishOnly: asides with Chinese characters or pinyin are removed', () => {
  assert.equal(englishOnly('(joining two nouns) and; together with; with (Taiwan pr. [hàn])'), '(joining two nouns) and; together with; with');
  assert.equal(englishOnly('(bound form) having; with; -ful; -ed; -al (as in 有意 [yǒuyì] intentional)'), '(bound form) having; with; -ful; -ed; -al');
  assert.equal(englishOnly('you (informal, as opposed to courteous 您 [nín])'), 'you');
  assert.equal(englishOnly('(bound form) this; these (followed by a classifier) (in this sense, commonly pr. [zhèi], esp. in Beijing)'),
    '(bound form) this; these (followed by a classifier)');
  assert.equal(englishOnly('to swim (used mostly in 会水 [huìshuǐ] and 水性 [shuǐxìng])'), 'to swim');
});

test('englishOnly: nested parentheses are handled as one aside', () => {
  assert.equal(englishOnly('a waiter (literally, one who runs (back and forth) in a restaurant, 跑堂儿的 [pǎotángrde])'), 'a waiter');
  assert.equal(englishOnly('to be in the process of (doing sth); to be currently ...-ing'), 'to be in the process of (doing sth); to be currently ...-ing');
});

test('englishOnly: English-only text is unchanged; glosses that stay Chinese are dropped', () => {
  for (const text of ['also; too; as well; (not ...) either', 'some; a few; (following an adjective) slightly ...er', '3', 'to eat'])
    assert.equal(englishOnly(text), text);
  for (const text of ['also pr. [zhīdao]', 'Taiwan pr. [zhāojí]', 'abbr. for Xinjiang 新疆 [xīnjiāng]', 'erhua variant of 一点 [yīdiǎn]', '', null, '(Taiwan pr. [hàn])'])
    assert.equal(englishOnly(text), null, String(text));
});

test('englishMeanings: English-only glosses, without duplicates, at most max', () => {
  assert.deepEqual(englishMeanings(['you (informal, as opposed to courteous 您 [nín])', 'you (Note: in Taiwan, 妳 is used for females.)', 'also pr. [ni]']), ['you']);
  assert.deepEqual(englishMeanings(['a', 'b', 'c', 'd', 'e'], { max: 2 }), ['a', 'b']);
  assert.deepEqual(englishMeanings(undefined), []);
});

test('referencedWords: the characters a gloss points to', () => {
  assert.deepEqual(referencedWords(['erhua variant of 一点 [yīdiǎn]']), ['一点']);
  assert.deepEqual(referencedWords(['see 血 [xuè]', 'used in 伎俩 [jìliǎng] and 血 [xuè]']), ['血', '伎俩']);
  assert.deepEqual(referencedWords(['to eat']), []);
});

test('englishGlosses: own glosses, else the referenced word, else the cross-reference itself', () => {
  assert.deepEqual(englishGlosses(['to eat', 'also pr. [chi]']), { list: ['to eat'], crossRef: false });
  const words = { 一点: [{ hanzi: '一点', meanings: ['a bit (Taiwan pr. [yìdiǎn])', 'a little'] }] };
  const lookup = (hanzi) => words[hanzi] ?? [];
  assert.deepEqual(englishGlosses(['erhua variant of 一点 [yīdiǎn]'], { lookup }), { list: ['a bit', 'a little'], crossRef: false });
  assert.deepEqual(englishGlosses(['erhua variant of 好玩 [hǎowán]'], { lookup }), { list: ['erhua variant of 好玩 [hǎowán]'], crossRef: true });
  assert.deepEqual(englishGlosses(['see 血 [xuè]'], { lookup: () => [{ hanzi: '血', meanings: ['see 血 [xuè]'] }], self: '血' }),
    { list: ['see 血 [xuè]'], crossRef: true }, 'a word never borrows from itself');
  assert.deepEqual(englishGlosses([]), { list: [], crossRef: false });
});
