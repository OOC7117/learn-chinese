// Run: node --test app/tests   (or `npm test` inside app/)
// API handlers against the JSON file store in a temp dir and a fake accounts service (tests/fake-accounts.mjs,
// a real HTTP server); card-state buckets (first sync, revs, deltas, unknown ids, answer budget); the
// deployment config; and the dev server end to end (two devices with conflicting offline edits must
// converge). Ported from the reference project (Inburgering flashcards, tests/api.test.mjs); the Redis
// adapter tests are in store.test.mjs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as forgot from '../api/forgot.js';
import * as login from '../api/login.js';
import * as register from '../api/register.js';
import * as service from '../api/service.js';
import * as sync from '../api/sync.js';
import {
  VERIFY_CACHE_MS, verifyCacheMs, accountsConfig, clearVerifyCache, clientIp, createAccountsClient, createVerifier,
} from '../api/_lib/accounts.js';
import { HttpError, MAX_BODY_BYTES } from '../api/_lib/http.js';
import { isKnownCard, onlyKnownCards, readCatalog } from '../api/_lib/items.js';
import { storeFromEnv } from '../api/_lib/store.js';
import { BUCKETS, recordKey, srsKey, srsKeys } from '../api/_lib/users.js';
import { MAX_CLOCK_SKEW_MS, mergeMarks, mergeSettings, setMark } from '../src/lib/marks.js';
import { bucketOf, createScheduler, decodeCard, makeEntry, mergeSrs } from '../src/lib/srs.js';
import { mergeStats } from '../src/lib/stats.js';
import { INVITE_CODE, SERVICE_KEY, startFakeAccounts } from './fake-accounts.mjs';

const STORE_ENV = ['VERCEL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'LEARN_CHINESE_STORE', 'LEARN_CHINESE_DATA_DIR', 'ACCOUNTS_URL', 'ACCOUNTS_SERVICE_KEY'];
const savedEnv = Object.fromEntries(STORE_ENV.map((key) => [key, process.env[key]]));
const dataDir = mkdtempSync(join(tmpdir(), 'learn-chinese-api-'));
for (const key of STORE_ENV) delete process.env[key];
process.env.LEARN_CHINESE_DATA_DIR = dataDir;
const accounts = await startFakeAccounts();
process.env.ACCOUNTS_URL = accounts.url;
process.env.ACCOUNTS_SERVICE_KEY = SERVICE_KEY;

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
  await accounts.close();
});

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

/** Capture console output while `fn` runs. */
async function captureConsole(fn) {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const original = Object.fromEntries(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join('\n');
}

function request(body, { method = 'POST', headers = {} } = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
  return new Request('http://localhost/api/test', init);
}

async function call(handler, body, options) {
  const response = await handler(request(body, options));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });
/** POST /api/sync as the owner of `token`. */
const syncAs = (token, body) => call(sync.POST, body, bearer(token));
const serviceCall = (body, key = SERVICE_KEY) => call(service.POST, body, { headers: key ? { 'x-accounts-service-key': key } : {} });

const now = () => Date.now();
// The API keeps marks and card states of real items only (api/_lib/items.js), so tests use the ids of
// the generated data (app/data), sorted so C(1) < C(2) < … as object keys. The data is regenerated by
// the pipeline, so nothing here depends on particular words.
const CATALOG = await readCatalog();
const WORD_IDS = [...CATALOG.ids].filter((id) => id.startsWith('w.')).sort();
const C = (n) => WORD_IDS[n];
const CARD = (n, type = 'read') => `${C(n)}.${type}`;
const scheduler = createScheduler({ fuzz: false });
/** A card state: `grade` answered at `t` (on `card`, or on a new card). */
const entry = (t, grade = 'good', card = null) => makeEntry(scheduler.review(card, grade, t), t);
/** Card ids (of real items) that fall into `bucket`, as many as asked. */
function cardsIn(bucket, count, type = 'read') {
  const out = [];
  for (let i = 0; out.length < count && i < WORD_IDS.length; i += 1) {
    const id = `${WORD_IDS[i]}.${type}`;
    if (bucketOf(id) === bucket) out.push(id);
  }
  return out;
}
const revsOf = (answer) => Object.fromEntries(Object.entries(answer.srs.buckets).map(([bucket, value]) => [bucket, value.rev]));

let counter = 0;
const freshEmail = () => `learner${(counter += 1)}@example.com`;
const PASSWORD = 'correct horse battery';

/** An email with an account at the (fake) accounts service and a valid session token. */
function signedIn(email = freshEmail()) {
  return { email, token: accounts.tokenFor(email) };
}

// ---- Items (api/_lib/items.js) ----

