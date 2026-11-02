// Request/response helpers shared by the API handlers (web-standard Request/Response).
// Ported from the reference project (Inburgering flashcards, api/_lib/http.js); only the body limit and
// the log prefix differ.

import { StorageUnavailable } from './store.js';

/** /api/sync bodies: the full marks map, the statistics and at most 3,000 card states (~400 KB). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** An expected failure with a status and a stable error code: answered as { error: code, ...extra }
 * (e.g. { retry_after }), with optional response `headers` (e.g. Retry-After). */
export class HttpError extends Error {
  constructor(status, code, { extra = {}, headers = {} } = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store', // per-user data: never cached by browsers or the CDN
  'X-Content-Type-Options': 'nosniff',
});

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/** Exported as GET/PUT/... by each endpoint: everything except POST is answered with 405. */
export function methodNotAllowed() {
  return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
}

/** Read at most `limit` bytes; the body may be streamed without a Content-Length, so count as we go. */
async function readLimited(stream, limit) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parse a JSON object body: 413 when larger than `limit`, 400 when it is not a JSON object. */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'body_too_large');
  const bytes = await readLimited(request.body, limit);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json');
  return value;
}

/**
 * Wrap an endpoint so every failure becomes a JSON response. Logs never contain request data (emails
 * in particular): only our own error codes and the error's class name.
 */
export function postHandler(fn) {
  return async function POST(request) {
    if (request.method !== 'POST') return methodNotAllowed();
    try {
      return await fn(request);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { ...error.extra, error: error.code }, error.headers);
      if (error instanceof StorageUnavailable) {
        console.error(`[learn-chinese api] storage unavailable: ${error.message}`);
        return json(503, { error: 'storage_unavailable' });
      }
      console.error(`[learn-chinese api] unexpected ${error?.name ?? 'error'}`);
      return json(500, { error: 'internal' });
    }
  };
}
