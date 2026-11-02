// Sync engine (src/sync.js) with a fake fetch, fake timers and a fake clock, against a fake server that
// speaks the API's protocol (marks, settings, statistics in full; card states as deltas into 32 buckets
// with revs). Ported from the reference project (Inburgering flashcards, tests/sync.test.mjs); the
// card-state tests and the account helpers (src/account.js) are new.
// Run: node --test app/tests   (or `npm test` inside app/)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS, DEFAULT_TIMING, STATUS, cleanRevs, createSync } from '../src/sync.js';
import {
  HEADER_TEXT, STATUS_TEXT, hasLocalData, longStatus, signinError, signinFormProblem, switchDropsData,
} from '../src/account.js';
import { bucketOf, mergeSrs } from '../src/lib/srs.js';
import { mergeStats } from '../src/lib/stats.js';

const ANA = Object.freeze({ email: 'ana@example.com', token: 'tok-ana' });

/** Manual clock + timers. `advance(ms)` fires due timers in order and lets promises settle. */
function fakeTime(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** fetch fake: records calls; answers with `respond(call)` (a response, a promise of one, or a throw). */
function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { fetch, calls };
}

/** A card state reviewed at `t` (a valid compact card: version 1, ten numbers). */
const card = (t, reps = 1) => ({ s: [1, Math.round(t / 60_000) + 10, 2.3, 5.1, reps, 0, 2, Math.round(t / 60_000), 0, 1], t, f: t });
/** `count` card states with ids that are valid card ids (the server checks them; this fake does not). */
function cards(count, t = 1_700_000_000_000, prefix = 'w.4e00') {
  const out = {};
  for (let i = 0; i < count; i += 1) out[`${prefix}.c${i}.read`] = card(t + i);
  return out;
}

/** The server: merges like the real one (marks per item, settings, statistics per day; card states per
 * bucket with revs, answering the buckets whose rev differs from the request's srs_revs). */
function fakeServer() {
  const state = { marks: {}, settings: null, settings_t: 0, stats: { days: {} }, updated_at: 0 };
  const buckets = {};
  return {
    state,
    buckets,
    /** Write card states as if another device had sent them. */
    put(entries) {
      for (const [id, entry] of Object.entries(entries)) {
        const b = bucketOf(id);
        const before = buckets[b] ?? { rev: 0, entries: {} };
        buckets[b] = { rev: before.rev + 1, entries: mergeSrs(before.entries, { [id]: entry }) };
      }
    },
    respond(call) {
      const body = call.body;
      for (const [id, entry] of Object.entries(body.marks ?? {})) {
        if (!state.marks[id] || entry.t > state.marks[id].t) state.marks[id] = entry;
      }
      if (body.settings && body.settings_t > state.settings_t) {
        state.settings = body.settings;
        state.settings_t = body.settings_t;
      }
      if (body.stats) state.stats = mergeStats(state.stats, body.stats);
      const revs = body.srs_revs ?? {};
      const groups = {};
      for (const [id, entry] of Object.entries(body.srs ?? {})) (groups[bucketOf(id)] ??= {})[id] = entry;
      const ackOnly = new Map();
      for (const [b, entries] of Object.entries(groups)) {
        const before = buckets[b] ?? { rev: 0, entries: {} };
        const merged = mergeSrs(before.entries, entries);
        if (JSON.stringify(merged) === JSON.stringify(before.entries)) continue;
        const exact = Object.entries(entries).every(([id, sent]) => JSON.stringify(merged[id]) === JSON.stringify(mergeSrs({}, { [id]: sent })[id]));
        if (exact && before.rev === (revs[b] ?? 0)) ackOnly.set(b, before.rev + 1);
        buckets[b] = { rev: before.rev + 1, entries: merged };
      }
      const answer = {};
      for (const [b, value] of Object.entries(buckets)) {
        if (value.rev === (revs[b] ?? 0)) continue;
        answer[b] = ackOnly.get(b) === value.rev ? { rev: value.rev, entries: {} } : structuredClone(value);
      }
      for (const [b, rev] of Object.entries(revs)) if (!buckets[b] && rev !== 0) answer[b] = { rev: 0, entries: {} };
      return json(200, { state: structuredClone(state), srs: { buckets: answer } });
    },
  };
}

function setup({ respond, online = true, local = {}, lastSynced: synced = 0, timing = {}, limits = {}, start } = {}) {
  const time = fakeTime(start);
  const server = fakeServer();
  const net = fakeFetch(respond ?? ((call) => server.respond(call)));
  const page = { marks: {}, settings: null, settings_t: 0, stats: { days: {} }, srs: {}, ...local };
  const remote = [];
  const statuses = [];
  const ended = [];
  let lastSynced = synced;
  let revs = {};
  let isOnline = online;
  const sync = createSync({
    getState: () => ({ marks: page.marks, settings: page.settings, settings_t: page.settings_t, stats: page.stats, srs: page.srs }),
    // The page merges what comes back (as account.js does through ctx.state.merge).
    onRemote: (state) => {
      remote.push(state);
      if (state.srs) page.srs = mergeSrs(page.srs, state.srs);
    },
    onStatus: (info) => statuses.push(info.status),
    onUnauthorized: (email) => ended.push(email),
    fetch: net.fetch,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    random: () => 0.5, // no jitter
    isOnline: () => isOnline,
    loadLastSynced: () => lastSynced,
    saveLastSynced: (t) => { lastSynced = t; },
    loadRevs: () => revs,
    saveRevs: (next) => { revs = structuredClone(next); },
    timing,
    limits,
  });
  return {
    sync, time, net, server, page, remote, statuses, ended,
    setOnline(value) { isOnline = value; },
    get lastSynced() { return lastSynced; },
    set lastSynced(value) { lastSynced = value; },
    get revs() { return revs; },
    set revs(value) { revs = value; },
  };
}

const srsOf = (call) => Object.keys(call.body.srs ?? {});

test('does nothing while signed out', async () => {
  const t = setup();
  t.sync.changed();
  t.sync.pull();
  t.sync.flush();
  t.sync.online();
  assert.deepEqual(await t.sync.syncNow(), { ok: false, error: 'signed_out' });
  await t.time.advance(120_000);
  assert.equal(t.net.calls.length, 0);
  assert.equal(t.sync.info().status, STATUS.OFF);
});

