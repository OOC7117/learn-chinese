// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SETTINGS_DEFAULTS, activeDeckList, cardTypesFor, cleanSettings, sameSettings, withDeck } from '../app/src/lib/settings.js';
import { validateSettings } from '../app/src/lib/marks.js';

const D = SETTINGS_DEFAULTS; // the fallback for every bad value (the defaults themselves are product decisions)
const ALL_TYPES = { ...D, typeListen: true, typeSpeak: true, typeRead: true, typeCloze: true };

test('cleanSettings: defaults for missing or untrusted input', () => {
  for (const raw of [undefined, null, 'x', 42, [], {}]) assert.deepEqual(cleanSettings(raw), SETTINGS_DEFAULTS, String(raw));
  assert.deepEqual(cleanSettings({ unknown: 1, constructor: 'x' }), SETTINGS_DEFAULTS, 'unknown keys are dropped');
  assert.deepEqual(cleanSettings(JSON.parse('{"__proto__": {"newPerDay": 50}}')), SETTINGS_DEFAULTS, 'JSON cannot inject a prototype');
  assert.doesNotThrow(() => validateSettings(SETTINGS_DEFAULTS), 'the defaults fit the sync shape (flat, primitive values)');
});

test('cleanSettings: numbers within range are kept (rounded), others fall back to the default', () => {
  const cases = [
    ['newPerDay', 0, 0], ['newPerDay', 100, 100], ['newPerDay', 12.6, 13], ['newPerDay', '20', 20], ['newPerDay', -1, D.newPerDay], ['newPerDay', 101, D.newPerDay],
    ['newPerDay', 'many', D.newPerDay], ['newPerDay', Number.NaN, D.newPerDay], ['newPerDay', Infinity, D.newPerDay],
    ['reviewLimit', 10, 10], ['reviewLimit', 2000, 2000], ['reviewLimit', 9, D.reviewLimit], ['reviewLimit', 2001, D.reviewLimit],
    ['dailyGoal', 5, 5], ['dailyGoal', 4, D.dailyGoal], ['dailyGoal', 1000, 1000], ['dailyGoal', 1001, D.dailyGoal],
    // Retention: the research's 0.80-0.95 (docs/RESEARCH.md 4.3); 0.70 and 0.97 are no longer accepted.
    ['retention', 0.8, 0.8], ['retention', 0.95, 0.95], ['retention', 0.854, 0.85], ['retention', 0.79, D.retention], ['retention', 0.96, D.retention],
    ['retention', 0.7, D.retention], ['retention', 0.97, D.retention],
    ['slowRate', 0.5, 0.5], ['slowRate', 1, 1], ['slowRate', 0.755, 0.76], ['slowRate', 0.4, D.slowRate], ['slowRate', 1.5, D.slowRate],
    ['dayStartHour', 0, 0], ['dayStartHour', 12, 12], ['dayStartHour', 4.6, 5], ['dayStartHour', 13, D.dayStartHour], ['dayStartHour', -1, D.dayStartHour],
  ];
  for (const [key, value, want] of cases) assert.equal(cleanSettings({ [key]: value })[key], want, `${key} = ${String(value)}`);
});

test('cleanSettings: booleans, level system and voice are type-checked', () => {
  const s = cleanSettings({ autoplay: !D.autoplay, typeListen: String(!D.typeListen), toneCheck: 0, showPinyinOnRead: !D.showPinyinOnRead, levelSystem: 'hsk20', ttsVoice: 'voice-1' });
  assert.equal(s.autoplay, !D.autoplay);
  assert.equal(s.typeListen, D.typeListen, 'a string is not a boolean');
  assert.equal(s.toneCheck, D.toneCheck, 'neither is a number');
  assert.equal(s.showPinyinOnRead, !D.showPinyinOnRead);
  assert.equal(s.levelSystem, 'hsk20');
  assert.equal(s.ttsVoice, 'voice-1');
  assert.equal(cleanSettings({ levelSystem: 'hsk3' }).levelSystem, D.levelSystem);
  assert.equal(cleanSettings({ ttsVoice: 'x'.repeat(201) }).ttsVoice, D.ttsVoice);
  assert.equal(cleanSettings({ ttsVoice: 7 }).ttsVoice, D.ttsVoice);
});

