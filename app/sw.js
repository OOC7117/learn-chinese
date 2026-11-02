// Learn Chinese service worker: after the first visit the app opens and works without a network.
// Precache version: 2e01d3f7d3ca (stamped by scripts/build-sw.mjs, so every browser sees a changed worker)
//
// A classic worker without libraries. Decisions (routes, cache keys, byte ranges) are in sw-logic.js and
// tested in tests/sw.test.mjs; the list of app-shell files and their hash is generated into sw-precache.js
// by `node scripts/build-sw.mjs` (run it after changing index.html, CSS, src/, icons, the web app manifest
// or data/manifest.json).
//
//   navigations   network first, after 3 s (or offline) the saved index.html
//   app shell     cache first (saved on install, one cache per version)
//   data/*.json   cache first by full URL (?v=<content hash>); offline, the latest saved copy of the file
//   audio/*.mp3   cache first, saved whole on first play; Range requests (Safari/iOS) get a real 206
//   api/*         network only, never cached (not handled here at all)
// Updates: a new version installs in the background and waits; the page offers "Reload", which posts
// 'skip-waiting' (src/main.js). Non-GET, opaque and error responses are never stored.

/* global SWLogic, SW_PRECACHE */
importScripts('sw-logic.js', 'sw-precache.js');

const L = self.SWLogic;
const { version: VERSION, files: SHELL_FILES } = self.SW_PRECACHE;
const CACHES = L.cacheNames(VERSION);
const SCOPE = self.registration.scope;
const INDEX_URL = new URL('index.html', SCOPE).href;

const noop = () => {};

// ---------- Install: save the app shell of this version ----------

/** A stored copy that may answer any request: a redirected response must not answer a navigation
 * (browsers reject it), so a redirect (e.g. index.html -> /) is stored as a plain response. */
async function storable(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function precache() {
  const cache = await caches.open(CACHES.shell);
  await Promise.all(SHELL_FILES.map(async (file) => {
    const url = new URL(file, SCOPE).href;
    if (await cache.match(url)) return; // same version installed again (only the worker changed)
    // cache: 'reload' skips the HTTP cache, so a stale copy is never saved under the new version.
    const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
    if (!res.ok) throw new Error(`precache ${file}: HTTP ${res.status}`);
    await cache.put(url, await storable(res));
  }));
}

self.addEventListener('install', (event) => {
  // Any missing file fails the install: the previous version keeps working and the browser retries later.
  event.waitUntil(precache());
});

// ---------- Activate: drop older app shells, take control ----------

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(L.obsoleteCaches(names, VERSION).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

// ---------- Fetch ----------

async function navigate(network) {
  const saved = caches.open(CACHES.shell).then((cache) => cache.match(INDEX_URL, { ignoreVary: true })).catch(noop);
  try {
    const res = await L.withTimeout(network, L.NAV_TIMEOUT_MS);
    if (res.status < 500) return res;
    return (await saved) || res; // server error: the saved app is more useful
  } catch {
    // Offline, or no answer within 3 s: the saved app. Nothing saved yet: keep waiting for the network.
    return (await saved) || network;
  }
}

async function shell(event) {
  const url = event.request.url;
  const cache = await caches.open(CACHES.shell);
  const hit = await cache.match(url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(event.request);
  // Not in this version's list (e.g. a file added without rebuilding sw-precache.js): keep it with this version.
  if (L.isCacheable(res)) event.waitUntil(cache.put(url, await storable(res.clone())).catch(noop));
  return res;
}

/** Store `res` under `key` and delete the other versions of the same file. */
async function storeLatest(cache, key, res) {
  await cache.put(key, res);
  const keys = (await cache.keys()).map((req) => req.url);
  await Promise.all(L.otherVersions(keys, key).map((old) => cache.delete(old)));
}

async function data(event) {
  const { request } = event;
  const key = L.dataKey(request.url);
  const cache = await caches.open(CACHES.data);
  // A ?v=<hash> URL never changes content: cache first. Without a version: network first.
  if (L.isVersioned(request.url)) {
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
  }
  // Offline (or the file is gone): the latest saved copy of the same file beats an error.
  const latest = () => cache.match(key, { ignoreSearch: true, ignoreVary: true });
  let res;
  try {
    res = await fetch(request);
  } catch (error) {
    const saved = await latest();
    if (saved) return saved;
    throw error;
  }
  if (L.isCacheable(res)) {
    event.waitUntil(storeLatest(cache, key, res.clone()).catch(noop));
    return res;
  }
  return (!res.ok && (await latest())) || res;
}

// Concurrent requests for one audio file (Safari sends several Range requests at once) share one download.
const audioDownloads = new Map(); // key -> Promise<{ blob, type }>

/** The whole file from the network (never a range: a 206 cannot be stored), saved before it is used. */
function downloadAudio(key, cache) {
  if (!audioDownloads.has(key)) {
    const job = (async () => {
      const res = await fetch(key, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`audio ${key}: HTTP ${res.status}`);
      const blob = await res.blob();
      const type = res.headers.get('content-type') || 'audio/mpeg';
      if (L.isCacheable(res)) {
        const headers = { 'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' };
        // Storage full or blocked: play it anyway, it just is not available offline.
        await cache.put(key, new Response(blob, { status: 200, headers })).catch(noop);
      }
      return { blob, type };
    })();
    audioDownloads.set(key, job);
    job.then(noop, noop).then(() => audioDownloads.delete(key));
  }
  return audioDownloads.get(key);
}

async function audio(event) {
  const { request } = event;
  const key = L.audioKey(request.url);
  const range = request.headers.get('range');
  const cache = await caches.open(CACHES.audio);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit && !range) return hit;
  if (hit) return L.rangeResponse(await hit.blob(), hit.headers.get('content-type') || 'audio/mpeg', range);
  // Not saved yet. Offline this rejects: the page falls back to the device voice (src/audio.js).
  const { blob, type } = await downloadAudio(key, cache);
  return L.rangeResponse(blob, type, range);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const route = L.routeOf({ url: request.url, method: request.method, mode: request.mode, range: request.headers.get('range'), cache: request.cache }, SCOPE);
  if (!route) return; // the browser handles it as if there were no worker (api/ is network only)
  if (route === 'navigate') {
    const network = fetch(request);
    network.catch(noop); // answered from the cache meanwhile: a late failure is expected
    event.respondWith(navigate(network));
  } else if (route === 'audio') event.respondWith(audio(event));
  else if (route === 'data') event.respondWith(data(event));
  else event.respondWith(shell(event));
});
