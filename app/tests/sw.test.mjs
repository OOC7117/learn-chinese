// Offline support: the service worker's pure helpers (sw-logic.js), the worker itself (sw.js) in a fake
// worker scope (in-memory Cache Storage, a network serving app/), the precache list (scripts/build-sw.mjs),
// the helpers of Settings > Offline (src/offline.js), and the web app manifest and icons.
// Run: node --test app/tests/sw.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellFiles, buildPrecache, precacheSource, precacheStatus, stampWorker } from '../../scripts/build-sw.mjs';
import { AUDIO_CACHE, DATA_CACHE, SHELL_CACHE_PREFIX, CONCURRENCY, audioFilesOf, dataFilesOf, estimateBytes, formatBytes, recordings, runPool } from '../src/offline.js';

const APP = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(APP, path));
const readText = (path) => readFileSync(join(APP, path), 'utf8');

/** Run a classic script (as importScripts would) with `self` (and optionally `module`) in this realm. */
function runClassic(file, self, module = undefined) {
  const fn = vm.runInThisContext(`(function (self, module) {\n${readText(file)}\n})`, { filename: join(APP, file) });
  fn(self, module);
  return self;
}

const L = runClassic('sw-logic.js', {}).SWLogic;
const PRECACHE = runClassic('sw-precache.js', {}).SW_PRECACHE;

