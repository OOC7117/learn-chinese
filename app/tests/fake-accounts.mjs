// A stand-in for the accounts service (the reference project's apps/accounts) for the API tests: a real
// HTTP server on 127.0.0.1 with the same endpoints, answers and service-key check, keeping users and
// tokens in memory. Ported from the reference (Inburgering flashcards, tests/fake-accounts.mjs).
// Not a test file itself (tests/index.js loads *.test.mjs only).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const SERVICE_KEY = 'test-service-key-test-service-key-0000';
export const INVITE_CODE = '010101';

const DAY = 24 * 60 * 60;

/**
 * Start the fake. `mode` switches failures for every request: 'down' (500 JSON), 'html' (502 HTML page).
 * Special emails: locked@example.com -> 423 + retry_after 840; limited@example.com -> 429 with only a
 * Retry-After header.
 */
export async function startFakeAccounts() {
  const users = new Map(); // email -> { password, resetRequested }
  const tokens = new Map(); // token -> email
  const calls = []; // { name, body, headers }
  const fake = { users, tokens, calls, mode: null, url: null };

  const issue = (email) => {
    const token = `v1.${randomBytes(12).toString('base64url')}.sig`;
    tokens.set(token, email);
    return { email, token, expires_at: Math.floor(Date.now() / 1000) + 30 * DAY };
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      // stays {}
    }
    const name = new URL(req.url, 'http://x').pathname.replace(/^\/api\//, '');
    calls.push({ name, body, headers: req.headers });
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (fake.mode === 'down') return send(500, { error: 'internal' });
    if (fake.mode === 'html') {
      res.writeHead(502, { 'content-type': 'text/html' });
      return res.end('<html><body>Bad gateway</body></html>');
    }
    if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
    if (req.headers['x-accounts-service-key'] !== SERVICE_KEY) return send(401, { error: 'unauthorized_service' });

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    switch (name) {
      case 'register':
        if (!validEmail) return send(400, { error: 'invalid_email' });
        if (typeof body.password !== 'string' || [...body.password].length < 8) return send(400, { error: 'invalid_password' });
        if (body.invite_code !== INVITE_CODE) return send(403, { error: 'invalid_invite_code' });
        if (users.has(email)) return send(409, { error: 'email_taken' });
        users.set(email, { password: body.password, resetRequested: false });
        return send(201, issue(email));
      case 'login':
        if (email === 'locked@example.com') return send(423, { error: 'account_locked', retry_after: 840 });
        if (email === 'limited@example.com') return send(429, { error: 'rate_limited' }, { 'Retry-After': '120' });
        if (body.audience !== 'app') return send(400, { error: 'invalid_audience' });
        if (!users.has(email) || users.get(email).password !== body.password) return send(401, { error: 'invalid_credentials' });
        return send(200, { ...issue(email), admin: false });
      case 'forgot':
        if (!validEmail) return send(400, { error: 'invalid_email' });
        if (users.has(email)) users.get(email).resetRequested = true;
        return send(200, { ok: true });
      case 'verify': {
        const owner = tokens.get(body.token);
        if (!owner) return send(401, { error: 'invalid_token' });
        return send(200, { email: owner, admin: false, audience: 'app' });
      }
      default:
        return send(404, { error: 'not_found' });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
  /** A valid token for `email` without going through register (the account exists at the service). */
  fake.tokenFor = (email) => issue(email).token;
  /** The service no longer accepts the token (expired, signed out everywhere, deleted account). */
  fake.revoke = (token) => tokens.delete(token);
  fake.callsTo = (name) => calls.filter((c) => c.name === name);
  return fake;
}
