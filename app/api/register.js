// POST /api/register { email, password, invite_code } -> 200 { email, token, expires_at, created, state }
//
// Creates the account with the accounts service (which checks the invitation code), then opens this
// app's record exactly like /api/login. The service's errors pass through: 400 invalid_email |
// invalid_password, 403 invalid_invite_code, 409 email_taken, 503 registration_closed, 429 rate_limited
// (+ retry_after); 503 accounts_unavailable when the service cannot be reached.

import { AUTH_BODY_BYTES, accountsFromEnv, clientIp, sessionFrom } from './_lib/accounts.js';
import { json, methodNotAllowed, postHandler, readJsonBody } from './_lib/http.js';
import { openRecord } from './_lib/users.js';

export const POST = postHandler(async (request) => {
  const body = await readJsonBody(request, AUTH_BODY_BYTES);
  const accounts = accountsFromEnv();
  const answer = await accounts.register(
    { email: body.email, password: body.password, invite_code: body.invite_code },
    clientIp(request),
  );
  const session = sessionFrom(answer);
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
