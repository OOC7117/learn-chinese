// Home: today's work, goal and streak, active decks with progress, shortcuts.

import { h, replace, icon, num, bar } from '../dom.js';
import { studyQueue, activeItems } from '../study-items.js';
import { deckProgress } from '../lib/queue.js';
import { dayKey } from '../lib/queue.js';
import { dayStats, streak } from '../lib/stats.js';
import { activeDeckList, cardTypesFor } from '../lib/settings.js';
import { cleanToneStats, drillAccuracy, suggestNext } from '../lib/tonedrill.js';

const DRILL_NAME = { syllables: 'single syllables', pairs: 'two-syllable words', minimal: 'minimal pairs' };

/** The Tones entry: a first nudge before any tone practice (the method starts with tones), then the
 * suggested drill and the recent accuracy. */
function tonesLink(ctx) {
  let stats = null;
  try {
    stats = cleanToneStats(ctx.store.getJSON('tones'));
  } catch {
    stats = cleanToneStats(null);
  }
  const all = drillAccuracy(stats, null);
  const next = suggestNext(stats);
  const sub = all.n
    ? `Next: ${DRILL_NAME[next]} · ${Math.round(all.rate * 100)} % right in your last ${all.n} answers`
    : 'Start here: learn to hear the four tones (about 5 minutes a round)';
  return h('li', h('a.list-link', { href: all.n ? `#/tones/${next}` : '#/tones' }, icon('tones'),
    h('span.grow', h('span.title', 'Tones'), h('span.sub', sub)), icon('next')));
}

export async function render(root, ctx) {
  const { state, data } = ctx;
  const body = h('div');
  replace(root, h('h1', 'Today'), body);

  const draw = async () => {
    let q;
    let decks = [];
    try {
      [q, decks] = await Promise.all([studyQueue(ctx), data.loadDecks()]);
    } catch (error) {
      replace(body, h('div.panel', h('p', 'Your decks could not be loaded. ', navigator.onLine ? '' : 'You are offline and the data is not on this device yet.'), h('p.small.muted', String(error.message ?? error))));
      return;
    }
    const today = dayKey(state.dayStart());
    const done = dayStats(state.stats, today);
    const goal = state.settings.dailyGoal;
    const days = streak(state.stats, today);
    const due = q.counts.learning + q.counts.review + q.counts.new;
    const active = new Set(activeDeckList(state.settings));
    const activeDecks = decks.filter((d) => active.has(d.id));
    const neverStudied = Object.keys(state.srs).length === 0;

    const progressRows = [];
    for (const deck of activeDecks) {
      const items = await data.deckItems(deck);
      const p = deckProgress(items.map((it) => ({ id: it.id, types: cardTypesFor(it.kind, state.settings) })), state.srs, state.marks);
      const known = p.learned + p.skipped;
      progressRows.push(h('li', h('a.list-link', { href: `#/deck/${deck.id}` },
        h('span.grow', h('span.title', `${deck.group} · ${deck.title}`),
          h('span.sub', `${num(known)} of ${num(p.total)} known · ${num(p.learning)} learning`), bar(known, p.total, `${deck.title} progress`)),
        icon('next'))));
    }

    replace(body,
      h('section.panel',
        h('div.stat-grid',
          h('div.stat', h('span.value', num(due)), h('span.label', 'cards for now')),
          h('div.stat', h('span.value', `${num(done.r)}/${num(goal)}`), h('span.label', 'daily goal')),
          h('div.stat', h('span.value', num(days)), h('span.label', days === 1 ? 'day streak' : 'days streak'))),
        h('p.muted.small', `${q.counts.new} new · ${q.counts.learning} learning · ${q.counts.review} to review`),
        q.paused ? h('p.small', 'New words are paused until the overdue reviews are done (Settings → Pace).') : null,
        h('a.btn.primary.block', { href: '#/study' }, icon('study'), due ? 'Study now' : 'Open study')),
      neverStudied ? h('section.callout', h('strong', 'Already know some words? '),
        'You said you are around HSK 1–2. Open HSK 1 and mark the words you know (they will be skipped), then study the rest. ',
        h('a', { href: '#/deck/exam2025-1?triage=1' }, 'Sort HSK 1 words')) : null,
      h('div.section-title', h('h2', 'Active decks'), h('a.small', { href: '#/decks' }, 'Change')),
      progressRows.length ? h('ul.list', progressRows) : h('p.muted', 'No active decks. ', h('a', { href: '#/decks' }, 'Pick decks')),
      h('div.section-title', h('h2', 'Practise')),
      h('ul.list',
        tonesLink(ctx),
        h('li', h('a.list-link', { href: '#/speak' }, icon('speak'), h('span.grow', h('span.title', 'Speaking scenes'), h('span.sub', 'Travel, family, work: phrases and dialogues')), icon('next'))),
        h('li', h('a.list-link', { href: '#/kinship' }, icon('family'), h('span.grow', h('span.title', 'Family terms'), h('span.sub', 'Who is 舅舅 and who is 叔叔?')), icon('next'))),
        h('li', h('a.list-link', { href: '#/facts' }, icon('plane'), h('span.grow', h('span.title', 'Travel facts'), h('span.sub', 'Visa, payment, trains: dated and sourced')), icon('next'))),
        h('li', h('a.list-link', { href: '#/progress' }, icon('chart'), h('span.grow', h('span.title', 'Progress'), h('span.sub', 'Words known per level, pace, time to next level')), icon('next')))));
  };
  await draw();
  const off = state.subscribe(() => draw());
  return off;
}

export { activeItems };
