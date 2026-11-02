// Key-value store adapter for the API: get(key) -> object | null, set(key, object[, { nx }]) -> boolean,
// update(key, fn) for read-merge-write without losing a concurrent request's write (see below),
// delete(key) -> boolean, deleteMany(keys) -> number, getMany(keys) -> [object | null] and
// list(prefix) -> keys (for /api/service). Ported from the reference project (Inburgering flashcards,
// api/_lib/store.js); deleteMany is new (delete-user removes a record and its 32 card-state buckets).
// Files and folders starting with "_" inside api/ are not turned into Vercel functions.
//
// Backend, chosen per request from the environment (see storeFromEnv):
//   1. Upstash Redis over its REST API, when KV_REST_API_URL + KV_REST_API_TOKEN (names used by the
//      Vercel Marketplace Upstash integration) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
//   2. Otherwise, off Vercel, JSON files in LEARN_CHINESE_DATA_DIR (default app/.data/, gitignored).
//   3. On Vercel without Redis: StorageUnavailable (the API answers 503).
// LEARN_CHINESE_STORE=file|redis forces a backend (the dev server sets "file" so a shell with production
// Redis variables never writes to production by accident).

import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../.data/', import.meta.url));

/** update() gives up after this many tries when other requests keep writing the same key. */
export const UPDATE_ATTEMPTS = 5;

// Compare-and-set: write ARGV[2] only if the key still holds ARGV[1] (the raw value read before; '' =
// missing, which no stored JSON record equals). Returns 1 when written, 0 when someone wrote first.
const CAS_SCRIPT = "local cur = redis.call('GET', KEYS[1]) or '' "
  + "if cur == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0";

/** SCAN batch size for list(). */
export const SCAN_COUNT = 500;

/** A SCAN MATCH pattern for keys starting with `prefix` (glob characters in it matched literally). */
export function prefixPattern(prefix) {
  return `${String(prefix).replace(/[*?[\]\\]/g, '\\$&')}*`;
}

/** The store cannot be reached or is not configured. The API maps it to 503. */
export class StorageUnavailable extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StorageUnavailable';
  }
}

/** Upstash Redis REST: each command is POSTed as a JSON array, e.g. ["GET", key]. */
export function createRedisStore({ url, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const endpoint = String(url).replace(/\/+$/, '');

  async function command(args) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new StorageUnavailable(`redis ${args[0]} request failed (${error?.name ?? 'error'})`);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // handled below
    }
    if (!response.ok || !payload || typeof payload !== 'object' || 'error' in payload) {
      // Not echoing payload.error: keep logs free of anything user-derived.
      throw new StorageUnavailable(`redis ${args[0]} failed (HTTP ${response.status})`);
    }
    return payload.result;
  }

  return {
    kind: 'redis',
    async get(key) {
      const raw = await command(['GET', key]);
      return raw === null || raw === undefined ? null : parseRecord(raw);
    },
    /** With { nx: true } it writes only if the key does not exist yet; returns whether it wrote. */
    async set(key, value, { nx = false } = {}) {
      const args = ['SET', key, JSON.stringify(value)];
      if (nx) args.push('NX');
      return (await command(args)) === 'OK';
    },
    /**
     * Read, let `fn(current)` return the next object (or null: nothing to write), write it only if
     * nobody else wrote in between, else start over with the newer value. The API's merges are CRDTs,
     * so redoing them on newer data is always safe.
     */
    async update(key, fn) {
      for (let i = 0; i < UPDATE_ATTEMPTS; i += 1) {
        const raw = await command(['GET', key]);
        const current = raw === null || raw === undefined ? null : parseRecord(raw);
        const next = await fn(current);
        if (next === null || next === undefined) return;
        if (await command(['EVAL', CAS_SCRIPT, '1', key, raw ?? '', JSON.stringify(next)]) === 1) return;
      }
      throw new StoreConflict();
    },
    /** Remove a key; returns whether it existed. */
    async delete(key) {
      return Number(await command(['DEL', key])) > 0;
    },
    /** Remove several keys in one round trip (DEL k1 k2 …); returns how many existed. */
    async deleteMany(keys) {
      if (keys.length === 0) return 0;
      return Number(await command(['DEL', ...keys])) || 0;
    },
    /** Several records in one round trip (MGET), in the order of `keys`; null for missing ones. */
    async getMany(keys) {
      if (keys.length === 0) return [];
      const raws = await command(['MGET', ...keys]);
      if (!Array.isArray(raws) || raws.length !== keys.length) throw new StorageUnavailable('redis MGET returned an unexpected answer');
      return raws.map((raw) => (raw === null || raw === undefined ? null : parseRecord(raw)));
    },
    /** Every key starting with `prefix`, sorted. SCAN walks the keyspace in batches without blocking
     * Redis; it may return a key twice, hence the Set. */
    async list(prefix) {
      const pattern = prefixPattern(prefix);
      const keys = new Set();
      let cursor = '0';
      do {
        const answer = await command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(SCAN_COUNT)]);
        if (!Array.isArray(answer) || !Array.isArray(answer[1])) throw new StorageUnavailable('redis SCAN returned an unexpected answer');
        cursor = String(answer[0]);
        for (const key of answer[1]) if (typeof key === 'string' && key.startsWith(prefix)) keys.add(key);
      } while (cursor !== '0');
      return [...keys].sort();
    },
  };
}

