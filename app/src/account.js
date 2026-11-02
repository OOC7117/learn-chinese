// Optional sign-in and cross-device sync: the header button (#account, #account-label), the sign-in
// dialog (#signin-dialog: sign in, create account, forgot password) and the account dialog
// (#account-dialog: sync status, Sync now, Sign out). Ported from the reference project (Inburgering
// flashcards, src/main.js "Account"); the dialogs keep its ids, texts are about this app's progress.
//
// Everything works without an account: nothing here runs before the person signs in, and the page never
// waits for the network. Signed in, every change of ctx.state (a star, a setting, an answered card) is
// saved on this device at once by state.js and then synced in the background by the engine in sync.js;
// what other devices changed is merged back with ctx.state.merge(). Signing out sends a final sync, then
// removes the account and all personal data from this device (shared-device safety): the account keeps it.
// Without the accounts service (no ACCOUNTS_URL / ACCOUNTS_SERVICE_KEY on the server, or a static host
// without the API) sign-in says it is not available right now and the app carries on anonymously.

import { STATUS, createSync } from './sync.js';
import { mergeMarks, normalizeEmail } from './lib/marks.js';
import { mergeSrs } from './lib/srs.js';
import { mergeStats } from './lib/stats.js';
import { KEYS, clearPersonalData, loadAccount, loadSynced, saveAccount, saveSynced } from './lib/storage.js';

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

/** Header label per sync status (short: the button is small on phones). */
export const HEADER_TEXT = Object.freeze({
  [STATUS.OFF]: 'Sign in',
  [STATUS.PENDING]: 'Syncing…',
  [STATUS.SYNCING]: 'Syncing…',
  [STATUS.SYNCED]: 'Synced',
  [STATUS.OFFLINE]: 'Saved · will sync',
  [STATUS.UNAVAILABLE]: 'Sync unavailable',
  [STATUS.ERROR]: 'Sync failed',
  [STATUS.EXPIRED]: 'Sign in again',
});

/** The same, in full (the button's tooltip and accessible name). */
export const STATUS_TEXT = Object.freeze({
  [STATUS.OFF]: 'Signed out',
  [STATUS.PENDING]: 'Syncing…',
  [STATUS.SYNCING]: 'Syncing…',
  [STATUS.SYNCED]: 'Synced',
  [STATUS.OFFLINE]: 'Saved on this device · will sync',
  [STATUS.UNAVAILABLE]: 'Sync unavailable',
  [STATUS.ERROR]: 'Saved on this device · sync failed',
  [STATUS.EXPIRED]: 'Signed out · sign in again',
});

const PROBLEMS = new Set([STATUS.OFFLINE, STATUS.UNAVAILABLE, STATUS.ERROR, STATUS.EXPIRED]);
/** Status icon paths (24 x 24, stroked like the sprite's icons), as in the reference app. */
const STATUS_ICONS = Object.freeze({
  check: 'M5 12.5 9.5 17 19 7.5',
  sync: 'M20 11a8 8 0 0 0-14.3-4.9M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.9M20 20v-4.5h-4.5',
  alert: 'M12 7.5v5.5M12 16.5v.5M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18',
});

export function formatWhen(t, now = Date.now()) {
  const then = new Date(t);
  const today = new Date(now);
  if (now - t < 60_000) return 'just now';
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return then.toDateString() === today.toDateString() ? `today at ${time}` : `on ${then.toLocaleDateString()} at ${time}`;
}

/** The account dialog's status line. */
export function longStatus({ status, lastSynced }, now = Date.now()) {
  const when = lastSynced ? ` Last synced ${formatWhen(lastSynced, now)}.` : '';
  switch (status) {
    case STATUS.SYNCED: return `Everything is synced.${when}`;
    case STATUS.PENDING:
    case STATUS.SYNCING: return 'Syncing…';
    case STATUS.OFFLINE: return `Saved on this device · will sync when the connection is back.${when}`;
    case STATUS.UNAVAILABLE: return `Sync is unavailable right now. Everything is saved on this device and syncs later.${when}`;
    case STATUS.ERROR: return `Sync failed. Everything is saved on this device; try Sync now later.${when}`;
    case STATUS.EXPIRED: return 'Signed out · sign in again. Your progress is still saved on this device and syncs once you sign in.';
    default: return '';
  }
}

