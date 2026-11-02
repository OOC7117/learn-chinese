// Run: node --test tests   (or `npm test` from the repository root)
// Exports of scripts/build-app-data.mjs; the definitions are real CC-CEDICT text (tests/fixtures/cedict-mini.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { displayMeaning, syllableFile } from '../scripts/build-app-data.mjs';

const CEDICT = JSON.parse(readFileSync(new URL('./fixtures/cedict-mini.json', import.meta.url), 'utf8')).entries;
/** The definition of a CC-CEDICT word (simplified + pinyin) that starts with `start`. */
function def(simplified, pinyin, start) {
  const found = CEDICT.filter((e) => e.simplified === simplified && e.pinyin === pinyin).flatMap((e) => e.definitions).find((d) => d.startsWith(start));
  assert.ok(found, `${simplified} [${pinyin}] ${start}`);
  return found;
}

test('displayMeaning: CC-CEDICT cross-references in display pinyin, simplified form only', () => {
  assert.equal(displayMeaning(def('你', 'ni3', 'you (informal')), 'you (informal, as opposed to courteous 您 [nín])');
  assert.equal(displayMeaning(def('个', 'ge3', 'used in')), 'used in 自个儿 [zìgěr]', 'traditional|simplified -> simplified; erhua joined');
  assert.equal(displayMeaning(def('个', 'ge4', 'variant of')), 'variant of 个 [gè]');
  assert.equal(displayMeaning(def('书', 'Shu1', 'abbr.')), 'abbr. for 书经 [shūjīng]');
  assert.equal(displayMeaning('erhua variant of 一點|一点[yi1 dian3]'), 'erhua variant of 一点 [yīdiǎn]');
});

test('displayMeaning: several references in one definition (the 的 entry of the docstring)', () => {
  const text = '(used after a noun, verb or adjective to form a nominal expression, as in 皮革的[pi2 ge2 de5] "one made of leather" or 跑堂兒的|跑堂儿的[pao3 tang2 r5 de5] "a waiter (literally, one who runs back and forth in a restaurant)" or 新的[xin1 de5] "new one")';
  assert.equal(displayMeaning(text), '(used after a noun, verb or adjective to form a nominal expression, as in 皮革的 [pígéde] "one made of leather" or 跑堂儿的 [pǎotángrde] "a waiter (literally, one who runs back and forth in a restaurant)" or 新的 [xīnde] "new one")');
});

test('displayMeaning leaves everything else unchanged', () => {
  assert.equal(displayMeaning('to love; to be fond of; to like'), 'to love; to be fond of; to like');
  assert.equal(displayMeaning('CL:本[ben3]'), 'CL:本 [běn]');
  assert.equal(displayMeaning('(math.) decimal point'), '(math.) decimal point');
  assert.equal(displayMeaning(''), '');
});

test('syllableFile: audio-cmn file names (ü as v; ju4 is only recorded as jv4)', () => {
  assert.equal(syllableFile('ma', 1), 'ma1');
  assert.equal(syllableFile('lü', 4), 'lv4');
  assert.equal(syllableFile('nü', 3), 'nv3');
  assert.equal(syllableFile('lüe', 4), 'lve4');
  assert.equal(syllableFile('ju', 4), 'jv4');
  assert.equal(syllableFile('ju', 3), 'ju3');
});

test('displayMeaning: a reading on its own ("Taiwan pr.", "also pr.") is shown in tone marks', () => {
  assert.equal(displayMeaning('Taiwan pr. [jie2]'), 'Taiwan pr. [jié]');
  assert.equal(displayMeaning('also pr. [pu4 lu4]'), 'also pr. [pùlù]');
  assert.equal(displayMeaning('also pr. [yi1mo2-yi1yang4]'), 'also pr. [yīmó-yīyàng]');
  assert.equal(displayMeaning('Taiwan pr. [nu:3]'), 'Taiwan pr. [nǚ]');
});
