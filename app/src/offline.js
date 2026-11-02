// Offline use: Settings > Offline (is the app saved, storage used, persistent storage, saving the audio of
// the active decks ahead of time, removing it) and warmUp(), which keeps every word list on the device.
// The service worker (sw.js) does the rest by itself: it saves the app on the first visit, each data file
// as it passes through and each recording when it first plays (same caches as here).

import { h, replace, bar, num, announce } from './dom.js';
import { activeItems } from './study-items.js';

/** Cache names shared with the service worker (sw-logic.js; app/tests/sw.test.mjs keeps them equal). */
export const AUDIO_CACHE = 'learn-chinese-audio-v1';
export const DATA_CACHE = 'learn-chinese-data-v1';
export const SHELL_CACHE_PREFIX = 'learn-chinese-shell-';
/** Downloads at once when saving audio. */
export const CONCURRENCY = 6;
/** Downloads at once when warming the word lists (in the background, so the page's own requests go first). */
const WARM_CONCURRENCY = 2;
/** Consecutive failed downloads that mean the connection is gone (saving stops; already saved files stay). */
const STOP_AFTER_FAILURES = 12;
/** Average size of a recording in app/audio (measured 2026-11: syllables 9.8 KB, words 4.6 KB), for estimates. */
const AVG_BYTES = { syllable: 9800, word: 4600 };

// ---------- Pure helpers (tested in app/tests/sw.test.mjs) ----------

/** The audio files (relative URLs such as "audio/s/ma3.mp3") of `items`, each once, in study order. */
export function audioFilesOf(items) {
  const files = new Set();
  for (const item of items ?? []) {
    const file = item?.audio?.file;
    if (typeof file === 'string' && /^audio\/.+\.mp3$/.test(file)) files.add(file);
  }
  return [...files];
}

/** The data files of a data manifest (app/data/manifest.json), as src/data.js requests them:
 * "data/words-1.json?v=<content hash>" (the service worker keys its data cache by this URL). */
export function dataFilesOf(manifest) {
  const files = new Set();
  for (const entry of Object.values(manifest?.files ?? {})) {
    if (typeof entry?.file === 'string' && /^data\/[^/?#]+\.json$/.test(entry.file) && typeof entry.hash === 'string' && entry.hash) {
      files.add(`${entry.file}?v=${entry.hash}`);
    }
  }
  return [...files];
}

/** "1 recording", "817 recordings". */
export const recordings = (n) => `${num(n)} recording${n === 1 ? '' : 's'}`;

/** Approximate download size of audio files (only for the "about 5 MB" label). */
export const estimateBytes = (files) => files.reduce((sum, f) => sum + (f.startsWith('audio/w/') ? AVG_BYTES.word : AVG_BYTES.syllable), 0);

/** 0 KB, 950 KB, 4.2 MB, 37 MB, 1.2 GB (decimal units, as phones show storage). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes === 0) return '0 KB';
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e9) return bytes < 1e7 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * Run `task(item, signal)` for every item, at most `concurrency` at once, until all are done, `signal`
 * aborts, or `stopAfterFailures` tasks in a row failed. onProgress({ done, failed, total }) after each item.
 * Resolves to { done, failed, total, aborted, stopped }. An aborted task is not a failure.
 */
export async function runPool(items, task, { concurrency = CONCURRENCY, signal = null, onProgress = null, stopAfterFailures = Infinity } = {}) {
  const total = items.length;
  let next = 0;
  let done = 0;
  let failed = 0;
  let inARow = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && !signal?.aborted && next < total) {
      const item = items[next];
      next += 1;
      try {
        await task(item, signal);
        done += 1;
        inARow = 0;
      } catch {
        if (signal?.aborted) break;
        failed += 1;
        inARow += 1;
        if (inARow >= stopAfterFailures) stopped = true;
      }
      onProgress?.({ done, failed, total });
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, total)) }, lane));
  return { done, failed, total, aborted: Boolean(signal?.aborted), stopped };
}

// ---------- Browser side ----------

const hasCaches = () => typeof caches !== 'undefined';
const hasWorker = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
const absolute = (file) => new URL(file, document.baseURI).href;

/** URLs of the saved recordings (empty when there are none, without creating the cache). */
async function savedAudioUrls() {
  if (!hasCaches() || !(await caches.has(AUDIO_CACHE))) return new Set();
  const cache = await caches.open(AUDIO_CACHE);
  return new Set((await cache.keys()).map((req) => req.url));
}