test('the catalog has the generated words, and phrases and kinship terms from content.json', async () => {
  assert.ok(WORD_IDS.length > 1000, 'the HSK words are known');
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  const first = JSON.parse(readFileSync(new URL(`../${manifest.files['words-1'].file}`, import.meta.url), 'utf8')).items[0];
  assert.deepEqual(CATALOG.items.get(first.i), { id: first.i, hanzi: first.h, pinyin: first.p, meaning: first.m[0] });

  const dir = mkdtempSync(join(tmpdir(), 'learn-chinese-items-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'manifest.json'), JSON.stringify({ files: {
      'words-1': { file: 'data/words-1.json' }, 'words-x': { file: '../secret.json' }, tones: { file: 'data/tones.json' },
      content: { file: 'data/content.json' },
    } }));
    writeFileSync(join(dir, 'data', 'words-1.json'), JSON.stringify({ items: [
      { i: 'w.4f60.ni3', h: '你', p: 'nǐ', m: ['you'] }, { i: 'Bad Id', h: 'x', p: 'x', m: [] },
    ] }));
    writeFileSync(join(dir, 'data', 'content.json'), JSON.stringify({
      situations: [{ id: 'travel', scenes: [{ id: 'travel.a', phrases: [{ id: 'travel.a.hello', hanzi: 'h', pinyin: 'p', english: 'Hello' }] }] }],
      kinship: { terms: [{ id: 'family.k.baba', hanzi: 'b', pinyin: 'bb', english: 'father' }] },
    }));
    const catalog = await readCatalog(pathToFileURL(`${join(dir, 'data')}/`));
    assert.deepEqual([...catalog.ids].sort(), ['family.k.baba', 'travel.a.hello', 'w.4f60.ni3']);
    assert.deepEqual(catalog.items.get('travel.a.hello'), { id: 'travel.a.hello', hanzi: 'h', pinyin: 'p', meaning: 'Hello' });
    // Without content.json (not built yet): words only.
    rmSync(join(dir, 'data', 'content.json'));
    assert.deepEqual([...(await readCatalog(pathToFileURL(`${join(dir, 'data')}/`))).ids], ['w.4f60.ni3']);

    const ids = catalog.ids;
    assert.equal(isKnownCard('w.4f60.ni3.read', ids), true);
    assert.equal(isKnownCard('travel.a.hello.speak', ids), true);
    assert.equal(isKnownCard('w.4f60.ni3.write', ids), false, 'not a card type');
    assert.equal(isKnownCard('w.4f60.ni4.read', ids), false, 'not an item');
    assert.equal(isKnownCard('read', ids), false);
    assert.deepEqual(Object.keys(onlyKnownCards({ 'w.4f60.ni3.listen': 1, 'w.x.read': 2, constructor: 3 }, ids)), ['w.4f60.ni3.listen']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Sign-in endpoints (forwarded to the accounts service) ----

test('register creates the account and the record; the email is normalised', async () => {
  const before = accounts.calls.length;
  const first = await call(register.POST, { email: '  Anna@Example.COM ', password: PASSWORD, invite_code: INVITE_CODE, extra: 'dropped' },
    { headers: { 'x-real-ip': '203.0.113.7' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.email, 'anna@example.com');
  assert.equal(typeof first.body.token, 'string');
  assert.ok(Number.isSafeInteger(first.body.expires_at));
  assert.equal(first.body.created, true);
  assert.deepEqual(first.body.state.marks, {});
  assert.equal(first.body.state.settings, null);
  assert.equal(first.body.state.settings_t, 0);
  assert.deepEqual(first.body.state.stats, { days: {} });
  assert.ok(Number.isInteger(first.body.state.updated_at));

  // Server to server: only the form fields, the service key and the browser's IP.
  const [sent] = accounts.calls.slice(before);
  assert.equal(sent.name, 'register');
  assert.deepEqual(sent.body, { email: '  Anna@Example.COM ', password: PASSWORD, invite_code: INVITE_CODE });
  assert.equal(sent.headers['x-accounts-service-key'], SERVICE_KEY);
  assert.equal(sent.headers['x-accounts-client-ip'], '203.0.113.7');

  // Stored under a hashed key: the file name does not contain the email, the record does.
  const hash = createHash('sha256').update('anna@example.com').digest('hex');
  assert.equal(recordKey('anna@example.com'), `learn-chinese:user:${hash}`);
  assert.equal(srsKey('anna@example.com', '07'), `learn-chinese:srs:${hash}:07`);
  assert.deepEqual(srsKeys('anna@example.com'), BUCKETS.map((b) => `learn-chinese:srs:${hash}:${b}`));
  assert.equal(BUCKETS.length, 32);
  const files = readdirSync(dataDir).filter((name) => name.includes(hash));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('anna'));
  const record = JSON.parse(readFileSync(join(dataDir, files[0]), 'utf8'));
  assert.equal(record.email, 'anna@example.com');
  assert.deepEqual(Object.keys(record).sort(), ['created_at', 'email', 'marks', 'settings', 'settings_t', 'stats', 'updated_at']);

  // The token works for sync right away.
  assert.equal((await syncAs(first.body.token, { marks: {} })).status, 200);
  const again = await call(register.POST, { email: 'anna@example.com', password: PASSWORD, invite_code: INVITE_CODE });
  assert.deepEqual([again.status, again.body], [409, { error: 'email_taken' }]);
});

test('register passes the service\'s refusals through', async () => {
  const cases = [
    [{ email: 'nope', password: PASSWORD, invite_code: INVITE_CODE }, 400, 'invalid_email'],
    [{ email: freshEmail(), password: 'short', invite_code: INVITE_CODE }, 400, 'invalid_password'],
    [{ email: freshEmail(), password: PASSWORD, invite_code: '999999' }, 403, 'invalid_invite_code'],
    [{ email: freshEmail(), password: PASSWORD }, 403, 'invalid_invite_code'],
  ];
  for (const [body, status, error] of cases) {
    const result = await call(register.POST, body);
    assert.deepEqual([result.status, result.body], [status, { error }], JSON.stringify(body));
  }
});

test('login checks the password with the service and opens the record', async () => {
  const email = freshEmail();
  assert.equal((await call(register.POST, { email, password: PASSWORD, invite_code: INVITE_CODE })).status, 200);
  const before = accounts.calls.length;
  const ok = await call(login.POST, { email, password: PASSWORD }, { headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['created', 'email', 'expires_at', 'state', 'token']);
  assert.deepEqual(Object.keys(ok.body.state).sort(), ['marks', 'settings', 'settings_t', 'stats', 'updated_at']);
  assert.equal(ok.body.email, email);
  assert.equal(ok.body.created, false, 'register made the record');
  const [sent] = accounts.calls.slice(before);
  assert.deepEqual(sent.body, { email, password: PASSWORD, audience: 'app' });
  assert.equal(sent.headers['x-accounts-client-ip'], '198.51.100.4', 'first x-forwarded-for entry');

  // An account made elsewhere (e.g. by the admin, or in another app) gets its record on the first sign-in.
  const other = freshEmail();
  accounts.users.set(other, { password: PASSWORD });
  assert.equal((await call(login.POST, { email: other, password: PASSWORD })).body.created, true);

  const wrong = await call(login.POST, { email, password: 'not it' });
  assert.deepEqual([wrong.status, wrong.body], [401, { error: 'invalid_credentials' }]);
  const unknown = await call(login.POST, { email: freshEmail(), password: PASSWORD });
  assert.deepEqual([unknown.status, unknown.body], [401, { error: 'invalid_credentials' }]);
  const locked = await call(login.POST, { email: 'locked@example.com', password: PASSWORD });
  assert.deepEqual([locked.status, locked.body], [423, { error: 'account_locked', retry_after: 840 }]);
  assert.equal(locked.headers.get('retry-after'), '840');
  const limited = await call(login.POST, { email: 'limited@example.com', password: PASSWORD });
  assert.deepEqual([limited.status, limited.body], [429, { error: 'rate_limited', retry_after: 120 }], 'Retry-After header -> retry_after');
  assert.equal(limited.headers.get('retry-after'), '120');
});

test('forgot answers ok for any email and only forwards the email', async () => {
  const email = freshEmail();
  accounts.users.set(email, { password: PASSWORD, resetRequested: false });
  const before = accounts.calls.length;
  for (const address of [email, freshEmail()]) {
    const result = await call(forgot.POST, { email: address, password: 'not forwarded' });
    assert.deepEqual([result.status, result.body], [200, { ok: true }]);
  }
  assert.equal(accounts.users.get(email).resetRequested, true);
  assert.deepEqual(accounts.calls.slice(before).map((c) => c.body), [{ email }, { email: accounts.calls.at(-1).body.email }]);
  const bad = await call(forgot.POST, { email: 'nope' });
  assert.deepEqual([bad.status, bad.body], [400, { error: 'invalid_email' }]);
});

test('sign-in endpoints reject bad JSON with 400', async () => {
  for (const handler of [login.POST, register.POST, forgot.POST]) {
    for (const raw of ['', '{', '[]', 'null', '"text"', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      const result = await call(handler, raw);
      assert.equal(result.status, 400, JSON.stringify(raw));
      assert.deepEqual(result.body, { error: 'invalid_json' });
    }
  }
});

test('accounts service down, unreachable or misconfigured -> 503 accounts_unavailable, nothing private in logs', async () => {
  const email = 'private.person@example.com';
  const form = { email, password: 'secret-password-123', invite_code: INVITE_CODE };
  const { token } = signedIn(email);
  clearVerifyCache();
  const expectUnavailable = async (label) => {
    for (const handler of [login.POST, register.POST, forgot.POST]) {
      const result = await call(handler, form);
      assert.deepEqual([result.status, result.body], [503, { error: 'accounts_unavailable' }], `${label} ${handler.name}`);
    }
    const synced = await syncAs(token, { marks: {} });
    assert.deepEqual([synced.status, synced.body], [503, { error: 'accounts_unavailable' }], `${label} sync`);
  };
  const logs = await captureConsole(async () => {
    for (const mode of ['down', 'html']) {
      accounts.mode = mode;
      try {
        await expectUnavailable(mode);
      } finally {
        accounts.mode = null;
      }
    }
    await withEnv({ ACCOUNTS_SERVICE_KEY: 'x'.repeat(40) }, () => expectUnavailable('wrong key'));
    await withEnv({ ACCOUNTS_URL: 'http://127.0.0.1:9' }, () => expectUnavailable('unreachable'));
    await withEnv({ ACCOUNTS_URL: undefined, ACCOUNTS_SERVICE_KEY: undefined }, () => expectUnavailable('not configured'));
    await withEnv({ ACCOUNTS_SERVICE_KEY: 'too-short' }, () => expectUnavailable('short key'));
  });
  assert.match(logs, /\[learn-chinese api\]/);
  assert.match(logs, /service key rejected/);
  assert.match(logs, /accounts not configured: set ACCOUNTS_URL and ACCOUNTS_SERVICE_KEY/);
  for (const secret of ['private.person', 'secret-password', token, SERVICE_KEY, INVITE_CODE]) {
    assert.ok(!logs.includes(secret), `logs must not contain ${secret}`);
  }
});

test('accountsConfig and clientIp read the environment and the request', () => {
  assert.deepEqual(accountsConfig({}).missing, ['ACCOUNTS_URL', 'ACCOUNTS_SERVICE_KEY']);
  assert.deepEqual(accountsConfig({ ACCOUNTS_URL: 'ftp://x', ACCOUNTS_SERVICE_KEY: SERVICE_KEY }).missing, ['ACCOUNTS_URL']);
  assert.deepEqual(accountsConfig({ ACCOUNTS_URL: 'https://accounts.example/', ACCOUNTS_SERVICE_KEY: SERVICE_KEY }),
    { url: 'https://accounts.example', serviceKey: SERVICE_KEY });
  const req = (headers) => new Request('http://localhost/', { headers });
  assert.equal(clientIp(req({ 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' })), '192.0.2.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': ' 192.0.2.2 , 10.0.0.1' })), '192.0.2.2');
  assert.equal(clientIp(req({})), 'unknown');
});

// ---- Sync: bearer token, verify cache ----

test('sync needs a valid bearer token; the email comes from the token, not the body', async () => {
  const anna = signedIn();
  const bo = freshEmail();
  const t = now() - 1000;
  for (const headers of [{}, { authorization: `Basic ${anna.token}` }, { authorization: 'Bearer' }, { authorization: 'Bearer forged.token.sig' }]) {
    const result = await call(sync.POST, { marks: { [C(1)]: { m: 'star', t } } }, { headers });
    assert.deepEqual([result.status, result.body], [401, { error: 'unauthorized' }], JSON.stringify(headers));
  }
  const result = await syncAs(anna.token, { email: bo, marks: { [C(1)]: { m: 'star', t } } });
  assert.equal(result.status, 200);
  assert.deepEqual((await storeFromEnv().get(recordKey(anna.email))).marks, { [C(1)]: { m: 'star', t } });
  assert.equal(await storeFromEnv().get(recordKey(bo)), null, 'the body email is ignored');
});

test('token checks are cached for a minute; failures are not cached', async () => {
  clearVerifyCache();
  const { email, token } = signedIn();
  const verifies = () => accounts.callsTo('verify').length;
  const before = verifies();
  for (let i = 0; i < 3; i += 1) assert.equal((await syncAs(token, { marks: {} })).status, 200);
  assert.equal(verifies() - before, 1, 'one check for three syncs');
  const sent = accounts.callsTo('verify').at(-1);
  assert.deepEqual(sent.body, { token, audience: 'app' });
  assert.equal(sent.headers['x-accounts-service-key'], SERVICE_KEY);

  accounts.revoke(token); // e.g. "sign out everywhere" in the admin panel
  assert.equal((await syncAs(token, { marks: {} })).status, 200, 'still cached');
  clearVerifyCache(); // as after a minute
  assert.equal((await syncAs(token, { marks: {} })).status, 401);
  assert.equal((await syncAs(token, { marks: {} })).status, 401);
  assert.equal(verifies() - before, 3, 'each failure asked the service again');
  assert.ok(email);
});

test('createVerifier: TTL, size cap, hashed keys, forgetEmail', async () => {
  let clock = 1_000_000;
  const asked = [];
  const client = {
    async verify(token) {
      asked.push(token);
      if (token.startsWith('bad')) throw new HttpError(401, 'invalid_token');
      return { email: ` ${token.split(':')[0]}@Example.com ` };
    },
  };
  const verifier = createVerifier({ ttlMs: VERIFY_CACHE_MS, max: 3, now: () => clock });
  assert.equal(await verifier.verify('ana:1', client), 'ana@example.com');
  assert.equal(await verifier.verify('ana:1', client), 'ana@example.com');
  assert.deepEqual(asked, ['ana:1']);
  clock += VERIFY_CACHE_MS - 1;
  await verifier.verify('ana:1', client);
  assert.equal(asked.length, 1);
  clock += 1;
  await verifier.verify('ana:1', client);
  assert.equal(asked.length, 2, 'expired after the TTL');

  await assert.rejects(verifier.verify('bad:1', client), (error) => error.status === 401);
  await assert.rejects(verifier.verify('bad:1', client), (error) => error.status === 401);
  assert.equal(asked.filter((t) => t === 'bad:1').length, 2, 'failures are not cached');

  for (const token of ['bo:1', 'cy:1', 'di:1']) await verifier.verify(token, client);
  assert.equal(verifier.size, 3, 'capped');
  const count = asked.length;
  await verifier.verify('ana:1', client);
  assert.equal(asked.length, count + 1, 'the oldest entry was dropped');

  await verifier.verify('di:2', client);
  verifier.forgetEmail('di@example.com');
  await verifier.verify('di:1', client);
  await verifier.verify('di:2', client);
  assert.deepEqual(asked.slice(-2), ['di:1', 'di:2'], 'both tokens of the deleted account are asked again');

  assert.deepEqual(await verifier.check('di:1', client), { email: 'di@example.com', cached: true });
  assert.deepEqual(await verifier.check('di:1', client, undefined, { fresh: true }), { email: 'di@example.com', cached: false });
  assert.equal(asked.at(-1), 'di:1', 'fresh asks the service even with a cache entry');
  await assert.rejects(verifier.check('bad:2', client, undefined, { fresh: true }), (error) => error.status === 401);
});

test('the accounts client maps answers: 4xx pass through, everything else is 503', async () => {
  const answers = {
    login: () => Response.json({ error: 'account_disabled' }, { status: 403 }),
    register: () => Response.json({ error: 'Not A Code!' }, { status: 400 }),
    forgot: () => new Response('nope', { status: 404 }),
    verify: () => Response.json({ error: 'unauthorized_service' }, { status: 401 }),
  };
  const client = createAccountsClient({
    url: 'https://accounts.example/',
    serviceKey: SERVICE_KEY,
    fetch: async (url, init) => {
      assert.equal(init.redirect, 'error');
      return answers[new URL(url).pathname.slice('/api/'.length)]();
    },
  });
  await captureConsole(async () => {
    await assert.rejects(client.login({ email: 'a@b.co', password: 'x' }), (e) => e.status === 403 && e.code === 'account_disabled');
    await assert.rejects(client.register({}), (e) => e.status === 503 && e.code === 'accounts_unavailable', 'malformed codes are not echoed');
    await assert.rejects(client.forgot({}), (e) => e.status === 503);
    await assert.rejects(client.verify('t'), (e) => e.status === 503, 'a rejected service key is a server problem');
  });
});

test('the accounts client passes 503 registration_closed through, other 5xx become accounts_unavailable', async () => {
  let answer = () => Response.json({ error: 'registration_closed' }, { status: 503 });
  const client = createAccountsClient({ url: 'https://accounts.example', serviceKey: SERVICE_KEY, fetch: async () => answer() });
  await assert.rejects(client.register({}), (e) => e.status === 503 && e.code === 'registration_closed');
  answer = () => Response.json({ error: 'storage_unavailable' }, { status: 503 });
  await captureConsole(() => assert.rejects(client.register({}), (e) => e.status === 503 && e.code === 'accounts_unavailable'));
});

test('verifyCacheMs: LEARN_CHINESE_VERIFY_CACHE_MS overrides the 60 s cache within 0..600000', () => {
  assert.equal(verifyCacheMs({}), VERIFY_CACHE_MS);
  assert.equal(verifyCacheMs({ LEARN_CHINESE_VERIFY_CACHE_MS: '0' }), 0);
  assert.equal(verifyCacheMs({ LEARN_CHINESE_VERIFY_CACHE_MS: '5000' }), 5000);
  for (const bad of ['-1', 'abc', '1.5', '600001']) assert.equal(verifyCacheMs({ LEARN_CHINESE_VERIFY_CACHE_MS: bad }), VERIFY_CACHE_MS, bad);
});

// ---- /api/service (called by the accounts admin panel) ----

test('service endpoint needs the service key', async () => {
  for (const key of [null, 'wrong', `${SERVICE_KEY}x`]) {
    const result = await serviceCall({ action: 'stats' }, key);
    assert.deepEqual([result.status, result.body], [401, { error: 'unauthorized_service' }], String(key));
  }
  await captureConsole(() => withEnv({ ACCOUNTS_SERVICE_KEY: undefined }, async () => {
    const result = await serviceCall({ action: 'stats' });
    assert.deepEqual([result.status, result.body], [503, { error: 'accounts_not_configured' }]);
  }));
  const bad = await serviceCall({ action: 'drop-tables' });
  assert.deepEqual([bad.status, bad.body], [400, { error: 'invalid_action' }]);
  const badEmail = await serviceCall({ action: 'delete-user', email: 'nope' });
  assert.deepEqual([badEmail.status, badEmail.body], [400, { error: 'invalid_email' }]);
});

test('service stats count stars, skips and answers over every record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-chinese-stats-'));
  try {
    await withEnv({ LEARN_CHINESE_DATA_DIR: dir }, async () => {
      const empty = await serviceCall({ action: 'stats' });
      assert.deepEqual(empty.body, {
        app: 'learn-chinese', users_with_data: 0, total_starred: 0, total_skipped: 0, total_reviews: 0, top_starred: [], top_skipped: [],
      });
      const store = storeFromEnv();
      const t = 1;
      const users = [
        [{ [C(1)]: { m: 'star', t }, [C(2)]: { m: 'star', t }, [C(3)]: { m: 'skip', t } }, {}],
        [{ [C(1)]: { m: 'star', t }, [C(2)]: { m: null, t }, 'made.up.id': { m: 'star', t } }, { '2026-11-01': { r: 12, n: 3, a: 1, ms: 1 } }],
        [{ [C(1)]: { m: 'star', t }, [C(4)]: { m: 'skip', t }, [C(3)]: { m: 'skip', t } }, { '2026-11-01': { r: 5 }, '2026-11-02': { r: 7 } }],
        [{ [C(5)]: { m: null, t } }, {}], // only a tombstone: no data
        [{}, { '2026-10-30': { r: 4, n: 4, a: 0, ms: 9 } }], // studied, never marked: has data
      ];
      for (const [i, [marks, days]] of users.entries()) {
        const email = `stats${i}@example.com`;
        await store.set(recordKey(email), { email, created_at: 1, updated_at: 1, marks, settings: null, settings_t: 0, stats: { days } });
      }
      await store.set(srsKey('stats0@example.com', '00'), { rev: 1, entries: {} }); // card-state buckets are not records
      await store.set('other-app:user:x', { marks: { [C(9)]: { m: 'star', t } } }); // another app's key
      const result = await serviceCall({ action: 'stats' });
      assert.equal(result.status, 200);
      const word = (id, count) => ({ ...CATALOG.items.get(id), count });
      assert.deepEqual(result.body, {
        app: 'learn-chinese',
        users_with_data: 4,
        total_starred: 4,
        total_skipped: 3,
        total_reviews: 28,
        top_starred: [word(C(1), 3), word(C(2), 1)],
        top_skipped: [word(C(3), 2), word(C(4), 1)],
      });
      assert.deepEqual(Object.keys(result.body.top_starred[0]).sort(), ['count', 'hanzi', 'id', 'meaning', 'pinyin']);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service delete-user deletes the record and every card-state bucket, and a cached token cannot bring them back', async () => {
  const { email, token } = signedIn();
  const t = now() - 1000;
  const srs = { [CARD(1)]: entry(t), [CARD(2, 'listen')]: entry(t), [CARD(3, 'speak')]: entry(t) };
  const first = await syncAs(token, { marks: { [C(1)]: { m: 'star', t } }, srs }); // token now cached
  assert.equal(first.status, 200);
  const stored = async () => (await storeFromEnv().getMany([recordKey(email), ...srsKeys(email)])).filter(Boolean).length;
  assert.equal(await stored(), 1 + new Set(Object.keys(srs).map(bucketOf)).size);
  accounts.revoke(token); // the accounts service deleted the account
  const deleted = await serviceCall({ action: 'delete-user', email: ` ${email.toUpperCase()} ` });
  assert.deepEqual([deleted.status, deleted.body], [200, { deleted: true }]);
  assert.equal(await stored(), 0, 'record and buckets are gone');
  const late = await syncAs(token, { marks: { [C(1)]: { m: 'star', t } }, srs });
  assert.equal(late.status, 401, 'the cache entry of the deleted account was dropped');
  assert.equal(await stored(), 0);
  assert.deepEqual((await serviceCall({ action: 'delete-user', email })).body, { deleted: false });
});

test('a token cached by another instance cannot recreate a deleted account\'s record or buckets', async () => {
  const { email, token } = signedIn();
  const t = now() - 1000;
  const verifies = () => accounts.callsTo('verify').length;
  assert.equal((await syncAs(token, { marks: { [C(1)]: { m: 'star', t } } })).status, 200); // token now cached
  // delete-user ran on another function instance: the record is gone, this instance's cache is not.
  accounts.revoke(token);
  await storeFromEnv().deleteMany([recordKey(email), ...srsKeys(email)]);
  let before = verifies();
  const late = await syncAs(token, { marks: { [C(1)]: { m: 'star', t }, [C(2)]: { m: 'skip', t } } });
  assert.deepEqual([late.status, late.body], [401, { error: 'unauthorized' }]);
  assert.equal(verifies() - before, 1, 'the cached check was not trusted for creating the record');
  // Card states alone: the same.
  clearVerifyCache();
  const other = signedIn();
  assert.equal((await syncAs(other.token, { marks: {} })).status, 200); // cached, no record
  accounts.revoke(other.token);
  const srsOnly = await syncAs(other.token, { marks: {}, srs: { [CARD(1)]: entry(t) } });
  assert.deepEqual([srsOnly.status, srsOnly.body], [401, { error: 'unauthorized' }]);
  for (const address of [email, other.email]) {
    assert.deepEqual((await storeFromEnv().getMany([recordKey(address), ...srsKeys(address)])).filter(Boolean), [], 'no orphans');
  }

  // A live account whose record is missing: one fresh check, then the record is created.
  const live = signedIn();
  assert.equal((await syncAs(live.token, { marks: {} })).status, 200); // cached, no record
  before = verifies();
  assert.equal((await syncAs(live.token, { marks: {}, srs: { [CARD(1)]: entry(t) } })).status, 200);
  assert.equal(verifies() - before, 1);
  assert.notEqual(await storeFromEnv().get(recordKey(live.email)), null, 'card states create the record');
  before = verifies();
  assert.equal((await syncAs(live.token, { marks: { [C(2)]: { m: 'star', t } } })).status, 200);
  assert.equal(verifies() - before, 0, 'with a record, the cache is used as before');
});

test('a cached token cannot create a card-state bucket either (delete-user racing a sync)', async () => {
  // The record still exists when the sync reads it, but the account is already gone at the accounts
  // service (it deletes the account first, then asks the apps to delete their data): a new bucket must
  // not be created on the strength of the cached check, or it would outlive delete-user.
  const { email, token } = signedIn();
  const t = now() - 1000;
  const verifies = () => accounts.callsTo('verify').length;
  const [first, second] = [CARD(1), cardsIn(bucketOf(CARD(1)) === '00' ? '01' : '00', 1)[0]];
  assert.notEqual(bucketOf(first), bucketOf(second));
  assert.equal((await syncAs(token, { marks: {}, srs: { [first]: entry(t) } })).status, 200); // record + one bucket, token cached
  accounts.revoke(token);
  let before = verifies();
  const late = await syncAs(token, { marks: {}, srs: { [second]: entry(t) } });
  assert.deepEqual([late.status, late.body], [401, { error: 'unauthorized' }]);
  assert.equal(verifies() - before, 1, 'one fresh check before creating the bucket');
  assert.equal(await storeFromEnv().get(srsKey(email, bucketOf(second))), null, 'no new bucket');

  // A live account: one fresh check per request that creates buckets (however many), none for
  // existing buckets; a request whose record check was already fresh needs no second one.
  const live = signedIn();
  assert.equal((await syncAs(live.token, { marks: {}, srs: { [first]: entry(t) } })).status, 200);
  const more = Object.fromEntries(BUCKETS.filter((b) => b !== bucketOf(first)).slice(0, 5).map((b) => [cardsIn(b, 1)[0], entry(t)]));
  before = verifies();
  assert.equal((await syncAs(live.token, { marks: {}, srs: more })).status, 200);
  assert.equal(verifies() - before, 1, 'five new buckets, one check');
  before = verifies();
  assert.equal((await syncAs(live.token, { marks: {}, srs: { [first]: entry(t + 1) } })).status, 200);
  assert.equal(verifies() - before, 0, 'an existing bucket: the cached check is enough');
  for (const id of [first, ...Object.keys(more)]) assert.notEqual(await storeFromEnv().get(srsKey(live.email, bucketOf(id))), null);
});

// ---- Limits and methods ----

test('bodies over 1 MB get 413, declared or streamed', async () => {
  const { token } = signedIn();
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);
  const big = JSON.stringify({ marks: {}, pad: 'x'.repeat(MAX_BODY_BYTES) });
  const declared = await syncAs(token, big);
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.body, { error: 'body_too_large' });
  const fits = await syncAs(token, JSON.stringify({ marks: {}, pad: 'x'.repeat(MAX_BODY_BYTES - 100) }));
  assert.equal(fits.status, 200, 'just under 1 MB is fine');

  // No Content-Length: a stream of chunks, cut off once the limit is passed.
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent > MAX_BODY_BYTES * 2) controller.close();
      else {
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      }
    },
  });
  const response = await sync.POST(new Request('http://localhost/api/sync', {
    method: 'POST', body: stream, duplex: 'half', headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(response.status, 413);
  assert.ok(sent < MAX_BODY_BYTES * 2, 'stopped reading early');

  // Sign-in bodies are small: 16 KB is plenty.
  const login16 = await call(login.POST, JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(17 * 1024) }));
  assert.equal(login16.status, 413);
});

test('every method except POST gets 405', async () => {
  for (const mod of [login, register, forgot, sync, service]) {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await mod[method](new Request('http://localhost/api/x', { method }));
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'POST');
    }
    const misrouted = await mod.POST(new Request('http://localhost/api/x', { method: 'GET' }));
    assert.equal(misrouted.status, 405);
  }
});

// ---- Sync: marks, settings, statistics (full state) ----

test('sync rejects bad JSON with 400', async () => {
  const { token } = signedIn();
  for (const raw of ['', '{', '[]', 'null', '"text"', new Uint8Array([0x7b, 0xff, 0x7d])]) {
    const result = await syncAs(token, raw);
    assert.equal(result.status, 400, JSON.stringify(raw));
    assert.deepEqual(result.body, { error: 'invalid_json' });
  }
});

test('sync merges per item (last writer wins), keeps tombstones and returns the full state', async () => {
  const email = freshEmail();
  accounts.users.set(email, { password: PASSWORD });
  const { token } = signedIn(email);
  const t = now() - 10_000;
  let state = (await call(login.POST, { email, password: PASSWORD })).body.state;

  const deviceA = { [C(1)]: { m: 'star', t }, [C(2)]: { m: 'skip', t }, [C(3)]: { m: 'star', t } };
  state = (await syncAs(token, { marks: deviceA })).body.state;
  assert.deepEqual(state.marks, deviceA);

  // Device B: un-stars 1 later (tombstone), skips 3 earlier than A's star, adds 4.
  const deviceB = { [C(1)]: { m: null, t: t + 5 }, [C(3)]: { m: 'skip', t: t - 5 }, [C(4)]: { m: 'skip', t } };
  const result = await syncAs(token, { marks: deviceB });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body), ['state', 'srs']);
  assert.deepEqual(result.body.state.marks, {
    [C(1)]: { m: null, t: t + 5 },
    [C(2)]: { m: 'skip', t },
    [C(3)]: { m: 'star', t },
    [C(4)]: { m: 'skip', t },
  });

  // The same full state comes back on the next login.
  assert.deepEqual((await call(login.POST, { email, password: PASSWORD })).body.state.marks, result.body.state.marks);
});

