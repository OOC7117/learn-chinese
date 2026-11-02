// Offline use: Settings > Offline (is the app saved, storage used, persistent storage, saving the audio of
// the active decks ahead of time, removing it) and warmUp() for the first visit. The service worker
// (sw.js) does the rest by itself: it saves the app on the first visit, each data file when it is first
// used and each recording when it first plays (same caches as here).

import { h, replace, bar, num, announce } from './dom.js';
import { activeItems } from './study-items.js';

/** Cache names shared with the service worker (sw-logic.js; app/tests/sw.test.mjs keeps them equal). */
export const AUDIO_CACHE = 'learn-chinese-audio-v1';
export const SHELL_CACHE_PREFIX = 'learn-chinese-shell-';
/** Downloads at once when saving audio. */
export const CONCURRENCY = 6;
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

/** The version of the saved app shell, or null when no app shell is saved. */
async function savedShellVersion() {
  if (!hasCaches()) return null;
  const names = (await caches.keys()).filter((n) => n.startsWith(SHELL_CACHE_PREFIX));
  return names.length ? names[names.length - 1].slice(SHELL_CACHE_PREFIX.length) : null;
}

/**
 * First visit: the page loaded its data before the service worker took control, so the worker never saw
 * those requests. Request them again (now through the worker, mostly from the HTTP cache) so the app also
 * works offline on the next start. Called by main.js when the first worker takes control.
 */
export async function warmUp() {
  const urls = new Set();
  for (const entry of globalThis.performance?.getEntriesByType?.('resource') ?? []) {
    const url = new URL(entry.name, location.href);
    url.hash = '';
    if (url.origin === location.origin && /\/data\/[^/]+\.json$/.test(url.pathname)) urls.add(url.href);
  }
  await Promise.all([...urls].map((url) => fetch(url).then((res) => res.arrayBuffer()).catch(() => null)));
  return urls.size;
}

