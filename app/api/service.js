// POST /api/service { action, ... }: called by the accounts service's admin panel, server to server.
// Header X-Accounts-Service-Key must equal ACCOUNTS_SERVICE_KEY (else 401 unauthorized_service; without a
// key configured the endpoint is off: 503 accounts_not_configured).
//
//   { action: 'stats' }
//     -> { app: 'learn-chinese', users_with_data, total_starred, total_skipped, total_reviews,
//          top_starred: [{ id, hanzi, pinyin, meaning, count }] (20), top_skipped: [...] (20) }
//        users_with_data = records with at least one starred or skipped item or one answered card;
//        total_reviews = cards answered, summed over every study day of every record. Only items the site
//        has are counted; "most starred" are the words learners find hardest.
//   { action: 'delete-user', email } -> { deleted: boolean }   (the account was deleted in the admin panel)
//        Removes the record and all 32 card-state buckets; deleted = any of them existed.
//   anything else -> 400 invalid_action

import { forgetVerifiedEmail, requireServiceKey } from './_lib/accounts.js';
import { HttpError, json, methodNotAllowed, postHandler, readJsonBody } from './_lib/http.js';
import { itemInfo } from './_lib/items.js';
import { storeFromEnv } from './_lib/store.js';
import { KEY_PREFIX, recordKey, requireEmail, srsKeys } from './_lib/users.js';

export const TOP_WORDS = 20;
/** Records fetched per MGET: a record can be ~1 MB (marks of every word), so keep each answer reasonably small. */
export const STATS_BATCH = 50;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

function top(counts, items) {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, TOP_WORDS)
    .map(([id, n]) => ({ ...items.get(id), count: n }));
}

/** Count stars, skips and answers over every record (list + getMany in batches). */
export async function computeStats(store) {
  const items = await itemInfo();
  const keys = await store.list(KEY_PREFIX);
  const starred = new Map();
  const skipped = new Map();
  let usersWithData = 0;
  let totalStarred = 0;
  let totalSkipped = 0;
  let totalReviews = 0;
  for (let i = 0; i < keys.length; i += STATS_BATCH) {
    const records = await store.getMany(keys.slice(i, i + STATS_BATCH));
    for (const record of records) {
      if (!isObject(record)) continue;
      let any = false;
      for (const [id, entry] of Object.entries(isObject(record.marks) ? record.marks : {})) {
        if (!items.has(id) || !isObject(entry)) continue;
        if (entry.m === 'star') {
          starred.set(id, (starred.get(id) ?? 0) + 1);
          totalStarred += 1;
          any = true;
        } else if (entry.m === 'skip') {
          skipped.set(id, (skipped.get(id) ?? 0) + 1);
          totalSkipped += 1;
          any = true;
        }
      }
      const days = isObject(record.stats) && isObject(record.stats.days) ? record.stats.days : {};
      for (const day of Object.values(days)) {
        const answers = isObject(day) ? count(day.r) : 0;
        totalReviews += answers;
        if (answers > 0) any = true;
      }
      if (any) usersWithData += 1;
    }
  }
  return {
    app: 'learn-chinese',
    users_with_data: usersWithData,
    total_starred: totalStarred,
    total_skipped: totalSkipped,
    total_reviews: totalReviews,
    top_starred: top(starred, items),
    top_skipped: top(skipped, items),
  };
}

export const POST = postHandler(async (request) => {
  requireServiceKey(request);
  const body = await readJsonBody(request, 16 * 1024);
  if (body.action === 'stats') return json(200, await computeStats(storeFromEnv()));
  if (body.action === 'delete-user') {
    const email = requireEmail(body.email);
    // One round trip (Redis DEL with 33 keys): the record and every card-state bucket.
    const deleted = await storeFromEnv().deleteMany([recordKey(email), ...srsKeys(email)]);
    // A cached token of this instance must not recreate the record. This clears only this instance's
    // cache; /api/sync re-checks a cached token with the service before it creates a missing record.
    forgetVerifiedEmail(email);
    return json(200, { deleted: deleted > 0 });
  }
  throw new HttpError(400, 'invalid_action');
});

export {
  methodNotAllowed as GET,
  methodNotAllowed as HEAD,
  methodNotAllowed as PUT,
  methodNotAllowed as PATCH,
  methodNotAllowed as DELETE,
  methodNotAllowed as OPTIONS,
};
