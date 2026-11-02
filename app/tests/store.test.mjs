// Run: node --test app/tests   (or `npm test` inside app/)
// The store adapters (api/_lib/store.js): backend choice, the JSON file store in a temp dir, and the
// Upstash Redis REST adapter against a fake Upstash (compare-and-set, SCAN, MGET, DEL), then the API
// handlers end to end on Redis, card-state buckets included (concurrent writers to one bucket must
// heal, delete-user must remove every key). Ported from the reference project (Inburgering flashcards,
// tests/api.test.mjs "Store adapters").
// This file changes process.env only inside tests (withEnv), never at import: tests/index.js runs every
// suite in one process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as register from '../api/register.js';
import * as service from '../api/service.js';
import * as sync from '../api/sync.js';
import { readCatalog } from '../api/_lib/items.js';
import {
  StorageUnavailable, StoreConflict, createFileStore, createRedisStore, prefixPattern, storeFromEnv,
} from '../api/_lib/store.js';
import { recordKey, srsKey, srsKeys } from '../api/_lib/users.js';
import { bucketOf, createScheduler, makeEntry } from '../src/lib/srs.js';
import { INVITE_CODE, SERVICE_KEY, startFakeAccounts } from './fake-accounts.mjs';

/** Run `fn` with some env vars changed, restoring them afterwards. */
async function withEnv(changes, fn) {
  const before = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('storeFromEnv picks the backend from the environment', () => {
  const dir = '/tmp/learn-chinese-somewhere';
  const kv = { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'kv-token' };
  const upstash = { UPSTASH_REDIS_REST_URL: 'https://up.example', UPSTASH_REDIS_REST_TOKEN: 'up-token' };
  assert.equal(storeFromEnv({}).kind, 'file');
  assert.match(storeFromEnv({}).dir, /app[\\/]\.data[\\/]?$/, 'default: app/.data/ (gitignored)');
  assert.equal(storeFromEnv({ LEARN_CHINESE_DATA_DIR: dir }).dir, dir);
  assert.equal(storeFromEnv(kv).kind, 'redis');
  assert.equal(storeFromEnv({ ...upstash, VERCEL: '1' }).kind, 'redis');
  assert.equal(storeFromEnv({ KV_REST_API_URL: 'https://kv.example', ...upstash }).kind, 'redis', 'incomplete KV pair falls back to UPSTASH_*');
  assert.equal(storeFromEnv({ ...kv, LEARN_CHINESE_STORE: 'file' }).kind, 'file');
  assert.throws(() => storeFromEnv({ VERCEL: '1' }), StorageUnavailable);
  assert.throws(() => storeFromEnv({ LEARN_CHINESE_STORE: 'redis' }), StorageUnavailable);
});

test('file store: atomic set, nx only creates, list / getMany / delete / deleteMany', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-chinese-store-'));
  try {
    const store = createFileStore(join(dir, 'nested'));
    assert.deepEqual(await store.list('app:'), [], 'missing folder: nothing listed');
    assert.equal(await store.get('app:key/with*odd chars'), null);
    assert.equal(await store.set('app:key/with*odd chars', { a: 1 }), true);
    assert.deepEqual(await store.get('app:key/with*odd chars'), { a: 1 });
    assert.equal(await store.set('app:key/with*odd chars', { a: 2 }, { nx: true }), false);
    assert.deepEqual(await store.get('app:key/with*odd chars'), { a: 1 });
    assert.equal(await store.set('other', { b: 1 }, { nx: true }), true);
    assert.deepEqual(readdirSync(join(dir, 'nested')).sort(), ['app%3Akey%2Fwith%2Aodd%20chars.json', 'other.json']);

    await store.set('app:b', { b: 2 });
    writeFileSync(join(dir, 'nested', 'app%3Ac.json.123.abc.tmp'), '{}'); // a temp file is not a key
    writeFileSync(join(dir, 'nested', 'not%ZZencoded.json'), '{}');
    assert.deepEqual(await store.list('app:'), ['app:b', 'app:key/with*odd chars']);
    assert.deepEqual(await store.getMany(['app:b', 'missing', 'other']), [{ b: 2 }, null, { b: 1 }]);
    assert.deepEqual(await store.getMany([]), []);
    assert.equal(await store.delete('app:b'), true);
    assert.equal(await store.delete('app:b'), false);
    assert.deepEqual(await store.list('app:'), ['app:key/with*odd chars']);
    await store.set('app:c', { c: 3 });
    assert.equal(await store.deleteMany(['app:c', 'app:key/with*odd chars', 'missing']), 2);
    assert.equal(await store.deleteMany([]), 0);
    assert.deepEqual(await store.list('app:'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file store: concurrent updates of one key are queued, none is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-chinese-store-'));
  try {
    const store = createFileStore(dir);
    const add = (n) => store.update('k', async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 1)); // a slow merge
      return { n: [...(current?.n ?? []), n], rev: (current?.rev ?? 0) + 1 };
    });
    await Promise.all(Array.from({ length: 10 }, (_, i) => add(i)));
    const value = await store.get('k');
    assert.deepEqual(value.n.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(value.rev, 10);
    await store.update('k', () => null);
    assert.equal((await store.get('k')).rev, 10, 'null: nothing written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake Upstash REST endpoint: POST <url> with a JSON command array, answers { result } / { error }. */
function fakeUpstash({ token = 'secret', fail = null, scanBatch = 2 } = {}) {
  const data = new Map();
  const commands = [];
  const globToRegExp = (glob) => new RegExp(`^${glob.replace(/\\(.)|([.+^${}()|[\]])|(\*)|(\?)/g, (m, escaped, special, star, q) => {
    if (escaped !== undefined) return escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (special !== undefined) return `\\${special}`;
    if (star) return '.*';
    if (q) return '.';
    return m;
  })}$`);
  const fake = { data, commands, beforeEval: null };
  fake.fetch = async (url, init) => {
    if (fail === 'network') throw new TypeError('fetch failed');
    if (fail === 'http') return Response.json({ error: 'ERR something' }, { status: 500 });
    assert.equal(url, 'https://redis.example');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    const args = JSON.parse(init.body);
    commands.push(args);
    const [name, key, value, flag] = args;
    if (name === 'GET') return Response.json({ result: data.get(key) ?? null });
    if (name === 'EVAL') { // only the store's compare-and-set script
      const [, script, numKeys, casKey, expected, next] = args;
      assert.match(script, /redis\.call\('GET', KEYS\[1\]\)/);
      assert.equal(numKeys, '1');
      await fake.beforeEval?.(casKey);
      if ((data.get(casKey) ?? '') !== expected) return Response.json({ result: 0 });
      data.set(casKey, next);
      return Response.json({ result: 1 });
    }
    if (name === 'SET') {
      assert.equal(typeof value, 'string');
      if (flag === 'NX' && data.has(key)) return Response.json({ result: null });
      data.set(key, value);
      return Response.json({ result: 'OK' });
    }
    if (name === 'DEL') return Response.json({ result: args.slice(1).filter((k) => data.delete(k)).length });
    if (name === 'MGET') return Response.json({ result: args.slice(1).map((k) => data.get(k) ?? null) });
    if (name === 'SCAN') { // small batches, cursor = offset; repeats one key like real SCAN may
      const [, cursor, match, pattern, countWord, count] = args;
      assert.deepEqual([match, countWord, count], ['MATCH', 'COUNT', '500']);
      const all = [...data.keys()].sort();
      const start = Number(cursor);
      const page = all.slice(start, start + scanBatch).filter((k) => globToRegExp(pattern).test(k));
      const next = start + scanBatch >= all.length ? '0' : String(start + scanBatch);
      return Response.json({ result: [next, start > 0 && page.length ? [...page, page[0]] : page] });
    }
    return Response.json({ error: 'ERR unknown command' }, { status: 400 });
  };
  return fake;
}

test('Redis store speaks the Upstash REST protocol', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://redis.example/', token: 'secret', fetch: fake.fetch });
  assert.equal(await store.get('k'), null);
  assert.equal(await store.set('k', { a: 1 }), true);
  assert.equal(await store.set('k', { a: 2 }, { nx: true }), false);
  assert.deepEqual(await store.get('k'), { a: 1 });
  assert.deepEqual(fake.commands, [['GET', 'k'], ['SET', 'k', '{"a":1}'], ['SET', 'k', '{"a":2}', 'NX'], ['GET', 'k']]);

  for (const fail of ['network', 'http']) {
    const broken = createRedisStore({ url: 'https://redis.example', token: 'secret', fetch: fakeUpstash({ fail }).fetch });
    await assert.rejects(broken.get('k'), StorageUnavailable);
    await assert.rejects(broken.set('k', {}), StorageUnavailable);
    await assert.rejects(broken.list('k'), StorageUnavailable);
    await assert.rejects(broken.getMany(['k']), StorageUnavailable);
    await assert.rejects(broken.deleteMany(['k']), StorageUnavailable);
  }
});

test('Redis list / getMany / delete / deleteMany: SCAN in batches, MGET, DEL', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://redis.example', token: 'secret', fetch: fake.fetch });
  for (const key of ['app:user:1', 'app:user:2', 'app:user:3', 'app:userx', 'apps:user:9', 'other:1', 'a*p:user:1']) {
    await store.set(key, { key });
  }
  fake.commands.length = 0;
  assert.deepEqual(await store.list('app:user:'), ['app:user:1', 'app:user:2', 'app:user:3']);
  const scans = fake.commands.filter(([name]) => name === 'SCAN');
  assert.ok(scans.length > 2, 'walked every cursor');
  assert.equal(scans[0][1], '0');
  assert.deepEqual(await store.list('a*p:'), ['a*p:user:1'], 'glob characters in the prefix are literal');
  assert.equal(prefixPattern('a*b?[c]\\'), 'a\\*b\\?\\[c\\]\\\\*');

  assert.deepEqual(await store.getMany(['app:user:2', 'nope', 'other:1']), [{ key: 'app:user:2' }, null, { key: 'other:1' }]);
  assert.deepEqual(fake.commands.at(-1), ['MGET', 'app:user:2', 'nope', 'other:1']);
  const before = fake.commands.length;
  assert.deepEqual(await store.getMany([]), []);
  assert.equal(await store.deleteMany([]), 0);
  assert.equal(fake.commands.length, before, 'no request for no keys');
  assert.equal(await store.delete('app:user:2'), true);
  assert.equal(await store.delete('app:user:2'), false);
  assert.deepEqual(fake.commands.at(-1), ['DEL', 'app:user:2']);
  assert.deepEqual(await store.list('app:user:'), ['app:user:1', 'app:user:3']);
  assert.equal(await store.deleteMany(['app:user:1', 'app:user:3', 'nope']), 2);
  assert.deepEqual(fake.commands.at(-1), ['DEL', 'app:user:1', 'app:user:3', 'nope'], 'one round trip');
  assert.deepEqual(await store.list('app:user:'), []);
});

test('Redis update is a compare-and-set: concurrent writers retry instead of overwriting', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://redis.example', token: 'secret', fetch: fake.fetch });
  const add = (n) => store.update('k', (current) => ({ n: [...(current?.n ?? []), n] }));
  await Promise.all([add(1), add(2), add(3)]);
  assert.deepEqual((await store.get('k')).n.sort(), [1, 2, 3]);
  assert.ok(fake.commands.filter(([name]) => name === 'EVAL').length > 3, 'losers retried');
  // Nothing to write: no EVAL.
  const before = fake.commands.length;
  await store.update('k', () => null);
  assert.deepEqual(fake.commands.slice(before), [['GET', 'k']]);
  // Someone else writes on every try: gives up with StoreConflict (a 500, which the browser retries).
  const busy = createRedisStore({ url: 'https://redis.example', token: 'secret', fetch: fake.fetch });
  await assert.rejects(busy.update('k', async (current) => {
    fake.data.set('k', JSON.stringify({ n: [...current.n, 0] }));
    return { n: [] };
  }), StoreConflict);
});

// ---- The API on Redis (as on Vercel with the Upstash integration) ----

const CATALOG = await readCatalog();
const WORD_IDS = [...CATALOG.ids].filter((id) => id.startsWith('w.')).sort();
const scheduler = createScheduler({ fuzz: false });
const entry = (t, grade = 'good') => makeEntry(scheduler.review(null, grade, t), t);

/** Calls a handler with a JSON body; { status, body }. */
async function call(handler, body, headers = {}) {
  const response = await handler(new Request('http://localhost/api/x', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

/** Redis requests go to `redisFetch`; the accounts service is the real (fake) HTTP server. */
async function withRedis(accounts, redisFetch, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith(accounts.url) ? realFetch(url, init) : redisFetch(url, init));
  try {
    return await withEnv({
      VERCEL: '1', KV_REST_API_URL: 'https://redis.example', KV_REST_API_TOKEN: 'secret', UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined, LEARN_CHINESE_STORE: undefined, LEARN_CHINESE_DATA_DIR: undefined,
      ACCOUNTS_URL: accounts.url, ACCOUNTS_SERVICE_KEY: SERVICE_KEY,
    }, fn);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('handlers work end to end on Redis (KV_REST_API_* from the Vercel integration), buckets included', async (t) => {
  const accounts = await startFakeAccounts();
  t.after(() => accounts.close());
  const fake = fakeUpstash();
  await withRedis(accounts, fake.fetch, async () => {
    const email = 'redis.learner@example.com';
    const now = Date.now();
    const registered = await call(register.POST, { email, password: 'correct horse battery', invite_code: INVITE_CODE });
    assert.equal(registered.body.created, true);
    const auth = { authorization: `Bearer ${registered.body.token}` };
    const card = `${WORD_IDS[0]}.read`;
    const synced = await call(sync.POST, {
      marks: { [WORD_IDS[1]]: { m: 'skip', t: now } }, srs: { [card]: entry(now - 1000) }, srs_revs: {},
      stats: { days: { [new Date(now).toISOString().slice(0, 10)]: { r: 1, n: 1, a: 0, ms: 2000 } } },
    }, auth);
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body.state.marks, { [WORD_IDS[1]]: { m: 'skip', t: now } });
    assert.deepEqual(synced.body.srs, { buckets: { [bucketOf(card)]: { rev: 1, entries: {} } } });
    const keys = [recordKey(email), srsKey(email, bucketOf(card))];
    assert.deepEqual([...fake.data.keys()].sort(), [...keys].sort());
    assert.equal(JSON.parse(fake.data.get(recordKey(email))).email, email);
    const allKeys = new Set([...keys, ...srsKeys(email)]);
    for (const command of fake.commands) {
      const used = command[0] === 'EVAL' ? [command[3]] : command[0] === 'MGET' || command[0] === 'DEL' ? command.slice(1) : [command[1]];
      for (const key of used) assert.ok(allKeys.has(key), `only the hashed keys are used (${command[0]})`);
    }
    assert.ok(!JSON.stringify(fake.commands.map((c) => (c[0] === 'EVAL' ? c.slice(0, 4) : c.slice(0, 2)))).includes('redis.learner'));
    // The answer's buckets come from one MGET of all 32 keys.
    const mgets = fake.commands.filter(([name]) => name === 'MGET');
    assert.equal(mgets.length, 1);
    assert.deepEqual(mgets[0].slice(1), srsKeys(email));

    const stats = await call(service.POST, { action: 'stats' }, { 'x-accounts-service-key': SERVICE_KEY });
    assert.equal(stats.body.total_skipped, 1);
    assert.equal(stats.body.total_reviews, 1);
    assert.deepEqual((await call(service.POST, { action: 'delete-user', email }, { 'x-accounts-service-key': SERVICE_KEY })).body, { deleted: true });
    assert.equal(fake.data.size, 0, 'the record and every bucket are gone');
    const del = fake.commands.filter(([name]) => name === 'DEL');
    assert.equal(del.length, 1, 'one DEL');
    assert.deepEqual(del[0].slice(1), [recordKey(email), ...srsKeys(email)]);
  });
  await quiet(() => withRedis(accounts, fakeUpstash({ fail: 'network' }).fetch, async () => {
    const token = accounts.tokenFor('redis.down@example.com');
    const result = await call(sync.POST, { marks: {} }, { authorization: `Bearer ${token}` });
    assert.deepEqual([result.status, result.body], [503, { error: 'storage_unavailable' }]);
  }));
});

test('concurrent syncs into one bucket on Redis: the compare-and-set conflict heals, no card state is lost', async (t) => {
  const accounts = await startFakeAccounts();
  t.after(() => accounts.close());
  const fake = fakeUpstash();
  await withRedis(accounts, fake.fetch, async () => {
    const email = 'redis.race@example.com';
    const token = accounts.tokenFor(email);
    const auth = { authorization: `Bearer ${token}` };
    const now = Date.now() - 10_000;
    // Two devices' requests for the same bucket, each with another card; the first CAS write of the
    // bucket is preceded by a foreign write, so it must re-read, merge again and retry.
    const bucket = '13';
    const cards = WORD_IDS.map((id) => `${id}.listen`).filter((id) => bucketOf(id) === bucket).slice(0, 3);
    assert.equal(cards.length, 3);
    await call(sync.POST, { marks: {}, srs: { [cards[0]]: entry(now) }, srs_revs: {} }, auth); // record + bucket rev 1
    let raced = false;
    fake.beforeEval = (key) => {
      if (raced || key !== srsKey(email, bucket)) return;
      raced = true;
      const stored = JSON.parse(fake.data.get(key));
      stored.entries[cards[2]] = entry(now + 2);
      stored.rev += 1;
      fake.data.set(key, JSON.stringify(stored)); // another device's write lands first
    };
    const [a, b] = await Promise.all([
      call(sync.POST, { marks: {}, srs: { [cards[1]]: entry(now + 1) }, srs_revs: { [bucket]: 1 } }, auth),
      call(sync.POST, { marks: {}, srs_revs: { [bucket]: 1 } }, auth),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(raced);
    const stored = JSON.parse(fake.data.get(srsKey(email, bucket)));
    assert.deepEqual(Object.keys(stored.entries).sort(), [...cards].sort(), 'every device\'s card state is kept');
    assert.equal(stored.rev, 3, 'rev 1, the foreign write, then the retried merge');
    assert.ok(fake.commands.filter(([name, , , key]) => name === 'EVAL' && key === srsKey(email, bucket)).length >= 3, 'the loser retried');
    // The request that lost the race did not have the foreign entry: it gets the whole bucket back.
    assert.equal(a.body.srs.buckets[bucket].rev, 3);
    assert.deepEqual(Object.keys(a.body.srs.buckets[bucket].entries).sort(), [...cards].sort());
  });
});
