// Boot: storage, state, audio, router. Views live in src/views/<name>.js and export
// render(root, ctx) -> optional cleanup function. Everything works without the network once cached.

import { createStore, KEYS } from './lib/storage.js';
import { createState } from './state.js';
import { createAudio } from './audio.js';
import * as data from './data.js';
import { h, replace, announce } from './dom.js';
import { studyQueue } from './study-items.js';

const store = createStore();
const state = createState({ store });
const audio = createAudio({ getSettings: () => state.settings });

// Route name -> [view module, tab]
const ROUTES = {
  '': ['home', 'home'],
  study: ['study', 'study'],
  decks: ['decks', 'more'],
  deck: ['deck', 'more'],
  word: ['word', 'more'],
  search: ['search', 'more'],
  more: ['more', 'more'],
  speak: ['speak', 'speak'],
  scene: ['scene', 'speak'],
  dialogue: ['dialogue', 'speak'],
  kinship: ['kinship', 'speak'],
  facts: ['facts', 'speak'],
  tones: ['tones', 'tones'],
  grammar: ['grammar', 'more'],
  pitfalls: ['pitfalls', 'more'],
  progress: ['progress', 'more'],
  settings: ['settings', 'more'],
  about: ['about', 'more'],
};

const main = document.getElementById('main');
let cleanup = null;
let renderToken = 0;

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [path, queryString = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryString));
  return { name: parts[0] ?? '', params: parts.slice(1), query };
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

let toastTimer = null;
function toast(text, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

const ctx = { state, audio, data, store, navigate, toast, announce, h };

async function render() {
  const token = ++renderToken;
  const route = parseHash();
  const [view, tab] = ROUTES[route.name] ?? ROUTES[''];
  for (const a of document.querySelectorAll('.tabbar a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (error) {
      console.error('[main] cleanup failed', error);
    }
  }
  cleanup = null;
  audio.stop();
  try {
    const mod = await import(`./views/${view}.js`);
    if (token !== renderToken) return; // a newer navigation won
    replace(main);
    cleanup = await mod.render(main, { ...ctx, params: route.params, query: route.query, route });
    if (token === renderToken) {
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      const title = main.querySelector('h1')?.textContent;
      document.title = title ? `${title} · Learn Chinese` : 'Learn Chinese';
    }
  } catch (error) {
    console.error('[main] view failed', error);
    if (token !== renderToken) return;
    replace(main, h('div.panel',
      h('h1', 'Something went wrong'),
      h('p', navigator.onLine ? 'This page could not be shown.' : 'You are offline and this page has not been saved on this device yet.'),
      h('p.small.muted', String(error?.message ?? error)),
      h('a.btn', { href: '#/' }, 'Home')));
  }
}

// ---- Due badge on the Study tab ----
let badgeTimer = null;
function updateBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const { counts } = await studyQueue(ctx);
      const n = counts.learning + counts.review + counts.new;
      const badge = document.getElementById('due-badge');
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = n === 0;
      const tab = document.querySelector('.tabbar a[data-tab="study"]');
      tab?.setAttribute('aria-label', n ? `Study, ${n} cards due` : 'Study');
    } catch {
      // Data not reachable yet (offline before first load): no badge.
    }
  }, 400);
}

state.subscribe(() => updateBadge());
window.addEventListener('hashchange', render);
window.addEventListener('storage', (event) => {
  if (Object.values(KEYS).includes(event.key)) state.reload();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') updateBadge();
});

// ---- Service worker (offline) and updates ----
// sw.js keeps the app on this device. A new version installs in the background and waits; a small banner
// offers "Reload", which tells the waiting worker to take over ('skip-waiting') and reloads once it has.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const sw = navigator.serviceWorker;
  let controlled = Boolean(sw.controller);
  let reloadAsked = false;
  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };

  const offerUpdate = (worker, text) => {
    document.getElementById('update-banner')?.remove();
    const reload = h('button.btn.small.primary', { type: 'button' }, 'Reload');
    const later = h('button.btn.small', { type: 'button' }, 'Later');
    const banner = h('div.callout.row.spread#update-banner', { role: 'region', aria: { label: 'App update' } }, h('span', text), h('span.row', reload, later));
    banner.style.marginBottom = '0.75rem';
    reload.addEventListener('click', () => {
      reload.disabled = true;
      if (worker && worker.state === 'installed') {
        reloadAsked = true;
        worker.postMessage('skip-waiting'); // the page reloads on controllerchange
        setTimeout(reloadOnce, 4000); // in case the switch never happens
      } else reloadOnce();
    });
    later.addEventListener('click', () => {
      banner.remove();
      main.focus({ preventScroll: true });
    });
    document.querySelector('.app-header')?.after(banner);
    announce(`${text} The Reload button is at the top of the page.`);
  };

  sw.addEventListener('controllerchange', () => {
    if (reloadAsked) reloadOnce();
    else if (controlled) offerUpdate(null, 'The app was updated in another window.');
    // First visit: the worker took control after the page loaded its data; save that data for offline use.
    else import('./offline.js').then((mod) => mod.warmUp()).catch(() => {});
    controlled = true;
  });

  const register = () => sw.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    const tracked = new WeakSet();
    const track = (worker) => {
      if (!worker || tracked.has(worker)) return;
      tracked.add(worker);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && sw.controller) offerUpdate(worker, 'A new version of the app is ready.');
      });
    };
    if (reg.waiting && sw.controller) offerUpdate(reg.waiting, 'A new version of the app is ready.');
    track(reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    // Installed apps stay open for days: look for a new version when the app comes back to the screen.
    let checked = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - checked < 30 * 60 * 1000) return;
      checked = Date.now();
      reg.update().catch(() => {});
    });
  }).catch((error) => console.warn('[main] service worker not registered', error?.message));

  // After the page has loaded, so saving the app for offline use does not slow down the first visit.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// ---- Account and sync (optional; the app works without it) ----
import('./account.js').then((mod) => mod.initAccount?.(ctx)).catch((error) => {
  console.warn('[main] account features unavailable', error?.message);
  const btn = document.getElementById('account');
  if (btn) btn.hidden = true;
});

render();
updateBadge();
