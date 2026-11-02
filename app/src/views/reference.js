// Shared renderer for the grammar and pitfalls pages: a list of points, and one point with its rule,
// examples (correct and, for pitfalls, the typical mistake), audio and sources.

import { h, replace, icon, zh, py } from '../dom.js';
import { sourceList, sourceLabel, richText, plainText } from './parts.js';

export async function renderReference(root, ctx, { key, title, intro, base }) {
  const content = await ctx.data.loadContent();
  const doc = content[key];
  const items = doc?.items ?? [];
  const id = ctx.params[0];
  if (!id) {
    replace(root, h('h1', title), h('p.muted', intro),
      items.length ? h('ul.list', items.map((it) => h('li', h('a.list-link', { href: `#/${base}/${it.id}` },
        h('span.grow', h('span.title', it.title), h('span.sub', plainText(it.rule))), icon('next'))))) : h('p.muted', 'No checked items yet.'));
    return null;
  }
  const it = items.find((x) => x.id === id);
  if (!it) {
    replace(root, h('h1', 'Not found'), h('a.btn', { href: `#/${base}` }, title));
    return null;
  }
  replace(root,
    h('a.btn.small', { href: `#/${base}` }, icon('back'), title),
    h('h1', it.title),
    h('p.rule-text', richText(it.rule)),
    it.details ? h('p', richText(it.details)) : null,
    it.examples.length ? h('h2', 'Examples') : null,
    h('ul.examples', it.examples.map((ex) => { const item = { hanzi: ex.hanzi, id: ex.hanzi, audio: ex.audio ?? null }; return h(`li.example${ex.correct ? '' : '.wrong'}`,
      h('span.example-mark', { aria: { label: ex.correct ? 'correct' : 'incorrect' } }, ex.correct ? '✓' : '✗'),
      h('div.grow',
        zh(ex.hanzi, 'example-hanzi'),
        h('div', py(ex.pinyin), ex.spoken && ex.spoken !== ex.pinyin ? h('span.spoken', ' · spoken ', py(ex.spoken)) : null),
        h('p.example-en', ex.english),
        ex.correct ? h('p.audio-src', sourceLabel(ctx.audio.sourceOf(item), item)) : null,
        ex.source?.url ? h('a.small', { href: ex.source.url, rel: 'noopener noreferrer', target: '_blank' }, 'Source') : null),
      ex.correct ? h('button.play-btn', { type: 'button', aria: { label: `Play ${ex.hanzi}` }, onclick: () => ctx.audio.play(item) }, icon('play')) : null); })),
    it.common_mistake ? [h('h2', 'Common mistake'), h('p', richText(it.common_mistake))] : null,
    h('h2', 'Sources'), sourceList(it.sources));
  return null;
}
