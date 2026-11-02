// Client sync engine: keeps this device's marks, settings, statistics and card states (srs) in step with
// the account on the server. Ported from the reference project (Inburgering flashcards, src/sync.js); the
// timing, retries, statuses and sign-in calls are unchanged, card states are new.
// Every sync request carries the session token (`Authorization: Bearer <token>`, from /api/login or
// /api/register); the server takes the account's email from it.
//
// Local first: the page saves every change to localStorage and carries on; this engine only ever runs
// in the background and the UI never waits on it. Every sync sends the full marks map (tombstones
// included), the statistics, the settings when the user has changed them, and the card states this
// device changed since its last successful sync; the server merges and answers with the merged marks,
// settings and statistics plus the card-state buckets that changed since this device last merged them
// (api/sync.js). `onRemote` merges all of that back into the page. Merging is idempotent, so a lost or
// repeated request heals on the next sync.
//
// Card states: up to ~50,000 cards, so they go as deltas. The engine remembers, in memory, which entry
// of each card the server is known to have (`acked`: what it sent, and what the server answered with);
// anything else is sent, at most limits.srsPerRequest per request and within the body limit, and syncNow
// loops until nothing is left. When a page starts, entries older than the last complete sync (minus
// timing.ackMarginMs) count as acked (`loadLastSynced`, shared by all tabs), so a reload does not send
// everything again. The buckets' revs this device has merged are kept with `loadRevs` / `saveRevs`
// (learn-chinese:v1:srs-revs); a bucket whose rev went backwards (the server lost data) is sent again.
//
// When it syncs:
//   - `changed()`        1.5 s after the last change (debounced), e.g. a star, a setting or an answer
//   - `changed({ quiet: true })`  no request of its own: the change rides along with the next sync or
//                        the flush below
//   - `syncNow()`        at once (sign-in, page load, the "Sync now" button)
//   - `pull()`           the page became visible again: at most every 30 s
//   - `flush()`          the page is being hidden or closed: best effort, `fetch(…, { keepalive: true })`;
//                        only the marks, days and card states changed since the last full sync, so the
//                        body stays small
//   - `online()`         the browser is back online: retry what failed
// Failures keep everything local and retry with exponential backoff (at most every 60 s); 4xx answers
// are not retried (the next change tries again), and 503 (storage or accounts not configured or down)
// pauses automatic syncing for a few minutes so many open pages cannot hammer the server. A 401 means
// the session ended (expired, signed out everywhere, account disabled): syncing stops, the token is
// dropped (`onUnauthorized`) and the status becomes EXPIRED until the person signs in again; the page
// keeps everything local, and the next sign-in merges it into the account.
//
// Everything with side effects (fetch, timers, clock, online state, where the last sync time and the
// revs are kept) is injectable, so tests can drive it with fakes.

import { SRS_BUCKETS, bucketOf } from './lib/srs.js';

export const STATUS = Object.freeze({
  OFF: 'off', // signed out
  PENDING: 'pending', // changes waiting for the debounce
  SYNCING: 'syncing',
  SYNCED: 'synced',
  OFFLINE: 'offline', // a sync failed (network, timeout, 5xx); will retry
  UNAVAILABLE: 'unavailable', // 503: sync storage is not available
  ERROR: 'error', // the server refused the request (4xx); not retried automatically
  EXPIRED: 'expired', // 401: the session ended; "Signed out · sign in again"
});

export const DEFAULT_TIMING = Object.freeze({
  debounceMs: 1500,
  pullEveryMs: 30_000,
  retryBaseMs: 2000,
  retryMaxMs: 60_000,
  unavailablePauseMs: 5 * 60_000,
  timeoutMs: 15_000,
  // Browsers cap the bodies of all pending keepalive requests at 64 KiB; above that a normal request
  // is sent instead (it usually still completes when the page is only being hidden).
  keepaliveMaxBytes: 60_000,
  // When a page starts, card states reviewed before the last complete sync minus this margin count as
  // already on the server; newer ones are sent again (harmless: the server merges idempotently).
  ackMarginMs: 60 * 60_000,
});

