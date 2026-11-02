// One deck: progress, study switch, word list with star/skip, filters, and triage ("I know it" /
// "Learn it": a quick way for an HSK 1-2 learner to skip what they already know).

import { h, replace, icon, num, bar, zh, py, announce } from '../dom.js';
import { activeDeckList, withDeck, cardTypesFor } from '../lib/settings.js';
import { deckProgress } from '../lib/queue.js';
import { audioButtons, markButtons } from './parts.js';

const PAGE = 100;

export async function render(root, ctx) {
  const { state, data, params, query } = ctx;
  const decks = await data.loadDecks();
  const deck = decks.find((d) => d.id === params[0]);
  if (!deck) {
    replace(root, h('h1', 'Deck not found'), h('a.btn', { href: '#/decks' }, 'All decks'));
    return null;
  }
  const items = await data.deckItems(deck);
  let filter = 'all';
  let shown = PAGE;
  let triage = query.triage === '1';
  let triageIndex = 0;
  const body = h('div');
  replace(root, h('a.btn.small', { href: '#/decks' }, icon('back'), 'Decks'), h('h1', `${deck.group} · ${deck.title}`), body);

  const visible = () => items.filter((it) => {
    const m = state.markOf(it.id);
    return filter === 'all' || (filter === 'starred' && m === 'star') || (filter === 'skipped' && m === 'skip');
  });

  function summary() {
    const p = deckProgress(items.map((it) => ({ id: it.id, types: cardTypesFor(it.kind, state.settings) })), state.srs, state.marks);
    const active = activeDeckList(state.settings).includes(deck.id);
    return h('section.panel',
      h('div.row.spread',
        h('div', h('strong', `${num(p.learned + p.skipped)} of ${num(p.total)} known`),
          h('div.small.muted', `${num(p.learned)} learned · ${num(p.skipped)} skipped · ${num(p.learning)} learning · ${num(p.unseen)} not started`)),
        h('label.row', h('span', 'Study'), h('input.switch', {
          type: 'checkbox', checked: active, aria: { label: `Include ${deck.title} in daily study` },
          onchange: (e) => state.updateSettings(withDeck(state.settings, deck.id, e.target.checked)),
        }))),
      bar(p.learned + p.skipped, p.total, 'Known'),
      h('div.row', { style: { marginTop: '0.75rem' } },
        h('a.btn.primary', { href: `#/study?deck=${encodeURIComponent(deck.id)}` }, icon('study'), 'Study this deck'),
        h('button.btn', { type: 'button', onclick: () => { triage = true; triageIndex = 0; draw(); } }, 'Sort: know / learn')));
  }

  function filterBar() {
    const counts = { all: items.length, starred: 0, skipped: 0 };
    for (const it of items) {
      const m = state.markOf(it.id);
      if (m === 'star') counts.starred += 1;
      if (m === 'skip') counts.skipped += 1;
    }
    return h('div.segmented', { role: 'group', aria: { label: 'Show' } },
      ['all', 'starred', 'skipped'].map((f) => h('button.seg', {
        type: 'button', aria: { pressed: String(filter === f) },
        onclick: () => { filter = f; shown = PAGE; draw(); },
      }, `${f[0].toUpperCase()}${f.slice(1)} ${counts[f]}`)));
  }

  function row(it) {
    const m = state.markOf(it.id);
    const href = it.kind === 'word' ? `#/word/${it.id}` : it.kind === 'phrase' ? `#/scene/${it.scene}` : '#/kinship';
    return h(`li.word-row${m === 'skip' ? '.is-skipped' : ''}`,
      h('a.hz', { href, lang: 'zh-Hans' }, it.hanzi),
      h('div.meta', py(it.pinyin), h('span.gloss', it.kind === 'word' ? it.meanings[0] ?? '' : it.english)),
      h('button.play-btn', { type: 'button', aria: { label: `Play ${it.hanzi}` }, onclick: () => ctx.audio.play(it) }, icon('play')),
      markButtons(it, ctx, { onChange: () => { if (filter !== 'all') draw(); } }));
  }

  function list() {
    const v = visible();
    return [
      h('ul.list', v.slice(0, shown).map(row)),
      v.length > shown ? h('button.btn.block', { type: 'button', style: { marginTop: '0.5rem' }, onclick: () => { shown += PAGE; draw(); } }, `Show more (${num(v.length - shown)} left)`) : null,
      v.length === 0 ? h('p.muted', filter === 'starred' ? 'No starred items. Tap the star on items you find hard.' : 'No skipped items.') : null,
    ];
  }

  // Triage: unseen, unmarked items one by one.
  function triageView() {
    const pending = items.filter((it) => !state.markOf(it.id) && !Object.keys(state.srs).some((id) => id.startsWith(`${it.id}.`)));
    if (triageIndex >= pending.length) {
      return h('section.panel', h('h2', 'Sorted'), h('p', 'Every item of this deck is either marked as known or waiting to be learned.'),
        h('button.btn.primary', { type: 'button', onclick: () => { triage = false; draw(); } }, 'Back to the list'));
    }
    const it = pending[triageIndex];
    const decide = (known) => {
      if (known) state.setMark(it.id, 'skip');
      else triageIndex += 1;
      announce(known ? `${it.hanzi}: known` : `${it.hanzi}: to learn`);
      draw();
    };
    return h('section.flashcard',
      h('span.card-kind', `Sort · ${pending.length - triageIndex} left`),
      h('div.prompt', zh(it.hanzi, it.kind === 'word' ? 'big-hanzi' : 'mid-hanzi'), py(it.pinyin, 'pinyin big-pinyin'),
        h('p.meaning', it.kind === 'word' ? it.meanings.slice(0, 2).join('; ') : it.english), audioButtons(it, ctx)),
      h('div.grades', { style: { gridTemplateColumns: '1fr 1fr', width: '100%' } },
        h('button.grade.good', { type: 'button', onclick: () => decide(true) }, 'I know it', h('span.when', 'skip')),
        h('button.grade.easy', { type: 'button', onclick: () => decide(false) }, 'Learn it', h('span.when', 'keep'))),
      h('button.btn.small', { type: 'button', onclick: () => { triage = false; draw(); } }, 'Stop sorting'));
  }

  function draw() {
    if (triage) replace(body, triageView());
    else replace(body, summary(), h('div.section-title', h('h2', 'Items')), filterBar(), h('div', { style: { marginTop: '0.5rem' } }, list()));
  }
  draw();
  return state.subscribe((e) => {
    if (e.type !== 'marks' && !triage) draw();
  });
}