test('changes are debounced into one request with the full state', async () => {
  const t = setup();
  t.sync.setAccount(ANA);
  t.page.marks = { 'w.1': { m: 'star', t: 1 } };
  t.sync.changed();
  assert.equal(t.sync.info().status, STATUS.PENDING);
  await t.time.advance(1000);
  t.page.marks = { 'w.1': { m: 'star', t: 1 }, 'w.2': { m: null, t: 2 } };
  t.page.stats = { days: { '2026-11-02': { r: 3, n: 1, a: 0, ms: 9000 } } };
  t.sync.changed();
  await t.time.advance(1499);
  assert.equal(t.net.calls.length, 0, 'still waiting: the debounce restarts on every change');
  await t.time.advance(1);
  assert.equal(t.net.calls.length, 1);
  const [call] = t.net.calls;
  assert.equal(call.url, 'api/sync');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, 'Bearer tok-ana', 'the session token, not an email in the body');
  assert.equal(call.init.keepalive, false);
  assert.deepEqual(call.body, { marks: t.page.marks, stats: t.page.stats, srs_revs: {}, srs: {} }, 'tombstones included, no settings yet');
  assert.equal(t.remote.length, 1, 'the merged state goes back to the page');
  assert.deepEqual(t.remote[0].marks, t.page.marks);
  assert.deepEqual(t.remote[0].stats, t.page.stats);
  assert.equal(t.remote[0].srs, undefined, 'no card states received');
  assert.equal(t.sync.info().status, STATUS.SYNCED);
  assert.equal(t.lastSynced, t.time.now());
  assert.equal(t.sync.hasUnsynced(), false);
});

test('settings are sent only once they have a time', async () => {
  const t = setup({ local: { settings: { newPerDay: 10 }, settings_t: 0 } });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal('settings' in t.net.calls[0].body, false);
  t.page.settings_t = 123;
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[1].body.settings, { newPerDay: 10 });
  assert.equal(t.net.calls[1].body.settings_t, 123);
});

test('quiet changes ride along: no request of their own, sent by the flush', async () => {
  const t = setup();
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  t.sync.changed({ quiet: true });
  await t.time.advance(60_000);
  assert.equal(t.net.calls.length, 1);
  assert.equal(t.sync.info().status, STATUS.SYNCED, 'not shown as pending');
  assert.equal(t.sync.hasUnsynced(), true);
  t.sync.flush();
  t.sync.flush(); // visibilitychange (hidden) and pagehide both fire: one request
  await t.time.advance(0);
  assert.equal(t.net.calls.length, 2);
  assert.equal(t.net.calls[1].init.keepalive, true);
  assert.equal(t.net.calls[1].init.headers.Authorization, 'Bearer tok-ana', 'the keepalive flush is authorised too');
  assert.equal(t.sync.hasUnsynced(), false);
  t.sync.flush();
  await t.time.advance(0);
  assert.equal(t.net.calls.length, 2, 'nothing new to flush');
});

test('flush cancels the pending debounce and skips keepalive for large bodies', async () => {
  const t = setup();
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  const big = {};
  for (let i = 0; i < 2000; i += 1) big[`w.4e00-4e01-4e02.yi1ding1xia4.c${i}`] = { m: 'star', t: 1_700_000_000_000 };
  t.page.marks = big;
  t.sync.changed();
  t.sync.flush();
  await t.time.advance(DEFAULT_TIMING.debounceMs * 2);
  assert.equal(t.net.calls.length, 2, 'the flush replaced the debounced request');
  assert.ok(t.net.calls[1].init.body.length > DEFAULT_TIMING.keepaliveMaxBytes);
  assert.equal(t.net.calls[1].init.keepalive, false, 'over the keepalive limit: a normal request');
});

test('flush sends only the marks, days and card states changed since the last full sync, so keepalive applies', async () => {
  const t = setup();
  const big = {};
  for (let i = 0; i < 2000; i += 1) big[`w.4e00-4e01-4e02.yi1ding1xia4.c${i}`] = { m: null, t: 1_700_000_000_000 };
  t.page.marks = big;
  t.page.stats = { days: { '2026-11-01': { r: 5, n: 1, a: 0, ms: 1 } } };
  t.page.srs = cards(300);
  t.sync.setAccount(ANA);
  await t.sync.syncNow(); // full state
  assert.equal(Object.keys(t.net.calls[0].body.marks).length, 2000);
  assert.equal(srsOf(t.net.calls[0]).length, 300);
  const id = 'w.4e00-4e01-4e02.yi1ding1xia4.c7';
  const studied = { 'w.4e00.c3.read': card(1_800_000_000_000, 2), 'w.4f60.new.listen': card(1_800_000_000_001) };
  t.page.marks = { ...big, [id]: { m: 'star', t: 1_700_000_000_001 }, 'w.new': { m: 'skip', t: 1_700_000_000_002 } };
  t.page.stats = { days: { '2026-11-01': { r: 5, n: 1, a: 0, ms: 1 }, '2026-11-02': { r: 2, n: 0, a: 1, ms: 5 } } };
  t.page.srs = { ...t.page.srs, ...studied };
  t.page.settings = { newPerDay: 10 };
  t.page.settings_t = 5;
  t.sync.changed();
  t.sync.flush();
  await t.time.advance(DEFAULT_TIMING.debounceMs * 2);
  assert.equal(t.net.calls.length, 2);
  const { body } = t.net.calls[1];
  assert.deepEqual(body.marks, { [id]: { m: 'star', t: 1_700_000_000_001 }, 'w.new': { m: 'skip', t: 1_700_000_000_002 } });
  assert.deepEqual(body.stats, { days: { '2026-11-02': { r: 2, n: 0, a: 1, ms: 5 } } });
  assert.deepEqual(body.srs, studied);
  assert.deepEqual([body.settings, body.settings_t], [{ newPerDay: 10 }, 5]);
  assert.equal(t.net.calls[1].init.keepalive, true);
  assert.equal(t.sync.hasUnsynced(), false);
  // The next ordinary sync sends the full marks and statistics again (self-healing), not the card states.
  await t.sync.syncNow();
  assert.equal(Object.keys(t.net.calls[2].body.marks).length, 2001);
  assert.equal(Object.keys(t.net.calls[2].body.stats.days).length, 2);
  assert.deepEqual(t.net.calls[2].body.srs, {});
});