test('sync merges settings as one last-writer-wins value (long deck lists included)', async () => {
  const { token } = signedIn();
  const t = now() - 10_000;
  const a = { newPerDay: 10, activeDecks: 'exam2025-1,exam2025-2', autoplay: true, ttsVoice: '' };
  const b = { newPerDay: 25, activeDecks: Array.from({ length: 40 }, (_, i) => `travel.scene-number-${i}`).join(','), autoplay: false, ttsVoice: '' };
  assert.ok(b.activeDecks.length > 200, 'longer than the reference\'s 200-character setting strings');
  let state = (await syncAs(token, { marks: {}, settings: a, settings_t: t })).body.state;
  assert.deepEqual([state.settings, state.settings_t], [a, t]);
  state = (await syncAs(token, { marks: {}, settings: b, settings_t: t - 1 })).body.state;
  assert.deepEqual([state.settings, state.settings_t], [a, t], 'older settings lose');
  state = (await syncAs(token, { marks: {}, settings: b, settings_t: t + 1 })).body.state;
  assert.deepEqual([state.settings, state.settings_t], [b, t + 1], 'newer settings win');
  state = (await syncAs(token, { marks: {} })).body.state;
  assert.deepEqual([state.settings, state.settings_t], [b, t + 1], 'a sync without settings keeps them');
});

