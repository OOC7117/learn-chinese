# Accounts and sync

Learn Chinese works without an account: everything is saved on the device first (`localStorage`,
keys `learn-chinese:v1:*`) and the page never waits for the network. Signing in is optional and adds
one thing: your progress (card states), stars, skips, statistics and settings follow you to every device
where you sign in. Sign-in and sync are ported from the reference project (`inburgeringen_a2`,
`apps/flashcards`) and use its shared accounts service (`apps/accounts`); behaviour, security properties
and error codes are the same, plus card states, which are synced as deltas in 32 buckets.

- **Sign in** (header button, top right) with email and password, or **Create account** with the
  invitation code from the admin. **Forgot password?** asks the admin for a reset link (no email is
  sent). Progress made before signing in is merged into the account.
- The header button shows "Sign in" while signed out; signed in it shows the email's initial and the
  sync state as an icon: a check (synced), sync arrows (syncing) or an alert sign in the warning colour
  (a problem). On screens wider than 30rem the state is also written out: "Synced", "Syncing…", "Saved ·
  will sync", "Sync unavailable", "Sync failed" or "Sign in again"; on phones the text stays in the
  button's accessible name (and tooltip, e.g. "Signed out · sign in again"), so the header never changes
  size while syncing. The account dialog has **Sync now** and **Sign out**, which first sends a final
  sync and then removes the account and all personal data from this device (shared-device safety); the
  account keeps it.
- Without the accounts service (or on a static host without the API) the app works anonymously and
  sign-in says "Sign-in is not available right now".

```
app/api/login.js        POST /api/login     (Vercel functions; sign-in goes through the accounts service)
app/api/register.js     POST /api/register
app/api/forgot.js       POST /api/forgot
app/api/sync.js         POST /api/sync      (Authorization: Bearer <session token>)
app/api/service.js      POST /api/service   (stats + delete-user for the accounts admin panel, service key only)
app/api/_lib/           shared API code (not endpoints): http helpers, accounts service client, user records
                        and card-state buckets (users.js), known item ids (items.js), store adapter (Redis / JSON files)
app/src/sync.js         client sync engine (debounce, retries with backoff, keepalive flush, status, card-state deltas)
app/src/account.js      header button, sign-in and account dialogs (markup in app/index.html), sign out
app/src/lib/marks.js    marks + settings merge rules, shared by the browser and the API
app/src/lib/srs.js      card states: mergeSrs, validateSrs, bucketOf (shared)
app/src/lib/stats.js    statistics: mergeStats (shared)
app/scripts/dev-server.mjs   local server: static files + the api/ handlers, JSON file store
app/tests/api.test.mjs, store.test.mjs, sync.test.mjs   node:test suites; fake-accounts.mjs is a stand-in
                        accounts service; index.js loads every *.test.mjs (so `node --test app/tests` works)
app/vercel.json         headers (strict CSP, caching), bundles data/** with the functions
app/.vercelignore       .data/, .env*, tests/, scripts/: never uploaded, so local accounts stay local
app/.gitignore          .data/ (local records), .vercel/, .env*.local
```

## Run locally

ES modules and `fetch` need a web server (opening `index.html` from disk will not work). The dev
server serves the site and the sign-in / sync API (no dependencies). Sign-in also needs the accounts
service, so run the reference project's accounts dev server too, in a second terminal:

```sh
cd inburgeringen_a2/apps/accounts && npm run dev   # accounts + admin panel, http://127.0.0.1:4175
cd learn-chinese/app && npm run dev                # = node scripts/dev-server.mjs, http://127.0.0.1:4176
                                                   #   (or `npm run dev` in the repository root)
PORT=8080 npm run dev                              # another port (PORT=0 picks a free one)
```

