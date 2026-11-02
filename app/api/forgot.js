// POST /api/forgot { email } -> 200 { ok: true }
//
// No email is sent: the accounts service only marks the account "reset requested", which the admin
// sees in the admin panel and answers by sending the person a reset link personally. The answer is the
// same for unknown emails (nothing to learn about who has an account). Errors: 400 invalid_email,
// 429 rate_limited (+ retry_after), 503 accounts_unavailable.

import { AUTH_BODY_BYTES, accountsFromEnv, clientIp } from './_lib/accounts.js';
import { json, methodNotAllowed, postHandler, readJsonBody } from './_lib/http.js';

export const POST = postHandler(async (request) => {
  const body = await readJsonBody(request, AUTH_BODY_BYTES);
  await accountsFromEnv().forgot({ email: body.email }, clientIp(request));
  return json(200, { ok: true });
});

export {
  methodNotAllowed as GET,
  methodNotAllowed as HEAD,
  methodNotAllowed as PUT,
  methodNotAllowed as PATCH,
  methodNotAllowed as DELETE,
  methodNotAllowed as OPTIONS,
};