test('sync merges statistics per day and counter (the maximum) and keeps only plausible days', async () => {
  const { email, token } = signedIn();
  const t = now() - 1000;
  const today = new Date(now()).toISOString().slice(0, 10);
  const phone = { days: { '2026-10-01': { r: 10, n: 2, a: 1, ms: 60_000 }, [today]: { r: 3, n: 1, a: 0, ms: 9000 } } };
  const laptop = { days: { '2026-10-01': { r: 4, n: 5, a: 0, ms: 90_000 }, '2026-10-02': { r: 7, n: 0, a: 2, ms: 1 } } };
  await syncAs(token, { marks: {}, stats: phone });
  const merged = (await syncAs(token, { marks: {}, stats: laptop })).body.state.stats;
  assert.deepEqual(merged, mergeStats(phone, laptop));
  assert.deepEqual(Object.keys(merged.days), ['2026-10-01', '2026-10-02', today], 'days in date order');
  // Made-up days are dropped (not refused), counters are capped.
  const junk = { days: {
    '1999-12-31': { r: 1 }, '2019-12-31': { r: 1 }, '2999-01-01': { r: 1 }, '2026-02-30': { r: 1 }, 'today': { r: 1 },
    '2026-10-03': { r: 1e9, n: -5, a: 'x', ms: 1e12 },
  } };
  const capped = (await syncAs(token, { marks: {}, stats: junk })).body.state.stats;
  assert.deepEqual(Object.keys(capped.days), ['2026-10-01', '2026-10-02', '2026-10-03', today]);
  assert.deepEqual(capped.days['2026-10-03'], { r: 100_000, n: 0, a: 0, ms: 86_400_000 });
  assert.deepEqual((await storeFromEnv().get(recordKey(email))).stats, capped);
  assert.ok(t);
});

