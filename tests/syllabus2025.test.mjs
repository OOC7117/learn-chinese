// Run: node --test tests   (or `npm test` from the repository root)
// tests/fixtures/syllabus2025-sample.txt: lines copied unchanged from `pdftotext -layout` of the official
// 2025 syllabus (raw/hsk2025/syllabus.txt): table of contents, page breaks (form feeds, page numbers,
// repeated headers) and rows 1-14, 24, 33, 37-42, 71, 181 and 6716.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseSyllabusText } from '../scripts/lib/syllabus2025.mjs';

const SAMPLE = readFileSync(new URL('./fixtures/syllabus2025-sample.txt', import.meta.url), 'utf8');
const { rows, problems } = parseSyllabusText(SAMPLE);
const row = (seq) => rows.find((r) => r.seq === seq);

test('every row of the sample is parsed, in order; nothing else is', () => {
  assert.deepEqual(rows.map((r) => r.seq), [...Array.from({ length: 14 }, (_, i) => i + 1), 24, 33, 37, 38, 39, 40, 41, 42, 71, 181, 6716]);
  const other = problems.filter((p) => p.why !== 'missing number');
  assert.deepEqual(other, [], 'no parse problems');
  assert.equal(problems.length, 11000 - rows.length, 'every number not in the sample is reported missing');
  assert.ok(problems.some((p) => p.seq === 15 && p.why === 'missing number'));
});

test('a plain row', () => {
  assert.deepEqual(row(1), {
    seq: 1, level: '1', extra_levels: [], word_as_printed: '爱', word: '爱', sense: null,
    pinyin_as_printed: 'ài', pos_as_printed: '动', pos: ['动'],
  });
  assert.equal(row(3).pinyin_as_printed, 'bàba');
  assert.equal(row(39).pinyin_as_printed, 'diànyǐngyuàn');
});

test('extra levels in parentheses: 1（4）, 1（2）（4）', () => {
  assert.equal(row(7).level, '1');
  assert.deepEqual(row(7).extra_levels, ['4']);
  assert.deepEqual(row(7).pos, ['数', '（副）']);
  assert.equal(row(71).word, '好');
  assert.deepEqual(row(71).extra_levels, ['2', '4']);
  assert.deepEqual(row(71).pos, ['形', '（副）', '（动）']);
});

test('sense numbers: 本1, 点1', () => {
  assert.equal(row(10).word_as_printed, '本1');
  assert.equal(row(10).word, '本');
  assert.equal(row(10).sense, 1);
  assert.equal(row(33).word, '点');
  assert.equal(row(33).sense, 1);
  assert.deepEqual(row(33).extra_levels, ['3']);
  assert.equal(row(1).sense, null);
});

test('empty part of speech: phrases printed as separate words (不客气 bú kèqi, 打电话 dǎ diànhuà)', () => {
  assert.equal(row(14).word, '不客气');
  assert.equal(row(14).pinyin_as_printed, 'bú kèqi', 'as printed: with the tone change of 不');
  assert.equal(row(14).pos_as_printed, '');
  assert.deepEqual(row(14).pos, []);
  assert.equal(row(24).pinyin_as_printed, 'dǎ diànhuà');
  assert.deepEqual(row(24).pos, []);
});

test("level 7-9 and a part of speech with a space after 、 ('名、 形', row 6716)", () => {
  assert.equal(row(6716).level, '7-9');
  assert.equal(row(6716).word, '高龄');
  assert.equal(row(6716).pinyin_as_printed, 'gāolíng');
  assert.equal(row(6716).pos_as_printed, '名、形');
  assert.deepEqual(row(6716).pos, ['名', '形']);
});

test('alternative readings stay as printed (谁 shéi/shuí)', () => {
  assert.equal(row(181).pinyin_as_printed, 'shéi/shuí');
  assert.deepEqual(row(181).pos, ['代']);
});

test('rows after a page break (form feed, page number, repeated header) are parsed', () => {
  assert.equal(row(41).word, '都');
  assert.equal(row(41).pinyin_as_printed, 'dōu');
  assert.equal(row(42).pos_as_printed, '动');
});

test('problems: unknown level, duplicate number; nothing before the header counts', () => {
  const header = '序号   等级     词语         拼音             词性';
  const before = ' 1     1    爱          ài             动'; // a row-like line before the header is ignored
  const text = [before, header, ' 1     1    爱          ài             动', ' 1     1    爱          ài             动', ' 2     X    八          bā             数'].join('\n');
  const result = parseSyllabusText(text);
  assert.deepEqual(result.rows.map((r) => r.seq), [1, 1]);
  assert.deepEqual(result.problems.filter((p) => p.why !== 'missing number').map((p) => [p.seq, p.why]), [[2, 'level'], [1, 'duplicate number']]);
});
