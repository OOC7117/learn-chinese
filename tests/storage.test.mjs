// Run: node --test tests   (or `npm test` from the repository root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYS, PREFIX, clearPersonalData, createStore, expiryMs, loadAccount, loadSettings, loadSynced, parseJSON, saveAccount,
  saveSettings, saveSynced,
} from '../app/src/lib/storage.js';

/** A Storage-like backend; `fail` makes every call throw (blocked or full storage). */
function fakeStorage({ fail = false } = {}) {
  const map = new Map();
  const guard = () => { if (fail) throw new Error('blocked'); };
  return {
    map,
    getItem: (k) => { guard(); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { guard(); map.set(k, String(v)); },
    removeItem: (k) => { guard(); map.delete(k); },
  };
}
const T = Date.UTC(2026, 10, 2, 12, 0);

test('keys are namespaced per app and version (docs/DATA.md)', () => {
  assert.equal(PREFIX, 'learn-chinese:v1:');
  assert.equal(KEYS.srs, 'learn-chinese:v1:srs');
  assert.deepEqual(Object.keys(KEYS), ['marks', 'srs', 'settings', 'stats', 'account', 'synced', 'srs-revs', 'tones']);
});

test('createStore reads and writes JSON through the backend', () => {
  const backend = fakeStorage();
  const store = createStore(() => backend);
  assert.equal(store.setJSON('stats', { days: {} }), true);
  assert.equal(backend.map.get('learn-chinese:v1:stats'), '{"days":{}}');
  assert.deepEqual(store.getJSON('stats'), { days: {} });
  assert.equal(store.get('marks'), null);
  backend.map.set('learn-chinese:v1:marks', '{broken');
  assert.equal(store.getJSON('marks'), null, 'corrupt JSON reads as nothing');
  assert.equal(store.remove('stats'), true);
  assert.equal(store.get('stats'), null);
  assert.equal(store.usage(), '{broken'.length * 2);
});

test('blocked, full or missing storage: values live in memory for the visit', () => {
  const blocked = fakeStorage({ fail: true });
  for (const getBackend of [() => blocked, () => { throw new Error('SecurityError'); }, () => undefined]) {
    const store = createStore(getBackend);
    assert.equal(store.setJSON('settings', { newPerDay: 5 }), false, 'reports that it did not reach storage');
    assert.deepEqual(store.getJSON('settings'), { newPerDay: 5 });
    store.remove('settings');
    assert.equal(store.get('settings'), null);
  }
  // Storage that comes back: the next successful write moves the value out of memory.
  const flaky = fakeStorage({ fail: true });
  const store = createStore(() => flaky);
  store.set('synced', '1');
  flaky.getItem = (k) => (flaky.map.has(k) ? flaky.map.get(k) : null);
  flaky.setItem = (k, v) => flaky.map.set(k, String(v));
  assert.equal(store.get('synced'), '1', 'from memory');
  assert.equal(store.set('synced', '2'), true);
  assert.equal(flaky.map.get('learn-chinese:v1:synced'), '2');
  flaky.map.delete('learn-chinese:v1:synced'); // e.g. another tab signed out and cleared it
  assert.equal(store.get('synced'), null, 'no stale copy left in memory');
});

test('settings are stored with their change time; a bad time reads as 0', () => {
  const backend = fakeStorage();
  const store = createStore(() => backend);
  assert.deepEqual(loadSettings(store), { settings: null, t: 0 });
  saveSettings(store, { newPerDay: 12 }, T);
  assert.deepEqual(loadSettings(store), { settings: { newPerDay: 12 }, t: T });
  store.set('settings', '{"newPerDay": 3, "t": "yesterday"}');
  assert.deepEqual(loadSettings(store), { settings: { newPerDay: 3 }, t: 0 });
});

test('account: signed in until the token expires (seconds or ms), then signed out keeping the email', () => {
  const backend = fakeStorage();
  const store = createStore(() => backend);
  assert.equal(loadAccount(store, T), null);
  saveAccount(store, { email: ' Learner@Example.com ', token: 'tok', expires_at: (T + 60_000) / 1000 });
  assert.deepEqual(loadAccount(store, T), { email: 'learner@example.com', token: 'tok', expires_at: (T + 60_000) / 1000 });
  assert.deepEqual(loadAccount(store, T + 61_000), { email: 'learner@example.com', token: null, expires_at: 0 }, 'expired');
  saveAccount(store, { email: 'learner@example.com', token: 'tok', expires_at: T + 60_000 });
  assert.equal(loadAccount(store, T).token, 'tok', 'milliseconds work too');
  saveAccount(store, { email: 'learner@example.com' });
  assert.deepEqual(store.getJSON('account'), { email: 'learner@example.com' });
  assert.deepEqual(loadAccount(store, T), { email: 'learner@example.com', token: null, expires_at: 0 });
  store.setJSON('account', { email: 'not an email', token: 'x' });
  assert.equal(loadAccount(store, T), null);
  assert.equal(expiryMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(expiryMs(T), T);
  assert.equal(expiryMs(0), 0);
});

test('sync time and clearing personal data', () => {
  const backend = fakeStorage();
  const store = createStore(() => backend);
  assert.equal(loadSynced(store), 0);
  saveSynced(store, T);
  assert.equal(loadSynced(store), T);
  store.set('synced', 'soon');
  assert.equal(loadSynced(store), 0);
  for (const name of ['account', 'marks', 'srs', 'settings', 'stats', 'srs-revs', 'tones']) store.set(name, '{}');
  backend.map.set('other-app:key', 'kept');
  clearPersonalData(store);
  assert.deepEqual([...backend.map.keys()], ['other-app:key'], "only this app's keys are removed");
  assert.equal(parseJSON(null), null);
  assert.deepEqual(parseJSON('[1]'), [1]);
});