test('sync validates marks, settings, statistics, card states and revs', async () => {
  const { email, token } = signedIn();
  const t = now();
  const card = entry(t - 1000);
  const cases = [
    [{ marks: [] }, 400, 'invalid_marks'],
    [{ marks: { 'Bad Id': { m: 'star', t } } }, 400, 'invalid_marks'],
    [{ marks: { [C(1)]: { m: 'love', t } } }, 400, 'invalid_marks'],
    [{ marks: {}, settings: { filter: 'all' } }, 400, 'invalid_settings'],
    [{ marks: {}, settings: { filter: 'all' }, settings_t: -1 }, 400, 'invalid_settings'],
    [{ marks: {}, settings: { nested: { a: 1 } }, settings_t: t }, 400, 'invalid_settings'],
    [{ marks: {}, settings: 'all', settings_t: t }, 400, 'invalid_settings'],
    [{ marks: {}, settings: { activeDecks: 'x'.repeat(4001) }, settings_t: t }, 400, 'invalid_settings'],
    [{ marks: Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [`c${i}`, { m: null, t: 1 }])) }, 413, 'too_many_marks'],
    [{ marks: {}, stats: [] }, 400, 'invalid_stats'],
    [{ marks: {}, stats: { days: 'all' } }, 400, 'invalid_stats'],
    [{ marks: {}, srs: [] }, 400, 'invalid_srs'],
    [{ marks: {}, srs: { 'Bad Id.read': card } }, 400, 'invalid_srs'],
    [{ marks: {}, srs: { [CARD(1)]: { ...card, s: [2, 1, 2, 3] } } }, 400, 'invalid_srs'],
    [{ marks: {}, srs: { [CARD(1)]: { ...card, t: -1 } } }, 400, 'invalid_srs'],
    [{ marks: {}, srs: Object.fromEntries(Array.from({ length: 3001 }, (_, i) => [`c${i}.read`, card])) }, 413, 'too_many_srs'],
    [{ marks: {}, srs_revs: [] }, 400, 'invalid_srs_revs'],
    [{ marks: {}, srs_revs: { 32: 1 } }, 400, 'invalid_srs_revs'],
    [{ marks: {}, srs_revs: { '07': -1 } }, 400, 'invalid_srs_revs'],
    [{ marks: {}, srs_revs: { '07': '3' } }, 400, 'invalid_srs_revs'],
  ];
  for (const [body, status, error] of cases) {
    const result = await syncAs(token, body);
    assert.equal(result.status, status, JSON.stringify(body).slice(0, 120));
    assert.deepEqual(result.body, { error });
  }
  // Nothing was stored for the rejected requests.
  assert.equal(await storeFromEnv().get(recordKey(email)), null);
  assert.deepEqual((await storeFromEnv().getMany(srsKeys(email))).filter(Boolean), []);
});

test('timestamps too far in the future are clamped, so a device with a wrong clock keeps syncing', async () => {
  const { token } = signedIn();
  const ahead = now() + 2 * MAX_CLOCK_SKEW_MS;
  const before = now();
  const future = { ...entry(now()), t: ahead, f: ahead };
  const first = await syncAs(token, {
    marks: { [C(1)]: { m: 'star', t: ahead } }, settings: { newPerDay: 5 }, settings_t: ahead, srs: { [CARD(1)]: future },
  });
  const after = now();
  assert.equal(first.status, 200);
  const { t } = first.body.state.marks[C(1)];
  assert.ok(t >= before + MAX_CLOCK_SKEW_MS && t <= after + MAX_CLOCK_SKEW_MS, 'clamped to now + 24 h');
  assert.ok(first.body.state.settings_t <= after + MAX_CLOCK_SKEW_MS);
  const stored = (await syncAs(token, { marks: {}, srs_revs: {} })).body.srs.buckets[bucketOf(CARD(1))].entries[CARD(1)];
  assert.ok(stored.t <= after + MAX_CLOCK_SKEW_MS && stored.f <= after + MAX_CLOCK_SKEW_MS, 'card state times clamped too');
  // The same device (still sending the future entries) can sync its next, ordinary change.
  const next = await syncAs(token, { marks: { [C(1)]: { m: 'star', t: ahead }, [C(2)]: { m: 'skip', t: now() } }, srs: { [CARD(1)]: future } });
  assert.equal(next.status, 200);
  assert.equal(next.body.state.marks[C(2)].m, 'skip');
});