// ---------------------------------------------------------------------------------------------------
describe('sw-logic.js', () => {
  test('loads as a classic script (self.SWLogic) and through module.exports', () => {
    assert.equal(typeof L.parseRange, 'function');
    const module = { exports: {} };
    runClassic('sw-logic.js', {}, module);
    assert.deepEqual(Object.keys(module.exports).sort(), Object.keys(L).sort());
  });

  test('parseRange: single ranges, suffixes, open ends, clamping', () => {
    assert.deepEqual(L.parseRange('bytes=0-', 1000), { start: 0, end: 999 });
    assert.deepEqual(L.parseRange('bytes=0-1', 1000), { start: 0, end: 1 });
    assert.deepEqual(L.parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
    assert.deepEqual(L.parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
    assert.deepEqual(L.parseRange('bytes=999-999', 1000), { start: 999, end: 999 });
    assert.deepEqual(L.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(L.parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
    assert.deepEqual(L.parseRange('Bytes = 5 - 9', 1000), { start: 5, end: 9 });
  });

  test('parseRange: unsatisfiable ranges (416) and headers to ignore (200)', () => {
    assert.equal(L.parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(L.parseRange('bytes=5000-6000', 1000), 'unsatisfiable');
    assert.equal(L.parseRange('bytes=-0', 1000), 'unsatisfiable');
    assert.equal(L.parseRange('bytes=0-', 0), 'unsatisfiable');
    for (const ignored of [undefined, null, '', 'bytes=', 'bytes=-', 'bytes=5-1', 'bytes=0-1,5-9', 'items=0-1', 'bytes=a-b', 'bytes=1.5-2']) {
      assert.equal(L.parseRange(ignored, 1000), null, String(ignored));
    }
  });

  test('rangeAnswer: 206 with Content-Range and Content-Length, 200 without a range, 416 beyond the end', () => {
    assert.deepEqual(L.rangeAnswer('bytes=10-19', 100, 'audio/mpeg'), {
      status: 206,
      statusText: 'Partial Content',
      start: 10,
      end: 19,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 10-19/100', 'Content-Length': '10' },
    });
    const whole = L.rangeAnswer(null, 100, 'audio/mpeg');
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['Content-Length'], '100');
    assert.equal(whole.headers['Accept-Ranges'], 'bytes');
    assert.equal(whole.headers['Content-Range'], undefined);
    const beyond = L.rangeAnswer('bytes=100-', 100, 'audio/mpeg');
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers['Content-Range'], 'bytes */100');
    assert.equal(L.rangeAnswer(null, 1, '').headers['Content-Type'], 'application/octet-stream');
  });

  test('rangeResponse: the bytes of the range', async () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, i) => i);
    const blob = new Blob([bytes]);
    const part = L.rangeResponse(blob, 'audio/mpeg', 'bytes=0-1');
    assert.equal(part.status, 206);
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [0, 1]);
    const tail = L.rangeResponse(blob, 'audio/mpeg', 'bytes=-3');
    assert.equal(tail.headers.get('content-range'), 'bytes 47-49/50');
    assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [47, 48, 49]);
    const whole = L.rangeResponse(blob, 'audio/mpeg', null);
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 50);
    const none = L.rangeResponse(blob, 'audio/mpeg', 'bytes=50-');
    assert.equal(none.status, 416);
    assert.equal((await none.arrayBuffer()).byteLength, 0);
  });

  test('routeOf: what the worker handles, and how', () => {
    const scope = 'https://app.test/';
    const route = (url, extra = {}) => L.routeOf({ url: new URL(url, scope).href, method: 'GET', mode: 'cors', range: null, ...extra }, scope);
    assert.equal(route('', { mode: 'navigate' }), 'navigate');
    assert.equal(route('index.html?x=1', { mode: 'navigate' }), 'navigate');
    assert.equal(route('index.html'), 'shell');
    assert.equal(route('styles.css'), 'shell');
    assert.equal(route('src/views/home.js'), 'shell');
    assert.equal(route('icons/icon-192.png'), 'shell');
    assert.equal(route('manifest.webmanifest'), 'shell');
    assert.equal(route('data/manifest.json'), 'shell');
    assert.equal(route('data/words-1.json?v=47da6fc4a46d'), 'data');
    assert.equal(route('data/content.json'), 'data');
    assert.equal(route('audio/s/ma3.mp3', { mode: 'no-cors' }), 'audio');
    assert.equal(route('audio/w/w.6211-4eec.wo3men5.mp3', { range: 'bytes=0-' }), 'audio');
    // Not handled: network only.
    assert.equal(route('api/sync'), null);
    assert.equal(route('api/login', { method: 'POST' }), null);
    assert.equal(route('api/verify?token=x', { mode: 'navigate' }), null);
    assert.equal(route('api'), null);
    assert.equal(route('data/words-1.json?v=1', { method: 'POST' }), null);
    assert.equal(route('data/words-1.json?v=1', { method: 'HEAD' }), null);
    assert.equal(route('https://cdn.example/x.js'), null);
    assert.equal(route('sw.js'), null);
    assert.equal(route('sw-precache.js'), null);
    assert.equal(route('sw-logic.js'), null);
    assert.equal(route('styles.css', { range: 'bytes=0-' }), null);
    assert.equal(route('styles.css', { cache: 'only-if-cached', mode: 'no-cors' }), null);
    assert.equal(route('styles.css', { cache: 'only-if-cached', mode: 'same-origin' }), 'shell');
    // An app deployed below a path.
    const sub = 'https://app.test/learn/';
    assert.equal(L.routeOf({ url: 'https://app.test/learn/audio/s/a1.mp3', method: 'GET', mode: 'no-cors', range: 'bytes=0-1' }, sub), 'audio');
    assert.equal(L.routeOf({ url: 'https://app.test/learn/api/sync', method: 'GET', mode: 'cors', range: null }, sub), null);
    assert.equal(L.routeOf({ url: 'https://app.test/other/', method: 'GET', mode: 'navigate', range: null }, sub), null);
  });

  test('cache keys: audio by path, data by full URL; other versions of the same file', () => {
    assert.equal(L.audioKey('https://app.test/audio/s/ma3.mp3?x=1#t=0.5'), 'https://app.test/audio/s/ma3.mp3');
    assert.equal(L.dataKey('https://app.test/data/words-1.json?v=abc#x'), 'https://app.test/data/words-1.json?v=abc');
    assert.equal(L.isVersioned('https://app.test/data/words-1.json?v=abc'), true);
    assert.equal(L.isVersioned('https://app.test/data/words-1.json'), false);
    const keys = [
      'https://app.test/data/words-1.json?v=old',
      'https://app.test/data/words-1.json?v=new',
      'https://app.test/data/words-1.json',
      'https://app.test/data/words-2.json?v=old',
      'https://other.test/data/words-1.json?v=old',
    ];
    assert.deepEqual(L.otherVersions(keys, 'https://app.test/data/words-1.json?v=new'), [
      'https://app.test/data/words-1.json?v=old',
      'https://app.test/data/words-1.json',
    ]);
  });

  test('isCacheable: only complete answers of this origin', () => {
    const res = (status, type) => ({ status, type });
    assert.equal(L.isCacheable(res(200, 'basic')), true);
    assert.equal(L.isCacheable(res(200, 'default')), true);
    assert.equal(L.isCacheable(res(0, 'opaque')), false);
    assert.equal(L.isCacheable(res(0, 'error')), false);
    assert.equal(L.isCacheable(res(206, 'basic')), false);
    assert.equal(L.isCacheable(res(404, 'basic')), false);
    assert.equal(L.isCacheable(res(500, 'basic')), false);
    assert.equal(L.isCacheable(res(200, 'cors')), false);
    assert.equal(L.isCacheable(res(0, 'opaqueredirect')), false);
    assert.equal(L.isCacheable(null), false);
  });

  test('cache names: a shell per version; data and audio caches survive updates', () => {
    assert.deepEqual(L.cacheNames('abc'), { shell: 'learn-chinese-shell-abc', data: 'learn-chinese-data-v1', audio: 'learn-chinese-audio-v1' });
    const names = ['learn-chinese-shell-old', 'learn-chinese-shell-abc', 'learn-chinese-data-v1', 'learn-chinese-audio-v1', 'learn-chinese-data-v0', 'other-app'];
    assert.deepEqual(L.obsoleteCaches(names, 'abc'), ['learn-chinese-shell-old', 'learn-chinese-data-v0']);
  });

  test('navigations wait 3 s for the network; withTimeout', async () => {
    assert.equal(L.NAV_TIMEOUT_MS, 3000);
    assert.equal(await L.withTimeout(Promise.resolve('fast'), 50), 'fast');
    await assert.rejects(L.withTimeout(new Promise(() => {}), 10), { name: 'TimeoutError' });
    await assert.rejects(L.withTimeout(Promise.reject(new Error('offline')), 50), { message: 'offline' });
  });
});

