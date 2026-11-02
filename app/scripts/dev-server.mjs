// Local development server (no dependencies): serves the static site and runs the api/*.js handlers the
// way Vercel does, so sign-in and sync work locally. Ported from the reference project (Inburgering
// flashcards, scripts/dev-server.mjs). Records go to the JSON file store (LEARN_CHINESE_DATA_DIR or
// app/.data/), never to a Redis database configured in the shell.
// Sign-in needs the accounts dev server too (the reference project's apps/accounts,
// http://127.0.0.1:4175/): unless set, the accounts URL and service key default to that server and its
// dev service key.
//
//   node scripts/dev-server.mjs          (or: npm run dev)   -> http://127.0.0.1:4176/
//   PORT=8080 node scripts/dev-server.mjs                    (PORT=0 picks a free port)
//
// It also sends the headers from vercel.json (CSP included), so CSP problems show up locally too, and
// answers byte ranges for static files (Safari asks for ranges before it plays audio).

import { readFileSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_PORT = 4176;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Top-level folders that are code, not site. Dot-files and dot-folders (.data, .gitignore) are never served.
const PRIVATE_DIRS = new Set(['api', 'scripts', 'tests', 'node_modules']);

/** Defaults for the accounts service when the shell does not set them (never used on Vercel). The
 * accounts dev server (reference project, apps/accounts) uses the same URL and dev-only key. */
export const DEV_ACCOUNTS_URL = 'http://127.0.0.1:4175';
export const DEV_SERVICE_KEY = 'dev-service-key-dev-service-key-0000';

/** vercel.json "headers" rules as [{ pattern, headers }]. Their sources here are plain regexes. */
function loadHeaderRules(root) {
  try {
    const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    return (config.headers ?? []).flatMap((rule) => {
      try {
        return [{ pattern: new RegExp(`^${rule.source}$`), headers: rule.headers ?? [] }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function configHeaders(rules, pathname) {
  const out = {};
  for (const rule of rules) if (rule.pattern.test(pathname)) for (const { key, value } of rule.headers) out[key] = value;
  return out;
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

// /api/<name> -> api/<name>.js, like Vercel; names starting with "_" (api/_lib) are not endpoints.
const API_ROUTE = /^\/api\/([a-z0-9][a-z0-9-]*)$/;

async function loadApi(root, name) {
  const file = join(root, 'api', `${name}.js`);
  try {
    if (!(await stat(file)).isFile()) return null;
  } catch {
    return null;
  }
  return import(pathToFileURL(file).href);
}

// The body is read here in full, not streamed to the handler: an early answer (413) on a half-read
// upload would otherwise leave bytes on the keep-alive socket and stall the browser's next request.
// Bytes past this cap (above what any handler accepts) are read and dropped.
const KEEP_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let kept = 0;
    req.on('data', (chunk) => {
      if (kept >= KEEP_BODY_BYTES) return;
      chunks.push(chunk);
      kept += chunk.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build a web Request from the Node request, call the handler, write its Response back. */
async function serveApi(req, res, mod, origin, extraHeaders) {
  const handler = mod[req.method];
  if (typeof handler !== 'function') {
    res.writeHead(405, { ...extraHeaders, Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // Vercel tells functions the browser's IP in x-real-ip (used for the accounts service's rate limits).
  if (!headers.has('x-real-ip') && req.socket.remoteAddress) headers.set('x-real-ip', req.socket.remoteAddress);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(new URL(req.url, origin), {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
  });
  const response = await handler(request);
  const body = Buffer.from(await response.arrayBuffer());
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.statusCode = response.status;
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** [start, end] (inclusive) of a single "bytes=a-b" range within `size`; null = no usable Range header,
 * false = not satisfiable. */
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2])); // the last n bytes
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : false;
}

async function serveStatic(req, res, pathname, root, extraHeaders) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request\n');
  }
  if (path.endsWith('/')) path += 'index.html';
  const segments = path.split('/').filter(Boolean);
  const hidden = segments.some((s) => s.startsWith('.') || s.includes('\\') || s.includes('\0'));
  if (hidden || segments.length === 0 || PRIVATE_DIRS.has(segments[0])) return sendText(res, 404, 'Not found\n');
  let file = join(root, ...segments);
  let data;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    data = await readFile(file);
  } catch {
    return sendText(res, 404, 'Not found\n');
  }
  const headers = {
    ...extraHeaders,
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', // always fresh while developing
  };
  const range = byteRange(req.headers.range, data.byteLength);
  if (range === false) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.byteLength}`, 'Content-Length': 0 });
    return res.end();
  }
  if (range) {
    const [start, end] = range;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.byteLength}`, 'Content-Length': end - start + 1 });
    return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.byteLength });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/** Start the server; resolves to { server, url } once it listens. */
export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', root = ROOT } = {}) {
  const rules = loadHeaderRules(root);
  let origin = `http://${host}:${port}`;

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, origin);
      const extraHeaders = configHeaders(rules, pathname);
      const route = API_ROUTE.exec(pathname);
      if (route) {
        const mod = await loadApi(root, route[1]);
        if (mod) return await serveApi(req, res, mod, origin, extraHeaders);
        return sendText(res, 404, 'Not found\n', extraHeaders);
      }
      if (pathname.startsWith('/api/')) return sendText(res, 404, 'Not found\n', extraHeaders);
      return await serveStatic(req, res, pathname, root, extraHeaders);
    } catch (error) {
      console.error(`[dev-server] ${req.method} request failed: ${error?.name ?? 'error'}`);
      if (!res.headersSent) sendText(res, 500, 'Internal error\n');
      else res.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      origin = `http://${host}:${server.address().port}`;
      resolve({ server, url: `${origin}/` });
    });
  });
}

function isDirectRun(scriptPath = process.argv[1]) {
  try {
    return Boolean(scriptPath) && realpathSync(scriptPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.env.LEARN_CHINESE_STORE ??= 'file';
  process.env.ACCOUNTS_URL ||= DEV_ACCOUNTS_URL;
  process.env.ACCOUNTS_SERVICE_KEY ||= DEV_SERVICE_KEY;
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT must be a number from 0 to 65535 (got ${JSON.stringify(process.env.PORT)}).`);
    process.exit(1);
  }
  const { storeFromEnv } = await import('../api/_lib/store.js');
  try {
    const { url } = await startServer({ port });
    const store = storeFromEnv();
    console.log(`Learn Chinese dev server: ${url}`);
    console.log(`Learn Chinese records: ${store.kind === 'file' ? `JSON files in ${store.dir}` : store.kind}.`);
    // The URL only: the service key is a secret and is never printed.
    const keySource = process.env.ACCOUNTS_SERVICE_KEY === DEV_SERVICE_KEY ? 'dev default' : 'from the environment';
    console.log(`Accounts service: ${process.env.ACCOUNTS_URL} (service key: ${keySource}). Sign-in needs it running: cd apps/accounts && npm run dev (reference project)`);
    console.log('Ctrl+C to stop.');
  } catch (error) {
    console.error(error?.code === 'EADDRINUSE' ? `Port ${port} is already in use; try PORT=${port + 1} npm run dev` : error);
    process.exit(1);
  }
}
