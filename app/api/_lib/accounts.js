// Client for the accounts service (the reference project's apps/accounts, its own deployment), server
// to server. Ported unchanged in behaviour from the reference (Inburgering flashcards, api/_lib/accounts.js).
//
// Browsers only ever talk to this site (CSP connect-src 'self', no CORS): /api/login, /api/register and
// /api/forgot forward to the accounts service, and /api/sync checks the browser's session token with
// the service's /api/verify. Every call carries the shared secret ACCOUNTS_SERVICE_KEY in
// X-Accounts-Service-Key and the browser's IP in X-Accounts-Client-IP (the service rate-limits per IP).
//
// Answers: the service's 4xx { error, retry_after? } are passed through with the same status (wrong
// password, invite code, lockout, rate limit…), and so is 503 registration_closed (sign-up has no invite
// code set); network errors, timeouts, 5xx, unreadable answers and a
// rejected service key become 503 accounts_unavailable. Without ACCOUNTS_URL / ACCOUNTS_SERVICE_KEY the
// app still works anonymously and these endpoints answer 503 accounts_unavailable.
//
// Logs never contain emails, passwords, tokens or IPs: only error codes, statuses, class names and the
// names (never values) of missing variables.

import { createHash, timingSafeEqual } from 'node:crypto';

import { HttpError } from './http.js';
import { normalizeEmail } from '../../src/lib/marks.js';

export const SERVICE_KEY_MIN_LENGTH = 32;
export const ACCOUNTS_TIMEOUT_MS = 8000;
/** Successful token checks are remembered this long per function instance (sync runs often). */
export const VERIFY_CACHE_MS = 60_000;
/**
 * The cache time actually used: LEARN_CHINESE_VERIFY_CACHE_MS (0 to 600000 ms) when set, else 60 s.
 * Only for tests and local checks (e.g. 0 to see a revoked token fail at once); leave it unset in production.
 */