test('only marks of real items are kept, and stored junk is pruned', async () => {
  const email = freshEmail();
  accounts.users.set(email, { password: PASSWORD });
  const { token } = signedIn(email);
  const t = now() - 1000;
  const junk = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`z${i}`, { m: null, t: 1 }]));
  const result = await syncAs(token, { marks: { ...junk, [C(1)]: { m: 'star', t } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.state.marks, { [C(1)]: { m: 'star', t } });
  // A record written before this check existed: junk is not returned and is dropped on the next write.
  const key = recordKey(email);
  const store = storeFromEnv();
  await store.set(key, { ...(await store.get(key)), marks: { ...junk, [C(1)]: { m: 'star', t } } });
  assert.deepEqual((await call(login.POST, { email, password: PASSWORD })).body.state.marks, { [C(1)]: { m: 'star', t } });
  await syncAs(token, { marks: { [C(2)]: { m: 'skip', t } } });
  assert.deepEqual(Object.keys((await store.get(key)).marks), [C(1), C(2)]);
});

test('a pull for an account without a record does not create one', async () => {
  const { email, token } = signedIn();
  const result = await syncAs(token, { marks: { z1: { m: 'star', t: 1 } }, srs: { 'w.made.up.read': entry(now() - 1000) }, srs_revs: {} });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.state.marks, {});
  assert.deepEqual(result.body.srs, { buckets: {} });
  assert.equal(await storeFromEnv().get(recordKey(email)), null);
  assert.deepEqual((await storeFromEnv().getMany(srsKeys(email))).filter(Boolean), []);
});

test('concurrent syncs of one account keep every change (file store)', async () => {
  const { email, token } = signedIn();
  const t = now() - 1000;
  const sameBucket = cardsIn('07', 20);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => syncAs(token, {
    marks: { [C(i)]: { m: 'star', t } }, srs: { [sameBucket[i]]: entry(t) }, srs_revs: {},
  })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(Object.keys((await storeFromEnv().get(recordKey(email))).marks).length, 20);
  const bucket = await storeFromEnv().get(srsKey(email, '07'));
  assert.deepEqual(Object.keys(bucket.entries).sort(), [...sameBucket].sort(), 'every card state is in the bucket');
  assert.equal(bucket.rev, 20, 'one rev per change');
});

test('sync creates a missing record and does not write on a pure pull', async () => {
  const email = freshEmail();
  accounts.users.set(email, { password: PASSWORD });
  const { token } = signedIn(email);
  const t = now() - 1000;
  const today = new Date(t).toISOString().slice(0, 10);
  const body = {
    marks: { [C(1)]: { m: 'star', t } }, stats: { days: { [today]: { r: 1, n: 1, a: 0, ms: 4000 } } }, srs: { [CARD(1)]: entry(t) },
  };
  const first = await syncAs(token, { ...body, srs_revs: {} });
  assert.equal(first.status, 200);
  const login1 = await call(login.POST, { email, password: PASSWORD });
  assert.equal(login1.body.created, false, 'sync created the record');

  const files = [recordKey(email), srsKey(email, bucketOf(CARD(1)))].map((key) => join(dataDir, `${encodeURIComponent(key).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}.json`));
  const before = files.map((file) => statSync(file).mtimeMs);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const revs = revsOf(first.body);
  const pull = await syncAs(token, { marks: {}, srs_revs: revs });
  const repeat = await syncAs(token, { ...body, srs_revs: revs });
  assert.deepEqual(files.map((file) => statSync(file).mtimeMs), before, 'no write when nothing changed');
  assert.equal(pull.body.state.updated_at, first.body.state.updated_at);
  assert.deepEqual(repeat.body.state, first.body.state);
  assert.deepEqual([pull.body.srs, repeat.body.srs], [{ buckets: {} }, { buckets: {} }], 'nothing new to receive');
  assert.ok(!readdirSync(dataDir).some((name) => name.endsWith('.tmp')), 'no temp files left behind');
});

// ---- Sync: card states in buckets ----

test('card states: the first sync gets every bucket, later syncs only buckets whose rev changed', async () => {
  const { token } = signedIn();
  const t = now() - 60_000;
  const srs = {};
  for (let n = 0; n < 24; n += 1) srs[CARD(n, ['read', 'listen', 'speak', 'cloze'][n % 4])] = entry(t + n);
  const buckets = new Set(Object.keys(srs).map(bucketOf));
  assert.ok(buckets.size > 10 && buckets.size < 32, 'spread over many buckets, not all');

  // Device A sends its states (it has merged nothing yet): every bucket it changed comes back as
  // "ack only" (it has every entry already, so no entries are echoed).
  const pushed = await syncAs(token, { marks: {}, srs, srs_revs: {} });
  assert.equal(pushed.status, 200);
  assert.deepEqual(Object.keys(pushed.body.srs.buckets).sort(), [...buckets].sort());
  for (const value of Object.values(pushed.body.srs.buckets)) assert.deepEqual(value, { rev: 1, entries: {} });
  const revsA = revsOf(pushed.body);

  // Device B, first sync: all buckets, with all entries.
  const first = await syncAs(token, { marks: {}, srs_revs: {} });
  assert.deepEqual(revsOf(first.body), revsA);
  const received = Object.assign({}, ...Object.values(first.body.srs.buckets).map((value) => value.entries));
  assert.deepEqual(received, mergeSrs({}, srs));
  for (const [bucket, value] of Object.entries(first.body.srs.buckets)) {
    assert.ok(Object.keys(value.entries).every((id) => bucketOf(id) === bucket), `bucket ${bucket} holds its own cards only`);
  }

  // Nothing new: nothing comes back.
  assert.deepEqual((await syncAs(token, { marks: {}, srs_revs: revsA })).body.srs, { buckets: {} });

  // Device B reviews one card again: its bucket is acked to B, and A (one rev behind) gets the whole bucket.
  const id = CARD(5, 'listen');
  const again = makeEntry(scheduler.review(null, 'again', t + 1000), t + 1000, srs[id]);
  const bucket = bucketOf(id);
  const fromB = await syncAs(token, { marks: {}, srs: { [id]: again }, srs_revs: revsA });
  assert.deepEqual(fromB.body.srs.buckets, { [bucket]: { rev: 2, entries: {} } });
  const toA = await syncAs(token, { marks: {}, srs_revs: revsA });
  assert.deepEqual(Object.keys(toA.body.srs.buckets), [bucket]);
  assert.equal(toA.body.srs.buckets[bucket].rev, 2);
  assert.deepEqual(toA.body.srs.buckets[bucket].entries[id], mergeSrs({}, { [id]: again })[id]);
  assert.equal(toA.body.srs.buckets[bucket].entries[id].f, srs[id].f, 'the first review time is kept');

  // An older state (a device that was offline) does not overwrite the newer one, and changes nothing.
  const stale = await syncAs(token, { marks: {}, srs: { [id]: srs[id] }, srs_revs: { ...revsA, [bucket]: 2 } });
  assert.deepEqual(stale.body.srs, { buckets: {} }, 'same rev: nothing changed');
  // A device whose rev is ahead of the server (the server lost data): it gets the bucket back.
  const ahead = await syncAs(token, { marks: {}, srs_revs: { [bucket]: 9 } });
  assert.equal(ahead.body.srs.buckets[bucket].rev, 2);
  const missing = BUCKETS.find((b) => !buckets.has(b));
  assert.ok(missing);
  const gone = await syncAs(token, { marks: {}, srs_revs: { ...revsA, [bucket]: 2, [missing]: 4 } });
  assert.deepEqual(gone.body.srs.buckets, { [missing]: { rev: 0, entries: {} } }, 'a bucket the server does not have: rev 0');
});

test('card states: "ack only" just when the bucket now holds exactly what the device sent', async () => {
  const { token } = signedIn();
  const t = now() - 60_000;
  const id = CARD(7, 'listen');
  const bucket = bucketOf(id);
  const first = await syncAs(token, { marks: {}, srs: { [id]: entry(t) }, srs_revs: {} });
  assert.deepEqual(first.body.srs.buckets, { [bucket]: { rev: 1, entries: {} } });
  // The item was reset on this device and studied again: a newer review, but a later first review than
  // the account knows. The merge keeps the earliest `f`, so the device must get the bucket back.
  const restarted = entry(t + 30_000);
  const second = await syncAs(token, { marks: {}, srs: { [id]: restarted }, srs_revs: { [bucket]: 1 } });
  assert.equal(second.body.srs.buckets[bucket].rev, 2);
  assert.deepEqual(second.body.srs.buckets[bucket].entries[id], { ...restarted, f: t });
  // Sent exactly as it is stored now: ack only.
  const third = await syncAs(token, { marks: {}, srs: { [id]: { ...entry(t + 40_000), f: t } }, srs_revs: { [bucket]: 2 } });
  assert.deepEqual(third.body.srs.buckets, { [bucket]: { rev: 3, entries: {} } });
});

