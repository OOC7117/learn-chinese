// POST /api/login { email, password } -> 200 { email, token, expires_at, created, state }
//
// Checks the password with the accounts service (the reference project's apps/accounts, see
// _lib/accounts.js), then opens this app's record for that email, creating it if needed. `token` is the
// session token the browser sends to /api/sync as `Authorization: Bearer <token>`; `state` = { marks,
// settings, settings_t, stats, updated_at }, which the browser merges into what it has and then pushes
// back with /api/sync (card states come with that first sync, per bucket).
// The service's errors pass through: 401 invalid_credentials, 403 account_disabled, 423 account_locked
// (+ retry_after), 429 rate_limited (+ retry_after), 400 invalid_email; 503 accounts_unavailable.

import { AUTH_BODY_BYTES, accountsFromEnv, clientIp, sessionFrom } from './_lib/accounts.js';
import { json, methodNotAllowed, postHandler, readJsonBody } from './_lib/http.js';
import { openRecord } from './_lib/users.js';

export const POST = postHandler(async (request) => {
  const body = await readJsonBody(request, AUTH_BODY_BYTES);
  const accounts = accountsFromEnv();
  const session = sessionFrom(await accounts.login({ email: body.email, password: body.password }, clientIp(request)));
  const { created, state } = await openRecord(session.email);
  return json(200, { ...session, created, state });
});

export {
  methodNotAllowed as GET,
  methodNotAllowed as HEAD,
  methodNotAllowed as PUT,
  methodNotAllowed as PATCH,
  methodNotAllowed as DELETE,
  methodNotAllowed as OPTIONS,
};