// ---------------------------------------------------------------------------------------------------
// A fake worker scope: sw.js runs in its own context with in-memory Cache Storage and a network that
// serves the files of app/ (or fails, hangs, or answers with an error status).

class FakeCache {
  constructor() {
    this.entries = new Map(); // url -> { body, status, statusText, headers }
  }

  static url(req) {
    const u = new URL(typeof req === 'string' ? req : req.url);
    u.hash = '';
    return u.href;
  }

  async put(req, res) {
    if (res.status === 206) throw new TypeError('Partial response (status code 206) is unsupported');
    const body = new Uint8Array(await res.arrayBuffer());
    this.entries.set(FakeCache.url(req), { body, status: res.status, statusText: res.statusText, headers: [...res.headers], redirected: res.redirected });
  }

  async match(req, { ignoreSearch = false } = {}) {
    const want = FakeCache.url(req);
    const bare = (url) => url.split('?')[0];
    for (const [url, e] of this.entries) {
      if (url === want || (ignoreSearch && bare(url) === bare(want))) {
        return new Response(e.body.slice(), { status: e.status, statusText: e.statusText, headers: e.headers });
      }
    }
    return undefined;
  }

  async delete(req) {
    return this.entries.delete(FakeCache.url(req));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

class FakeCacheStorage {
  constructor() {
    this.caches = new Map();
  }

  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name);
  }

  async has(name) {
    return this.caches.has(name);
  }