/** The version of the saved app shell the running worker uses, or null when no app shell is saved. Cache
 * names come in the order they were made: the first is the active version's (activating deletes older
 * ones); a later one belongs to an update that waits, or to one whose install failed half-way. */
async function savedShellVersion() {
  if (!hasCaches()) return null;
  const names = (await caches.keys()).filter((n) => n.startsWith(SHELL_CACHE_PREFIX));
  return names.length ? names[0].slice(SHELL_CACHE_PREFIX.length) : null;
}

/** The data files of the running app version: [{ url, saved }] (url absolute), or null when unknown. */
async function dataFileStatus() {
  if (!hasCaches()) return null;
  // The worker answers this from the saved app (the manifest belongs to the app version), so it works offline.
  const res = await fetch('data/manifest.json');
  if (!res.ok) return null;
  const urls = dataFilesOf(await res.json()).map(absolute);
  const saved = (await caches.has(DATA_CACHE)) ? new Set((await (await caches.open(DATA_CACHE)).keys()).map((req) => req.url)) : new Set();
  return urls.map((url) => ({ url, saved: saved.has(url) }));
}

let warming = null;

/**
 * Keep every data file (word lists, tones, phrases) of the running app version on this device, so all of
 * the app (search, progress, every deck, tones) works offline after one online visit, not only what has
 * been opened. The files go through the service worker, which saves each one in its data cache; files
 * already saved are skipped, so after the first visit this only downloads what an app update changed.
 * First visit: the page loaded its data before the worker took control, so the worker never saw it; this
 * requests it again. Best effort and quiet: without a worker in control, offline or with Data Saver on it
 * does nothing. Called by main.js. Resolves to the number of files requested.
 */
export function warmUp() {
  warming ??= (async () => {
    if (!hasWorker() || !navigator.serviceWorker?.controller) return 0;
    if (navigator.onLine === false || navigator.connection?.saveData) return 0;
    const missing = ((await dataFileStatus()) ?? []).filter((f) => !f.saved).map((f) => f.url);
    await runPool(missing, async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
    }, { concurrency: WARM_CONCURRENCY, stopAfterFailures: 2 });
    return missing.length;
  })().catch(() => 0).finally(() => {
    warming = null;
  });
  return warming;
}

// One saving job per page, so it keeps going while you study and Settings shows it when you come back.
// { running, phase: 'collecting' | 'saving', total, saved, failed, result, message, controller,
//   removing (Remove saved audio stopped it), finished (Promise, settles when it has stopped) }
let job = null;
const jobListeners = new Set();
const emitJob = () => {
  for (const fn of jobListeners) fn(job);
};

async function saveFiles(files, { signal, onProgress }) {
  const cache = await caches.open(AUDIO_CACHE);
  const before = await savedAudioUrls();
  const urls = files.map(absolute);
  const todo = urls.filter((url) => !before.has(url));
  const already = urls.length - todo.length;
  onProgress({ saved: already, failed: 0 });
  const result = await runPool(todo, async (url, sig) => {
    const res = await fetch(url, { signal: sig });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Through the worker the file is saved on the way; without one in control yet, save it here.
    if (navigator.serviceWorker?.controller) await res.arrayBuffer();
    else await cache.put(url, res);
  }, { concurrency: CONCURRENCY, signal, stopAfterFailures: STOP_AFTER_FAILURES, onProgress: ({ done, failed }) => onProgress({ saved: already + done, failed }) });
  // Count what really is in the cache (a full disk makes the worker skip saving).
  const after = await savedAudioUrls();
  return { ...result, saved: urls.filter((url) => after.has(url)).length, total: urls.length };
}