const minutes = (seconds) => {
  const n = Math.max(1, Math.ceil(seconds / 60));
  return n === 1 ? '1 minute' : `${n} minutes`;
};

/** { text, field } for a failed login / register / forgot request (field: email | password | invite). */
export function signinError({ status, error, retryAfter }) {
  const wait = retryAfter === null || retryAfter === undefined ? 'a few minutes' : minutes(retryAfter);
  switch (error) {
    case 'invalid_email': return { text: "That doesn't look like an email address. Please check it.", field: 'email' };
    case 'invalid_password': return { text: `Choose a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`, field: 'password' };
    case 'invalid_credentials': return { text: 'That email and password do not match. Check them and try again, or use “Forgot password?”.', field: 'password' };
    case 'account_disabled': return { text: 'This account is disabled. Ask your admin for help.' };
    case 'account_locked': return { text: `Too many wrong passwords, so this account is locked for now. Try again in ${wait}, or use “Forgot password?”.` };
    case 'rate_limited': return { text: `Too many attempts. Please wait ${wait} and try again.` };
    case 'invalid_invite_code': return { text: "That invitation code isn't right. Ask your admin for the current code.", field: 'invite' };
    case 'email_taken': return { text: 'There is already an account for this email. Sign in instead, or use “Forgot password?”.', field: 'email' };
    case 'registration_closed': return { text: 'Creating accounts is closed right now. Ask your admin.' };
    default: break;
  }
  if (status === 503) return { text: 'Sign-in is not available right now. Your progress is still saved on this device.' };
  if (status === 0) return { text: 'Could not reach the server. Check your connection and try again.' };
  if (status === 404 || status === 405 || status === 501) return { text: 'Sign-in is not available on this site.' };
  return { text: `Something went wrong (error ${status}). Please try again.` };
}

