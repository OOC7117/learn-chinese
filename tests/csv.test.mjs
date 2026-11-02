// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../scripts/lib/csv.mjs';

test('parseCsv: rows keyed by the header (the first rows of raw/hsk2021/hsk30-expanded.csv)', () => {
  const text = 'ID,Simplified,Traditional,Pinyin,POS,Level,WebNo,WebPinyin,OCR,CEDICT,Example\n'
    + 'L1-0001,爱,愛,ài,V,1,18,ài,爱,愛|爱[ai4],\n'
    + 'L1-0004,爸爸,爸爸,bàba,N,1,83,bàba|bà,爸爸｜爸,爸爸|爸爸[ba4 ba5],\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    ID: 'L1-0001', Simplified: '爱', Traditional: '愛', Pinyin: 'ài', POS: 'V', Level: '1', WebNo: '18', WebPinyin: 'ài', OCR: '爱', CEDICT: '愛|爱[ai4]', Example: '',
  });
  assert.equal(rows[1].WebPinyin, 'bàba|bà');
  assert.equal(rows[1].CEDICT, '爸爸|爸爸[ba4 ba5]');
});

test('parseCsv: quoted fields with commas, doubled quotes and line breaks; CRLF', () => {
  const text = 'id,text\r\n1,"x, y"\r\n2,"say ""hi"""\r\n3,"two\r\nlines"\r\n4,plain\r\n';
  assert.deepEqual(parseCsv(text), [
    { id: '1', text: 'x, y' },
    { id: '2', text: 'say "hi"' },
    { id: '3', text: 'two\r\nlines' },
    { id: '4', text: 'plain' },
  ]);
});

test('parseCsv: LF or CR line ends, blank lines skipped, no final newline, short rows padded', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n3,4'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  assert.deepEqual(parseCsv('a,b\r1,2\r'), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCsv('a,b,c\n1\n'), [{ a: '1', b: '', c: '' }]);
  assert.deepEqual(parseCsv('a,b\n,\n'), [{ a: '', b: '' }], 'a row of empty fields is kept');
  assert.deepEqual(parseCsv('a,b\n""," "\n'), [{ a: '', b: ' ' }]);
  assert.deepEqual(parseCsv('a,b\n'), [], 'header only');
});
