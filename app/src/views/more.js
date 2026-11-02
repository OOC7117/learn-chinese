// More: everything that is not on the tab bar.

import { h, replace, icon } from '../dom.js';

const LINKS = [
  ['#/decks', 'study', 'Decks', 'Choose what you study: HSK levels, scenes, family terms'],
  ['#/search', 'search', 'Search', 'Characters, pinyin or English'],
  ['#/progress', 'chart', 'Progress', 'Known words per level, pace, streak'],
  ['#/kinship', 'family', 'Family terms', 'The kinship chart'],
  ['#/grammar', 'book', 'Essential grammar', 'Sentence patterns with checked examples'],
  ['#/pitfalls', 'info', 'Pitfalls', 'Tone changes, 了, measure words, 的/得/地 and more'],
  ['#/facts', 'plane', 'Travel facts', 'Visa, payment, trains: dated and sourced'],
  ['#/settings', 'gear', 'Settings', 'New words per day, card types, audio, account, backup'],
  ['#/about', 'info', 'About and sources', 'Where every word, sound and fact comes from'],
];

export function render(root) {
  replace(root, h('h1', 'More'), h('ul.list', LINKS.map(([href, ic, title, sub]) => h('li', h('a.list-link', { href },
    icon(ic), h('span.grow', h('span.title', title), h('span.sub', sub)), icon('next'))))));
  return null;
}