test('card states of unknown items or types are dropped, stored junk is pruned', async () => {
  const { email, token } = signedIn();
  const t = now() - 1000;
  const card = entry(t);
  const result = await syncAs(token, {
    marks: {},
    srs: { [CARD(1)]: card, 'w.made.up.read': card, [`${C(2)}.write`]: card, [`${C(3)}`]: card },
    srs_revs: {},
  });
  assert.equal(result.status, 200);
  const all = Object.assign({}, ...await Promise.all(srsKeys(email).map(async (key) => (await storeFromEnv().get(key))?.entries ?? {})));
  assert.deepEqual(Object.keys(all), [CARD(1)]);
  // A bucket written before this check existed: junk is not returned and is dropped on the next write.
  const key = srsKey(email, bucketOf(CARD(1)));
  await storeFromEnv().set(key, { rev: 1, entries: { ...(await storeFromEnv().get(key)).entries, 'w.junk.read': card } });
  const fresh = await syncAs(token, { marks: {}, srs_revs: {} });
  assert.deepEqual(Object.keys(fresh.body.srs.buckets[bucketOf(CARD(1))].entries), [CARD(1)]);
  const sameBucket = cardsIn(bucketOf(CARD(1)), 2).find((id) => id !== CARD(1));
  await syncAs(token, { marks: {}, srs: { [sameBucket]: card }, srs_revs: {} });
  assert.deepEqual(Object.keys((await storeFromEnv().get(key)).entries).sort(), [CARD(1), sameBucket].sort());
});

test('a large first sync is answered in parts (`more`), the next request gets the rest', async () => {
  const { email, token } = signedIn();
  const t = now() - 1000;
  // ~20,000 card states written straight into the buckets (as many devices would have, over months).
  const card = entry(t);
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, {}]));
  for (const id of WORD_IDS.slice(0, 5000)) for (const type of ['read', 'listen', 'speak', 'cloze']) byBucket[bucketOf(`${id}.${type}`)][`${id}.${type}`] = card;
  const store = storeFromEnv();
  await store.set(recordKey(email), { email, created_at: 1, updated_at: 1, marks: {}, settings: null, settings_t: 0, stats: { days: {} } });
  for (const bucket of BUCKETS) await store.set(srsKey(email, bucket), { rev: 3, entries: mergeSrs({}, byBucket[bucket]) });
  const total = Object.values(byBucket).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
  assert.ok(JSON.stringify(byBucket).length > sync.SRS_ANSWER_BYTES, 'more than one answer holds');

  const revs = {};
  const received = {};
  let requests = 0;
  for (;;) {
    const answer = await syncAs(token, { marks: {}, srs_revs: revs });
    requests += 1;
    assert.equal(answer.status, 200);
    assert.ok(JSON.stringify(answer.body).length < sync.SRS_ANSWER_BYTES + 300_000, 'each answer stays near the budget');
    for (const [bucket, value] of Object.entries(answer.body.srs.buckets)) {
      revs[bucket] = value.rev;
      Object.assign(received, value.entries);
    }
    if (!answer.body.srs.more) break;
    assert.ok(requests < 10);
  }
  assert.ok(requests >= 2, `answered in ${requests} parts`);
  assert.equal(Object.keys(received).length, total);
  assert.equal(Object.keys(revs).length, 32);
});

test('503 storage_unavailable on Vercel without Redis, and no email in the logs', async () => {
  const email = 'private.storage@example.com';
  accounts.users.set(email, { password: PASSWORD });
  const { token } = signedIn(email);
  const logs = await captureConsole(() => withEnv({ VERCEL: '1', LEARN_CHINESE_DATA_DIR: undefined }, async () => {
    for (const result of [await call(login.POST, { email, password: PASSWORD }), await syncAs(token, { marks: {} }),
      await serviceCall({ action: 'stats' })]) {
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: 'storage_unavailable' });
    }
  }));
  assert.match(logs, /storage unavailable/);
  assert.ok(!logs.includes('private.storage'));
});

test('a corrupt record gives 500 without leaking its content into the logs', async () => {
  const email = 'corrupt.record@example.com';
  accounts.users.set(email, { password: PASSWORD });
  writeFileSync(join(dataDir, `${encodeURIComponent(recordKey(email))}.json`), `{"email":"${email}", broken`);
  const logs = await captureConsole(async () => {
    const result = await call(login.POST, { email, password: PASSWORD });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'internal' });
  });
  assert.ok(!logs.includes('corrupt.record'));
});

// ---- Deployment config ----