The dev server binds to 127.0.0.1, sends the same headers as `vercel.json` (so CSP problems show up
locally; only `Cache-Control` is always `no-store` while developing), answers byte ranges for static
files (Safari needs them for audio), routes `POST /api/<name>` to `api/<name>.js` exactly as Vercel
would (passing the browser's IP as `x-real-ip`, like Vercel), and always uses the JSON file store: one
file per key in `app/.data/` (gitignored), or in `LEARN_CHINESE_DATA_DIR`. Delete that folder to
forget all local records. It never writes to a Redis database, even if Redis variables are set in your
shell.

Unless set in your shell, it uses `ACCOUNTS_URL=http://127.0.0.1:4175` and the accounts dev server's
service key (`ACCOUNTS_SERVICE_KEY`, a fixed dev-only value both dev servers share), and prints the
accounts URL on start (never the key). Locally you create an account with the dev invitation code
`010101`; the admin panel is at http://127.0.0.1:4175/admin/. To see this app's insights there, start
the accounts dev server with `ACCOUNTS_APP_URLS="Learn Chinese=http://127.0.0.1:4176"` (its default
lists only the flashcards app). Without the accounts dev server the app works anonymously and sign-in
says it is not available right now.

Any static server also works for the anonymous app (sign-in then says it is not available on this
site): `python3 -m http.server -d app`.

## Test

```sh
node --test app/tests          # or: cd app && npm test
```

`api.test.mjs` runs the handlers against a temp JSON store and a fake accounts service (a real HTTP
server), checks the card-state buckets, `vercel.json` and the dev server end to end (two devices with
conflicting offline edits converge). `store.test.mjs` runs the Redis adapter against a fake Upstash
(compare-and-set conflicts on a bucket heal). `sync.test.mjs` drives the client engine with a fake
fetch, fake timers and a fake server (chunks of 3,000 card states, revs, retries, 401, 503).

## Deploy on Vercel (sync)

1. **Create the project.** Import the repository and set **Root Directory** to `app`. Framework
   preset: *Other*; no build command and no output directory (the folder is served as is, `api/*.js`
   become Node functions; `package.json` only declares ES modules, there are no dependencies).
   `vercel.json` adds the security headers, makes browsers revalidate `/`, `/sw.js` and `data/*`,
   caches `audio/*` for a week, and bundles `data/**` with the functions (the API reads the item ids
   from `data/manifest.json`, `data/words-*.json` and `data/content.json`).
2. **Storage for sync.** In the project's **Storage** tab add **Upstash Redis** from the Vercel
   Marketplace and connect it to the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
   (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` from a database created directly at Upstash
   work too.) You can connect the same database as the reference project's flashcards and accounts
   apps: every key of this app starts with `learn-chinese:`.
3. **Sign-in.** The accounts service is the reference project's `apps/accounts`, deployed once and
   shared by all apps (its README: "Deploy on Vercel"). Add two **Environment Variables** to this
   project (Settings → Environment Variables, Production and Preview), mark the key *Sensitive*, and
   redeploy:

   | Variable | Value |
   | --- | --- |
   | `ACCOUNTS_URL` | the accounts deployment, e.g. `https://inburgering-accounts.vercel.app` (no trailing path) |
   | `ACCOUNTS_SERVICE_KEY` | the **same** value as `ACCOUNTS_SERVICE_KEY` in the accounts project (at least 32 characters) |

4. **Admin panel.** In the accounts project, add this site to `ACCOUNTS_APP_URLS` (comma-separated, next
   to the flashcards entry), e.g. `Flashcards=https://inburgering-flashcards.vercel.app,Learn Chinese=https://learn-chinese.vercel.app`,
   and redeploy the accounts project. Its admin panel then shows this app's insights, and deleting a
   user there also deletes their Learn Chinese record and card states (`/api/service`). The panel's
   word tables were written for the Dutch flashcards (columns `nl`, `en`, `deck`): this app's rows
   carry `hanzi`, `pinyin` and `meaning` instead, so until the panel learns those fields it lists them
   by item id.

Optional variables (leave unset in production):

| Variable | Effect |
| --- | --- |
| `LEARN_CHINESE_STORE` | `file` or `redis` forces a backend (the dev server sets `file`) |
| `LEARN_CHINESE_DATA_DIR` | folder of the JSON file store (default `app/.data/`; never used on Vercel) |
| `LEARN_CHINESE_VERIFY_CACHE_MS` | how long a successful token check is cached per function instance, 0–600000 ms (default 60000); `0` makes a revoked token fail on the very next sync. For tests and local checks |

Without Redis the site still works anonymously; `/api/*` answers `503 storage_unavailable` and the app
shows "Sync unavailable". Without `ACCOUNTS_URL` / `ACCOUNTS_SERVICE_KEY` (or with a wrong key) sign-in
and sync answer `503 accounts_unavailable` and the app says "Sign-in is not available right now" (the
accounts service refuses a wrong key on login, register and forgot as well as on verify); the function
logs name the missing variable (never values), or say "service key rejected: check
ACCOUNTS_SERVICE_KEY". It never falls back to files on Vercel (its filesystem is read-only and not
shared between instances).

**Costs.** Upstash bills per command. A pure pull (page shown again, nothing changed) is 2 commands
(GET the record, MGET the 32 buckets). A sync after answering cards is about 2 + 2 × (buckets touched)
+ 1: the record and each touched bucket are read and compare-and-set written, then one MGET. While
studying, the engine sends one request 1.5 s after the last answer, so a pause between cards usually
means one sync per card: roughly 5 commands per answered card, plus the accounts service's own reads
for a token check once a minute. Each sync's MGET reads all 32 buckets from Redis (about 120 bytes per
studied card, a few hundred KB for a typical learner); only the changed buckets go to the browser.