function startSaving(ctx) {
  if (job?.running) return;
  const controller = new AbortController();
  const current = { running: true, phase: 'collecting', total: 0, saved: 0, failed: 0, result: null, message: '', controller, removing: false, finished: null };
  job = current;
  emitJob();
  let lastQuarter = 0;
  current.finished = (async () => {
    try {
      if (navigator.onLine === false) throw new Error('you are offline. Connect to the internet and try again.');
      const files = audioFilesOf((await activeItems(ctx)).items);
      if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      Object.assign(current, { phase: 'saving', total: files.length });
      emitJob();
      announce(`Saving ${recordings(files.length)} for offline use.`);
      const r = await saveFiles(files, {
        signal: controller.signal,
        onProgress: ({ saved, failed }) => {
          Object.assign(current, { saved, failed });
          const quarter = current.total ? Math.floor((saved / current.total) * 4) : 4;
          if (quarter > lastQuarter && quarter < 4) announce(`${quarter * 25}% of the recordings saved.`);
          lastQuarter = Math.max(lastQuarter, quarter);
          emitJob();
        },
      });
      current.saved = r.saved;
      const missing = r.total - r.saved;
      if (r.aborted) current.result = 'cancelled';
      else if (r.stopped) current.result = 'stopped';
      else current.result = missing ? 'partial' : 'done';
      current.message = {
        cancelled: 'Stopped. Saving again continues where it stopped.',
        stopped: `The connection seems to be gone. ${num(r.saved)} of ${recordings(r.total)} saved; try again when you are online.`,
        partial: `${num(r.saved)} of ${recordings(r.total)} saved. ${num(missing)} could not be saved (connection or storage full); try again later.`,
        done: r.total ? `All ${recordings(r.total)} of your active decks are saved on this device.` : 'Your active decks have no recordings (they use the device voice).',
      }[current.result];
    } catch (error) {
      const cancelled = controller.signal.aborted;
      current.result = cancelled ? 'cancelled' : 'error';
      current.message = cancelled ? 'Stopped.' : `Saving failed: ${error?.message ?? error}`;
    } finally {
      current.running = false;
      // Stopped by "Remove saved audio": that action reports the outcome (nothing is left to continue).
      if (current.removing) Object.assign(current, { result: 'removed', message: '' });
      if (current.message) {
        announce(current.message);
        if (!jobListeners.size && current.result !== 'cancelled') ctx.toast(current.message, 6000); // Settings is closed
      }
      emitJob();
    }
  })();
}

// ---------- Settings > Offline ----------

