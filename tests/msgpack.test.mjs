// Run: node --test tests   (or `npm test` from the repository root)
// Hand-encoded MessagePack (https://github.com/msgpack/msgpack/blob/master/spec.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeMsgpack, wordfreqTable } from '../scripts/lib/msgpack.mjs';

const bytes = (...xs) => new Uint8Array(xs.flat());
const utf8 = (s) => [...new TextEncoder().encode(s)];

test('ints: positive/negative fixint, uint8/16/32, int8/16/32', () => {
  assert.equal(decodeMsgpack(bytes(0x00)), 0);
  assert.equal(decodeMsgpack(bytes(0x7f)), 127);
  assert.equal(decodeMsgpack(bytes(0xff)), -1);
  assert.equal(decodeMsgpack(bytes(0xe0)), -32);
  assert.equal(decodeMsgpack(bytes(0xcc, 0xff)), 255);
  assert.equal(decodeMsgpack(bytes(0xcd, 0x01, 0x00)), 256);
  assert.equal(decodeMsgpack(bytes(0xce, 0xff, 0xff, 0xff, 0xff)), 4294967295);
  assert.equal(decodeMsgpack(bytes(0xd0, 0x80)), -128);
  assert.equal(decodeMsgpack(bytes(0xd1, 0xff, 0x00)), -256);
  assert.equal(decodeMsgpack(bytes(0xd2, 0x80, 0x00, 0x00, 0x00)), -2147483648);
});

test('nil, booleans, float32/64', () => {
  assert.equal(decodeMsgpack(bytes(0xc0)), null);
  assert.equal(decodeMsgpack(bytes(0xc2)), false);
  assert.equal(decodeMsgpack(bytes(0xc3)), true);
  assert.equal(decodeMsgpack(bytes(0xca, 0x3f, 0xc0, 0x00, 0x00)), 1.5);
  assert.equal(decodeMsgpack(bytes(0xcb, 0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18)), 3.141592653589793);
});

test('strings: fixstr, str8, str16 (UTF-8)', () => {
  assert.equal(decodeMsgpack(bytes(0xa0)), '');
  assert.equal(decodeMsgpack(bytes(0xa3, utf8('abc'))), 'abc');
  assert.equal(decodeMsgpack(bytes(0xa2, utf8('ǚ'))), 'ǚ', 'two UTF-8 bytes');
  const long = 'x'.repeat(40);
  assert.equal(decodeMsgpack(bytes(0xd9, 40, utf8(long))), long);
  const longer = 'y'.repeat(300);
  assert.equal(decodeMsgpack(bytes(0xda, 0x01, 0x2c, utf8(longer))), longer);
});

test('arrays and maps: fixarray, array16, fixmap, map16, nested', () => {
  assert.deepEqual(decodeMsgpack(bytes(0x90)), []);
  assert.deepEqual(decodeMsgpack(bytes(0x93, 0x01, 0x02, 0x03)), [1, 2, 3]);
  assert.deepEqual(decodeMsgpack(bytes(0xdc, 0x00, 0x02, 0xc3, 0xc0)), [true, null]);
  assert.deepEqual(decodeMsgpack(bytes(0x82, 0xa1, utf8('a'), 0x01, 0xa1, utf8('b'), 0x92, 0xa1, utf8('c'), 0xff)), { a: 1, b: ['c', -1] });
  assert.deepEqual(decodeMsgpack(bytes(0xde, 0x00, 0x01, 0xa1, utf8('k'), 0x80)), { k: {} });
});

test('a view into a larger buffer (byteOffset) decodes correctly', () => {
  const backing = new Uint8Array([0xaa, 0xbb, 0x92, 0xcd, 0x12, 0x34, 0xa1, 0x7a, 0xcc]);
  assert.deepEqual(decodeMsgpack(backing.subarray(2, 8)), [0x1234, 'z']);
  assert.deepEqual(decodeMsgpack(Buffer.from([0x91, 0x05])), [5], 'a Node Buffer');
  assert.deepEqual(decodeMsgpack(new Uint8Array([0x91, 0x07]).buffer), [7], 'an ArrayBuffer');
});

test('unsupported types throw with their offset', () => {
  assert.throws(() => decodeMsgpack(bytes(0x91, 0xc4, 0x00)), /unsupported type 0xc4 at 1/);
});

test('wordfreqTable: bucket i holds words of frequency 10^(-i/100), zipf = 9 - i/100; rank by bucket', () => {
  const table = wordfreqTable([{ format: 'cB' }, ['a'], [], ['b', 'c'], ['d', 'a']]);
  assert.deepEqual(table.get('a'), { cb: 0, zipf: 9, rank: 1 }, 'the first (most frequent) bucket wins');
  assert.deepEqual(table.get('b'), { cb: 2, zipf: 8.98, rank: 2 });
  assert.deepEqual(table.get('c'), { cb: 2, zipf: 8.98, rank: 2 }, 'same bucket, same rank');
  assert.deepEqual(table.get('d'), { cb: 3, zipf: 8.97, rank: 4 });
  assert.equal(table.size, 4);
  const deep = wordfreqTable([{ format: 'cB' }, ...Array.from({ length: 351 }, (_, i) => (i === 350 ? ['rare'] : []))]);
  assert.deepEqual(deep.get('rare'), { cb: 350, zipf: 5.5, rank: 1 });
  assert.throws(() => wordfreqTable([{ format: 'other' }]), /not a wordfreq cB file/);
  assert.throws(() => wordfreqTable([]), /not a wordfreq cB file/);
});

test('decode + wordfreqTable together on a hand-encoded cB file', () => {
  // [{ "format": "cB" }, ["x"], [], ["y"]]
  const file = bytes(0x94, 0x81, 0xa6, utf8('format'), 0xa2, utf8('cB'), 0x91, 0xa1, utf8('x'), 0x90, 0x91, 0xa1, utf8('y'));
  const table = wordfreqTable(decodeMsgpack(file));
  assert.deepEqual([...table.entries()], [['x', { cb: 0, zipf: 9, rank: 1 }], ['y', { cb: 2, zipf: 8.98, rank: 2 }]]);
});