/** update() kept losing the race (answered as a 500, which the browser retries with backoff). */
export class StoreConflict extends Error {
  constructor() {
    super('store update kept conflicting');
    this.name = 'StoreConflict';
  }
}

// File store updates (and deletes) of one file run one after another (the dev server is a single process).
const fileQueues = new Map(); // file path -> promise of the last queued task

/** Run `task` after every task already queued for `file`; resolves to its result. */
function queued(file, task) {
  const run = (fileQueues.get(file) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  fileQueues.set(file, tail);
  tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file);
  });
  return run;
}

/** Any string is a safe, unique file name once percent-encoded (encodeURIComponent leaves !'()* alone). */
function fileName(key) {
  const encoded = encodeURIComponent(key).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${encoded}.json`;
}

/** One JSON file per key. Writes go to a temp file first, then rename (atomic): a crash or a
 * concurrent read never sees half a record. */
export function createFileStore(dir = DEFAULT_DATA_DIR) {
  const fileFor = (key) => join(dir, fileName(key));
  const tempFor = (file) => `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

  const store = {
    kind: 'file',
    dir,
    async get(key) {
      let raw;
      try {
        raw = await readFile(fileFor(key), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new StorageUnavailable(`file store read failed (${error?.code ?? 'error'})`);
      }
      return parseRecord(raw);
    },
    async set(key, value, { nx = false } = {}) {
      const file = fileFor(key);
      const temp = tempFor(file);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(temp, JSON.stringify(value));
        if (!nx) {
          await rename(temp, file);
          return true;
        }
        // link() fails if the target exists, so "create only if absent" stays atomic.
        try {
          await link(temp, file);
          return true;
        } catch (error) {
          if (error?.code === 'EEXIST') return false;
          throw error;
        } finally {
          await unlink(temp).catch(() => {});
        }
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw new StorageUnavailable(`file store write failed (${error?.code ?? 'error'})`);
      }
    },
    /** See the Redis store; here concurrent updates of a key are queued instead of retried. */
    update(key, fn) {
      return queued(fileFor(key), async () => {
        const next = await fn(await store.get(key));
        if (next !== null && next !== undefined) await store.set(key, next);
      });
    },
    delete(key) {
      return queued(fileFor(key), async () => {
        try {
          await unlink(fileFor(key));
          return true;
        } catch (error) {
          if (error?.code === 'ENOENT') return false;
          throw new StorageUnavailable(`file store delete failed (${error?.code ?? 'error'})`);
        }
      });
    },
    async deleteMany(keys) {
      const deleted = await Promise.all(keys.map((key) => store.delete(key)));
      return deleted.filter(Boolean).length;
    },
    getMany(keys) {
      return Promise.all(keys.map((key) => store.get(key)));
    },
    /** Keys of the files in the folder (temp files and other names that are not ours are skipped). */
    async list(prefix) {
      let names;
      try {
        names = await readdir(dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw new StorageUnavailable(`file store list failed (${error?.code ?? 'error'})`);
      }
      const keys = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        let key;
        try {
          key = decodeURIComponent(name.slice(0, -'.json'.length));
        } catch {
          continue;
        }
        if (key.startsWith(prefix) && fileName(key) === name) keys.push(key);
      }
      return keys.sort();
    },
  };
  return store;
}

// Our own message: V8's JSON errors quote the input, which could put an email into the logs.
function parseRecord(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('stored record is not valid JSON');
  }
}

function redisConfig(env) {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN };
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
  }
  return null;
}

/** The store for this environment. Cheap (no I/O), so handlers call it per request. */
export function storeFromEnv(env = process.env, { fetch } = {}) {
  const forced = env.LEARN_CHINESE_STORE;
  const redis = redisConfig(env);
  if (forced === 'file') return createFileStore(env.LEARN_CHINESE_DATA_DIR || DEFAULT_DATA_DIR);
  if (redis) return createRedisStore({ ...redis, fetch });
  if (forced === 'redis') throw new StorageUnavailable('LEARN_CHINESE_STORE=redis but no Redis REST URL/token is set');
  // Vercel's filesystem is read-only and not shared between instances: never fall back to files there.
  if (env.VERCEL) throw new StorageUnavailable('no storage configured (add Upstash Redis to the Vercel project)');
  return createFileStore(env.LEARN_CHINESE_DATA_DIR || DEFAULT_DATA_DIR);
}