test('vercel.json: security headers, caching, functions bundle the data; .vercelignore keeps dev files out', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.functions, { 'api/*.js': { includeFiles: 'data/**' } });
  const headers = (source) => Object.fromEntries((config.headers.find((rule) => rule.source === source)?.headers ?? []).map((h) => [h.key, h.value]));
  assert.deepEqual(headers('/(.*)'), {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  for (const source of ['/', '/index.html', '/sw.js']) assert.deepEqual(headers(source), { 'Cache-Control': 'no-cache' }, source);
  assert.deepEqual(headers('/data/(.*)'), { 'Cache-Control': 'public, max-age=0, must-revalidate' });
  assert.deepEqual(headers('/audio/(.*)'), { 'Cache-Control': 'public, max-age=604800' });
  const ignored = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
  for (const entry of ['.data/', '.env*', 'tests/', 'scripts/']) assert.ok(ignored.includes(entry), entry);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module', 'api/*.js are ES modules');
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

// ---- Dev server, end to end ----

const devServerFile = fileURLToPath(new URL('../scripts/dev-server.mjs', import.meta.url));

async function startDevServer(dir, env = {}) {
  const childEnv = { ...process.env, PORT: '0', LEARN_CHINESE_DATA_DIR: dir, ...env };
  for (const key of STORE_ENV.filter((name) => !(name in env) && name !== 'LEARN_CHINESE_DATA_DIR')) delete childEnv[key];
  const child = spawn(process.execPath, [devServerFile], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`dev server did not start:\n${out}${err}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(out);
      if (match && /Ctrl\+C/.test(out)) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited with ${code}:\n${err}`));
    });
  });
  return { child, url, output: () => out };
}

async function stopDevServer(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

function rawStatus(base, path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    httpGet({ hostname, port, path }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
}

/** A browser holding marks, settings, statistics and card states locally, syncing the way the app does:
 * full marks and statistics, card states changed since its last sync, and the bucket revs it has merged. */
class Device {
  constructor(base) {
    this.base = base;
    this.token = null;
    this.marks = {};
    this.settings = null;
    this.settingsT = 0;
    this.stats = { days: {} };
    this.srs = {};
    this.sent = {}; // card id -> entry the server has
    this.revs = {};
  }

  async post(path, body, headers = {}) {
    const response = await fetch(new URL(path, this.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  }

  absorb(state, srs = null) {
    this.marks = mergeMarks(this.marks, state.marks);
    ({ settings: this.settings, t: this.settingsT } = mergeSettings(this.settings, this.settingsT, state.settings, state.settings_t));
    this.stats = mergeStats(this.stats, state.stats);
    for (const [bucket, value] of Object.entries(srs?.buckets ?? {})) {
      this.srs = mergeSrs(this.srs, value.entries);
      Object.assign(this.sent, value.entries);
      this.revs[bucket] = value.rev;
    }
  }

  /** Sign in (or create the account) and push what this device had before. */
  async signIn(path, form) {
    const { status, body } = await this.post(path, form);
    assert.equal(status, 200, JSON.stringify(body));
    this.token = body.token;
    this.absorb(body.state);
    await this.sync();
    return body;
  }

  async sync() {
    const changes = {};
    for (const [id, value] of Object.entries(this.srs)) if (JSON.stringify(this.sent[id]) !== JSON.stringify(value)) changes[id] = value;
    const body = { marks: this.marks, stats: this.stats, srs: changes, srs_revs: this.revs };
    if (this.settings) Object.assign(body, { settings: this.settings, settings_t: this.settingsT });
    const result = await this.post('api/sync', body, { authorization: `Bearer ${this.token}` });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    Object.assign(this.sent, changes);
    this.absorb(result.body.state, result.body.srs);
    return result.body;
  }

  mark(id, m, t) {
    this.marks = setMark(this.marks, id, m, t);
  }

  answer(id, grade, t) {
    const previous = this.srs[id] ?? null;
    const card = previous ? decodeCard(previous.s) : null;
    this.srs = { ...this.srs, [id]: makeEntry(scheduler.review(card, grade, t), t, previous) };
    const day = new Date(t).toISOString().slice(0, 10);
    const was = this.stats.days[day] ?? { r: 0, n: 0, a: 0, ms: 0 };
    this.stats = { days: { ...this.stats.days, [day]: { ...was, r: was.r + 1, a: was.a + (grade === 'again' ? 1 : 0) } } };
  }

  setSettings(settings, t) {
    this.settings = settings;
    this.settingsT = t;
  }
}

test('dev server: static files, headers, private paths, API routing and two devices converging', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-chinese-dev-'));
  const { child, url, output } = await startDevServer(dir, { ACCOUNTS_URL: accounts.url, ACCOUNTS_SERVICE_KEY: SERVICE_KEY });
  t.after(async () => {
    await stopDevServer(child);
    rmSync(dir, { recursive: true, force: true });
  });
  assert.match(output(), new RegExp(`Accounts service: ${accounts.url.replace(/[.]/g, '\\.')}`));
  assert.ok(!output().includes(SERVICE_KEY), 'the service key is never printed');

  // Static site with the vercel.json headers.
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /^text\/html/);
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(home.headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=(self)');
  assert.equal(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const html = await home.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /id="signin-dialog"/);
  for (const path of ['src/sync.js', 'src/account.js', 'src/lib/marks.js']) {
    const module = await fetch(new URL(path, url));
    assert.equal(module.status, 200, path);
    assert.match(module.headers.get('content-type'), /^text\/javascript/);
    await module.arrayBuffer();
  }
  // Audio: the right type, and byte ranges (Safari plays audio only with them).
  const audioDir = new URL('../audio/s/', import.meta.url);
  const clip = readdirSync(audioDir).find((name) => name.endsWith('.mp3'));
  if (clip) {
    const full = await fetch(new URL(`audio/s/${clip}`, url));
    assert.equal(full.headers.get('content-type'), 'audio/mpeg');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const size = (await full.arrayBuffer()).byteLength;
    const part = await fetch(new URL(`audio/s/${clip}`, url), { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const beyond = await fetch(new URL(`audio/s/${clip}`, url), { headers: { range: `bytes=${size}-` } });
    assert.equal(beyond.status, 416);
    await beyond.arrayBuffer();
  }
  for (const path of ['api/_lib/store.js', 'api/login.js', 'scripts/dev-server.mjs', 'tests/index.js', '.data/', '.gitignore',
    'nope.html', 'api/nope', 'api/_lib']) {
    const response = await fetch(new URL(path, url));
    assert.equal(response.status, 404, path);
    await response.arrayBuffer();
  }
  // Encoded traversal, sent raw (fetch would normalise the path first).
  for (const path of ['/..%2f..%2fpackage.json', '/src/..%2f..%2f..%2fREADME.md', '/%2e%2e%2f.data%2f', '/src/%5c..%5cindex.html']) {
    assert.equal(await rawStatus(url, path), 404, path);
  }
  const getLogin = await fetch(new URL('api/login', url));
  assert.equal(getLogin.status, 405);
  assert.deepEqual(await getLogin.json(), { error: 'method_not_allowed' });
  // After an early answer the keep-alive connection must stay usable (the requests below reuse it).
  const tooBig = await fetch(new URL('api/sync', url), { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1) });
  assert.equal(tooBig.status, 401, 'no token: refused before the body is looked at');
  await tooBig.arrayBuffer();
  const before = accounts.calls.length;
  const badLogin = await fetch(new URL('api/login', url), { method: 'POST', body: '{"email":"nope@example.com","password":"x"}' });
  assert.equal(badLogin.status, 401);
  assert.deepEqual(await badLogin.json(), { error: 'invalid_credentials' });
  assert.equal(accounts.calls.slice(before)[0].headers['x-accounts-client-ip'], '127.0.0.1', 'the dev server reports the IP like Vercel');

  // Two devices. Each was used anonymously first; progress made before signing in joins the account.
  const t0 = Date.now() - 60_000;
  const phone = new Device(url);
  const laptop = new Device(url);
  phone.mark(C(1), 'star', t0);
  phone.mark(C(2), 'star', t0 + 1);
  phone.answer(CARD(1, 'listen'), 'good', t0 + 2);
  laptop.mark(C(3), 'skip', t0 + 2);
  laptop.answer(CARD(3, 'read'), 'easy', t0 + 3);

  const form = { email: ' Learner@Example.com ', password: PASSWORD, invite_code: INVITE_CODE };
  assert.equal((await phone.signIn('api/register', form)).created, true);
  const laptopLogin = await laptop.signIn('api/login', { email: 'learner@example.com', password: PASSWORD });
  assert.equal(laptopLogin.created, false);
  assert.deepEqual(Object.keys(laptopLogin.state.marks), [C(1), C(2)]);
  assert.ok(laptop.srs[CARD(1, 'listen')], 'the laptop got the phone\'s card state');
  await phone.sync();
  assert.deepEqual(phone.marks, laptop.marks);
  assert.deepEqual(phone.srs, laptop.srs);
  assert.deepEqual(Object.keys(phone.marks), [C(1), C(2), C(3)]);

  // Conflicting edits while both are offline.
  phone.mark(C(1), 'skip', t0 + 10); //    star -> skip
  laptop.mark(C(1), null, t0 + 20); //     cleared later: wins
  phone.mark(C(3), 'star', t0 + 15); //    skip -> star later than ...
  laptop.mark(C(3), 'skip', t0 + 12); //   ... the laptop's re-skip
  laptop.mark(C(2), 'star', t0 + 25); //   re-star, but ...
  phone.mark(C(2), null, t0 + 30); //      ... cleared even later: wins
  laptop.mark(C(4), 'skip', t0 + 31); //   new on one device only
  phone.answer(CARD(1, 'listen'), 'again', t0 + 40); // reviewed on both: the later review wins
  laptop.answer(CARD(1, 'listen'), 'easy', t0 + 50);
  phone.answer(CARD(5, 'speak'), 'good', t0 + 41);
  phone.setSettings({ newPerDay: 5, activeDecks: 'exam2025-1', autoplay: true }, t0 + 5);
  laptop.setSettings({ newPerDay: 20, activeDecks: 'exam2025-1,exam2025-2', autoplay: false }, t0 + 40);

  await phone.sync();
  await laptop.sync();
  const final = await phone.sync();

  assert.deepEqual(phone.marks, laptop.marks, 'devices converge');
  assert.deepEqual(phone.marks, final.state.marks, 'devices match the server');
  assert.deepEqual(phone.marks, {
    [C(1)]: { m: null, t: t0 + 20 },
    [C(2)]: { m: null, t: t0 + 30 },
    [C(3)]: { m: 'star', t: t0 + 15 },
    [C(4)]: { m: 'skip', t: t0 + 31 },
  });
  assert.deepEqual(phone.srs, laptop.srs, 'card states converge');
  assert.equal(phone.srs[CARD(1, 'listen')].t, t0 + 50, 'the later review wins');
  assert.equal(phone.srs[CARD(1, 'listen')].f, t0 + 2, 'the first review stays the earliest');
  assert.deepEqual(Object.keys(phone.srs).sort(), [CARD(1, 'listen'), CARD(3, 'read'), CARD(5, 'speak')].sort());
  assert.deepEqual(phone.stats, laptop.stats, 'statistics converge');
  assert.deepEqual(phone.revs, laptop.revs, 'both devices merged the same bucket revs');
  assert.deepEqual([phone.settings, phone.settingsT], [laptop.settings, laptop.settingsT]);
  assert.equal(phone.settings.newPerDay, 20);

  // A third, fresh device signing in sees the same state; the records live in the temp data dir.
  const tablet = new Device(url);
  await tablet.signIn('api/login', { email: 'LEARNER@example.com', password: PASSWORD });
  assert.deepEqual([tablet.marks, tablet.srs, tablet.stats], [phone.marks, phone.srs, phone.stats]);
  const hash = createHash('sha256').update('learner@example.com').digest('hex');
  assert.ok(readdirSync(dir).every((name) => name.includes(hash)), 'only this account\'s files');
  assert.equal(readdirSync(dir).length, 1 + new Set(Object.keys(phone.srs).map(bucketOf)).size);

  // The admin panel's hook works through the dev server too.
  const stats = await fetch(new URL('api/service', url), {
    method: 'POST', headers: { 'x-accounts-service-key': SERVICE_KEY }, body: '{"action":"stats"}',
  });
  assert.equal(stats.status, 200);
  const body = await stats.json();
  assert.equal(body.users_with_data, 1);
  assert.equal(body.total_reviews, Object.values(phone.stats.days).reduce((sum, day) => sum + day.r, 0));
});

test('dev server defaults: port 4176 printed for PORT unset, accounts on 127.0.0.1:4175 with the dev service key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-chinese-dev-'));
  // A stand-in on a free port would need the URL; here only the printed defaults are checked.
  const { child, output } = await startDevServer(dir);
  t.after(async () => {
    await stopDevServer(child);
    rmSync(dir, { recursive: true, force: true });
  });
  assert.match(output(), /Accounts service: http:\/\/127\.0\.0\.1:4175 \(service key: dev default\)/);
  assert.match(output(), /Learn Chinese records: JSON files in /);
  assert.ok(!output().includes('dev-service-key'), 'the key itself is never printed');
  const source = readFileSync(devServerFile, 'utf8');
  assert.match(source, /DEFAULT_PORT = 4176/);
});