export const DEFAULT_LIMITS = Object.freeze({
  srsPerRequest: 3000, // the server's maximum (api/sync.js MAX_SRS_PER_REQUEST)
  maxBodyBytes: 900_000, // below the server's 1 MiB body limit
  maxRounds: 50, // requests per syncNow() while card states remain (50 x 3,000 is more than all cards)
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = (text) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length * 3);
const BUCKET = /^\d\d$/;
const COUNTERS = ['r', 'n', 'a', 'ms'];

/** { bucket: rev } from storage or a server answer: only "00" … "31" with integer revs >= 0. */
export function cleanRevs(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const [bucket, rev] of Object.entries(raw)) {
    if (BUCKET.test(bucket) && Number(bucket) < SRS_BUCKETS && Number.isSafeInteger(rev) && rev >= 0) out[bucket] = rev;
  }
  return out;
}

/** Entries of `marks` that differ from `base` (a map the server is known to have). */
function changedSince(base, marks) {
  const out = {};
  for (const [id, entry] of Object.entries(marks)) {
    const was = Object.hasOwn(base, id) ? base[id] : null;
    if (!was || was.m !== entry?.m || was.t !== entry?.t) out[id] = entry;
  }
  return out;
}

/** Days of `stats` that differ from `base` (statistics the server is known to have). */
function changedDays(base, stats) {
  const days = {};
  const before = isObject(base?.days) ? base.days : {};
  for (const [key, day] of Object.entries(isObject(stats?.days) ? stats.days : {})) {
    const was = Object.hasOwn(before, key) ? before[key] : null;
    if (!was || COUNTERS.some((c) => was[c] !== day?.[c])) days[key] = day;
  }
  return { days };
}

const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
/** Same card state (review time, first review, compact card). */
const sameEntry = (a, b) => isObject(a) && isObject(b) && a.t === b.t && (a.f || 0) === (b.f || 0) && sameArray(a.s, b.s);

/**
 * @param {object} options
 * @param {() => { marks: object, settings: object | null, settings_t: number, stats: object, srs: object }} options.getState
 *   the full local state; settings null = never changed on this device (not sent); srs = every card state
 *   (the engine sends only what the server does not have)
 * @param {(state: object) => void} [options.onRemote] merge the server's state into the page:
 *   { marks, settings, settings_t, stats, updated_at, srs? } (srs: the entries of the buckets received)
 * @param {(info: { status: string, email: string | null, lastSynced: number, error: string | null }) => void} [options.onStatus]
 * @param {(email: string) => void} [options.onUnauthorized] the server answered 401: forget the token
 */
