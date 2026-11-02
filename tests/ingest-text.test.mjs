// Run: node --test tests   (or `npm test` from the repository root)
// scripts/ingest-research.mjs learnerText: research-process notes are dropped from texts the app shows;
// the content around them is kept as written. Inputs are taken from the research files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clauses, learnerText } from '../scripts/ingest-research.mjs';

test('clauses: sentences and ;-clauses, not inside brackets or after abbreviations', () => {
  assert.deepEqual(clauses('One. Two; three (a. b; c) four. Hanban BCT B sample of c. 2013. 5 e.g. 赵老板 ok.'),
    ['One.', 'Two;', 'three (a. b; c) four.', 'Hanban BCT B sample of c. 2013.', '5 e.g. 赵老板 ok.']);
});

test('drops sentences about the research session', () => {
  assert.equal(learnerText('Answer with 我姓X (the humble reply 免贵姓X was not verified in this session). HSK level 5; on the BCT (B) word list.'),
    'Answer with 我姓X. HSK level 5; on the BCT (B) word list.');
  assert.equal(learnerText('Use with superiors. The brief\'s plainer 我有个问题 was not found in a source seen this session.'), 'Use with superiors.');
  assert.equal(learnerText('Whether 礼拜 is more common in southern Mandarin was not verified this session.'), null);
});

test('a ;-clause that was dropped leaves a full stop', () => {
  assert.equal(learnerText('CC-CEDICT describes 阿 as a prefix to indicate familiarity; which regions use it, and whether at work, was not verified in this session.'),
    'CC-CEDICT describes 阿 as a prefix to indicate familiarity.');
});

test('meta parentheses go, the claim stays', () => {
  assert.equal(learnerText('In Chongqing speech 老师 is a broad term of respect (search-result summary).'), 'In Chongqing speech 老师 is a broad term of respect.');
});

test('texts without research notes are kept exactly (also "note:" and "evidence:" in content)', () => {
  for (const text of [
    '新华字典/汉典 note: 用于多数时不加词尾“们”，两个人称“您俩”或“您二位”.',
    '您 is far more frequent in northern speech — but it is never wrong at a first meeting (anecdotal evidence: learner-forum reports).',
    'HSK 3 phone call 喂，请问张经理在吗？; email salutation 黄经理：您好！ (BCT A).',
  ]) assert.equal(learnerText(text), text);
  assert.equal(learnerText(null), null);
});
