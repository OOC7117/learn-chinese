// One scene: its phrases (what you say and what you will hear), usage notes, etiquette tips with
// sources, and the dialogue practice.

import { h, replace, icon, zh, py } from '../dom.js';
import { activeDeckList, withDeck } from '../lib/settings.js';
import { audioButtons, markButtons, sourceList } from './parts.js';

const SPEAKER = { me: 'You say', them: 'You hear', either: 'Either' };

export function phraseCard(p, ctx, { open = false } = {}) {
  return h('article.phrase', { id: `p-${p.id}` },
    h('div.phrase-head',
      h('span.chip', SPEAKER[p.speaker] ?? 'Phrase'),
      p.register && p.register !== 'neutral' ? h('span.chip', p.register) : null,
      h('span.grow'),
      markButtons(p, ctx)),
    zh(p.hanzi, 'phrase-hanzi'),
    h('div.phrase-pinyin', py(p.pinyin), p.spoken ? h('span.spoken', ' · spoken ', py(p.spoken)) : null),
    h('p.phrase-en', p.english),
    audioButtons(p, ctx),
    h('details.phrase-more', { open },
      h('summary', 'Usage, literal meaning, sources'),
      p.literal ? h('p.note', h('strong', 'Literally: '), p.literal) : null,
      p.usage ? h('p', p.usage) : null,
      p.regional_note ? h('p.note', h('strong', 'Regional: '), p.regional_note) : null,
      p.slots?.length ? h('p.note', h('strong', 'Swap in: '), p.slots.map((s, i) => [i ? '; ' : '', zh(s.text), ` (${s.meaning})`, s.examples?.length ? [': ', s.examples.map((e, k) => [k ? ', ' : '', zh(e)])] : null])) : null,
      sourceList(p.sources)));
}

export async function render(root, ctx) {
  const { data, state, params } = ctx;
  const content = await data.loadContent();
  let scene = null;
  let situation = null;
  for (const s of content.situations ?? []) for (const sc of s.scenes) if (sc.id === params[0]) [scene, situation] = [sc, s];
  if (!scene) {
    replace(root, h('h1', 'Scene not found'), h('a.btn', { href: '#/speak' }, 'All scenes'));
    return null;
  }
  const head = h('div');
  const drawHead = () => {
    const on = activeDeckList(state.settings).includes(scene.id);
    replace(head,
      h('a.btn.small', { href: '#/speak' }, icon('back'), situation.title),
      h('h1', scene.title),
      scene.description ? h('p.muted', scene.description) : null,
      h('div.row',
        scene.dialogues?.length ? h('a.btn.primary', { href: `#/dialogue/${scene.id}/${scene.dialogues[0].id}` }, icon('speak'), 'Practise the dialogue') : null,
        h('label.btn', h('input.switch', { type: 'checkbox', checked: on, onchange: (e) => state.updateSettings(withDeck(state.settings, scene.id, e.target.checked)) }), on ? 'In daily study' : 'Add to daily study')));
  };
  drawHead();
  replace(root,
    head,
    h('h2', `Phrases (${scene.items.length})`),
    h('div.phrase-list', scene.items.map((p) => phraseCard(p, ctx))),
    scene.rules?.length ? [h('h2', 'Etiquette and tips'), h('ul.rules', scene.rules.map((r) => h('li.rule',
      h('p', h('strong', r.rule)),
      r.why ? h('p.note', r.why) : null,
      r.regional_note ? h('p.note', h('strong', 'Regional: '), r.regional_note) : null,
      h('details', h('summary', 'Sources'), sourceList(r.sources)))))] : null);
  if (location.hash.includes('#p-')) document.getElementById(location.hash.split('#p-')[1])?.scrollIntoView();
  return state.subscribe((e) => {
    if (e.type === 'settings') drawHead();
  });
}