export function createSync({
  getState,
  onRemote = () => {},
  onStatus = () => {},
  onUnauthorized = () => {},
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
  random = Math.random,
  isOnline = () => globalThis.navigator?.onLine !== false,
  loadLastSynced = () => 0,
  saveLastSynced = () => {},
  loadRevs = () => ({}),
  saveRevs = () => {},
  syncUrl = 'api/sync',
  loginUrl = 'api/login',
  registerUrl = 'api/register',
  forgotUrl = 'api/forgot',
  timing = {},
  limits = {},
} = {}) {
  const cfg = { ...DEFAULT_TIMING, ...timing };
  const lim = { ...DEFAULT_LIMITS, ...limits };

  let email = null;
  let token = null; // null while signed out or after a 401: no syncing
  let generation = 0; // bumped when the account changes: answers for the previous account are dropped
  let changeCount = 0; // local changes so far
  let syncedCount = 0; // changeCount included in the last complete sync
  let flushedCount = -1; // changeCount of the last flush, so hidden + pagehide flush only once
  let inFlight = null; // promise of the running syncNow loop
  let again = false; // syncNow was called while a request was running
  let debounceTimer = null;
  let retryTimer = null;
  let failures = 0;
  let pausedUntil = 0; // after a 503
  let status = STATUS.OFF;
  let error = null;
  let memoryLastSynced = 0;
  let syncedMarks = {}; // the marks map of the last successful full sync: the server has all of it
  let syncedStats = null; // the statistics of the last successful full sync
  let acked = new Map(); // card id -> the entry the server is known to have
  let seeded = false; // acked was seeded from the last complete sync (once per account)

  const lastSynced = () => Math.max(memoryLastSynced, Number(loadLastSynced()) || 0);
  const hasUnsynced = () => changeCount !== syncedCount;
  const active = () => Boolean(email && token);
  const info = () => ({ status, email, lastSynced: lastSynced(), error });
  const readRevs = () => {
    try {
      return cleanRevs(loadRevs());
    } catch {
      return {};
    }
  };

  function setStatus(next, nextError = null) {
    if (next === status && nextError === error) return;
    status = next;
    error = nextError;
    onStatus(info());
  }

  function stopTimers() {
    if (debounceTimer !== null) clearTimer(debounceTimer);
    if (retryTimer !== null) clearTimer(retryTimer);
    debounceTimer = null;
    retryTimer = null;
  }

  /** POST JSON; never throws. { ok, status (0 = network error / timeout), data } */
  async function post(url, body, { keepalive = false, bearer = null } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimer(() => controller.abort(), cfg.timeoutMs) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        keepalive,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller?.signal,
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      if (timer !== null) clearTimer(timer);
    }
  }

  function scheduleRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    if (!isOnline()) return; // the 'online' event retries
    const base = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** Math.min(failures - 1, 30));
    const delay = Math.min(cfg.retryMaxMs, Math.round(base * (0.8 + 0.4 * random()))); // jitter
    retryTimer = setTimer(() => {
      retryTimer = null;
      syncNow();
    }, delay);
  }

  /** Once per account (the first request): card states reviewed well before the last complete sync
   * (shared by all tabs of this device) are on the server already. Without a complete sync yet (first
   * sign-in on this device) everything is sent. */
  function seedAcks(srs) {
    seeded = true;
    const mark = Number(loadLastSynced()) || 0;
    if (mark <= 0) return;
    const before = mark - cfg.ackMarginMs;
    for (const [id, entry] of Object.entries(srs)) {
      if (!acked.has(id) && isObject(entry) && Number.isSafeInteger(entry.t) && entry.t < before) acked.set(id, entry);
    }
  }

  /**
   * One request: the full marks, statistics and settings (or with `partial` only the marks and days
   * changed since the last full sync: the server merges per item and day, so a partial map is safe) and
   * the card states the server does not have yet, as many as fit. Resolves to { ok, more, ... }: `more`
   * when card states are left to send or to receive, or a bucket must be sent again.
   */
  async function attempt({ keepalive = false, partial = false } = {}) {
    const gen = generation;
    const count = changeCount;
    const used = token;
    const built = now();
    const state = getState() ?? {};
    const srs = isObject(state.srs) ? state.srs : {};
    if (!seeded) seedAcks(srs);
    const marks = isObject(state.marks) ? state.marks : {};
    const stats = isObject(state.stats) ? state.stats : null;
    const revs = readRevs();
    const payload = { marks: partial ? changedSince(syncedMarks, marks) : marks };
    if (state.settings && state.settings_t > 0) {
      payload.settings = state.settings;
      payload.settings_t = state.settings_t;
    }
    if (stats) payload.stats = partial ? changedDays(syncedStats, stats) : stats;
    payload.srs_revs = revs;

    // Card states the server does not have: as many as the request may carry.
    const base = JSON.stringify(payload).length + 10; // + ',"srs":{}'
    const small = keepalive && base <= cfg.keepaliveMaxBytes;
    const budget = small ? cfg.keepaliveMaxBytes : lim.maxBodyBytes;
    const chunk = {};
    let size = base;
    let sent = 0;
    let left = 0;
    for (const [id, entry] of Object.entries(srs)) {
      if (sameEntry(acked.get(id), entry)) continue;
      const piece = id.length + JSON.stringify(entry).length + 4;
      if (sent < lim.srsPerRequest && size + piece <= budget) {
        chunk[id] = entry;
        sent += 1;
        size += piece;
      } else {
        left += 1;
      }
    }
    payload.srs = chunk;

    const body = JSON.stringify(payload);
    setStatus(STATUS.SYNCING);
    const res = await post(syncUrl, body, { keepalive: keepalive && byteLength(body) <= cfg.keepaliveMaxBytes, bearer: used });
    if (gen !== generation) return { ok: false, error: 'stale' }; // signed out (or in as someone else) meanwhile

    const remote = res.ok && res.data && isObject(res.data.state) ? res.data.state : null;
    if (remote) {
      failures = 0;
      pausedUntil = 0;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      // What the server has now: everything sent, and the buckets it answered with.
      for (const [id, entry] of Object.entries(chunk)) acked.set(id, entry);
      const answer = isObject(res.data.srs) ? res.data.srs : {};
      const buckets = isObject(answer.buckets) ? answer.buckets : {};
      const received = {};
      const nextRevs = { ...readRevs() };
      let resend = false;
      for (const [bucket, value] of Object.entries(buckets)) {
        if (!BUCKET.test(bucket) || Number(bucket) >= SRS_BUCKETS || !isObject(value)) continue;
        if (!Number.isSafeInteger(value.rev) || value.rev < 0) continue;
        if (value.rev < (revs[bucket] ?? 0)) {
          // The bucket went back (restored backup, account data deleted and started again): send every
          // card state of this bucket again.
          for (const id of [...acked.keys()]) if (bucketOf(id) === bucket) acked.delete(id);
          resend = true;
        }
        for (const [id, entry] of Object.entries(isObject(value.entries) ? value.entries : {})) {
          received[id] = entry;
          acked.set(id, entry);
        }
        nextRevs[bucket] = value.rev;
      }
      let merged = true;
      try {
        onRemote({ ...remote, srs: Object.keys(received).length ? received : undefined });
      } catch (cause) {
        // A bug in the page must not wedge syncing; the next sync merges again (same revs: the buckets
        // come back).
        merged = false;
        globalThis.console?.error?.('[learn-chinese sync] could not apply synced state', cause);
      }
      if (merged && Object.keys(buckets).length) saveRevs(nextRevs);
      if (!partial) {
        syncedMarks = marks;
        syncedStats = stats;
      }
      const complete = left === 0 && answer.more !== true && !resend;
      if (complete) {
        // Everything this device had when the request was built is on the server now.
        syncedCount = Math.max(syncedCount, count);
        memoryLastSynced = built;
        saveLastSynced(built);
      }
      // Another request right away? Only when it can make progress: card states left that fit (none fit
      // when the rest of the body is already at the limit), buckets left to receive, a bucket to resend.
      const more = merged && ((left > 0 && sent > 0) || answer.more === true || resend);
      if (more && !partial) setStatus(STATUS.SYNCING); // syncNow sends the rest at once
      else setStatus(debounceTimer !== null || !complete ? STATUS.PENDING : STATUS.SYNCED);
      return { ok: true, state: remote, more };
    }

    const code = typeof res.data?.error === 'string' ? res.data.error : res.status ? `http_${res.status}` : 'network';
    if (res.status === 401) {
      // The session ended. Only the first answer for this token acts (several requests may be in flight).
      if (token === used && token !== null) {
        token = null;
        stopTimers();
        failures = 0;
        pausedUntil = 0;
        setStatus(STATUS.EXPIRED, code);
        try {
          onUnauthorized(email);
        } catch (cause) {
          globalThis.console?.error?.('[learn-chinese sync] could not handle the ended session', cause);
        }
      }
      return { ok: false, status: 401, error: code };
    }
    failures += 1;
    if (res.status === 503) {
      pausedUntil = now() + cfg.unavailablePauseMs;
      setStatus(STATUS.UNAVAILABLE, code);
    } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      setStatus(STATUS.ERROR, code); // retrying the same request would fail the same way
    } else {
      setStatus(STATUS.OFFLINE, code); // network error, timeout, 5xx, 429 or an unreadable answer
      scheduleRetry();
    }
    return { ok: false, status: res.status, error: code };
  }

  /** Sync at once (bypasses the 503 pause). Resolves to the result of the last request it ran. */
  function syncNow() {
    if (!active()) return Promise.resolve({ ok: false, error: 'signed_out' });
    stopTimers();
    if (inFlight) {
      again = true; // send again when the running request is done: it may miss the latest changes
      return inFlight;
    }
    const run = (async () => {
      let result;
      let rounds = 0;
      do {
        again = false;
        result = await attempt();
        rounds += 1;
      } while ((again || result.more) && result.ok && active() && rounds < lim.maxRounds);
      if (result.ok && result.more && status === STATUS.SYNCING) setStatus(STATUS.PENDING); // the next sync goes on
      if (inFlight === run) inFlight = null;
      return result;
    })();
    inFlight = run;
    return run;
  }

  return {
    STATUS,
    info,
    hasUnsynced,
    get email() {
      return email;
    },

    /**
     * Start ({ email, token }) or stop (null) syncing. { email, token: null } is an ended session: no
     * syncing, status EXPIRED. Local data is the page's business.
     */
    setAccount(next) {
      const nextEmail = next?.email || null;
      const nextToken = nextEmail ? next.token || null : null;
      if (nextEmail === email && nextToken === token) return;
      email = nextEmail;
      token = nextToken;
      generation += 1;
      stopTimers();
      inFlight = null;
      again = false;
      failures = 0;
      pausedUntil = 0;
      syncedMarks = {};
      syncedStats = null;
      acked = new Map();
      seeded = false;
      changeCount += 1; // whatever this device has is new to the account
      setStatus(!email ? STATUS.OFF : token ? STATUS.PENDING : STATUS.EXPIRED);
    },

    /** The page saved a local change. */
    changed({ quiet = false } = {}) {
      changeCount += 1;
      if (!active() || quiet) return;
      if (now() < pausedUntil) return; // stays "unavailable"; sent with the next sync after the pause
      // Failing already: the pending retry (or the 'online' event) sends this too.
      if (status === STATUS.OFFLINE && (retryTimer !== null || !isOnline())) return;
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        syncNow();
      }, cfg.debounceMs);
      if (!inFlight) setStatus(STATUS.PENDING);
    },

    syncNow,

    /** The page became visible: fetch what other devices changed, at most every pullEveryMs. */
    pull() {
      if (!active() || inFlight || now() < pausedUntil) return;
      if (now() - lastSynced() < cfg.pullEveryMs) return;
      syncNow();
    },

    /** The page is being hidden or unloaded: send unsynced changes now, without waiting. */
    flush() {
      if (!active() || !hasUnsynced() || now() < pausedUntil || flushedCount === changeCount) return;
      flushedCount = changeCount;
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = null;
      // Not through syncNow: a request already running may be cancelled with the page, this one is not.
      attempt({ keepalive: true, partial: true });
    },

    /** The browser is back online. */
    online() {
      if (!active() || now() < pausedUntil) return;
      if (hasUnsynced() || status === STATUS.OFFLINE) syncNow();
    },

    /** POST /api/login { email, password }.
     * { ok: true, email, token, expires_at, created, state } or { ok: false, status, error, retryAfter }. */
    login({ email: address, password }) {
      return signInRequest(loginUrl, { email: address, password });
    },

    /** POST /api/register { email, password, invite_code }: same answers as login. */
    register({ email: address, password, inviteCode }) {
      return signInRequest(registerUrl, { email: address, password, invite_code: inviteCode });
    },

    /** POST /api/forgot { email }: { ok: true } or { ok: false, status, error, retryAfter }. */
    async forgot(address) {
      const res = await post(forgotUrl, JSON.stringify({ email: address }));
      return res.ok && res.data?.ok === true ? { ok: true } : failure(res);
    },
  };

  async function signInRequest(url, body) {
    const res = await post(url, JSON.stringify(body));
    const data = res.data;
    if (res.ok && data && typeof data.email === 'string' && typeof data.token === 'string' && data.token
      && data.state && typeof data.state === 'object') {
      return {
        ok: true,
        email: data.email,
        token: data.token,
        expires_at: Number.isSafeInteger(data.expires_at) ? data.expires_at : 0,
        created: data.created === true,
        state: data.state,
      };
    }
    return failure(res);
  }
}

/** { ok: false, status, error, retryAfter } from a failed post(); retryAfter in seconds or null. */
function failure(res) {
  const data = res.data;
  const code = typeof data?.error === 'string' ? data.error : res.status ? `http_${res.status}` : 'network';
  const retryAfter = Number.isFinite(data?.retry_after) && data.retry_after >= 0 ? data.retry_after : null;
  return { ok: false, status: res.status, error: code, retryAfter };
}
