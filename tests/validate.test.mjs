// Run: node --test tests   (or `npm test` from the repository root)
// scripts/validate.mjs on small data roots under tests/fixtures/validate/: clean/ is a complete root (real
// items copied from data/) that passes; every other folder holds the files that replace clean/'s to break
// exactly one rule. The dictionary is a tiny CC-CEDICT (tests/fixtures/cedict-mini.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate } from '../scripts/validate.mjs';
import { indexCedict } from '../scripts/lib/cedict.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/validate/', import.meta.url));
const dict = indexCedict(JSON.parse(readFileSync(new URL('./fixtures/cedict-mini.json', import.meta.url), 'utf8')));

/** validate() on clean/ with the files of `name` copied over it (in a temporary folder). */
function validateCase(name) {
  const root = mkdtempSync(join(tmpdir(), `learn-chinese-validate-${name}-`));
  try {
    cpSync(join(FIXTURES, 'clean'), root, { recursive: true });
    cpSync(join(FIXTURES, name), root, { recursive: true, force: true });
    return validate({ root, dict });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const codes = (result) => [...new Set(result.errors.map((e) => e.code))].sort();
const errorIds = (result, code) => result.errors.filter((e) => e.code === code).map((e) => e.id);

test('the clean fixture passes: no errors, no warnings, nothing unverified', () => {
  const result = validate({ root: join(FIXTURES, 'clean'), dict });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(result.counts, { hsk: 3, ids: 8, contentFiles: 1 }, '3 words + 1 scene, 3 phrases, 1 rule');
  assert.equal(result.cedict, '2026-05-18');
});

test('invalid pinyin syllable', () => {
  const result = validateCase('bad-syllable');
  assert.deepEqual(codes(result), ['pinyin-alignment', 'pinyin-not-pinyin'], 'and the word no longer lines up with its characters');
  assert.deepEqual(errorIds(result, 'pinyin-not-pinyin'), ['w.4f60-597d.ni3hao3']);
  assert.match(result.errors.find((e) => e.code === 'pinyin-not-pinyin').detail, /^hǎu: /);
});

test('tone mark on the wrong vowel', () => {
  const result = validateCase('wrong-tone-mark');
  assert.deepEqual(codes(result), ['pinyin-mark-position']);
  assert.match(result.errors[0].detail, /expected hǎo/);
});

test('duplicate id across files', () => {
  const result = validateCase('duplicate-id');
  assert.deepEqual(codes(result), ['duplicate-id']);
  assert.deepEqual(errorIds(result, 'duplicate-id'), ['w.7231.ai4']);
  assert.match(result.errors[0].detail, /words-1\.json and data\/hsk\/words-2\.json/);
});

test('missing provenance (HSK word without source_url; phrase source without access date)', () => {
  const word = validateCase('missing-provenance');
  assert.deepEqual(codes(word), ['missing-provenance']);
  assert.deepEqual(errorIds(word, 'missing-provenance'), ['w.4f60-597d.ni3hao3']);
  const phrase = validateCase('missing-provenance-phrase');
  assert.deepEqual(codes(phrase), ['missing-provenance']);
  assert.deepEqual(errorIds(phrase, 'missing-provenance'), ['travel.greetings.ni-hao']);
});

test('traditional character in a phrase (checked even for items that are not shown)', () => {
  const result = validateCase('traditional-character');
  assert.deepEqual(codes(result), ['traditional-character']);
  assert.deepEqual(errorIds(result, 'traditional-character'), ['travel.greetings.xiexie', 'travel.greetings.xiexie']);
  assert.match(result.errors[0].detail, /^謝 in 謝謝！/);
  assert.deepEqual([...new Set(result.unverified.map((u) => u.id))], ['travel.greetings.xiexie'], 'not shown: listed in UNVERIFIED.md');
});

test('unresolved CC-CEDICT disagreement', () => {
  const result = validateCase('unresolved-disagreement');
  assert.deepEqual(codes(result), ['cedict-disagreement-unresolved']);
  assert.deepEqual(errorIds(result, 'cedict-disagreement-unresolved'), ['w.4e0b-8f7d.xia4zai4']);
  assert.match(result.errors[0].detail, /下载 xiàzài vs CC-CEDICT xià zǎi/);
});

test('pending decision', () => {
  const result = validateCase('pending-decision');
  assert.deepEqual(codes(result), ['cedict-disagreement-pending']);
  assert.deepEqual(errorIds(result, 'cedict-disagreement-pending'), ['w.4e0b-8f7d.xia4zai4']);
  assert.deepEqual(result.unverified.map((u) => [u.kind, u.id]), [['HSK word', 'w.4e0b-8f7d.xia4zai4']]);
});

test('verified phrase failing the CC-CEDICT check', () => {
  const result = validateCase('cedict-check-failed');
  assert.deepEqual(codes(result), ['cedict-check-failed']);
  assert.deepEqual(errorIds(result, 'cedict-check-failed'), ['travel.greetings.ni-hao']);
  assert.match(result.errors[0].detail, /你好: given nǐ hào, CC-CEDICT nǐ hǎo/);
});

test('verified phrase written with spoken (sandhi) tones instead of citation tones', () => {
  const result = validateCase('not-citation');
  assert.deepEqual(codes(result), ['pinyin-not-citation']);
  assert.deepEqual(errorIds(result, 'pinyin-not-citation'), ['travel.greetings.bu-keqi']);
  assert.match(result.errors[0].detail, /不客气: write citation tones \(bù kè qi\)/);
});

test('missing audio file', () => {
  const result = validateCase('missing-audio-file');
  assert.deepEqual(codes(result), ['audio-file-missing']);
  assert.deepEqual(result.errors.map((e) => [e.id, e.detail]), [['w.597d.hao3', 's/hao3.mp3']]);
});

test('a shown text may not quote a hidden (unverified or refuted) phrase', () => {
  const result = validateCase('quotes-hidden-phrase');
  assert.deepEqual(codes(result), ['quotes-hidden-phrase']);
  // The usage note made for this case, and the scene's tip, which also names 不客气 as the reply to thanks.
  assert.deepEqual(errorIds(result, 'quotes-hidden-phrase').sort(), ['travel.greetings.rule-core-set', 'travel.greetings.xiexie']);
});
