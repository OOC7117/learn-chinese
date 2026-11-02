// Run: node --test tests   (or `npm test` from the repository root)
// app/src/state.js with an in-memory store: answering and resetting cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createState } from '../app/src/state.js';
import { createStore } from '../app/src/lib/storage.js';
import { decodeCard, mergeSrs } from '../app/src/lib/srs.js';

function memoryBackend() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('resetting an item writes a newer never-reviewed state that wins a sync merge', () => {
  let clock = Date.UTC(2026, 10, 2, 9);
  const backend = memoryBackend();
  const state = createState({ store: createStore(() => backend), now: () => clock });
  state.answer('w.4f60.ni3.listen', 'good');
  state.answer('w.4f60.ni3.speak', 'good');
  const before = state.srs['w.4f60.ni3.listen'];
  assert.equal(decodeCard(before.s).reps, 1);

  clock += 60_000;
  state.resetItem('w.4f60.ni3');
  const after = state.srs['w.4f60.ni3.listen'];
  assert.ok(after, 'the card is kept (as a new card), not deleted');
  assert.equal(decodeCard(after.s).reps, 0);
  assert.ok(after.t > before.t);
  assert.equal(decodeCard(state.srs['w.4f60.ni3.speak'].s).reps, 0);

  // Another device still has the old review: the reset is newer and wins in both directions.
  const remote = { 'w.4f60.ni3.listen': before };
  assert.equal(decodeCard(mergeSrs(state.srs, remote)['w.4f60.ni3.listen'].s).reps, 0);
  assert.equal(decodeCard(mergeSrs(remote, state.srs)['w.4f60.ni3.listen'].s).reps, 0);

  // Studying it again starts it as a new card.
  clock += 60_000;
  state.answer('w.4f60.ni3.listen', 'good');
  assert.equal(decodeCard(state.srs['w.4f60.ni3.listen'].s).reps, 1);
});

test('a value that storage refused is what the app reads back', () => {
  const backend = memoryBackend();
  let full = false;
  const store = createStore(() => ({ ...backend, setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); backend.setItem(k, v); } }));
  store.set('srs', 'old');
  full = true;
  assert.equal(store.set('srs', 'new'), false);
  assert.equal(store.get('srs'), 'new', 'not the stale stored value');
  full = false;
  assert.equal(store.set('srs', 'newer'), true);
  assert.equal(store.get('srs'), 'newer');
});
