// One HSK word: characters, pinyin (+ spoken form), meanings, levels in all three systems, audio with
// its source, phrases that use it, provenance, and the learner's state for it.

import { h, replace, icon, zh, py, num } from '../dom.js';
import { decodeCard, intervalLabel } from '../lib/srs.js';
import { audioButtons, markButtons, pinyinBlock, meaningList, levelChips } from './parts.js';

export async function render(root, ctx) {
  const { data, state, params } = ctx;
  const item = await data.getItem(params[0]);
  if (!item || item.kind !== 'word') {
    replace(root, h('h1', 'Word not found'), h('a.btn', { href: '#/search' }, 'Search'));
    return null;
  }
  const examples = await data.examplesFor(item.hanzi, { id: item.id });
  const cards = Object.entries(state.srs).filter(([id]) => id.startsWith(`${item.id}.`)).map(([id, e]) => ({ type: id.slice(item.id.length + 1), card: decodeCard(e.s) })).filter((c) => c.card && c.card.reps > 0);

  replace(root,
    h('button.btn.small', { type: 'button', onclick: () => history.back() }, icon('back'), 'Back'),
    h('section.panel.center',
      h('div.row.spread', h('span.chip', item.pos.length ? item.pos.join(' · ') : 'word'), markButtons(item, ctx)),
      h('h1', zh(item.hanzi, 'big-hanzi')),
      pinyinBlock(item, { big: true }),
      audioButtons(item, ctx)),
    h('h2', 'Meaning'),
    meaningList(item.meanings, { max: 10 }),
    item.classifiers.length ? h('p', 'Measure word: ', item.classifiers.map((c, i) => [i ? ', ' : '', zh(c)])) : null,
    h('h2', 'Levels'),
    levelChips(item, state.settings.levelSystem),
    item.freq ? h('p.small.muted', `Frequency rank ${num(item.freq)} in a large Chinese corpus (wordfreq).`) : null,
    examples.length ? [h('h2', 'In phrases'), h('ul.list', examples.map((p) => h('li', h('a.list-link', { href: `#/scene/${p.scene}` },
      h('span.grow', zh(p.hanzi, 'title'), h('span.sub', p.english)), icon('next')))))] : null,
    h('h2', 'Your progress'),
    cards.length
      ? h('ul.list', cards.map(({ type, card }) => h('li.setting', h('span', type), h('span.muted', card ? `${card.reps} reviews · next ${intervalLabel(card.due)}` : '')) ))
      : h('p.muted', state.markOf(item.id) === 'skip' ? 'Marked as known (skipped).' : 'Not studied yet.'),
    cards.length ? h('button.btn.small', { type: 'button', onclick: () => { state.resetItem(item.id); ctx.toast('Progress for this word reset'); ctx.navigate(location.hash); } }, 'Reset progress') : null,
    h('h2', 'Sources'),
    h('dl.kv',
      h('dt', 'Word list'), h('dd', item.levels.exam2025 !== null ? 'HSK exam syllabus 2025 (CLEC)' : item.levels.std2021 !== null ? 'GF 0025-2021 standard' : 'HSK 2.0 (2012)'),
      h('dt', 'Meaning'), h('dd', 'CC-CEDICT (MDBG), CC BY-SA 4.0'),
      h('dt', 'Pinyin check'), h('dd', item.resolution ? `Differs from CC-CEDICT; decision: ${item.resolution} (see data/hsk/resolutions.json)` : 'Matches CC-CEDICT'),
      h('dt', 'Audio'), h('dd', item.audio ? `${item.audio.speaker}, audio-cmn, CC BY-SA` : 'Your device\'s Chinese voice (synthetic; it may misread rare readings)')));
  return null;
}

export { py };
