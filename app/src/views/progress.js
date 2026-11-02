// Progress: words known per HSK level (in the chosen level system), streak, daily goal, pace and the
// time to the next level at the current pace, and the review forecast for the coming week.

import { h, replace, num, bar } from '../dom.js';
import { deckProgress, dayKey } from '../lib/queue.js';
import { streak, dayStats, newPerDayPace, daysToFinish } from '../lib/stats.js';
import { cardTypesFor } from '../lib/settings.js';
import { decodeCard, DAY } from '../lib/srs.js';
import { SYSTEM_LABEL } from '../data.js';

export async function render(root, ctx) {
  const { state, data } = ctx;
  const system = ctx.query.system ?? state.settings.levelSystem;
  const body = h('div', h('p.muted', 'Loading…'));
  replace(root, h('h1', 'Progress'),
    h('div.segmented', { role: 'group', aria: { label: 'Level system' } }, ['exam2025', 'std2021', 'hsk20'].map((s) => h('a.seg', { href: `#/progress?system=${s}`, aria: { pressed: String(s === system) }, role: 'button' }, SYSTEM_LABEL[s]))),
    body);

  const decks = (await data.loadDecks()).filter((d) => d.kind === 'hsk' && d.system === system);
  const today = dayKey(state.dayStart());
  const pace = newPerDayPace(state.stats, today) ?? 0;
  const rows = [];
  let nextLevel = null;
  for (const deck of decks) {
    const items = await data.deckItems(deck);
    const p = deckProgress(items.map((it) => ({ id: it.id, types: cardTypesFor('word', state.settings) })), state.srs, state.marks);
    const known = p.learned + p.skipped;
    if (!nextLevel && known < p.total) nextLevel = { deck, remaining: p.total - known };
    rows.push(h('li', h('a.list-link', { href: `#/deck/${deck.id}` }, h('span.grow',
      h('span.title', deck.title),
      h('span.sub', `${num(known)} / ${num(p.total)} known · ${num(p.mature)} mature (21+ days) · ${num(p.learning)} learning`),
      bar(known, p.total, `${deck.title}: ${known} of ${p.total} known`)))));
  }
  const days = streak(state.stats, today);
  const t = dayStats(state.stats, today);
  // Reviews due in each of the next 7 days (cards in Review state).
  const forecast = Array.from({ length: 7 }, () => 0);
  const start = state.dayStart();
  for (const entry of Object.values(state.srs)) {
    const card = decodeCard(entry.s);
    if (!card || card.state !== 2) continue;
    const d = Math.floor((card.due.getTime() - start) / DAY);
    if (d >= 0 && d < 7) forecast[d] += 1;
    else if (d < 0) forecast[0] += 1;
  }
  const eta = nextLevel ? daysToFinish(nextLevel.remaining, pace || state.settings.newPerDay) : 0;
  replace(body,
    h('section.panel',
      h('div.stat-grid',
        h('div.stat', h('span.value', num(days)), h('span.label', 'day streak')),
        h('div.stat', h('span.value', `${num(t.r)}/${num(state.settings.dailyGoal)}`), h('span.label', 'goal today')),
        h('div.stat', h('span.value', pace ? pace.toFixed(1) : '–'), h('span.label', 'new words/day (14 days)'))),
      nextLevel ? h('p', `Next: ${nextLevel.deck.title}, ${num(nextLevel.remaining)} words to go. At ${pace ? `your pace (${pace.toFixed(1)}/day)` : `${state.settings.newPerDay} new words a day (your setting)`} that is about `, h('strong', `${num(eta)} days`), '.') : h('p', 'Every level of this list is known. 太棒了!'),
      h('p.small.muted', 'Known = learned with spaced repetition, or skipped as already known. Skipped words are not tested.')),
    h('h2', 'Levels'),
    h('ul.list', rows),
    h('h2', 'Reviews in the next 7 days'),
    h('div.forecast', forecast.map((n, i) => h('div.forecast-day', h('span.value', num(n)), h('span.label', i === 0 ? 'today' : i === 1 ? 'tmrw' : `+${i}d`)))));
  return null;
}
