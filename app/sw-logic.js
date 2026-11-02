/* Learn Chinese: the pure decisions of the service worker (app/sw.js), kept apart so Node can test them
 * (app/tests/sw.test.mjs). A classic script on purpose: sw.js loads it with importScripts('sw-logic.js')
 * and finds it at self.SWLogic; CommonJS (Node) gets it from module.exports. No state, no I/O.
 *
 * Caches (Settings > Offline in src/offline.js uses the audio cache name too; a test keeps them equal):
 *   learn-chinese-shell-<version>  app shell from sw-precache.js; a new version gets a new cache
 *   learn-chinese-data-v1          data/*.json by full URL (?v=<content hash>), the latest copy of each file
 *   learn-chinese-audio-v1         audio/**.mp3 by path, saved on first play or from Settings > Offline
 * Data and audio caches outlive app versions: their URLs (data) or files (audio) say what they hold. */
(function (root) {
  'use strict';

  const PREFIX = 'learn-chinese-';
  const DATA_CACHE = `${PREFIX}data-v1`;
  const AUDIO_CACHE = `${PREFIX}audio-v1`;
  const SHELL_PREFIX = `${PREFIX}shell-`;
  /** Navigations wait this long for the network before the saved app answers. */
  const NAV_TIMEOUT_MS = 3000;
  /** The worker's own scripts: the browser fetches them itself when it checks for an update. */
  const WORKER_FILES = ['sw.js', 'sw-logic.js', 'sw-precache.js'];

  /** The caches one version of the app uses. */
  function cacheNames(version) {
    return { shell: `${SHELL_PREFIX}${version}`, data: DATA_CACHE, audio: AUDIO_CACHE };
  }

  /** Caches to delete when `version` activates: this app's caches that the version does not use
   * (older app shells, data or audio caches of an older format). Other apps' caches are left alone. */
  function obsoleteCaches(names, version) {
    const keep = new Set(Object.values(cacheNames(version)));
    return names.filter((name) => name.startsWith(PREFIX) && !keep.has(name));
  }

  /** Path of `url` below the worker's scope ('' for the scope itself), or null outside it (other origins too). */
  function scopedPath(url, scope) {
    const u = new URL(url);
    const s = new URL(scope);
    if (u.origin !== s.origin || !u.pathname.startsWith(s.pathname)) return null;
    return u.pathname.slice(s.pathname.length);
  }

  /**
   * How the worker answers a request. `req` = { url, method, mode, range } (range: the Range header or null).
   *   'navigate'  page loads: network first (NAV_TIMEOUT_MS), else the saved index.html
   *   'audio'     audio/*.mp3: cache first, whole file saved on first use, Range answered from the cache
   *   'data'      data/*.json other than the manifest: cache first by full URL (?v=<hash>)
   *   'shell'     everything else of the app: cache first (precached), network for anything missing
   *   null        not handled: non-GET, other origins, api/ (network only, never cached), the worker's own
   *               files, and partial (Range) requests of anything but audio
   */
  function routeOf(req, scope) {
    if (String(req.method || 'GET').toUpperCase() !== 'GET') return null;
    const path = scopedPath(req.url, scope);
    if (path === null) return null;
    if (path === 'api' || path.startsWith('api/')) return null;
    if (req.mode === 'navigate') return 'navigate';
    if (/^audio\/.+\.mp3$/i.test(path)) return 'audio';
    if (req.range) return null;
    if (WORKER_FILES.includes(path)) return null;
    if (/^data\/.+\.json$/i.test(path) && path !== 'data/manifest.json') return 'data';
    return 'shell';
  }

  /** URL without its fragment (never sent to a server; the Cache API ignores it as well). */
  function withoutHash(url) {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  }

  /** Cache key of an audio file: its URL without query or fragment, so every request for the file
   * (the audio element, a Range request, Settings > Offline) finds the one saved copy. */
  function audioKey(url) {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href;
  }

  /** Cache key of a data file: the full URL, including ?v=<content hash> (a new hash is a new entry). */
  const dataKey = withoutHash;

  /** True when a data URL names its content version (?v=…): such a URL never changes content. */
  function isVersioned(url) {
    return new URL(url).searchParams.has('v');
  }

  /** Cached URLs that are other versions of the same file as `url` (same path, other query): deleted once
   * `url` is stored, so the cache keeps only the latest copy of each data file. */
  function otherVersions(keys, url) {
    const u = new URL(url);
    const key = dataKey(url);
    return keys.filter((k) => {
      const o = new URL(k);
      return o.origin === u.origin && o.pathname === u.pathname && withoutHash(k) !== key;
    });
  }

  /** Only complete, successful answers are stored: status 200 from this origin ('basic', or 'default' for a
   * Response built by the worker). Never opaque (status 0), errors, partial content (206) or redirects to
   * another origin (those are 'opaqueredirect' or 'cors'). */
  function isCacheable(res) {
    return Boolean(res) && res.status === 200 && (res.type === 'basic' || res.type === 'default');
  }

  /**
   * One byte range from a Range header for a body of `size` bytes (RFC 9110, section 14.1.2).
   * Returns { start, end } (inclusive, end clamped to the last byte), 'unsatisfiable' (answer 416), or null:
   * no header, another unit, several ranges or a malformed value, which a server may answer with the whole
   * body (200). Media elements send one range: "bytes=0-" (Chrome) or "bytes=0-1" and later "bytes=N-M"
   * (Safari, which needs a 206 answer to play at all).
   */
  function parseRange(header, size) {
    if (typeof header !== 'string') return null;
    const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
    if (!m) return null;
    const [, first, last] = m;
    if (first === '' && last === '') return null;
    if (first === '') {
      // Suffix range: the final `last` bytes (all of them when the body is shorter).
      const length = Number(last);
      if (length === 0 || size === 0) return 'unsatisfiable';
      return { start: Math.max(0, size - length), end: size - 1 };
    }
    const start = Number(first);
    if (last !== '' && Number(last) < start) return null; // invalid range: ignore the header
    if (start >= size) return 'unsatisfiable';
    const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    return { start, end };
  }

  /** Status, headers and byte span (inclusive) of the answer to `rangeHeader` for a stored body. */
  function rangeAnswer(rangeHeader, size, type) {
    const range = parseRange(rangeHeader, size);
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': type || 'application/octet-stream' };
    if (range === null) {
      return { status: 200, statusText: 'OK', start: 0, end: size - 1, headers: { ...headers, 'Content-Length': String(size) } };
    }
    if (range === 'unsatisfiable') {
      return { status: 416, statusText: 'Range Not Satisfiable', start: 0, end: -1, headers: { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } };
    }
    return {
      status: 206,
      statusText: 'Partial Content',
      start: range.start,
      end: range.end,
      headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) },
    };
  }

  /** The Response for `rangeHeader` (or none) from a stored Blob: 200 whole, 206 partial or 416.
   * Uses the global Response (the worker; Node 18+ for the tests). */
  function rangeResponse(blob, type, rangeHeader) {
    const answer = rangeAnswer(rangeHeader, blob.size, type);
    let body = null;
    if (answer.status === 200) body = blob;
    else if (answer.status === 206) body = blob.slice(answer.start, answer.end + 1);
    return new Response(body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
  }

  /** Settles like `promise`, or rejects with a TimeoutError after `ms`. */
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`no answer within ${ms} ms`);
        error.name = 'TimeoutError';
        reject(error);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  const api = Object.freeze({
    PREFIX,
    DATA_CACHE,
    AUDIO_CACHE,
    SHELL_PREFIX,
    NAV_TIMEOUT_MS,
    WORKER_FILES,
    cacheNames,
    obsoleteCaches,
    scopedPath,
    routeOf,
    audioKey,
    dataKey,
    isVersioned,
    otherVersions,
    isCacheable,
    parseRange,
    rangeAnswer,
    rangeResponse,
    withTimeout,
  });

  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.SWLogic = api;
})(typeof self !== 'undefined' ? self : globalThis);