test('network failures keep retrying with capped exponential backoff', async () => {
  let fail = true;
  const server = fakeServer();
  const t = setup({ respond: (call) => { if (fail) throw new TypeError('Failed to fetch'); return server.respond(call); } });
  t.sync.setAccount(ANA);
  const first = await t.sync.syncNow();
  assert.equal(first.ok, false);
  assert.equal(first.error, 'network');
  assert.equal(t.sync.info().status, STATUS.OFFLINE);
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    const [delay] = t.time.pending();
    delays.push(delay);
    await t.time.advance(delay);
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(t.net.calls.length, 8);
  // While failing, new changes do not add requests of their own: the retry sends everything.
  t.sync.changed();
  assert.deepEqual(t.time.pending(), [60000]);
  fail = false;
  await t.time.advance(60000);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
  assert.equal(t.sync.hasUnsynced(), false);
  assert.deepEqual(t.time.pending(), [], 'no retry after success');
});

test('5xx and timeouts retry; the online event retries at once', async () => {
  let mode = 'error';
  const server = fakeServer();
  const t = setup({
    respond: (call) => {
      if (mode === 'error') return json(500, { error: 'internal' });
      if (mode === 'hang') return new Promise((_, reject) => call.init.signal.addEventListener('abort', () => reject(new Error('AbortError'))));
      return server.respond(call);
    },
  });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal(t.sync.info().status, STATUS.OFFLINE);
  assert.equal(t.sync.info().error, 'internal');

  mode = 'hang';
  await t.time.advance(2000); // first retry: hangs until the timeout aborts it
  assert.equal(t.sync.info().status, STATUS.SYNCING);
  await t.time.advance(DEFAULT_TIMING.timeoutMs);
  assert.equal(t.sync.info().status, STATUS.OFFLINE);
  assert.equal(t.sync.info().error, 'network');

  // Offline: no timer at all, the 'online' event takes over.
  t.setOnline(false);
  await t.time.advance(4000); // the scheduled retry runs (and fails) while offline
  mode = 'error';
  await t.time.advance(0);
  const callsBefore = t.net.calls.length;
  await t.time.advance(10 * 60_000);
  assert.ok(t.net.calls.length <= callsBefore + 1, 'no retry loop while the browser is offline');
  t.setOnline(true);
  mode = 'ok';
  t.sync.online();
  await t.time.advance(0);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('503 pauses automatic syncing (no retry storm); Sync now still tries', async () => {
  let unavailable = true;
  const server = fakeServer();
  const t = setup({ respond: (call) => (unavailable ? json(503, { error: 'storage_unavailable' }) : server.respond(call)) });
  t.sync.setAccount(ANA);
  const result = await t.sync.syncNow();
  assert.deepEqual(result, { ok: false, status: 503, error: 'storage_unavailable' });
  assert.equal(t.sync.info().status, STATUS.UNAVAILABLE);
  assert.deepEqual(t.time.pending(), [], 'no retry timer');
  t.sync.changed();
  t.sync.pull();
  t.sync.online();
  t.sync.flush();
  await t.time.advance(DEFAULT_TIMING.unavailablePauseMs - 1);
  assert.equal(t.net.calls.length, 1, 'changes, pulls, online and flushes wait out the pause');
  assert.equal(t.sync.hasUnsynced(), true);

  await t.sync.syncNow(); // the "Sync now" button tries even during the pause (and re-arms it)
  assert.equal(t.net.calls.length, 2);
  assert.equal(t.sync.info().status, STATUS.UNAVAILABLE);
  await t.time.advance(DEFAULT_TIMING.unavailablePauseMs);
  assert.equal(t.net.calls.length, 2);
  unavailable = false;
  t.sync.pull(); // pause over, never synced: pulls
  await t.time.advance(0);
  assert.equal(t.net.calls.length, 3);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('4xx answers are not retried; the next change tries again', async () => {
  let reject = true;
  const server = fakeServer();
  const t = setup({ respond: (call) => (reject ? json(400, { error: 'invalid_marks' }) : server.respond(call)) });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal(t.sync.info().status, STATUS.ERROR);
  assert.equal(t.sync.info().error, 'invalid_marks');
  await t.time.advance(10 * 60_000);
  assert.equal(t.net.calls.length, 1);
  reject = false;
  t.sync.changed();
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  assert.equal(t.net.calls.length, 2);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('an unreadable 200 answer counts as a failure and is retried', async () => {
  const t = setup({ respond: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('HTML'); } }) });
  t.sync.setAccount(ANA);
  const result = await t.sync.syncNow();
  assert.equal(result.ok, false);
  assert.equal(t.sync.info().status, STATUS.OFFLINE);
  assert.equal(t.remote.length, 0);
  assert.deepEqual(t.time.pending(), [2000]);
});

test('changes made while a request runs are sent by a second request', async () => {
  const server = fakeServer();
  const gates = [];
  const t = setup({ respond: (call) => new Promise((resolve) => gates.push(() => resolve(server.respond(call)))) });
  t.sync.setAccount(ANA);
  t.page.marks = { 'w.1': { m: 'star', t: 1 } };
  const running = t.sync.syncNow();
  await settle();
  assert.equal(t.net.calls.length, 1);
  // The user stars another word (and answers a card) while the request is on its way.
  t.page.marks = { ...t.page.marks, 'w.2': { m: 'skip', t: 2 } };
  t.page.srs = cards(1);
  t.sync.changed();
  const again = t.sync.syncNow(); // e.g. "Sync now": joins the running one and runs once more
  assert.equal(again, running);
  gates.shift()();
  await settle();
  assert.equal(t.net.calls.length, 2, 'second request after the first answered');
  assert.deepEqual(Object.keys(t.net.calls[1].body.marks), ['w.1', 'w.2']);
  assert.deepEqual(srsOf(t.net.calls[1]), Object.keys(cards(1)));
  gates.shift()();
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(t.sync.hasUnsynced(), false);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('a change during a request keeps the state unsynced until it is sent', async () => {
  const server = fakeServer();
  const gates = [];
  const t = setup({ respond: (call) => new Promise((resolve) => gates.push(() => resolve(server.respond(call)))) });
  t.sync.setAccount(ANA);
  t.sync.syncNow();
  await settle();
  t.sync.changed();
  gates.shift()();
  await settle();
  assert.equal(t.sync.hasUnsynced(), true);
  assert.equal(t.sync.info().status, STATUS.PENDING, 'its debounce is still waiting');
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  gates.shift()();
  await settle();
  assert.equal(t.sync.hasUnsynced(), false);
});

test('pull runs at most every 30 s', async () => {
  const t = setup();
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  t.sync.pull();
  await t.time.advance(29_999);
  t.sync.pull();
  await t.time.advance(0);
  assert.equal(t.net.calls.length, 1);
  await t.time.advance(1);
  t.sync.pull();
  await t.time.advance(0);
  assert.equal(t.net.calls.length, 2);
  assert.equal(t.remote.length, 2);
});

test('signing out drops answers for the old account and stops all timers', async () => {
  const server = fakeServer();
  const gates = [];
  const t = setup({ respond: (call) => new Promise((resolve) => gates.push(() => resolve(server.respond(call)))) });
  t.sync.setAccount(ANA);
  const running = t.sync.syncNow();
  await settle();
  t.sync.changed();
  t.sync.setAccount(null);
  assert.equal(t.sync.info().status, STATUS.OFF);
  assert.deepEqual(t.time.pending().filter((ms) => ms < DEFAULT_TIMING.timeoutMs), [], 'debounce cleared');
  gates.shift()();
  assert.deepEqual(await running, { ok: false, error: 'stale' });
  assert.equal(t.remote.length, 0, 'the old account\'s state never reaches the page');
  assert.equal(t.sync.info().status, STATUS.OFF);
  // Signing in as someone else starts clean.
  t.sync.setAccount({ email: 'bo@example.com', token: 'tok-bo' });
  const next = t.sync.syncNow();
  await settle();
  gates.shift()();
  assert.equal((await next).ok, true);
  assert.equal(t.net.calls.at(-1).init.headers.Authorization, 'Bearer tok-bo');
});

test('a throwing onRemote does not wedge the engine, and its buckets are asked for again', async () => {
  const time = fakeTime();
  const server = fakeServer();
  server.put(cards(3));
  const net = fakeFetch((call) => server.respond(call));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  let revs = {};
  try {
    const sync = createSync({
      getState: () => ({ marks: {}, settings: null, settings_t: 0, stats: { days: {} }, srs: {} }),
      onRemote: () => { throw new Error('bug'); },
      loadRevs: () => revs,
      saveRevs: (next) => { revs = next; },
      fetch: net.fetch, now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    });
    sync.setAccount(ANA);
    assert.equal((await sync.syncNow()).ok, true);
    assert.equal(sync.info().status, STATUS.SYNCED);
    assert.equal(errors.length, 1);
    assert.deepEqual(revs, {}, 'revs are saved only once the page merged the buckets');
    await sync.syncNow();
    assert.ok(Object.keys(net.calls[1].body.srs_revs).length === 0 && errors.length === 2, 'the same buckets come again');
  } finally {
    console.error = original;
  }
});

test('login and register post the form and return the session and the account state', async () => {
  const state = { marks: {}, settings: null, settings_t: 0, stats: { days: {} }, updated_at: 1 };
  const t = setup({
    respond: (call) => {
      const { email } = call.body;
      if (email === 'bad') return json(400, { error: 'invalid_email' });
      if (email === 'wrong@example.com') return json(401, { error: 'invalid_credentials' });
      if (email === 'locked@example.com') return json(423, { error: 'account_locked', retry_after: 840 });
      if (email === 'down@example.com') return json(503, { error: 'accounts_unavailable' });
      if (email === 'offline@example.com') throw new TypeError('Failed to fetch');
      if (email === 'notoken@example.com') return json(200, { email, created: true, state });
      return json(200, { email, token: `tok-${email}`, expires_at: 2_000_000_000, created: call.url === 'api/register', state });
    },
  });
  const ok = await t.sync.login({ email: 'ana@example.com', password: 'hunter2hunter2' });
  assert.deepEqual(ok, {
    ok: true, email: 'ana@example.com', token: 'tok-ana@example.com', expires_at: 2_000_000_000, created: false, state,
  });
  assert.equal(t.net.calls[0].url, 'api/login');
  assert.deepEqual(t.net.calls[0].body, { email: 'ana@example.com', password: 'hunter2hunter2' });
  assert.equal(t.net.calls[0].init.headers.Authorization, undefined);

  const created = await t.sync.register({ email: 'bo@example.com', password: 'longenough', inviteCode: '010101' });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(t.net.calls[1].url, 'api/register');
  assert.deepEqual(t.net.calls[1].body, { email: 'bo@example.com', password: 'longenough', invite_code: '010101' });

  const login = (email) => t.sync.login({ email, password: 'x' });
  assert.deepEqual(await login('bad'), { ok: false, status: 400, error: 'invalid_email', retryAfter: null });
  assert.deepEqual(await login('wrong@example.com'), { ok: false, status: 401, error: 'invalid_credentials', retryAfter: null });
  assert.deepEqual(await login('locked@example.com'), { ok: false, status: 423, error: 'account_locked', retryAfter: 840 });
  assert.deepEqual(await login('down@example.com'), { ok: false, status: 503, error: 'accounts_unavailable', retryAfter: null });
  assert.deepEqual(await login('offline@example.com'), { ok: false, status: 0, error: 'network', retryAfter: null });
  assert.equal((await login('notoken@example.com')).ok, false, 'an answer without a token is not a sign-in');
  assert.equal(t.sync.info().status, STATUS.OFF, 'login alone does not start syncing');
  assert.deepEqual(t.ended, [], 'a 401 from login is a wrong password, not an ended session');
});

test('forgot posts the email only', async () => {
  const t = setup({
    respond: (call) => (call.body.email === 'slow@example.com'
      ? json(429, { error: 'rate_limited', retry_after: 3600 })
      : json(200, { ok: true })),
  });
  assert.deepEqual(await t.sync.forgot('ana@example.com'), { ok: true });
  assert.equal(t.net.calls[0].url, 'api/forgot');
  assert.deepEqual(t.net.calls[0].body, { email: 'ana@example.com' });
  assert.deepEqual(await t.sync.forgot('slow@example.com'), { ok: false, status: 429, error: 'rate_limited', retryAfter: 3600 });
});

test('a 401 ends the session: syncing stops, local state stays, nothing retries', async () => {
  let expired = false;
  const server = fakeServer();
  const t = setup({ respond: (call) => (expired ? json(401, { error: 'unauthorized' }) : server.respond(call)) });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  expired = true;
  t.page.marks = { 'w.1': { m: 'star', t: 5 } };
  t.page.srs = cards(2);
  t.sync.changed();
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  assert.equal(t.net.calls.length, 2);
  assert.equal(t.sync.info().status, STATUS.EXPIRED);
  assert.equal(t.sync.info().email, 'ana@example.com', 'the email stays for "sign in again"');
  assert.deepEqual(t.ended, ['ana@example.com']);
  assert.deepEqual(t.time.pending().filter((ms) => ms < DEFAULT_TIMING.timeoutMs), [], 'no retry timer');
  assert.equal(t.sync.hasUnsynced(), true, 'the local change is still waiting for the account');
  assert.deepEqual(t.page.marks, { 'w.1': { m: 'star', t: 5 } });

  // Nothing sends while the session is over.
  t.sync.changed();
  t.sync.pull();
  t.sync.online();
  t.sync.flush();
  assert.deepEqual(await t.sync.syncNow(), { ok: false, error: 'signed_out' });
  await t.time.advance(10 * 60_000);
  assert.equal(t.net.calls.length, 2);

  // Signing in again (new token) sends everything this device kept.
  expired = false;
  t.sync.setAccount({ email: 'ana@example.com', token: 'tok-ana-2' });
  assert.equal((await t.sync.syncNow()).ok, true);
  assert.equal(t.net.calls[2].init.headers.Authorization, 'Bearer tok-ana-2');
  assert.deepEqual(t.net.calls[2].body.marks, { 'w.1': { m: 'star', t: 5 } });
  assert.deepEqual(srsOf(t.net.calls[2]), Object.keys(cards(2)), 'the card states the 401 refused are sent');
  assert.equal(t.sync.info().status, STATUS.SYNCED);
  assert.equal(t.sync.hasUnsynced(), false);
});

test('several 401 answers for one token end the session once', async () => {
  const gates = [];
  const t = setup({ respond: () => new Promise((resolve) => gates.push(() => resolve(json(401, { error: 'unauthorized' })))) });
  t.sync.setAccount(ANA);
  t.sync.syncNow();
  t.sync.changed();
  t.sync.flush(); // a second request in flight with the same token
  await settle();
  assert.equal(t.net.calls.length, 2);
  for (const open of gates.splice(0)) open();
  await settle();
  assert.deepEqual(t.ended, ['ana@example.com']);
  assert.equal(t.statuses.filter((s) => s === STATUS.EXPIRED).length, 1);
});

test('an account without a token (ended session) does not sync and shows EXPIRED', async () => {
  const t = setup();
  t.sync.setAccount({ email: 'ana@example.com', token: null });
  assert.equal(t.sync.info().status, STATUS.EXPIRED);
  t.sync.changed();
  await t.time.advance(DEFAULT_TIMING.debounceMs * 2);
  assert.equal(t.net.calls.length, 0);
  t.sync.setAccount(null);
  assert.equal(t.sync.info().status, STATUS.OFF);
});

test('status events report each transition once', async () => {
  const t = setup();
  t.sync.setAccount(ANA);
  t.sync.changed();
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  t.sync.setAccount(null);
  assert.deepEqual(t.statuses, [STATUS.PENDING, STATUS.SYNCING, STATUS.SYNCED, STATUS.OFF]);
});

// ---- Card states (srs): deltas, chunks, buckets and revs ----

test('card states: only what the server does not have is sent', async () => {
  const t = setup({ local: { srs: cards(5) } });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[0].body.srs, cards(5), 'first sync on this device: every card state');
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[1].body.srs, {}, 'acknowledged: not sent again');
  // One card answered again, one new card.
  const id = 'w.4e00.c2.read';
  t.page.srs = { ...t.page.srs, [id]: card(1_800_000_000_000, 2), 'w.4e00.new.speak': card(1_800_000_000_001) };
  t.sync.changed();
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  assert.deepEqual(srsOf(t.net.calls[2]).sort(), [id, 'w.4e00.new.speak']);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('a malformed local card state is never sent (the server would refuse every later sync)', async () => {
  const t = setup({ local: { srs: { ...cards(2), 'w.4e00.bad.read': { s: [2, 1], t: 5 }, 'Not An Id': card(1) } } });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.deepEqual(srsOf(t.net.calls[0]).sort(), Object.keys(cards(2)).sort());
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('card states go in chunks of 3,000 within one syncNow; "Synced" and lastSynced only once all are sent', async () => {
  const t = setup({ local: { srs: cards(7000) } });
  t.sync.setAccount(ANA);
  const result = await t.sync.syncNow();
  assert.equal(result.ok, true);
  assert.deepEqual(t.net.calls.map((call) => srsOf(call).length), [3000, 3000, 1000]);
  assert.equal(new Set(t.net.calls.flatMap(srsOf)).size, 7000, 'every card state once');
  assert.ok(t.net.calls.every((call) => JSON.stringify(call.body).length < DEFAULT_LIMITS.maxBodyBytes), 'every body below the limit');
  assert.deepEqual(t.statuses, [STATUS.PENDING, STATUS.SYNCING, STATUS.SYNCED], 'no "Synced" between the chunks');
  assert.equal(t.lastSynced, t.time.now());
  assert.equal(t.sync.hasUnsynced(), false);
  const total = Object.values(t.server.buckets).reduce((sum, b) => sum + Object.keys(b.entries).length, 0);
  assert.equal(total, 7000);
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[3].body.srs, {}, 'then nothing is left');
});

test('card states are cut at the body limit too; nothing is sent twice', async () => {
  const t = setup({ local: { srs: cards(400) }, limits: { maxBodyBytes: 20_000 } });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.ok(t.net.calls.length > 2, `${t.net.calls.length} requests`);
  assert.ok(t.net.calls.every((call) => call.init.body.length <= 20_000));
  assert.equal(t.net.calls.flatMap(srsOf).length, 400);
  assert.equal(new Set(t.net.calls.flatMap(srsOf)).size, 400);
});

test('nothing fits (marks alone fill the body): no request loop, the state stays unsynced', async () => {
  const marks = {};
  for (let i = 0; i < 500; i += 1) marks[`w.4e00-4e01.c${i}`] = { m: 'skip', t: 1_700_000_000_000 };
  const t = setup({ local: { marks, srs: cards(3) }, limits: { maxBodyBytes: 10_000 } });
  t.sync.setAccount(ANA);
  const result = await t.sync.syncNow();
  assert.equal(result.ok, true);
  assert.equal(t.net.calls.length, 1, 'no loop');
  assert.deepEqual(t.net.calls[0].body.srs, {});
  assert.equal(t.sync.hasUnsynced(), true);
  assert.equal(t.sync.info().status, STATUS.PENDING);
  assert.equal(t.lastSynced, 0, 'not a complete sync');
});

test('received buckets: merged by the page, acknowledged (never sent back), their revs kept and sent', async () => {
  const t = setup({ local: { srs: cards(2, 1_700_000_000_000, 'w.mine') } });
  const theirs = cards(4, 1_700_000_100_000, 'w.theirs');
  t.server.put(theirs);
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  const received = t.remote[0].srs;
  assert.deepEqual(received, { ...mergeSrs({}, theirs) }, 'onRemote gets the entries of the buckets received');
  assert.deepEqual(t.page.srs, mergeSrs(cards(2, 1_700_000_000_000, 'w.mine'), theirs));
  const expected = Object.fromEntries(Object.entries(t.server.buckets).map(([b, v]) => [b, v.rev]));
  assert.deepEqual(t.revs, expected, 'every bucket\'s rev is kept (learn-chinese:v1:srs-revs)');
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[1].body.srs, {}, 'received entries are not sent back');
  assert.deepEqual(t.net.calls[1].body.srs_revs, expected);
  assert.equal(t.remote[1].srs, undefined, 'nothing new');

  // Another device changes one card: only its bucket comes, and the page gets the newer entry.
  const id = Object.keys(theirs)[1];
  t.server.put({ [id]: card(1_800_000_000_000, 3) });
  await t.sync.syncNow();
  assert.deepEqual(Object.keys(t.remote[2].srs), Object.keys(t.server.buckets[bucketOf(id)].entries));
  assert.equal(t.page.srs[id].t, 1_800_000_000_000);
  assert.equal(t.revs[bucketOf(id)], t.server.buckets[bucketOf(id)].rev);
});

test('a newer local entry beats a received older one and is still sent; the earliest first review is kept', async () => {
  const id = 'w.4e00.c0.read';
  const mine = card(1_800_000_000_000, 5);
  const t = setup({ local: { srs: { [id]: mine } } });
  t.server.put({ [id]: card(1_700_000_000_000, 1) });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.deepEqual(srsOf(t.net.calls[0]), [id]);
  const stored = t.server.buckets[bucketOf(id)];
  assert.equal(stored.rev, 2);
  assert.deepEqual(stored.entries[id], { ...mine, f: 1_700_000_000_000 }, 'the newer review wins, the earliest first review stays');
  assert.deepEqual(t.remote[0].srs, { [id]: stored.entries[id] }, 'not "ack only": the merge kept something of the stored entry');
  assert.deepEqual(t.page.srs[id], stored.entries[id]);
  assert.equal(t.revs[bucketOf(id)], 2);
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[1].body.srs, {}, 'in step: nothing to send');

  // Sent as stored, from the rev the device has: "ack only", no entries echoed.
  t.page.srs = { ...t.page.srs, [id]: { ...card(1_900_000_000_000, 6), f: 1_700_000_000_000 } };
  await t.sync.syncNow();
  assert.deepEqual(t.remote.at(-1).srs, undefined);
  assert.equal(t.revs[bucketOf(id)], 3);
});

test('a bucket whose rev went back (the server lost data) is sent again at once', async () => {
  const t = setup({ local: { srs: cards(30) } });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  const [lost] = Object.keys(t.server.buckets);
  const inLost = Object.keys(t.server.buckets[lost].entries);
  assert.ok(inLost.length > 0);
  delete t.server.buckets[lost]; // e.g. restored from an older backup
  const calls = t.net.calls.length;
  const result = await t.sync.syncNow();
  assert.equal(result.ok, true);
  assert.deepEqual(t.net.calls[calls].body.srs, {}, 'the device thinks the server has everything ...');
  assert.deepEqual(srsOf(t.net.calls[calls + 1]).sort(), [...inLost].sort(), '... until the bucket comes back at rev 0');
  assert.deepEqual(Object.keys(t.server.buckets[lost].entries).sort(), [...inLost].sort());
});

test('an answer cut short by the server (`more`) is followed by another request at once', async () => {
  const server = fakeServer();
  server.put(cards(40));
  let first = true;
  const t = setup({
    respond: (call) => {
      const answer = server.respond(call);
      if (!first) return answer;
      first = false;
      return answer.json().then((data) => {
        const keep = Object.keys(data.srs.buckets).slice(0, 3);
        return json(200, { ...data, srs: { buckets: Object.fromEntries(keep.map((b) => [b, data.srs.buckets[b]])), more: true } });
      });
    },
  });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal(t.net.calls.length, 2);
  assert.equal(Object.keys(t.net.calls[1].body.srs_revs).length, 3, 'the second request says which buckets it has');
  assert.deepEqual(t.page.srs, mergeSrs({}, cards(40)));
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('after a page reload, card states from before the last complete sync count as sent', async () => {
  const lastSynced = 1_700_000_000_000 + 10 * DEFAULT_TIMING.ackMarginMs;
  const old = cards(50, 1_700_000_000_000);
  const recent = { 'w.4e00.recent.read': card(lastSynced - 1000), 'w.4e00.later.read': card(lastSynced + 5000) };
  const t = setup({ local: { srs: { ...old, ...recent } }, lastSynced, start: lastSynced + 60_000 });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.deepEqual(srsOf(t.net.calls[0]).sort(), Object.keys(recent).sort(), 'only the last hour before the sync, and after it');
  // Another account on this device (after signing out, which clears the last sync time): everything again.
  t.sync.setAccount(null);
  const fresh = setup({ local: { srs: { ...old, ...recent } } });
  fresh.sync.setAccount(ANA);
  await fresh.sync.syncNow();
  assert.equal(srsOf(fresh.net.calls[0]).length, 52, 'never synced: everything');
});

test('a bucket received in full that lacks states this device counted as sent: they go up again', async () => {
  // This device synced long ago (its states count as sent after a reload), then the account's data was
  // replaced (deleted, created again and filled by another device) without this device knowing. A bucket
  // the server has at a lower rev than this device remembers is sent again (rev went back); one at a
  // higher rev comes in full and shows what is missing; one at the very same rev shows nothing until it
  // changes again, then the same.
  const lastSynced = 1_700_000_000_000 + 10 * DEFAULT_TIMING.ackMarginMs;
  const mine = cards(40, 1_700_000_000_000, 'w.mine');
  const byBucket = {};
  for (const id of Object.keys(mine)) (byBucket[bucketOf(id)] ??= []).push(id);
  const [higher, equal] = Object.keys(byBucket);
  const theirs = (bucket, n, from = 0) => {
    const out = {};
    for (let i = from; Object.keys(out).length < n; i += 1) {
      const id = `w.theirs.c${i}.listen`;
      if (bucketOf(id) === bucket) out[id] = card(1_750_000_000_000 + i);
    }
    return out;
  };
  const t = setup({ local: { srs: mine }, lastSynced, start: lastSynced + 60_000 });
  for (const [id, entry] of Object.entries(theirs(higher, 7))) t.server.put({ [id]: entry }); // rev 7
  for (const [id, entry] of Object.entries(theirs(equal, 3))) t.server.put({ [id]: entry }); // rev 3
  t.revs = { ...Object.fromEntries(Object.keys(byBucket).map((b) => [b, 2])), [higher]: 5, [equal]: 3 };
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[0].body.srs, {}, 'everything counted as sent');
  const others = Object.keys(mine).filter((id) => bucketOf(id) !== equal);
  assert.deepEqual(srsOf(t.net.calls[1]).sort(), others.sort(), 'at once: the bucket at a higher rev (its missing states) and the buckets that went back');
  assert.equal(t.net.calls.length, 2);
  assert.ok(others.every((id) => t.server.buckets[bucketOf(id)].entries[id]));
  assert.ok(byBucket[equal].every((id) => !t.server.buckets[equal].entries[id]), 'same rev, other contents: not seen yet');
  assert.equal(t.sync.info().status, STATUS.SYNCED);

  t.server.put(theirs(equal, 1, 1000)); // another device studies a card of that bucket: rev 4
  await t.sync.syncNow();
  assert.deepEqual(srsOf(t.net.calls[3]).sort(), [...byBucket[equal]].sort(), 'now it comes in full, and the missing states go up');
  assert.ok(byBucket[equal].every((id) => t.server.buckets[equal].entries[id]));
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls.at(-1).body.srs, {}, 'in step');
  assert.equal(t.net.calls.length, 5, 'no request loop');
});

test('a bucket answered "ack only" or in full with this device\'s own states never makes it send again', async () => {
  const t = setup({ local: { srs: cards(30) } });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal(t.net.calls.length, 1, 'first sync: everything sent, every bucket acknowledged');
  t.server.put({ 'w.other.c1.read': card(1_800_000_000_000) }); // another device: one bucket comes in full
  await t.sync.syncNow();
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls.slice(1).map((call) => srsOf(call).length), [0, 0], 'nothing sent again');
});

test('an imported backup is sent, and its old card states never count as sent after a reload', async () => {
  const lastSynced = 1_700_000_000_000 + 10 * DEFAULT_TIMING.ackMarginMs;
  const synced = cards(20, 1_700_000_000_000);
  const t = setup({ local: { srs: synced }, lastSynced, start: lastSynced + 60_000 });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.deepEqual(t.net.calls[0].body.srs, {}, 'reviewed long before the last sync: on the server already');

  // Settings → Import backup: card states reviewed even longer ago, which the account never had.
  const backup = cards(5, 1_600_000_000_000, 'w.4e01');
  t.page.srs = mergeSrs(t.page.srs, backup);
  t.sync.imported();
  assert.equal(t.lastSynced, 0, 'the last-sync mark is gone until a complete sync has sent the import');
  assert.equal(t.sync.info().status, STATUS.PENDING, 'synced like any change (debounced)');
  // The page is closed before that sync runs. Next visit: nothing counts as sent, so the backup goes up.
  const reloaded = setup({ local: { srs: t.page.srs }, lastSynced: t.lastSynced, start: t.time.now() + 60_000 });
  reloaded.sync.setAccount(ANA);
  await reloaded.sync.syncNow();
  assert.deepEqual(srsOf(reloaded.net.calls[0]).sort(), Object.keys({ ...synced, ...backup }).sort());
  assert.ok(reloaded.lastSynced > 0, 'complete again');

  // The first page, had it stayed open: its debounced sync sends the backup, then the mark is back.
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  assert.deepEqual(srsOf(t.net.calls[1]).sort(), Object.keys(backup).sort());
  assert.equal(t.lastSynced, t.time.now());
});

test('a sync built before an import does not set the last-sync mark when it completes', async () => {
  let release = null;
  const server = fakeServer();
  const t = setup({
    respond: (call, n) => (n === 1 ? new Promise((resolve) => { release = () => resolve(server.respond(call)); }) : server.respond(call)),
    local: { srs: cards(3) },
  });
  t.sync.setAccount(ANA);
  const running = t.sync.syncNow();
  await settle();
  assert.equal(t.net.calls.length, 1, 'built and sent');
  t.page.srs = mergeSrs(t.page.srs, cards(2, 1_600_000_000_000, 'w.4e01'));
  t.sync.imported();
  release();
  await running;
  assert.equal(t.lastSynced, 0, 'that request did not carry the import');
  assert.equal(t.sync.hasUnsynced(), true);
  await t.time.advance(DEFAULT_TIMING.debounceMs);
  assert.deepEqual(srsOf(t.net.calls[1]).sort(), Object.keys(cards(2, 1_600_000_000_000, 'w.4e01')).sort());
  assert.ok(t.lastSynced > 0);
  assert.equal(t.sync.hasUnsynced(), false);
  assert.equal(t.sync.info().status, STATUS.SYNCED);
});

test('an import while signed out or after the session ended is sent by the next sign-in', async () => {
  const lastSynced = 1_700_000_000_000 + 10 * DEFAULT_TIMING.ackMarginMs;
  const t = setup({ local: { srs: cards(4, 1_700_000_000_000) }, lastSynced, start: lastSynced + 60_000 });
  t.sync.setAccount({ email: ANA.email, token: null }); // "Signed out · sign in again"
  t.page.srs = mergeSrs(t.page.srs, cards(2, 1_600_000_000_000, 'w.4e01'));
  t.sync.imported();
  await t.time.advance(10_000);
  assert.equal(t.net.calls.length, 0, 'no sync without a session');
  assert.equal(t.lastSynced, 0);
  t.sync.setAccount(ANA); // signed in again
  await t.sync.syncNow();
  assert.equal(srsOf(t.net.calls[0]).length, 6, 'everything: the import may be older than the last sync');
});

test('a last-sync mark from a clock that ran ahead is not trusted after a reload', async () => {
  const start = 1_800_000_000_000;
  // Synced while the clock was three days ahead; the clock was put right and cards were studied since.
  const studied = cards(3, start - 5 * DEFAULT_TIMING.ackMarginMs);
  const t = setup({ local: { srs: studied }, lastSynced: start + 3 * 86_400_000, start });
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal(srsOf(t.net.calls[0]).length, 3, 'the mark lies in the future: nothing counts as sent');
  // The same states with a mark from the past (a clock that was right) count as sent.
  const right = setup({ local: { srs: studied }, lastSynced: start - DEFAULT_TIMING.ackMarginMs, start });
  right.sync.setAccount(ANA);
  await right.sync.syncNow();
  assert.equal(srsOf(right.net.calls[0]).length, 0);
});

test('the last sync of the previous account is not shown for the next one', async () => {
  const t = setup();
  t.sync.setAccount(ANA);
  await t.sync.syncNow();
  assert.equal(t.sync.info().lastSynced, t.time.now());
  t.sync.setAccount(null);
  t.lastSynced = 0; // signing out clears learn-chinese:v1:synced (clearPersonalData)
  t.sync.setAccount({ email: 'bo@example.com', token: 'tok-bo' });
  assert.equal(t.sync.info().lastSynced, 0);
  // The same person signing in again (new token) keeps it.
  await t.sync.syncNow();
  const at = t.sync.info().lastSynced;
  t.sync.setAccount({ email: 'bo@example.com', token: 'tok-bo-2' });
  assert.equal(t.sync.info().lastSynced, at);
});

test('requests per syncNow are capped', async () => {
  const t = setup({ local: { srs: cards(50) }, limits: { srsPerRequest: 2, maxRounds: 5 } });
  t.sync.setAccount(ANA);
  const result = await t.sync.syncNow();
  assert.equal(t.net.calls.length, 5);
  assert.equal(result.more, true);
  assert.equal(t.sync.info().status, STATUS.PENDING, 'the rest goes with the next sync');
  assert.equal(t.sync.hasUnsynced(), true);
});

test('cleanRevs keeps buckets 00-31 with integer revs only', () => {
  assert.deepEqual(cleanRevs({ '00': 1, 31: 2, 32: 3, 7: 4, '07': 5, '08': -1, '09': 1.5, 10: '3', x: 1 }), { '00': 1, 31: 2, '07': 5 });
  for (const bad of [null, [], 'x', 5]) assert.deepEqual(cleanRevs(bad), {});
});

// ---- Account helpers (src/account.js) ----

test('account texts: header label and full status for every status, the account dialog line', () => {
  for (const status of Object.values(STATUS)) {
    assert.equal(typeof HEADER_TEXT[status], 'string', status);
    assert.equal(typeof STATUS_TEXT[status], 'string', status);
    assert.ok(HEADER_TEXT[status].length <= 18, `"${HEADER_TEXT[status]}" fits the header button on a phone`);
  }
  assert.equal(HEADER_TEXT[STATUS.OFF], 'Sign in');
  assert.equal(STATUS_TEXT[STATUS.EXPIRED], 'Signed out · sign in again');
  const now = new Date(2026, 10, 2, 15, 0).getTime();
  assert.equal(longStatus({ status: STATUS.SYNCED, lastSynced: now - 10_000 }, now), 'Everything is synced. Last synced just now.');
  assert.match(longStatus({ status: STATUS.SYNCED, lastSynced: now - 3_600_000 }, now), /^Everything is synced\. Last synced today at /);
  assert.match(longStatus({ status: STATUS.EXPIRED, lastSynced: 0 }, now), /^Signed out · sign in again\. Your progress is still saved/);
  assert.equal(longStatus({ status: STATUS.OFF, lastSynced: 0 }, now), '');
});

test('sign-in errors: every code the API and the accounts service answer has a message and a field', () => {
  assert.deepEqual(signinError({ status: 503, error: 'accounts_unavailable', retryAfter: null }),
    { text: 'Sign-in is not available right now. Your progress is still saved on this device.' });
  assert.match(signinError({ status: 503, error: 'storage_unavailable' }).text, /^Sign-in is not available right now/);
  assert.equal(signinError({ status: 401, error: 'invalid_credentials' }).field, 'password');
  assert.equal(signinError({ status: 403, error: 'invalid_invite_code' }).field, 'invite');
  assert.equal(signinError({ status: 409, error: 'email_taken' }).field, 'email');
  assert.match(signinError({ status: 423, error: 'account_locked', retryAfter: 840 }).text, /14 minutes/);
  assert.match(signinError({ status: 429, error: 'rate_limited', retryAfter: 30 }).text, /1 minute/);
  assert.match(signinError({ status: 429, error: 'rate_limited', retryAfter: null }).text, /a few minutes/);
  assert.match(signinError({ status: 0, error: 'network' }).text, /Could not reach the server/);
  assert.match(signinError({ status: 501, error: 'http_501' }).text, /not available on this site/, 'a static host without the API');
  assert.match(signinError({ status: 500, error: 'internal' }).text, /error 500/);
});

test('sign-in form checks before sending', () => {
  assert.equal(signinFormProblem('signin', null, 'x', '').field, 'email');
  assert.equal(signinFormProblem('signin', 'a@b.co', '', '').field, 'password');
  assert.equal(signinFormProblem('signin', 'a@b.co', 'x', ''), null);
  assert.equal(signinFormProblem('forgot', 'a@b.co', '', ''), null);
  assert.equal(signinFormProblem('create', 'a@b.co', 'short', '010101').field, 'password');
  assert.equal(signinFormProblem('create', 'a@b.co', 'x'.repeat(201), '010101').field, 'password');
  assert.equal(signinFormProblem('create', 'a@b.co', 'long enough', '').field, 'invite');
  assert.equal(signinFormProblem('create', 'a@b.co', '长密码长密码长密码', '010101'), null, 'characters, not bytes');
});

test('signing in as someone else asks first only when an ended session left progress here', () => {
  const ended = { email: 'ana@example.com', token: null };
  const progress = { marks: {}, srs: cards(1), stats: { days: {} } };
  assert.equal(hasLocalData({ marks: { 'w.1': { m: null, t: 1 } }, srs: {}, stats: { days: { '2026-11-01': { r: 0 } } } }), false, 'tombstones and empty days are not progress');
  assert.equal(hasLocalData({ marks: { 'w.1': { m: 'star', t: 1 } } }), true);
  assert.equal(hasLocalData({ stats: { days: { '2026-11-01': { r: 2 } } } }), true);
  assert.equal(hasLocalData(progress), true);
  assert.equal(switchDropsData(ended, 'bo@example.com', progress), true);
  assert.equal(switchDropsData(ended, 'ana@example.com', progress), false, 'the same person keeps everything');
  assert.equal(switchDropsData({ email: 'ana@example.com', token: 'tok' }, 'bo@example.com', progress), false, 'signed in: sign out first');
  assert.equal(switchDropsData(null, 'bo@example.com', progress), false, 'anonymous progress joins the account');
  assert.equal(switchDropsData(ended, 'bo@example.com', { marks: {}, srs: {}, stats: { days: {} } }), false);
});