test('cleanSettings: deck lists are trimmed, validated, de-duplicated, and limited to known decks', () => {
  assert.equal(cleanSettings({ activeDecks: ' exam2025-1 , Bad Deck!, exam2025-1,std2021-2,, travel.station ' }).activeDecks, 'exam2025-1,std2021-2,travel.station');
  assert.equal(cleanSettings({ activeDecks: '' }).activeDecks, '', 'an empty selection is allowed');
  assert.equal(cleanSettings({ activeDecks: 42 }).activeDecks, SETTINGS_DEFAULTS.activeDecks);
  const known = new Set(['exam2025-1', 'kinship']);
  assert.equal(cleanSettings({ activeDecks: 'exam2025-1,exam2025-9,kinship' }, { deckIds: known }).activeDecks, 'exam2025-1,kinship');
  assert.equal(cleanSettings({ activeDecks: `${'a'.repeat(82)},kinship` }).activeDecks, 'kinship', 'over-long ids are dropped');
});

test('activeDeckList and withDeck', () => {
  const s = cleanSettings({ activeDecks: 'exam2025-1,exam2025-2' });
  assert.deepEqual(activeDeckList(s), ['exam2025-1', 'exam2025-2']);
  assert.deepEqual(activeDeckList({ activeDecks: '' }), []);
  const added = withDeck(s, 'kinship', true);
  assert.equal(added.activeDecks, 'exam2025-1,exam2025-2,kinship');
  assert.equal(withDeck(added, 'exam2025-1', false).activeDecks, 'exam2025-2,kinship');
  assert.equal(withDeck(added, 'kinship', true).activeDecks, 'exam2025-1,exam2025-2,kinship', 'no duplicates');
  assert.equal(s.activeDecks, 'exam2025-1,exam2025-2', 'the input is not mutated');
});

test('cardTypesFor: introduction order listen, speak, read, cloze; switched-off types are left out', () => {
  assert.deepEqual(cardTypesFor('word', ALL_TYPES), ['listen', 'speak', 'read', 'cloze']);
  assert.deepEqual(cardTypesFor('word', { ...ALL_TYPES, typeSpeak: false }), ['listen', 'read', 'cloze']);
  assert.deepEqual(cardTypesFor('word', { ...ALL_TYPES, typeListen: false, typeCloze: false }), ['speak', 'read']);
  assert.deepEqual(cardTypesFor('word', { ...ALL_TYPES, typeRead: false }), ['listen', 'speak', 'cloze']);
  assert.deepEqual(cardTypesFor('phrase', ALL_TYPES), ['listen', 'speak']);
  assert.deepEqual(cardTypesFor('phrase', { ...ALL_TYPES, typeListen: false }), ['speak']);
  assert.deepEqual(cardTypesFor('term', ALL_TYPES), ['speak', 'listen']);
  assert.deepEqual(cardTypesFor('rule', ALL_TYPES), []);
  assert.deepEqual(cardTypesFor('word', D), ['listen', 'speak', 'read', 'cloze'].filter((t) => D[`type${t[0].toUpperCase()}${t.slice(1)}`]), 'the defaults');
  assert.deepEqual(cardTypesFor('word', {}), ['listen', 'speak', 'read', 'cloze'], 'missing switches count as on');
});

test('sameSettings', () => {
  assert.ok(sameSettings(cleanSettings({}), cleanSettings(null)));
  assert.ok(!sameSettings(cleanSettings({}), cleanSettings({ newPerDay: D.newPerDay + 1 })));
});

test('cleanSettings: pausing new words while reviews are overdue is on by default and can be switched off', () => {
  assert.equal(cleanSettings({}).pauseNewWhenOverdue, true);
  assert.equal(cleanSettings({ pauseNewWhenOverdue: false }).pauseNewWhenOverdue, false);
  assert.equal(cleanSettings({ pauseNewWhenOverdue: 'no' }).pauseNewWhenOverdue, true);
});