export function verifyCacheMs(env = process.env) {
  const raw = env.LEARN_CHINESE_VERIFY_CACHE_MS;
  if (raw === undefined || raw === '') return VERIFY_CACHE_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 600_000 ? value : VERIFY_CACHE_MS;
}
export const VERIFY_CACHE_MAX = 1000;
/** Bodies of /api/login, /api/register, /api/forgot are tiny; anything bigger is not a real request. */
export const AUTH_BODY_BYTES = 16 * 1024;

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** 5xx answers of the service that are about the request, not an outage: passed through like a 4xx. */
const PASS_THROUGH_5XX = new Set(['registration_closed']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest();

const unavailable = () => new HttpError(503, 'accounts_unavailable');

/** { url, serviceKey } from the environment, or { missing: [variable names] }. */
export function accountsConfig(env = process.env) {
  const missing = [];
  let url = null;
  try {
    const parsed = new URL(env.ACCOUNTS_URL ?? '');
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href.replace(/\/+$/, '');
  } catch {
    // reported below
  }
  if (!url) missing.push('ACCOUNTS_URL');
  const serviceKey = env.ACCOUNTS_SERVICE_KEY ?? '';
  if (serviceKey.length < SERVICE_KEY_MIN_LENGTH) missing.push('ACCOUNTS_SERVICE_KEY');
  return missing.length ? { missing } : { url, serviceKey };
}

/** The browser's IP, as the platform reports it (Vercel sets x-real-ip and x-forwarded-for). */
export function clientIp(request) {
  const real = request.headers.get('x-real-ip')?.trim();
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = real || forwarded || 'unknown';
  return ip.slice(0, 100);
}

/**
 * @param {{ url: string, serviceKey: string, fetch?: typeof fetch, timeoutMs?: number }} options
 * Each method resolves to the service's JSON answer or throws an HttpError (see the top of the file).
 */
export function createAccountsClient({ url, serviceKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = ACCOUNTS_TIMEOUT_MS }) {
  const base = String(url).replace(/\/+$/, '');

  async function call(name, body, ip = 'unknown') {
    let response;
    try {
      response = await fetchImpl(`${base}/api/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Accounts-Service-Key': serviceKey,
          'X-Accounts-Client-IP': ip,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[learn-chinese api] accounts ${name} request failed (${error?.name ?? 'error'})`);
      throw unavailable();
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // handled below
    }
    if (response.ok && isObject(data)) return data;
    const code = isObject(data) && typeof data.error === 'string' && ERROR_CODE.test(data.error) ? data.error : null;
    const passThrough = (response.status >= 400 && response.status < 500) || PASS_THROUGH_5XX.has(code);
    if (passThrough && code && code !== 'unauthorized_service') {
      const extra = {};
      const headers = {};
      let retry = Number(data.retry_after);
      if (!(Number.isFinite(retry) && retry >= 0)) retry = Number(response.headers.get('retry-after') ?? NaN);
      if (Number.isFinite(retry) && retry >= 0) {
        extra.retry_after = Math.ceil(retry);
        headers['Retry-After'] = String(extra.retry_after);
      }
      throw new HttpError(response.status, code, { extra, headers });
    }
    const why = code === 'unauthorized_service' ? ', service key rejected: check ACCOUNTS_SERVICE_KEY' : code ? ` ${code}` : '';
    console.error(`[learn-chinese api] accounts ${name} failed (HTTP ${response.status}${why})`);
    throw unavailable();
  }

  return {
    url: base,
    login: ({ email, password }, ip) => call('login', { email, password, audience: 'app' }, ip),
    register: ({ email, password, invite_code: inviteCode }, ip) => call('register', { email, password, invite_code: inviteCode }, ip),
    forgot: ({ email }, ip) => call('forgot', { email }, ip),
    verify: (token, ip) => call('verify', { token, audience: 'app' }, ip),
  };
}

/** The client for this environment, or 503 accounts_unavailable when it is not configured. */
export function accountsFromEnv(env = process.env, { fetch } = {}) {
  const config = accountsConfig(env);
  if (config.missing) {
    console.error(`[learn-chinese api] accounts not configured: set ${config.missing.join(' and ')}`);
    throw unavailable();
  }
  return createAccountsClient({ ...config, fetch });
}

/** { email, token, expires_at } from a login / register answer of the service. */
export function sessionFrom(data) {
  const email = normalizeEmail(data?.email);
  const token = typeof data?.token === 'string' && data.token ? data.token : null;
  const expiresAt = Number.isSafeInteger(data?.expires_at) ? data.expires_at : null;
  if (!email || !token || expiresAt === null) {
    console.error('[learn-chinese api] accounts answered without a session');
    throw unavailable();
  }
  return { email, token, expires_at: expiresAt };
}

/**
 * Remembers successful token checks for `ttlMs` (at most `max` tokens, oldest dropped first). Keys are
 * SHA-256 hashes of the tokens, so the cache never holds a token itself. Failures are not cached.
 */
export function createVerifier({ ttlMs = VERIFY_CACHE_MS, max = VERIFY_CACHE_MAX, now = Date.now } = {}) {
  const cache = new Map(); // sha256(token) hex -> { email, until }
  return {
    /** The email the token belongs to; throws the client's HttpError otherwise. */
    async verify(token, client, ip, options) {
      return (await this.check(token, client, ip, options)).email;
    },
    /** { email, cached }: `cached` when the answer came from the cache. `fresh` skips the cache (the
     * service is asked, and a success is cached again). */
    async check(token, client, ip, { fresh = false } = {}) {
      const key = sha256(token).toString('hex');
      const hit = cache.get(key);
      if (!fresh && hit && hit.until > now()) return { email: hit.email, cached: true };
      cache.delete(key);
      const data = await client.verify(token, ip);
      const email = normalizeEmail(data.email);
      if (!email) {
        console.error('[learn-chinese api] accounts verify answered without an email');
        throw unavailable();
      }
      cache.set(key, { email, until: now() + ttlMs });
      while (cache.size > max) cache.delete(cache.keys().next().value);
      return { email, cached: false };
    },
    /** Forget every cached token of `email` (its record was just deleted). */
    forgetEmail(email) {
      for (const [key, entry] of cache) if (entry.email === email) cache.delete(key);
    },
    clear() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
  };
}

const verifier = createVerifier({ ttlMs: verifyCacheMs() });

/** Empty this instance's token cache (tests). */
export const clearVerifyCache = () => verifier.clear();
/** Only this function instance's cache: on Vercel every api/*.js is its own function with its own
 * instances, so /api/sync may still hold the token (sync.js re-checks before creating a record). */
export const forgetVerifiedEmail = (email) => verifier.forgetEmail(email);

/** The bearer token of a request, or 401 unauthorized. */
export function bearerToken(request) {
  const match = /^Bearer[ ]+([^\s]{1,4096})$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new HttpError(401, 'unauthorized');
  return match[1];
}

/**
 * { email, cached } for a request (Authorization: Bearer <token>, checked with the accounts service):
 * `cached` when the check came from this instance's cache (up to VERIFY_CACHE_MS old); `fresh: true`
 * always asks the service. Missing, invalid or expired token -> 401 unauthorized; service down or not
 * configured -> 503.
 */
export async function authenticate(request, env = process.env, { fresh = false } = {}) {
  const token = bearerToken(request);
  const client = accountsFromEnv(env);
  try {
    return await verifier.check(token, client, clientIp(request), { fresh });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // The service refused the token (invalid, expired, signed out everywhere, account disabled or deleted).
    if ([400, 401, 403].includes(error.status)) throw new HttpError(401, 'unauthorized');
    // Anything else (e.g. 429) is not the browser's fault: never sign it out for that.
    if (error.status !== 503) console.error(`[learn-chinese api] accounts verify answered ${error.status} ${error.code}`);
    throw new HttpError(503, 'accounts_unavailable');
  }
}

/** Constant-time comparison of two strings of any length (both hashed first). */
export function sameSecret(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** For /api/service: the request must carry our ACCOUNTS_SERVICE_KEY (401 unauthorized_service);
 * without a key configured the endpoint is off (503 accounts_not_configured). */
export function requireServiceKey(request, env = process.env) {
  const key = env.ACCOUNTS_SERVICE_KEY ?? '';
  if (key.length < SERVICE_KEY_MIN_LENGTH) {
    console.error('[learn-chinese api] service endpoint not configured: set ACCOUNTS_SERVICE_KEY');
    throw new HttpError(503, 'accounts_not_configured');
  }
  const given = request.headers.get('x-accounts-service-key');
  if (!given || !sameSecret(given, key)) throw new HttpError(401, 'unauthorized_service');
}
