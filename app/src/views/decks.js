// Decks: every deck, grouped, with a switch that adds it to (or removes it from) "Study".

import { h, replace, icon, num } from '../dom.js';
import { activeDeckList, withDeck } from '../lib/settings.js';

export async function render(root, ctx) {
  const { state, data } = ctx;
  const body = h('div');
  replace(root, h('h1', 'Decks'),
    h('p.muted', 'Switch on the decks you want in your daily study. The HSK levels follow the 2025 exam syllabus (the exam from 13 December 2026); the 2021 standard and HSK 2.0 levels are other views of the same words.'),
    body);
  const decks = await data.loadDecks();
  const groups = new Map();
  for (const d of decks) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  const draw = () => {
    const active = new Set(activeDeckList(state.settings));
    const sections = [];
    for (const [group, list] of groups) {
      sections.push(h('h2', group), h('ul.list', list.map((d) => {
        const id = `active-${d.id}`;
        return h('li.deck-row',
          h('a.list-link', { href: `#/deck/${d.id}` }, h('span.grow', h('span.title', d.title), h('span.sub', `${num(d.count)} ${d.kind === 'hsk' ? 'words' : 'items'}`)), icon('next')),
          h('label.visually-hidden', { for: id }, `Study ${group} ${d.title}`),
          h('input.switch', {
            type: 'checkbox', id, checked: active.has(d.id),
            onchange: (e) => state.updateSettings(withDeck(state.settings, d.id, e.target.checked)),
          }));
      })));
    }
    replace(body, sections);
  };
  draw();
  return state.subscribe((e) => {
    if (e.type === 'settings' || e.type === 'merge' || e.type === 'reload') draw();
  });
}