// One saving job per page, so it keeps going while you study and Settings shows it when you come back.
let job = null; // { running, phase: 'collecting' | 'saving', total, saved, failed, result, message, controller }
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
  job = { running: true, phase: 'collecting', total: 0, saved: 0, failed: 0, result: null, message: '', controller };
  emitJob();
  let lastQuarter = 0;
  (async () => {
    try {
      const files = audioFilesOf((await activeItems(ctx)).items);
      if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      Object.assign(job, { phase: 'saving', total: files.length });
      emitJob();
      announce(`Saving ${num(files.length)} recordings for offline use.`);
      const r = await saveFiles(files, {
        signal: controller.signal,
        onProgress: ({ saved, failed }) => {
          Object.assign(job, { saved, failed });
          const quarter = job.total ? Math.floor((saved / job.total) * 4) : 4;
          if (quarter > lastQuarter && quarter < 4) announce(`${quarter * 25}% of the recordings saved.`);
          lastQuarter = Math.max(lastQuarter, quarter);
          emitJob();
        },
      });
      job.saved = r.saved;
      const missing = r.total - r.saved;
      if (r.aborted) job.result = 'cancelled';
      else if (r.stopped) job.result = 'stopped';
      else job.result = missing ? 'partial' : 'done';
      job.message = {
        cancelled: `Stopped. ${num(r.saved)} of ${num(r.total)} recordings are saved; saving again continues where it stopped.`,
        stopped: `The connection seems to be gone. ${num(r.saved)} of ${num(r.total)} recordings are saved; try again when you are online.`,
        partial: `${num(r.saved)} of ${num(r.total)} recordings saved. ${num(missing)} could not be saved (connection or storage full); try again later.`,
        done: `All ${num(r.total)} recordings of your active decks are saved on this device.`,
      }[job.result];
    } catch (error) {
      const cancelled = controller.signal.aborted;
      job.result = cancelled ? 'cancelled' : 'error';
      job.message = cancelled ? 'Stopped.' : `Saving failed: ${error?.message ?? error}`;
    } finally {
      job.running = false;
      announce(job.message);
      if (!jobListeners.size && job.result !== 'cancelled') ctx.toast(job.message, 6000); // Settings is closed
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
  const persistBtn = h('button.btn.small', { type: 'button', onclick: askPersist }, 'Keep data');
  const persistChip = h('span.chip.good', { hidden: true, tabindex: '-1' }, 'Kept');
  // Recordings
  const audioSummary = h('p', 'Counting the recordings of your active decks…');
  const progressText = h('p.small');
  const progressBar = bar(0, 1, 'Recordings saved');
  const progressBox = h('div', { hidden: true }, progressBar, progressText);
  const saveBtn = h('button.btn.primary.block', { type: 'button', onclick: () => startSaving(ctx), disabled: !workerSupported }, 'Save audio of my active decks for offline use');
  const cancelBtn = h('button.btn.block', { type: 'button', hidden: true, onclick: () => job?.controller.abort() }, 'Cancel');
  const audioMessage = h('p.small');
  const savedCount = h('span.small.muted');
  const removeBtn = h('button.btn.small', { type: 'button', onclick: removeAudio, hidden: true }, 'Remove saved audio');
  progressBox.style.margin = '0.25rem 0 0.75rem';
  progressText.style.margin = '0.4rem 0 0';
  cancelBtn.style.marginTop = '0.5rem';

  const el = h('section', { aria: { labelledby: 'offline-title' } },
    h('h2#offline-title', 'Offline'),
    h('p.small.muted', 'Once the app has loaded, it opens and works without a network. Word lists are saved on this device as you use them, each recording the first time it plays.'),
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
      h('p.small', 'The Home Screen app keeps its own storage, separate from Safari: progress and recordings saved in Safari are not there. Sign in to sync, or use Export and Import backup, and save the audio again inside the app.'),
      h('p.small', 'Safari may delete the data of websites you have not used for a while. Sign in or export a backup now and then, so your progress is never only on this device.')));
  el.lastElementChild.style.marginTop = '1rem';
  for (const p of el.lastElementChild.querySelectorAll('p')) p.style.margin = '0.4rem 0 0';

  async function refreshApp() {
    if (!workerSupported) {
      appHint.textContent = 'This browser cannot keep the app for offline use (or it is in a private window).';
      replace(appChip, 'Not available');
      appChip.className = 'chip warn';
      return;
    }
    const version = await savedShellVersion().catch(() => null);
    if (!alive) return;
    const ready = Boolean(version && navigator.serviceWorker.controller);
    appHint.textContent = ready
      ? `Saved: opens without a network (version ${version}).`
      : 'Being saved now. Reload once while online to finish.';
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

  async function refreshAudio() {
    const saved = await savedAudioUrls().catch(() => new Set());
    if (!alive) return;
    savedCount.textContent = saved.size ? `${num(saved.size)} recordings saved in total` : 'No recordings saved yet';
    removeBtn.hidden = saved.size === 0;
    if (!activeFiles) {
      try {
        activeFiles = audioFilesOf((await activeItems(ctx)).items);
      } catch {
        if (alive) audioSummary.textContent = 'Your active decks could not be loaded (offline before they were saved?).';
        return;
      }
      if (!alive) return;
    }
    const savedHere = activeFiles.filter((f) => saved.has(absolute(f))).length;
    audioSummary.textContent = activeFiles.length
      ? `Your active decks use ${num(activeFiles.length)} recordings (about ${formatBytes(estimateBytes(activeFiles))}). ${savedHere === activeFiles.length ? 'All of them are' : `${num(savedHere)} are`} saved on this device.`
      : 'Your active decks have no recordings (they use the device voice).';
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
    job?.controller.abort();
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
  const onControllerChange = () => refreshApp();
  if (hasWorker()) navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  if (job) showJob();
  refreshApp();
  refreshStorage();
  refreshAudio();

  return {
    el,
    cleanup() {
      alive = false;
      jobListeners.delete(onJob);
      if (hasWorker()) navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    },
  };
}
