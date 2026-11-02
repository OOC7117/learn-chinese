// Run: node --test tests   (or `npm test` from the repository root)
// Exports of scripts/import-hsk.mjs; definitions are real CC-CEDICT entries (tests/fixtures/cedict-mini.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanDefinitions, itemId } from '../scripts/import-hsk.mjs';

const CEDICT = JSON.parse(readFileSync(new URL('./fixtures/cedict-mini.json', import.meta.url), 'utf8')).entries;
const defsOf = (simplified) => CEDICT.filter((e) => e.simplified === simplified).flatMap((e) => e.definitions);

test('itemId: hex code points + numbered pinyin, stable across spellings of the same reading', () => {
  assert.equal(itemId('爱好', 'àihào'), 'w.7231-597d.ai4hao4', 'the docs/DATA.md example');
  assert.equal(itemId('爱', 'ài'), 'w.7231.ai4');
  assert.equal(itemId('的', 'de'), 'w.7684.de5', 'neutral tone is 5');
  assert.equal(itemId('你好', 'nǐ hǎo'), 'w.4f60-597d.ni3hao3');
  assert.equal(itemId('你好', 'nǐhǎo'), 'w.4f60-597d.ni3hao3', 'spacing does not matter');
  assert.equal(itemId('女儿', "nǚ'ér"), 'w.5973-513f.nv3er2', 'ü as v');
  assert.equal(itemId('女儿', 'nǚ’ér'), 'w.5973-513f.nv3er2', 'either apostrophe');
  assert.equal(itemId('一点儿', 'yīdiǎnr'), 'w.4e00-70b9-513f.yi1dian3r5', 'erhua r5');
  assert.notEqual(itemId('好', 'hǎo'), itemId('好', 'hào'), 'one item per reading');
  assert.match(itemId('一点儿', 'yīdiǎnr'), /^[a-z0-9][a-z0-9._-]{0,159}$/, 'the id alphabet of marks and sync');
});

test('cleanDefinitions: classifiers split off (traditional|simplified forms -> simplified)', () => {
  assert.deepEqual(cleanDefinitions(defsOf('书')), {
    meanings: ['abbr. for 書經|书经[Shu1 jing1]', 'book', 'letter', 'document', 'to write'],
    classifiers: ['本', '册', '部'],
  });
  assert.deepEqual(cleanDefinitions(defsOf('朋友')), { meanings: ['friend'], classifiers: ['个', '位'] });
});

test('cleanDefinitions: surnames move last, variant cross-references are dropped when there is a real meaning', () => {
  const che = cleanDefinitions(defsOf('车'));
  assert.equal(che.meanings.at(-1), 'surname Che');
  assert.equal(che.meanings[0], 'car');
  assert.deepEqual(che.classifiers, ['辆']);
  const bei = cleanDefinitions(defsOf('杯'));
  assert.deepEqual(bei.meanings, ['cup', 'trophy cup', 'classifier for certain containers of liquids: glass, cup'], 'variants dropped, duplicates merged');
  const shi = cleanDefinitions(defsOf('是'));
  assert.ok(!shi.meanings.some((m) => /variant of/.test(m)));
  assert.deepEqual(cleanDefinitions(['variant of 個|个[ge4]']).meanings, ['variant of 個|个[ge4]'], 'kept when it is all there is');
  assert.deepEqual(cleanDefinitions(['erhua variant of 一點|一点[yi1 dian3]']).meanings, ['erhua variant of 一點|一点[yi1 dian3]']);
});

test('cleanDefinitions: at most 12 meanings, trimmed, no duplicates', () => {
  const many = Array.from({ length: 15 }, (_, i) => `meaning ${i}`);
  assert.equal(cleanDefinitions(many).meanings.length, 12);
  assert.deepEqual(cleanDefinitions([' cup ', 'cup']).meanings, ['cup']);
  assert.deepEqual(cleanDefinitions([]), { meanings: [], classifiers: [] });
});