  async delete(name) {
    return this.caches.delete(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async match(req, options) {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(req, options);
      if (hit) return hit;
    }
    return undefined;
  }
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function workerScope({ scope = 'https://app.test/', navTimeoutMs = null } = {}) {
  const net = { offline: false, hang: false, status: new Map(), redirected: new Set(), calls: [] };
  const scopePath = new URL(scope).pathname;
  async function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
    net.calls.push({ url, range: headers.get('range'), cache: typeof input === 'string' ? init.cache : input.cache });
    if (net.hang) return new Promise(() => {});
    if (net.offline) throw new TypeError('Failed to fetch');
    const path = decodeURIComponent(new URL(url).pathname.slice(scopePath.length)) || 'index.html';
    if (net.status.has(path)) return new Response('error', { status: net.status.get(path) });
    const file = join(APP, path);
    if (!existsSync(file) || !statSync(file).isFile()) return new Response('not found', { status: 404 });
    const res = new Response(readFileSync(file), { status: 200, headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' } });
    // The answer came after a redirect (e.g. index.html -> /): fetch() marks such responses.
    if (net.redirected.has(path)) Object.defineProperty(res, 'redirected', { value: true });
    return res;
  }
  const listeners = {};
  const scopeObject = {
    registration: { scope },
    clients: { claimed: 0, async claim() { this.claimed += 1; } },
    skipped: 0,
    skipWaiting() { scopeObject.skipped += 1; return Promise.resolve(); },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    caches: new FakeCacheStorage(),
    fetch,
    URL, Request, Response, Headers, Blob, console,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  scopeObject.self = scopeObject;
  const context = vm.createContext(scopeObject);
  scopeObject.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(readText(file), context, { filename: join(APP, file) });
      if (file === 'sw-logic.js' && navTimeoutMs !== null) scopeObject.SWLogic = { ...scopeObject.SWLogic, NAV_TIMEOUT_MS: navTimeoutMs };
    }
  };
  vm.runInContext(readText('sw.js'), context, { filename: join(APP, 'sw.js') });

  const env = {
    net,
    scope: scopeObject,
    caches: scopeObject.caches,
    /** Dispatch an extendable event; resolves when all waitUntil promises settle (rejects like them). */
    async dispatch(type, fields = {}) {
      const waits = [];
      const event = { ...fields, waitUntil: (p) => waits.push(Promise.resolve(p)) };
      for (const fn of listeners[type] ?? []) fn(event);
      await Promise.all(waits);
    },
    /** A fetch event: the worker's answer, or null when the worker leaves the request to the network. */
    async request(url, { method = 'GET', mode = 'cors', headers = {} } = {}) {
      const request = { url: new URL(url, scope).href, method, mode, headers: new Headers(headers) };
      let answer = null;
      const waits = [];
      const event = {
        request,
        respondWith(p) {
          assert.equal(answer, null, 'respondWith called twice');
          answer = Promise.resolve(p);
        },
        waitUntil: (p) => waits.push(Promise.resolve(p)),
      };
      for (const fn of listeners.fetch ?? []) fn(event);
      if (!answer) return null;
      const res = await answer;
      await Promise.all(waits); // background cache writes
      return res;
    },
    async cacheUrls(name) {
      if (!(await scopeObject.caches.has(name))) return [];
      return (await (await scopeObject.caches.open(name)).keys()).map((r) => r.url).sort();
    },
    callsTo: (path) => net.calls.filter((c) => new URL(c.url).pathname === new URL(path, scope).pathname),
  };
  return env;
}

const SHELL = L.cacheNames(PRECACHE.version).shell;
const bytes = async (res) => Buffer.from(await res.arrayBuffer());
const AUDIO_FILE = 'audio/s/a1.mp3';

describe('sw.js in a fake worker scope', () => {
  test('install saves exactly the app shell of sw-precache.js, bypassing the HTTP cache', async () => {
    const env = workerScope();
    await env.dispatch('install');
    assert.deepEqual(await env.cacheUrls(SHELL), PRECACHE.files.map((f) => new URL(f, 'https://app.test/').href).sort());
    assert.equal(env.net.calls.length, PRECACHE.files.length);
    assert.ok(env.net.calls.every((c) => c.cache === 'reload'));
    const saved = await (await env.caches.open(SHELL)).match('https://app.test/index.html');
    assert.deepEqual(await bytes(saved), read('index.html'));
  });

  test('install stores a redirected answer as a plain one (browsers refuse redirected answers to navigations)', async () => {
    const env = workerScope();
    env.net.redirected.add('index.html');
    await env.dispatch('install');
    const entry = (await env.caches.open(SHELL)).entries.get('https://app.test/index.html');
    assert.equal(entry.redirected, false);
    assert.equal(entry.status, 200);
    assert.deepEqual(Buffer.from(entry.body), read('index.html'));
    assert.ok(entry.headers.some(([name, value]) => name === 'content-type' && value === 'text/html'));
    env.net.offline = true;
    assert.deepEqual(await bytes(await env.request('', { mode: 'navigate' })), read('index.html'));
  });

  test('installing the same version again (only sw.js changed) downloads nothing', async () => {
    const env = workerScope();
    await env.dispatch('install');
    const calls = env.net.calls.length;
    await env.dispatch('install');
    assert.equal(env.net.calls.length, calls);
  });

  test('install fails when a file of the shell is missing (the old version keeps working)', async () => {
    const env = workerScope();
    env.net.status.set('styles.css', 404);
    await assert.rejects(env.dispatch('install'), /styles\.css: HTTP 404/);
  });

  test('activate deletes older app shells only, then takes control', async () => {
    const env = workerScope();
    for (const name of ['learn-chinese-shell-0123456789ab', 'learn-chinese-data-v1', 'learn-chinese-audio-v1', 'another-app']) await env.caches.open(name);
    await env.dispatch('install');
    await env.dispatch('activate');
    assert.deepEqual((await env.caches.keys()).sort(), ['another-app', 'learn-chinese-audio-v1', 'learn-chinese-data-v1', SHELL].sort());
    assert.equal(env.scope.clients.claimed, 1);
  });

  test("message 'skip-waiting' activates the waiting worker; other messages do nothing", async () => {
    const env = workerScope();
    await env.dispatch('message', { data: 'hello' });
    assert.equal(env.scope.skipped, 0);
    await env.dispatch('message', { data: 'skip-waiting' });
    assert.equal(env.scope.skipped, 1);
  });

  test('app shell: cache first, no network once installed', async () => {
    const env = workerScope();
    await env.dispatch('install');
    env.net.offline = true;
    for (const file of ['styles.css', 'src/main.js', 'data/manifest.json', 'icons/icon-192.png', 'manifest.webmanifest']) {
      const res = await env.request(file);
      assert.equal(res.status, 200, file);
      assert.deepEqual(await bytes(res), read(file), file);
    }
  });

  test('a same-origin file missing from the list comes from the network and is kept with this version', async () => {
    const env = workerScope();
    await env.dispatch('install');
    const file = 'src/vendor/ts-fsrs.LICENSE.txt';
    assert.equal(PRECACHE.files.includes(file), false);
    assert.equal((await env.request(file)).status, 200);
    env.net.offline = true;
    assert.deepEqual(await bytes(await env.request(file)), read(file));
  });

  test('navigation: network first; offline or 5xx the saved index.html; nothing saved yet: network error', async () => {
    const env = workerScope();
    await env.dispatch('install');
    const fromNetwork = await env.request('', { mode: 'navigate' });
    assert.equal(fromNetwork.status, 200);
    assert.equal(env.callsTo('').length, 1);
    env.net.offline = true;
    const offline = await env.request('?utm=1', { mode: 'navigate' });
    assert.deepEqual(await bytes(offline), read('index.html'));
    env.net.offline = false;
    env.net.status.set('index.html', 503);
    const serverError = await env.request('', { mode: 'navigate' });
    assert.equal(serverError.status, 200);
    assert.deepEqual(await bytes(serverError), read('index.html'));
    env.net.status.set('index.html', 404);
    assert.equal((await env.request('', { mode: 'navigate' })).status, 404); // an honest 404 stays a 404

    const fresh = workerScope();
    fresh.net.offline = true;
    await assert.rejects(fresh.request('', { mode: 'navigate' }), /Failed to fetch/);
  });

  test('navigation: a network that does not answer in time gets the saved app', async () => {
    const env = workerScope({ navTimeoutMs: 30 });
    await env.dispatch('install');
    env.net.hang = true;
    const started = Date.now();
    const res = await env.request('', { mode: 'navigate' });
    assert.deepEqual(await bytes(res), read('index.html'));
    assert.ok(Date.now() - started >= 25);
  });

  test('api/ is never handled or cached (network only)', async () => {
    const env = workerScope();
    await env.dispatch('install');
    assert.equal(await env.request('api/sync'), null);
    assert.equal(await env.request('api/login', { method: 'POST' }), null);
    assert.equal(await env.request('api/verify?token=abc', { mode: 'navigate' }), null);
    assert.equal(await env.request('https://elsewhere.test/a.js'), null);
    assert.equal(await env.request('sw-precache.js'), null);
    for (const name of await env.caches.keys()) {
      assert.ok((await env.cacheUrls(name)).every((url) => !url.includes('/api/')), name);
    }
  });

  test('audio: saved whole on first play (no Range sent to the network); ranges answered with 206 from the cache', async () => {
    const env = workerScope();
    const file = read(AUDIO_FILE);
    const size = file.length;
    const first = await env.request(AUDIO_FILE, { mode: 'no-cors', headers: { Range: 'bytes=0-1' } });
    assert.equal(first.status, 206);
    assert.equal(first.statusText, 'Partial Content');
    assert.equal(first.headers.get('content-range'), `bytes 0-1/${size}`);
    assert.equal(first.headers.get('content-length'), '2');
    assert.equal(first.headers.get('accept-ranges'), 'bytes');
    assert.equal(first.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(await bytes(first), file.subarray(0, 2));
    assert.deepEqual(env.callsTo(AUDIO_FILE).map((c) => c.range), [null]);
    assert.deepEqual(await env.cacheUrls('learn-chinese-audio-v1'), [new URL(AUDIO_FILE, 'https://app.test/').href]);

    env.net.offline = true;
    const middle = await env.request(`${AUDIO_FILE}?t=1`, { headers: { Range: 'bytes=100-' } });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get('content-range'), `bytes 100-${size - 1}/${size}`);
    assert.deepEqual(await bytes(middle), file.subarray(100));
    const tail = await env.request(AUDIO_FILE, { headers: { Range: 'bytes=-500' } });
    assert.deepEqual(await bytes(tail), file.subarray(size - 500));
    const whole = await env.request(AUDIO_FILE);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(await bytes(whole), file);
    const beyond = await env.request(AUDIO_FILE, { headers: { Range: `bytes=${size}-` } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${size}`);
    assert.equal(env.callsTo(AUDIO_FILE).length, 1);
  });

  test('audio: parallel requests for one file share one download; offline and unsaved fails; errors are not saved', async () => {
    const env = workerScope();
    const answers = await Promise.all(['bytes=0-1', 'bytes=0-', null].map((range) => env.request(AUDIO_FILE, { headers: range ? { Range: range } : {} })));
    assert.deepEqual(answers.map((r) => r.status), [206, 206, 200]);
    assert.equal(env.callsTo(AUDIO_FILE).length, 1);

    env.net.status.set('audio/s/a2.mp3', 404);
    await assert.rejects(env.request('audio/s/a2.mp3'), /HTTP 404/);
    env.net.offline = true;
    await assert.rejects(env.request('audio/s/a3.mp3', { headers: { Range: 'bytes=0-' } }), /Failed to fetch/);
    assert.deepEqual(await env.cacheUrls('learn-chinese-audio-v1'), [new URL(AUDIO_FILE, 'https://app.test/').href]);
  });

  test('data: cache first by full URL; a new version replaces the old; offline, the latest copy of the file', async () => {
    const env = workerScope();
    const v1 = 'data/words-1.json?v=111111111111';
    const v2 = 'data/words-1.json?v=222222222222';
    assert.equal((await env.request(v1)).status, 200);
    assert.equal((await env.request(v1)).status, 200);
    assert.equal(env.callsTo(v1).length, 1);
    assert.deepEqual(await env.cacheUrls('learn-chinese-data-v1'), [`https://app.test/${v1}`]);
    await env.request(v2);
    assert.deepEqual(await env.cacheUrls('learn-chinese-data-v1'), [`https://app.test/${v2}`]);
    env.net.offline = true;
    const latest = await env.request('data/words-1.json?v=333333333333');
    assert.deepEqual(await bytes(latest), read('data/words-1.json'));
    await assert.rejects(env.request('data/words-2.json?v=1'), /Failed to fetch/);
    env.net.offline = false;
    env.net.status.set('data/tones.json', 500);
    assert.equal((await env.request('data/tones.json?v=1')).status, 500);
    assert.equal((await env.cacheUrls('learn-chinese-data-v1')).some((u) => u.includes('tones')), false);
  });

  test('data: a server error answers with the latest saved copy of the file, and is not saved', async () => {
    const env = workerScope();
    await env.request('data/tones.json?v=111111111111');
    env.net.status.set('data/tones.json', 503);
    const res = await env.request('data/tones.json?v=222222222222');
    assert.equal(res.status, 200);
    assert.deepEqual(await bytes(res), read('data/tones.json'));
    assert.deepEqual(await env.cacheUrls('learn-chinese-data-v1'), ['https://app.test/data/tones.json?v=111111111111']);
  });

  test('audio: storage full still plays (just not saved for offline use)', async () => {
    const env = workerScope();
    const cache = await env.caches.open('learn-chinese-audio-v1');
    cache.put = async () => {
      throw new Error('QuotaExceededError');
    };
    const part = await env.request(AUDIO_FILE, { headers: { Range: 'bytes=0-1' } });
    assert.equal(part.status, 206);
    assert.deepEqual(await bytes(part), read(AUDIO_FILE).subarray(0, 2));
    assert.deepEqual(await env.cacheUrls('learn-chinese-audio-v1'), []);
  });

  test('data without ?v= is network first (never stale while online)', async () => {
    const env = workerScope();
    await env.request('data/tones.json');
    await env.request('data/tones.json');
    assert.equal(env.callsTo('data/tones.json').length, 2);
    env.net.offline = true;
    assert.deepEqual(await bytes(await env.request('data/tones.json')), read('data/tones.json'));
  });
});

// ---------------------------------------------------------------------------------------------------
describe('scripts/build-sw.mjs', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  test('the shell: index, styles, manifest, icons, every module and stylesheet under src/, data/manifest.json', () => {
    const files = shellFiles();
    for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'data/manifest.json', 'src/main.js', 'src/vendor/ts-fsrs.mjs', 'src/offline.js']) assert.ok(files.includes(f), f);
    const underSrc = walk(join(APP, 'src')).filter((p) => /\.(m?js|css)$/.test(p)).map((p) => relative(APP, p).split(sep).join('/'));
    for (const f of underSrc) assert.ok(files.includes(f), f);
    for (const f of readdirSync(join(APP, 'icons'))) assert.ok(files.includes(`icons/${f}`), f);
    assert.ok(files.every((f) => !/^(api|audio|tests|scripts)\//.test(f) && !L.WORKER_FILES.includes(f)));
    assert.ok(files.every((f) => existsSync(join(APP, f))));
    assert.deepEqual(files, [...new Set(files)].sort());
  });

  test('app/sw-precache.js and the version line of app/sw.js are up to date (else run `node scripts/build-sw.mjs`)', () => {
    const status = precacheStatus();
    assert.ok(status.upToDate, 'app/sw-precache.js is stale: run `node scripts/build-sw.mjs` and commit app/sw-precache.js and app/sw.js');
    assert.deepEqual(PRECACHE, { version: status.version, files: status.files });
    assert.match(readText('sw.js'), new RegExp(`^// Precache version: ${status.version} `, 'm'));
  });

  test('the version is a hash of the contents: same files, same version; one byte changed, a new version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-sw-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      writeFileSync(join(dir, 'data', 'manifest.json'), '{}');
      writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;');
      writeFileSync(join(dir, 'src', 'notes.txt'), 'not part of the shell');
      const first = buildPrecache(dir);
      assert.deepEqual(first.files, ['data/manifest.json', 'index.html', 'src/a.js']);
      assert.match(first.version, /^[0-9a-f]{12}$/);
      assert.equal(buildPrecache(dir).version, first.version);
      writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 2;');
      assert.notEqual(buildPrecache(dir).version, first.version);
      writeFileSync(join(dir, 'src', 'notes.txt'), 'changed');
      const again = buildPrecache(dir).version;
      writeFileSync(join(dir, 'src', 'notes.txt'), 'changed again');
      assert.equal(buildPrecache(dir).version, again);
      rmSync(join(dir, 'index.html'));
      assert.throws(() => buildPrecache(dir), /index\.html is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('generated source and stamping', () => {
    const source = precacheSource({ version: 'abcdefabcdef', files: ['index.html'] });
    assert.equal(vm.runInNewContext(`${source}; JSON.stringify(self.SW_PRECACHE)`, { self: {} }), JSON.stringify({ version: 'abcdefabcdef', files: ['index.html'] }));
    const worker = '// a\n// Precache version: 000000000000 (stamped by scripts/build-sw.mjs, so every browser sees a changed worker)\nimportScripts();\n';
    assert.equal(stampWorker(worker, 'abcdefabcdef'), worker.replace('000000000000', 'abcdefabcdef'));
    assert.throws(() => stampWorker('// no version line\n', 'abcdefabcdef'), /version/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('src/offline.js helpers', () => {
  test('uses the same cache names as the worker', () => {
    assert.equal(AUDIO_CACHE, L.AUDIO_CACHE);
    assert.equal(DATA_CACHE, L.DATA_CACHE);
    assert.equal(SHELL_CACHE_PREFIX, L.SHELL_PREFIX);
    assert.equal(CONCURRENCY, 6);
  });

  test('dataFilesOf: the warm-up asks for exactly the URLs src/data.js loads (so the worker finds them offline)', async () => {
    const manifest = JSON.parse(readText('data/manifest.json'));
    const requested = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(read(String(url).split('?')[0]), { status: 200 });
    };
    try {
      // A module instance of its own: data.js keeps what it loaded in memory (other test files import it too).
      const data = await import(`../src/data.js?warm-up-test=${Date.now()}`);
      await Promise.all([data.loadAllWords(), data.loadTones(), data.loadContent()]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const files = dataFilesOf(manifest);
    assert.equal(files.length, Object.keys(manifest.files).length);
    assert.deepEqual([...files].sort(), requested.filter((url) => url !== 'data/manifest.json').sort());
    assert.ok(files.every((f) => L.routeOf({ url: new URL(f, 'https://app.test/').href, method: 'GET', mode: 'cors', range: null }, 'https://app.test/') === 'data'), 'the worker saves them in its data cache');
  });

  test('dataFilesOf: only data/*.json entries with a hash, each once', () => {
    assert.deepEqual(dataFilesOf({ files: {
      a: { file: 'data/a.json', hash: 'x1' },
      again: { file: 'data/a.json', hash: 'x1' },
      outside: { file: '../a.json', hash: 'x2' },
      sub: { file: 'data/sub/b.json', hash: 'x3' },
      nohash: { file: 'data/c.json' },
      empty: { file: 'data/d.json', hash: '' },
      broken: null,
    } }), ['data/a.json?v=x1']);
    assert.deepEqual(dataFilesOf(null), []);
    assert.deepEqual(dataFilesOf({}), []);
  });

  test('audioFilesOf: each recording once, in study order; no recording, no file', () => {
    const items = [
      { id: 'w.1', audio: { file: 'audio/s/ma3.mp3' } },
      { id: 'w.2', audio: null },
      { id: 'w.3', audio: { file: 'audio/w/w.3.mp3' } },
      { id: 'w.4', audio: { file: 'audio/s/ma3.mp3' } },
      { id: 'p.1' },
      null,
      { id: 'x', audio: { file: 'https://elsewhere.test/x.mp3' } },
    ];
    assert.deepEqual(audioFilesOf(items), ['audio/s/ma3.mp3', 'audio/w/w.3.mp3']);
    assert.deepEqual(audioFilesOf(undefined), []);
  });

  test('counts of recordings read right for one', () => {
    assert.equal(recordings(1), '1 recording');
    assert.equal(recordings(0), '0 recordings');
    assert.equal(recordings(817), '817 recordings');
    assert.equal(recordings(12345), '12,345 recordings');
  });

  test('size labels', () => {
    assert.equal(formatBytes(0), '0 KB');
    assert.equal(formatBytes(1), '1 KB');
    assert.equal(formatBytes(950_000), '950 KB');
    assert.equal(formatBytes(4_230_000), '4.2 MB');
    assert.equal(formatBytes(37_400_000), '37 MB');
    assert.equal(formatBytes(1_230_000_000), '1.2 GB');
    assert.equal(formatBytes(Number.NaN), '?');
    assert.equal(estimateBytes(['audio/s/ma3.mp3', 'audio/w/w.1.mp3']), 9800 + 4600);
  });

  test('runPool: every item once, never more than `concurrency` at a time', async () => {
    let running = 0;
    let most = 0;
    const seen = [];
    const progress = [];
    const result = await runPool([...Array(40).keys()], async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, n % 3));
      seen.push(n);
      running -= 1;
      if (n % 10 === 9) throw new Error('fails');
    }, { concurrency: 6, onProgress: (p) => progress.push(p) });
    assert.equal(most, 6);
    assert.deepEqual(seen.sort((a, b) => a - b), [...Array(40).keys()]);
    assert.deepEqual(result, { done: 36, failed: 4, total: 40, aborted: false, stopped: false });
    assert.equal(progress.length, 40);
    assert.deepEqual(progress.at(-1), { done: 36, failed: 4, total: 40 });
  });

  test('runPool: cancelling stops new work and is not a failure; many failures in a row stop it', async () => {
    const controller = new AbortController();
    let started = 0;
    const result = await runPool([...Array(100).keys()], async (n, signal) => {
      started += 1;
      if (n === 10) controller.abort();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }, { concurrency: 6, signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.failed, 0);
    assert.ok(started <= 17, `started ${started}`);
    assert.ok(result.done < 100);

    const failing = await runPool([...Array(100).keys()], async () => {
      throw new Error('offline');
    }, { concurrency: 6, stopAfterFailures: 12 });
    assert.equal(failing.stopped, true);
    assert.ok(failing.failed >= 12 && failing.failed <= 17, `failed ${failing.failed}`);
    assert.deepEqual(await runPool([], async () => {}), { done: 0, failed: 0, total: 0, aborted: false, stopped: false });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('web app manifest and icons', () => {
  const manifest = JSON.parse(readText('manifest.webmanifest'));
  /** Width, height and colour type of a PNG (IHDR). */
  const png = (path) => {
    const b = read(path);
    assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', path);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25] };
  };

  test('installable: identity, start URL, scope, display, colours of the light theme, category', () => {
    assert.equal(manifest.id, './');
    assert.equal(manifest.name, 'Learn Chinese');
    assert.equal(manifest.short_name, '中文');
    assert.equal(manifest.lang, 'en');
    assert.equal(manifest.start_url, './#/');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.description.length > 20);
    assert.deepEqual(manifest.categories, ['education']);
    const lightBg = /:root\s*{[^}]*--bg:\s*(#[0-9a-f]{6})/i.exec(readText('styles.css'))[1];
    assert.equal(manifest.background_color, lightBg);
    assert.equal(manifest.theme_color, lightBg);
    assert.match(readText('index.html'), new RegExp(`<meta name="theme-color" content="${lightBg}" media="\\(prefers-color-scheme: light\\)">`));
  });

  test('icons: 192 and 512 "any", 512 "maskable", files of the stated size', () => {
    const want = [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']];
    assert.deepEqual(manifest.icons.map((i) => [i.sizes, i.purpose]), want);
    for (const icon of manifest.icons) {
      assert.equal(icon.type, 'image/png');
      const { width, height } = png(icon.src);
      assert.equal(`${width}x${height}`, icon.sizes, icon.src);
    }
  });

  test('apple-touch-icon is 180 x 180 and opaque; icon.svg draws 中 with shapes (no font)', () => {
    const apple = png('icons/apple-touch-icon.png');
    assert.deepEqual([apple.width, apple.height], [180, 180]);
    assert.ok([0, 2].includes(apple.colourType), 'no alpha channel');
    for (const f of ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png']) assert.ok([0, 2].includes(png(f).colourType), f);
    const svg = readText('icons/icon.svg');
    assert.match(svg, /viewBox="0 0 512 512"/);
    assert.match(svg, /fill="#a8231b"/);
    assert.match(svg, /<path /);
    assert.doesNotMatch(svg, /<text|font-family|<image|href=/);
  });

  test('index.html links the manifest and icons that exist', () => {
    const html = readText('index.html');
    for (const [, href] of html.matchAll(/<link rel="(?:manifest|icon|apple-touch-icon)" href="([^"]+)"/g)) assert.ok(existsSync(join(APP, href)), href);
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon.png">/);
  });
});