/** The "Offline" section of Settings: { el, cleanup }. */
export function offlineSection(ctx) {
  const workerSupported = hasWorker() && hasCaches();
  const storage = globalThis.navigator?.storage ?? null;
  let activeFiles = null; // audio files of the active decks, once counted
  let alive = true;

  // App status
  const appHint = h('span.hint', 'Checking…');
  const appChip = h('span.chip', '…');
  // Storage
  const usageHint = h('span.hint', storage?.estimate ? 'Checking…' : 'Your browser does not tell how much space is used.');
  const persistHint = h('span.hint', 'Browsers may clear a website\'s data when the device runs low on space. Ask yours to keep this app\'s data: your progress (unless you sign in to sync) and the saved recordings.');
  const persistBtn = h('button.btn', { type: 'button', onclick: askPersist }, 'Keep data');
  const persistChip = h('span.chip.good', { hidden: true, tabindex: '-1' }, 'Kept');
  // Recordings
  const audioTotal = h('span', 'Counting the recordings of your active decks…');
  const audioSaved = h('span');
  const audioSummary = h('p', audioTotal, audioSaved);
  const progressText = h('p.small');
  const progressBar = bar(0, 1, 'Recordings saved');
  const progressBox = h('div', { hidden: true }, progressBar, progressText);
  const saveBtn = h('button.btn.primary.block', { type: 'button', onclick: () => startSaving(ctx), disabled: !workerSupported }, 'Save audio of my active decks for offline use');
  const cancelBtn = h('button.btn.block', { type: 'button', hidden: true, onclick: () => job?.controller.abort() }, 'Cancel');
  const audioMessage = h('p.small');
  const savedCount = h('span.small.muted');
  const removeBtn = h('button.btn', { type: 'button', onclick: removeAudio, hidden: true }, 'Remove saved audio');
  progressBox.style.margin = '0.25rem 0 0.75rem';
  Object.assign(persistBtn.style, { flex: 'none', whiteSpace: 'nowrap' });
  progressText.style.margin = '0.4rem 0 0';
  cancelBtn.style.marginTop = '0.5rem';

  const el = h('section', { aria: { labelledby: 'offline-title' } },
    h('h2#offline-title', 'Offline'),
    h('p.small.muted', 'Once the app has loaded, it opens and works without a network. The word lists are saved on this device in the background while you are online, each recording the first time it plays.'),
    h('ul.list',
      h('li.setting', h('span', 'App on this device', appHint), appChip),
      h('li.setting', h('span', 'Space used on this device', usageHint)),
      h('li.setting', h('span', 'Keep data on this device', persistHint), storage?.persist ? [persistBtn, persistChip] : h('span.chip', 'Not offered'))),
    h('h3', 'Recordings for offline use'),
    h('div.panel',
      audioSummary,
      progressBox,
      saveBtn,
      cancelBtn,
      audioMessage,
      h('p.note', 'Words without a recording use your device\'s voice. Some device voices need a connection.'),
      h('div.row.spread', savedCount, removeBtn)),
    h('div.callout',
      h('strong', 'iPhone and iPad'),
      h('p.small', 'For offline use, add the app to your Home Screen: in Safari tap Share, then Add to Home Screen, and open it from there.'),
      h('p.small', 'The Home Screen app may not see what you saved in Safari (progress and recordings). If it starts empty, sign in to sync, or use Export and Import backup, and save the audio again inside the app.'),
      h('p.small', 'Safari may delete the data of websites you have not used for a while. Sign in or export a backup now and then, so your progress is never only on this device.')));
  el.lastElementChild.style.marginTop = '1rem';
  for (const p of el.lastElementChild.querySelectorAll('p')) p.style.margin = '0.4rem 0 0';

  let appSeq = 0;
  async function refreshApp() {
    if (!workerSupported) {
      appHint.textContent = 'This browser cannot keep the app for offline use (or it is in a private window).';
      replace(appChip, 'Not available');
      appChip.className = 'chip warn';
      return;
    }
    const seq = ++appSeq;
    const [version, reg, files] = await Promise.all([
      savedShellVersion().catch(() => null),
      navigator.serviceWorker.getRegistration().catch(() => null),
      dataFileStatus().catch(() => null),
    ]);
    if (!alive || seq !== appSeq) return; // a newer refresh is on its way
    const ready = Boolean(version && reg?.active);
    let lists = '';
    if (ready && files?.length) {
      const saved = files.filter((f) => f.saved).length;
      const rest = navigator.connection?.saveData
        ? 'Data Saver is on, so the others are saved only when you open them'
        : 'the others are saved while the app is open and online';
      lists = saved === files.length
        ? ' All word lists are saved too.'
        : ` Word lists: ${num(saved)} of ${num(files.length)} saved; ${rest}.`;
    }
    appHint.textContent = ready
      ? `Saved: opens without a network (version ${version}).${lists}`
      : 'Not saved yet. It is saved while the app is open and online; then reload once.';
    replace(appChip, ready ? 'Ready' : 'Not yet');
    appChip.className = ready ? 'chip good' : 'chip warn';
  }

  async function refreshStorage() {
    try {
      if (storage?.estimate) {
        const { usage, quota } = await storage.estimate();
        if (!alive) return;
        const used = `${formatBytes(usage)} in total: app, word lists, recordings and progress`;
        usageHint.textContent = Number.isFinite(quota) && quota > 0 ? `${used}. Your browser allows up to ${formatBytes(quota)}.` : `${used}.`;
      }
      if (storage?.persisted) {
        const kept = await storage.persisted();
        if (!alive) return;
        persistBtn.hidden = kept;
        persistChip.hidden = !kept;
      }
    } catch {
      usageHint.textContent = 'Not available in this browser.';
    }
  }

  async function askPersist() {
    const hadFocus = document.activeElement === persistBtn;
    persistBtn.disabled = true;
    let kept = false;
    try {
      kept = await storage.persist();
    } catch {
      kept = false;
    }
    persistBtn.disabled = false;
    if (!alive) return;
    persistBtn.hidden = kept;
    persistChip.hidden = !kept;
    const text = kept
      ? 'Done: the browser will not clear this app\'s data by itself, even when space runs low.'
      : 'The browser did not agree (yet). Some browsers decide by themselves, for example for installed apps or sites you use often; others ask you.';
    persistHint.textContent = text;
    announce(text);
    if (hadFocus) (kept ? persistChip : persistBtn).focus();
  }

  let audioSeq = 0;
  async function refreshAudio() {
    const seq = ++audioSeq; // only the latest refresh writes (one may start before a removal, one after)
    const saved = await savedAudioUrls().catch(() => new Set());
    if (!alive || seq !== audioSeq) return;
    savedCount.textContent = saved.size ? `${recordings(saved.size)} saved in total` : 'No recordings saved yet';
    removeBtn.hidden = saved.size === 0;
    if (!activeFiles) {
      try {
        activeFiles = audioFilesOf((await activeItems(ctx)).items);
      } catch {
        if (alive && seq === audioSeq) audioTotal.textContent = 'Your active decks could not be loaded (offline before they were saved?).';
        return;
      }
      if (!alive || seq !== audioSeq) return;
    }
    const savedHere = activeFiles.filter((f) => saved.has(absolute(f))).length;
    audioTotal.textContent = activeFiles.length
      ? `Your active decks use ${recordings(activeFiles.length)} (about ${formatBytes(estimateBytes(activeFiles))}).`
      : 'Your active decks have no recordings (they use the device voice).';
    let savedText = `${num(savedHere)} ${savedHere === 1 ? 'is' : 'are'}`;
    if (savedHere === activeFiles.length) savedText = activeFiles.length === 1 ? 'It is' : 'All of them are';
    audioSaved.textContent = activeFiles.length ? ` ${savedText} saved on this device.` : '';
  }

  let wasRunning = Boolean(job?.running);
  function showJob() {
    const running = Boolean(job?.running);
    const started = running && !wasRunning;
    const finished = !running && wasRunning;
    wasRunning = running;
    const hadFocus = document.activeElement;
    saveBtn.disabled = running || !workerSupported;
    cancelBtn.hidden = !running;
    progressBox.hidden = !running;
    audioSaved.hidden = running; // the progress line counts while saving
    if (running) {
      const total = Math.max(job.total, 1);
      progressBar.setAttribute('aria-valuemax', String(total));
      progressBar.setAttribute('aria-valuenow', String(job.saved));
      progressBar.setAttribute('aria-valuetext', job.phase === 'collecting' ? 'Preparing' : `${num(job.saved)} of ${num(job.total)}`);
      progressBar.firstElementChild.style.width = `${Math.round((job.saved / total) * 100)}%`;
      progressText.textContent = job.phase === 'collecting'
        ? 'Preparing the list of recordings…'
        : `Saving: ${num(job.saved)} of ${num(job.total)}${job.failed ? ` · ${num(job.failed)} failed` : ''}`;
      audioMessage.textContent = '';
      if (started && hadFocus === saveBtn) cancelBtn.focus();
    } else {
      audioMessage.textContent = job?.message ?? '';
      if (finished) {
        // The Cancel button disappears: keep keyboard focus in the section.
        if (hadFocus === cancelBtn || hadFocus === document.body) saveBtn.focus();
        refreshAudio().then(refreshStorage);
      }
    }
  }

  async function removeAudio() {
    if (!confirm('Remove the saved recordings from this device? They download again when played while online.')) return;
    const running = job?.running ? job : null;
    if (running) {
      // Stop the saving first, so nothing it fetched is saved after the removal.
      running.removing = true;
      running.controller.abort();
      await running.finished;
    }
    try {
      await caches.delete(AUDIO_CACHE);
      ctx.toast('Saved recordings removed from this device.');
    } catch (error) {
      ctx.toast(`Could not remove them: ${error?.message ?? error}`, 5000);
    }
    if (job && !job.running) job = null;
    if (!alive) return;
    audioMessage.textContent = '';
    if (document.activeElement === removeBtn || document.activeElement === document.body) saveBtn.focus();
    await refreshAudio();
    await refreshStorage();
  }

  const onJob = () => {
    if (alive) showJob();
  };
  jobListeners.add(onJob);
  // The word lists are saved in the background (warmUp, also started by main.js; one run at a time):
  // show the result once it is done.
  const afterWarmUp = () => warmUp().then((requested) => {
    if (alive && requested) {
      refreshApp();
      refreshStorage();
    }
  });
  const onControllerChange = () => {
    refreshApp();
    afterWarmUp();
  };
  if (hasWorker()) navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  if (job) showJob();
  refreshApp();
  refreshStorage();
  refreshAudio();
  afterWarmUp();

  return {
    el,
    cleanup() {
      alive = false;
      jobListeners.delete(onJob);
      if (hasWorker()) navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    },
  };
}