/** What is wrong with the form before sending it, or null. */
export function signinFormProblem(mode, email, password, inviteCode) {
  if (!email) return { text: 'Enter your email address, for example name@example.com.', field: 'email' };
  if (mode === 'forgot') return null;
  if (mode === 'signin' && !password) return { text: 'Enter your password.', field: 'password' };
  if (mode === 'create') {
    const length = [...password].length;
    if (length < MIN_PASSWORD) return { text: `Choose a password of at least ${MIN_PASSWORD} characters.`, field: 'password' };
    if (length > MAX_PASSWORD) return { text: `Choose a password of at most ${MAX_PASSWORD} characters.`, field: 'password' };
    if (!inviteCode) return { text: 'Enter the invitation code from your admin.', field: 'invite' };
  }
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True when this device holds progress worth keeping: a star or skip, a card state or a studied day. */
export function hasLocalData({ marks, srs, stats } = {}) {
  if (isObject(marks) && Object.values(marks).some((entry) => entry?.m === 'star' || entry?.m === 'skip')) return true;
  if (isObject(srs) && Object.keys(srs).length > 0) return true;
  return isObject(stats?.days) && Object.values(stats.days).some((day) => day?.r > 0);
}

/** Signing in as someone else clears this device. When the previous person's session ended (so their
 * latest changes may not have reached their account), ask first: true when that would drop data. */
export function switchDropsData(account, email, snapshot) {
  if (!account || account.token || account.email === email) return false;
  return hasLocalData(snapshot);
}

const SIGNIN_VIEWS = {
  signin: {
    title: 'Sign in',
    note: 'Optional: sign in to sync your progress, stars, skips and settings across your devices. Everything also works without an account.',
    submit: 'Sign in',
  },
  create: {
    title: 'Create account',
    note: 'Create an account to sync your progress, stars, skips and settings across your devices. You need the invitation code from your admin.',
    submit: 'Create account',
  },
  forgot: {
    title: 'Forgot password',
    note: 'Ask for a reset link: your admin sees the request and sends you a link to set a new password.',
    submit: 'Ask for a reset link',
  },
};

/**
 * Wire the header button and the dialogs of index.html to the sync engine. Returns { sync, openSignIn,
 * openAccount }, or null when the markup is missing.
 */
export function initAccount(ctx) {
  const { state, store } = ctx;
  const announce = (text) => ctx.announce?.(text);
  const byId = (id) => document.getElementById(id);
  const el = {
    account: byId('account'), accountLabel: byId('account-label'),
    signinDialog: byId('signin-dialog'), signinForm: byId('signin-form'), signinTitle: byId('signin-title'),
    signinModes: byId('signin-modes'), signinNote: byId('signin-note'), signinEmail: byId('signin-email'),
    passwordGroup: byId('password-group'), signinPassword: byId('signin-password'), showPassword: byId('show-password'),
    passwordHint: byId('password-hint'), inviteGroup: byId('invite-group'), signinInvite: byId('signin-invite'),
    signinMessage: byId('signin-message'), forgotLink: byId('forgot-link'), backToSignin: byId('back-to-signin'),
    signinSubmit: byId('signin-submit'), signinCancel: byId('signin-cancel'),
    accountDialog: byId('account-dialog'), accountWhoLabel: byId('account-who-label'),
    accountDialogEmail: byId('account-dialog-email'), accountDialogStatus: byId('account-dialog-status'),
    signoutWarning: byId('signout-warning'), syncNow: byId('sync-now'), signOut: byId('sign-out'),
    signinAgain: byId('signin-again'), accountClose: byId('account-close'),
  };
  if (Object.values(el).some((node) => !node)) {
    console.warn('[account] sign-in markup missing: sign-in is off');
    if (el.account) el.account.hidden = true;
    return null;
  }

  // The email's initial while signed in (in place of the person icon). Styled through CSSOM with the
  // design tokens (CSP: no style attributes), so it follows light and dark mode.
  const userIcon = el.account.querySelector('svg');
  const initial = document.createElement('span');
  initial.className = 'account-initial';
  initial.setAttribute('aria-hidden', 'true');
  initial.hidden = true;
  Object.assign(initial.style, {
    display: 'inline-grid', placeItems: 'center', flex: 'none', width: '1.6rem', height: '1.6rem', borderRadius: '50%',
    background: 'var(--accent-fill)', color: 'var(--on-accent)', fontWeight: '700', fontSize: '0.85rem', lineHeight: '1',
  });
  el.account.insertBefore(initial, el.accountLabel);
  // The sync state as an icon next to the initial (check, sync arrows, alert). On phones it stands alone:
  // the status text would make the button wider on every sync and push the header around, so the text
  // is visually hidden there and stays in the button's accessible name (as in the reference app).
  const statusIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  statusIcon.setAttribute('class', 'icon account-status-icon');
  statusIcon.setAttribute('viewBox', '0 0 24 24');
  statusIcon.setAttribute('aria-hidden', 'true');
  statusIcon.setAttribute('hidden', '');
  const statusPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  statusIcon.append(statusPath);
  el.account.insertBefore(statusIcon, el.accountLabel);
  const phone = window.matchMedia?.('(max-width: 30rem)') ?? null;
  // Tap targets of at least 44 px (the shared .segmented .seg rule makes them 40 px).
  for (const button of el.signinModes.querySelectorAll('button[data-mode]')) button.style.minHeight = '44px';

  // { email, token, expires_at } while signed in; token null once the session ended ("Signed out · sign in
  // again": local data stays until the person signs in again); null when signed out.
  let account = loadAccount(store);

  const sync = createSync({
    // Settings are sent only once the user has changed them here (t > 0), so a fresh device never
    // overrides the account's settings with its defaults.
    getState: () => ({
      marks: state.marks,
      settings: state.settingsT > 0 ? state.settings : null,
      settings_t: state.settingsT,
      stats: state.stats,
      srs: state.srs,
    }),
    onRemote: applyRemote,
    onStatus: renderSyncStatus,
    onUnauthorized: onSessionEnded,
    loadLastSynced: () => loadSynced(store),
    saveLastSynced: (t) => (t > 0 ? saveSynced(store, t) : store.remove('synced')), // 0: no complete sync to rely on
    loadRevs: () => store.getJSON('srs-revs'),
    saveRevs: (revs) => store.setJSON('srs-revs', revs),
  });

  let applyingRemote = false; // state.merge() below runs: its 'merge' event is the account's own state

  /** The server's merged state (after sign-in or a sync): merge it into this device. Another tab may have
   * saved changes this one has not loaded yet; they are folded in, so writing back never drops them. */
  function applyRemote(remote) {
    if (!isObject(remote)) return;
    const marks = mergeMarks(store.getJSON('marks'), remote.marks);
    const stats = mergeStats(store.getJSON('stats'), remote.stats);
    const srs = isObject(remote.srs) ? mergeSrs(store.getJSON('srs'), remote.srs) : undefined;
    applyingRemote = true;
    try {
      state.merge({ marks, srs, stats, settings: remote.settings, settings_t: remote.settings_t });
    } finally {
      applyingRemote = false;
    }
  }

  // Every local change goes to the account (debounced). Merges from the server and reloads after another
  // tab's change are not new: that tab syncs its own changes. Any other merge brought data from outside
  // (Settings → Import backup): it must reach the account too, and may be older than the last sync.
  state.subscribe((event) => {
    if (event?.type === 'reload') return;
    if (event?.type === 'merge') {
      if (!applyingRemote) sync.imported();
      return;
    }
    sync.changed();
  });

  // ---------- Header button and account dialog ----------

  /** Header button + account dialog. Not announced on its own (syncs happen all the time); the
   * dialog's status line is a live region while the dialog is open. */
  function renderSyncStatus(info = sync.info()) {
    const signedIn = Boolean(account);
    const status = signedIn ? info.status : STATUS.OFF;
    const short = HEADER_TEXT[status] ?? HEADER_TEXT[STATUS.OFF];
    const problem = signedIn && PROBLEMS.has(status);
    el.account.dataset.sync = status;
    el.accountLabel.textContent = short;
    el.accountLabel.style.color = problem ? 'var(--warn)' : '';
    el.accountLabel.classList.toggle('visually-hidden', signedIn && Boolean(phone?.matches));
    statusIcon.toggleAttribute('hidden', !signedIn);
    statusPath.setAttribute('d', STATUS_ICONS[problem ? 'alert' : status === STATUS.SYNCED ? 'check' : 'sync']);
    statusIcon.style.color = problem ? 'var(--warn)' : status === STATUS.SYNCED ? 'var(--good)' : 'var(--muted)';
    if (signedIn) {
      el.account.setAttribute('aria-label', `Account ${account.email}: ${short}`);
      el.account.title = `${account.email} · ${STATUS_TEXT[status] ?? ''}`;
    } else {
      el.account.setAttribute('aria-label', 'Sign in to sync your progress (optional)');
      el.account.title = 'Sign in to sync your progress across devices (optional)';
    }
    el.accountDialogStatus.textContent = longStatus(info);
  }

  function renderAccount() {
    const ended = Boolean(account) && !account.token;
    el.account.classList.toggle('is-signed-in', Boolean(account));
    userIcon?.toggleAttribute('hidden', Boolean(account));
    initial.hidden = !account;
    if (account) {
      initial.textContent = [...account.email][0].toUpperCase();
      el.accountDialogEmail.textContent = account.email;
    }
    el.accountWhoLabel.textContent = ended ? 'Signed out of' : 'Signed in as';
    // "Sync now" can answer 401 while it has focus: hiding it would drop focus to the page.
    const hadFocus = document.activeElement === el.syncNow;
    el.syncNow.hidden = ended;
    el.signinAgain.hidden = !ended;
    if (hadFocus && ended) el.signinAgain.focus();
    el.accountClose.classList.toggle('primary', !ended);
    renderSyncStatus();
  }

  function showDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  // ---------- Sign-in dialog: three views (sign in, create account, forgot password) ----------

  let signinMode = 'signin';
  let signingIn = false;
  let signinAttempt = 0; // bumped when the dialog closes or changes view: a late answer is dropped
  let signinSwitchFor = null; // the email "Sign in anyway" was offered for (see submitSignIn)

  const fieldFor = (name) => ({ email: el.signinEmail, password: el.signinPassword, invite: el.signinInvite }[name] ?? null);

  /** The message under the form; an error marks `field` (email | password | invite) invalid and focuses it. */
  function setSigninMessage(text, { error = false, field = null } = {}) {
    el.signinMessage.textContent = text;
    el.signinMessage.classList.toggle('is-error', error);
    const invalid = error ? fieldFor(field) : null;
    for (const input of [el.signinEmail, el.signinPassword, el.signinInvite]) {
      if (input === invalid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    invalid?.focus();
  }

  function setPasswordVisible(visible) {
    el.signinPassword.type = visible ? 'text' : 'password';
    el.showPassword.setAttribute('aria-pressed', String(visible));
  }

  /** Drop a running request's answer (the person moved on) and make the submit button usable again. */
  function cancelSigninAttempt() {
    signinAttempt += 1;
    signingIn = false;
    el.signinSubmit.removeAttribute('aria-disabled');
  }

  function setSigninMode(mode, { focus = true } = {}) {
    cancelSigninAttempt();
    signinMode = mode;
    const view = SIGNIN_VIEWS[mode];
    el.signinForm.dataset.mode = mode;
    el.signinTitle.textContent = view.title;
    el.signinNote.textContent = view.note;
    el.signinSubmit.textContent = view.submit;
    signinSwitchFor = null;
    for (const button of el.signinModes.querySelectorAll('button[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    el.signinModes.hidden = mode === 'forgot';
    el.passwordGroup.hidden = mode === 'forgot';
    el.passwordHint.hidden = mode !== 'create';
    // A hidden element still describes the field when aria-describedby names it: name the hint only here.
    el.signinPassword.setAttribute('aria-describedby', mode === 'create' ? 'password-hint signin-message' : 'signin-message');
    el.inviteGroup.hidden = mode !== 'create';
    el.forgotLink.hidden = mode !== 'signin';
    el.backToSignin.hidden = mode !== 'forgot';
    // Password managers: offer saved passwords when signing in, suggest a new one when creating.
    el.signinPassword.setAttribute('autocomplete', mode === 'create' ? 'new-password' : 'current-password');
    setPasswordVisible(false);
    setSigninMessage('');
    if (focus) (mode !== 'forgot' && el.signinEmail.value ? el.signinPassword : el.signinEmail).focus();
  }

  function openSignIn({ email = '' } = {}) {
    if (email) el.signinEmail.value = email;
    setSigninMode('signin', { focus: false });
    showDialog(el.signinDialog);
    (el.signinEmail.value ? el.signinPassword : el.signinEmail).focus();
  }

  async function submitSignIn(event) {
    event.preventDefault();
    if (signingIn) return;
    const mode = signinMode;
    const email = normalizeEmail(el.signinEmail.value);
    const password = el.signinPassword.value;
    const inviteCode = el.signinInvite.value.trim();
    const problem = signinFormProblem(mode, email, password, inviteCode);
    if (problem) {
      setSigninMessage(problem.text, { error: true, field: problem.field });
      return;
    }
    // Signing in as someone else clears this device (see signIn()). Progress made after another
    // account's session ended may never have reached it: ask first, like "Sign out anyway".
    if (mode !== 'forgot' && signinSwitchFor !== email && switchDropsData(account, email, state.snapshot())) {
      signinSwitchFor = email;
      const action = mode === 'create' ? `Create an account for ${email}` : `Sign in as ${email}`;
      el.signinSubmit.textContent = `${SIGNIN_VIEWS[mode].submit} anyway`;
      setSigninMessage(`This device has progress from ${account.email} that may not have synced. ${action} anyway to remove it from this device, or sign in as ${account.email} to keep it.`);
      return;
    }
    // aria-disabled rather than disabled: a disabled button would drop keyboard focus.
    signingIn = true;
    el.signinSubmit.setAttribute('aria-disabled', 'true');
    setPasswordVisible(false);
    setSigninMessage({ signin: 'Signing in…', create: 'Creating your account…', forgot: 'Sending…' }[mode]);
    const attempt = signinAttempt;
    let result;
    if (mode === 'forgot') result = await sync.forgot(email);
    else if (mode === 'create') result = await sync.register({ email, password, inviteCode });
    else result = await sync.login({ email, password });
    if (attempt !== signinAttempt || !el.signinDialog.open) return; // closed or switched view: cancelled
    signingIn = false;
    el.signinSubmit.removeAttribute('aria-disabled');
    if (!result.ok) {
      const { text, field } = signinError(result);
      setSigninMessage(text, { error: true, field });
      return;
    }
    if (mode === 'forgot') {
      setSigninMessage('Your admin will send you a link to set a new password.');
      return;
    }
    el.signinPassword.value = '';
    el.signinInvite.value = '';
    setSigninMessage('');
    closeDialog(el.signinDialog);
    signIn(result, { newAccount: mode === 'create' });
  }

  /** The sign-in dialog closed (Esc, Cancel, backdrop, success): a running attempt counts as cancelled,
   * and the password never stays in the page. */
  function onSigninClosed() {
    cancelSigninAttempt();
    signinSwitchFor = null;
    el.signinPassword.value = '';
    setPasswordVisible(false);
  }

  /** Signed in: progress made on this device before is merged into the account, then pushed back. */
  function signIn({ email, token, expires_at: expiresAt, created, state: remote }, { newAccount = false } = {}) {
    // Someone else's ended session on this device: their data stays with their account, not this one.
    if (account && account.email !== email) {
      sync.setAccount(null);
      resetLocal();
    }
    if (created) {
      // This app had no record for the account yet (a new account, or one deleted and created again
      // after this device's session ended): the bucket revs and the last-sync mark kept here belong to
      // the earlier data, so nothing counts as sent or merged. Everything goes up with the first sync.
      store.remove('srs-revs');
      store.remove('synced');
    }
    account = { email, token, expires_at: expiresAt };
    saveAccount(store, account);
    sync.setAccount(account);
    try {
      applyRemote(remote);
    } catch (error) {
      console.error('[account] could not apply the account state', error);
    }
    sync.syncNow();
    renderAccount();
    let detail = 'Progress from this account was merged with this device.';
    if (newAccount) detail = 'Account created. Your progress now syncs to it.';
    else if (created) detail = 'Your progress now syncs to this account.';
    announce(`Signed in as ${email}. ${detail}`);
  }

  /** The server answered 401: the session ended (expired, signed out everywhere, account disabled). Keep
   * every local change; the next sign-in merges it into the account. */
  function onSessionEnded() {
    if (!account?.token) return;
    account = { email: account.email, token: null, expires_at: 0 };
    saveAccount(store, account);
    renderAccount();
    announce('Signed out · sign in again. Your progress is still saved on this device; sign in again to keep syncing.');
  }

  let signOutAnyway = false;
  let signingOut = false;

  function openAccount() {
    signOutAnyway = false;
    el.signOut.textContent = 'Sign out';
    el.signoutWarning.textContent = '';
    renderAccount();
    showDialog(el.accountDialog);
    (el.syncNow.hidden ? el.signinAgain : el.syncNow).focus();
  }

  /** Clear this device back to a fresh start (shared-device safety). */
  function resetLocal() {
    account = null;
    clearPersonalData(store);
    state.reload();
    // Nothing of the previous person stays in the page, not even in the sign-in fields.
    el.signinEmail.value = '';
    el.signinPassword.value = '';
    el.signinInvite.value = '';
    setSigninMessage('');
    initial.textContent = '';
    el.accountDialogEmail.textContent = '';
    renderAccount();
    ctx.navigate?.(location.hash || '#/'); // re-render the open view without their data
  }

  async function signOut() {
    if (signingOut || !account) return;
    if (!signOutAnyway) {
      // Always send the full state first (cheap), even when nothing looks unsynced: an earlier write may
      // have been lost, or another tab has changes still waiting. If it fails, ask.
      let done = false;
      if (account.token) {
        signingOut = true;
        el.signOut.setAttribute('aria-disabled', 'true');
        const result = await sync.syncNow();
        signingOut = false;
        el.signOut.removeAttribute('aria-disabled');
        if (!account) return; // signed out in another tab meanwhile
        done = result.ok && !result.more && !sync.hasUnsynced();
      }
      if (!done) {
        signOutAnyway = true;
        el.signOut.textContent = 'Sign out anyway';
        el.signoutWarning.textContent = account.token
          ? "Your latest changes haven't synced yet, so signing out now would lose them. Sign out anyway, or close and try again later."
          : "You're signed out of this account, so changes made here since the last sync can't reach it. Sign in again to keep them, or sign out anyway to remove them from this device.";
        return;
      }
    }
    sync.setAccount(null);
    closeDialog(el.accountDialog);
    resetLocal();
    el.account.focus();
    announce('Signed out. Your progress, stars, skips and settings were removed from this device.');
  }

  /** Another tab signed in or out, signed in again, or saw the session end. */
  function onAccountChangedElsewhere() {
    const next = loadAccount(store);
    if ((next?.email ?? null) === (account?.email ?? null) && (next?.token ?? null) === (account?.token ?? null)) return;
    if (!next) {
      for (const dialog of [el.signinDialog, el.accountDialog]) closeDialog(dialog);
      sync.setAccount(null);
      resetLocal();
      announce('Signed out in another tab. Your progress, stars, skips and settings were removed from this device.');
      return;
    }
    // Same person with a new token (signed in again) or none (session ended): only the dialogs that no
    // longer fit close. Another person: everything closes.
    if (next.email !== account?.email || next.token) {
      for (const dialog of [el.signinDialog, el.accountDialog]) closeDialog(dialog);
    }
    account = next;
    sync.setAccount(next);
    if (next.token) sync.syncNow();
    renderAccount();
  }

  /** Close a modal dialog on a click on its backdrop (pressed and released outside its box). */
  function closeOnBackdrop(dialog) {
    const outside = (event) => {
      const r = dialog.getBoundingClientRect();
      return event.target === dialog
        && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
    };
    let downOutside = false;
    dialog.addEventListener('pointerdown', (event) => { downOutside = outside(event); });
    dialog.addEventListener('click', (event) => {
      if (downOutside && outside(event)) closeDialog(dialog);
      downOutside = false;
    });
  }

  // ---------- Events ----------

  el.account.addEventListener('click', () => (account ? openAccount() : openSignIn()));
  // Enter and Space on the header button activate it: page shortcuts that listen on the document (Study's
  // Space / Enter = reveal, which prevents the default) must not swallow them.
  el.account.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  el.signinForm.addEventListener('submit', submitSignIn);
  for (const button of el.signinModes.querySelectorAll('button[data-mode]')) {
    button.addEventListener('click', () => {
      if (signinMode !== button.dataset.mode) setSigninMode(button.dataset.mode);
    });
  }
  el.forgotLink.addEventListener('click', () => setSigninMode('forgot'));
  el.backToSignin.addEventListener('click', () => setSigninMode('signin'));
  el.showPassword.addEventListener('click', () => {
    setPasswordVisible(el.signinPassword.type === 'password');
    el.signinPassword.focus();
  });
  el.signinCancel.addEventListener('click', () => closeDialog(el.signinDialog));
  el.signinDialog.addEventListener('close', onSigninClosed);
  el.syncNow.addEventListener('click', () => sync.syncNow());
  el.signOut.addEventListener('click', signOut);
  el.signinAgain.addEventListener('click', () => {
    const email = account?.email ?? '';
    closeDialog(el.accountDialog);
    openSignIn({ email });
  });
  el.accountClose.addEventListener('click', () => closeDialog(el.accountDialog));
  for (const dialog of [el.signinDialog, el.accountDialog]) {
    closeOnBackdrop(dialog);
    // Keys typed in a dialog belong to it: page shortcuts (e.g. Study's Space / 1-4 / S / X, which listen
    // on the document) must not act behind the modal.
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
  }
  window.addEventListener('storage', (event) => {
    if (event.key === KEYS.account || event.key === null) onAccountChangedElsewhere();
  });
  phone?.addEventListener?.('change', () => renderSyncStatus()); // rotated, or a resized window
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sync.flush();
    else sync.pull();
  });
  window.addEventListener('pagehide', () => sync.flush());
  window.addEventListener('online', () => sync.online());

  // ---------- Start ----------

  if (account) {
    sync.setAccount(account); // without a token (session ended): "Signed out · sign in again"
    if (account.token) sync.syncNow(); // pick up what other devices changed (and send what a lost flush missed)
  }
  renderAccount();
  return { sync, openSignIn, openAccount };
}