## Accounts and sync

**How it works.** Accounts (email + password) live in the reference project's accounts service, which
is shared by every app and has the admin panel. This site never sees a password hash: its
`/api/login`, `/api/register` and `/api/forgot` forward the form to the accounts service server to
server (header `X-Accounts-Service-Key`, plus the browser's IP in `X-Accounts-Client-IP` for the
service's rate limits; login and verify ask for `audience: 'app'`) and pass its answers through. The
browser only ever talks to this site (CSP `connect-src 'self'`, no CORS).

- **Create account** needs the invitation code (the admin sees and changes it in the admin panel).
  Passwords are 8–200 characters, nothing else is required.
- **Sign in** returns a session token, valid 30 days, which the browser keeps in `localStorage` and
  sends with every sync as `Authorization: Bearer <token>`. `/api/sync` checks it with the accounts
  service (`/api/verify`) and takes the email from it; successful checks are cached for 60 s per function
  instance (keyed by a SHA-256 of the token).
- **Forgot password?** sends no email: it marks the account "reset requested" in the admin panel, and
  the admin sends a one-time reset link personally.
- **Session ended.** When a sync answers `401` (token expired, the admin signed the person out
  everywhere, reset the password, disabled or deleted the account), the app stops syncing, keeps
  everything local, forgets the token and shows "Signed out · sign in again". Signing in again merges
  this device's progress into the account. Because of the 60 s cache, a revoked token may keep syncing
  for up to a minute on a warm function instance; a cached check is never enough to *create* a record
  or a card-state bucket, though: when the record or a bucket it would write is missing, `/api/sync`
  asks the service again first (once per request), so a deleted account's token gets `401` instead of
  bringing the data back, even when delete-user runs between reading the record and writing the
  buckets (the accounts service deletes the account before it asks the apps to delete their data). (Signing in as a
  *different* email on that device clears the previous person's local data; if it has progress that
  may not have synced, the dialog first asks "Sign in anyway" / "Create account anyway".)

The server stores the email inside the record (so it can be shown back) but never logs it; every key is
built from a SHA-256 hash of it. Logs never contain emails, passwords, tokens or IPs.

**Local first.** Every change is saved to `localStorage` at once (`app/src/state.js`); the sync engine
only runs in the background. Anonymous use works exactly the same. Signing in merges what this device
has (progress made before signing in included) with the account, then pushes the result back. Sign out
always sends a final sync (if it fails it asks before discarding, via "Sign out anyway"), then removes
the account, marks, card states, settings, statistics, tone-trainer results and sync bookkeeping from
this device (`clearPersonalData`); the account keeps what was synced.

**What syncs, and how.** Every request carries:

- the **full marks map**, tombstones included (~50 bytes per marked item) and the **full statistics**
  (one entry per study day). The server merges, saves and returns the merged marks, settings and
  statistics; the device merges them back. The merges are commutative, associative and idempotent, so
  lost, repeated or reordered requests heal on the next sync.
- the **settings**, once the user has changed them on this device (`settings_t > 0`), so a new device
  never overwrites the account's settings with defaults.
- the **card states changed since this device's last successful sync** (`srs`), at most 3,000 per
  request and within the 1 MB body limit; `syncNow` sends further requests until none are left. The
  engine remembers in memory which state of each card the server has (what it sent, and what came back);
  after a page reload, states reviewed before the last complete sync (minus an hour) count as sent, so a
  reload does not upload everything again. Malformed local states are never sent. A backup imported in
  Settings syncs like any change, and since it can hold states reviewed long before the last sync, it
  clears the last-sync mark (`learn-chinese:v1:synced`) until a complete sync has sent it; a mark that
  lies in the future (saved while the device's clock ran ahead) is not trusted either.
- `srs_revs`: the rev of every bucket this device has merged (kept in `learn-chinese:v1:srs-revs`).

The server merges the card states into their buckets (compare-and-set per bucket; `rev` + 1 only when
the bucket changed) and answers with every bucket whose rev differs from the device's (all of them on a
first sync), read in one round trip (MGET). A bucket that changed only because of this request, from
the rev the device had, comes back as `{ rev, entries: {} }`: the device has all of it already. If the
merge kept something of the stored state (an earlier first review), the whole bucket comes back instead.
Answers stop adding buckets after ~2 MB of entries and say `more: true`; the engine asks again at once.
A bucket whose rev went *back* (the server lost data, e.g. a restored backup) makes the device send that
bucket's card states again. A bucket received in full is everything the server has in it, so a card
state the device counted as sent that is missing there goes up again at once (this also covers a lost
bucket whose rev has since grown past the device's). Signing in when the account has no record in this
app yet (`created: true`: a new account, or one deleted and created again while this device kept its
data) clears the device's revs and last-sync mark first, so everything it has goes up.

When it syncs: on sign-in and page load; 1.5 s after the last change (a star, a setting, an answered
card); when the page becomes visible (at most every 30 s); a best-effort `fetch(…, { keepalive: true })`
when the page is hidden or closed, with only the marks, days and card states changed since the last full
sync (so it stays below the 64 KB browsers allow for keepalive requests); on the browser's `online`
event. Failures keep everything local, show "Saved · will sync" and retry with backoff (at most every
60 s); a 503 shows "Sync unavailable" and pauses automatic syncs for 5 minutes; a 401 stops syncing
until the person signs in again; other 4xx are not retried until the next change. Concurrent syncs of
one account cannot drop each other's changes: every write is a compare-and-set (Redis `EVAL`; queued
per file in the dev server's file store) that merges again on a conflict.

The server keeps marks and card states only for items that exist in the bundled data (HSK words, and
the phrases and kinship terms of `content.json`) and card types `read`, `listen`, `speak`, `cloze`; the
rest is dropped. So nobody can fill an account with made-up ids, and a record stays below ~1 MB, each
bucket below ~200 KB even for someone who studied every card. A sync for an account without a record
that brings nothing to store does not create one.

### Data model

`app/src/lib/marks.js`, `srs.js` and `stats.js` are shared by the browser and the API, so both sides
merge identically.

```js
marks    = { [itemId]: { m: 'star' | 'skip' | null, t: 1793083527785 } }
srs      = { [cardId]: { s: [1, due, stability, difficulty, reps, lapses, state, lastReview, steps, days], t, f } }
stats    = { days: { 'YYYY-MM-DD': { r: answers, n: new items, a: 'again' answers, ms: time studied } } }
settings = { newPerDay, reviewLimit, dailyGoal, retention, typeListen, …, activeDecks: 'exam2025-1,…', dayStartHour }
```

- **Marks**: one per item (an HSK word, a phrase, a kinship term); star = hard, skip = already known.
  Per item, last writer wins: higher `t` wins; at equal `t`, star > skip > cleared. `m: null` is a
  tombstone, kept so a clear on one device beats an older star on another.
- **Card states** (`cardId` = `<item id>.<type>`): per card, the later review (`t`) wins; ties go to
  more reps, then to the canonical JSON. `f` (first review) is the earliest seen on any device. Times in
  `s` are whole minutes since the epoch.
- **Statistics**: per day and counter, the maximum (idempotent; two devices studying on the same day
  under-count that day, but streaks and "goal met" stay right).
- **Settings**: one value with its own `settings_t`, last writer wins.
- Timestamps more than 24 h in the future (`t`, `f`, `settings_t`) are clamped to now + 24 h by
  `/api/sync`, so a device with a wrong clock keeps syncing. Statistics days outside 2020-01-01 … today
  + 2 days (UTC) are dropped, counters are capped (100,000 answers, 24 h of study time per day).
- Browser keys (`app/src/lib/storage.js`): `learn-chinese:v1:marks`, `…:srs`, `…:settings` (settings +
  `t`), `…:stats`, `…:account` (`{ email, token, expires_at }` while signed in; `{ email }` once the
  session ended), `…:synced` (last complete sync), `…:srs-revs` (`{ bucket: rev }` merged),
  `…:tones` (tone trainer, local only, not synced).
- Server keys (namespaced, so the database can be shared with the reference project):
  - `learn-chinese:user:<sha256(normalised email) hex>`:
    `{ email, created_at, updated_at, marks, settings, settings_t, stats }`
  - `learn-chinese:srs:<sha256(normalised email) hex>:<bucket>`: `{ rev, entries: { [cardId]: { s, t, f } } }`,
    bucket `"00"` … `"31"` = `bucketOf(cardId)` (FNV-1a of the card id, mod 32).
- Emails are normalised (trimmed, NFC, lower-cased) and checked loosely: one `@`, a dotted domain, no
  spaces, at most 254 characters. Ids match `^[a-z0-9][a-z0-9._-]{0,159}$`; at most 20,000 marks.

### API

JSON in and out, POST only, `Cache-Control: no-store`. Errors are `{ "error": "<code>" }` (plus
`retry_after` in seconds and a `Retry-After` header where noted): `405 method_not_allowed` (anything but
POST), `413 body_too_large` (over 1 MB; 16 KB for the sign-in endpoints and /api/service),
`413 too_many_marks | too_many_srs`, `400 invalid_json | invalid_marks | invalid_settings | invalid_stats |
invalid_srs | invalid_srs_revs`, `503 storage_unavailable | accounts_unavailable`, `500 internal`.

```
POST /api/register  { email, password, invite_code }
  -> 200 { email, token, expires_at, created, state: { marks, settings, settings_t, stats, updated_at } }
     Creates the account at the accounts service, then opens (creates) this app's record.
     Errors from the service, passed through: 400 invalid_email | invalid_password,
     403 invalid_invite_code, 409 email_taken, 503 registration_closed, 429 rate_limited (+ retry_after).

POST /api/login     { email, password }
  -> 200 { email, token, expires_at, created, state }
     Errors: 401 invalid_credentials (unknown email or wrong password: same answer), 403 account_disabled,
     423 account_locked (+ retry_after), 429 rate_limited (+ retry_after). `created` is true when this
     app's record was just created. Card states come with the first /api/sync after signing in.

POST /api/forgot    { email }
  -> 200 { ok: true }   (also for unknown emails)   Errors: 400 invalid_email, 429 rate_limited.

POST /api/sync      { marks, settings?, settings_t?, stats?, srs?, srs_revs? }      Authorization: Bearer <token>
  -> 200 { state: { marks, settings, settings_t, stats, updated_at },
           srs: { buckets: { "07": { rev, entries } … }, more? } }
     401 unauthorized when the token is missing, invalid or expired (an `email` in the body is ignored).
     marks: the full map; mergeMarks(stored, marks), unknown item ids ignored, at most 20,000.
     settings: one flat object (at most 32 keys, primitive values, strings up to 4,000 characters);
       `settings: null` / absent leaves the stored settings alone.
     stats: { days }; merged per day and counter (maximum).
     srs: at most 3,000 card states (413 too_many_srs above); unknown card ids are dropped.
     srs_revs: { "00" … "31": rev } this device has merged.
     Saves only what changed (a pure pull writes nothing); the answer has every bucket whose rev
     differs from srs_revs (a missing bucket has rev 0), `entries: {}` when the device already has them
     all, `more: true` when the rest did not fit (~2 MB).

POST /api/service   { action }      X-Accounts-Service-Key: <ACCOUNTS_SERVICE_KEY>
     Called by the accounts admin panel only. Without the right key: 401 unauthorized_service; without
     ACCOUNTS_SERVICE_KEY configured: 503 accounts_not_configured.
  { action: 'stats' }
  -> 200 { app: 'learn-chinese', users_with_data, total_starred, total_skipped, total_reviews,
           top_starred: [{ id, hanzi, pinyin, meaning, count }], top_skipped: [...] }
     users_with_data = records with at least one starred or skipped item or one answered card;
     total_reviews = cards answered, summed over all study days of all records; the top lists (20 each)
     are the items most learners starred ("hardest") or skipped. Lists every `learn-chinese:user:*` key
     (Redis SCAN) and reads the records in batches of 50 (MGET); card-state buckets are not read.
  { action: 'delete-user', email }
  -> 200 { deleted: true | false }   the record and all 32 buckets, in one DEL; deleted = any existed
     (400 invalid_email; any other action: 400 invalid_action)
```

Rate limits for sign-in, sign-up and "forgot password" are enforced by the accounts service (per IP and
per account). Sync has no rate limit in the code (it would cost a Redis round trip per request); if
someone abuses it, add a rate-limit rule for `/api/*` in the project's Vercel Firewall. No code change
is needed, and the app already retries a `429` with backoff.

### Known limits

- A learner with tens of thousands of card states makes each sync's MGET read several MB from Redis
  (all 32 buckets), and the first sync on a new device downloads them in ~2 MB parts.
- Two tabs of one browser share `localStorage` but each has its own sync engine; both may send the same
  change (harmless: merges are idempotent).
- If `localStorage` refuses to save the card states (quota) while the bucket revs still save, this
  device can miss card states of buckets that do not change again; signing out and in again (or
  clearing site data) re-downloads everything.
- Revs count changes, they do not name a bucket's history: if the server lost a bucket and it was
  written again exactly as many times as this device remembers, the device only notices once that
  bucket changes again (then it comes in full and the device fills the gaps).
- Card states have no tombstones. "Reset progress" on a word page (`state.resetItem`) deletes the
  word's card states on this device only: the account and other devices keep them, and they come back
  here the next time their bucket is received in full.
