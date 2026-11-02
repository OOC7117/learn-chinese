// Speak: the three situations (travel, family, work), their scenes, and shortcuts to the kinship chart
// and the travel facts.

import { h, replace, icon, num } from '../dom.js';
import { activeDeckList, withDeck } from '../lib/settings.js';

const ICONS = { travel: 'plane', family: 'family', work: 'work' };

export async function render(root, ctx) {
  const { data, state } = ctx;
  const content = await data.loadContent();
  const body = h('div');
  replace(root, h('h1', 'Speak'),
    h('p.muted', 'Real phrases for real situations, each checked against sources and a dictionary. Tap a scene to hear the phrases, read when (not) to use them, and practise a dialogue.'),
    body);
  const draw = () => {
    const active = new Set(activeDeckList(state.settings));
    const sections = [];
    for (const situation of content.situations ?? []) {
      sections.push(h('div.section-title', h('h2', icon(ICONS[situation.id] ?? 'speak'), ' ', situation.title)));
      if (situation.intro) sections.push(h('p.small.muted', situation.intro));
      sections.push(h('ul.list', situation.scenes.map((scene) => {
        const id = `scene-on-${scene.id}`;
        return h('li.deck-row',
          h('a.list-link', { href: `#/scene/${scene.id}` },
            h('span.grow', h('span.title', scene.title), h('span.sub', `${num(scene.items.length)} phrases${scene.dialogues?.length ? ` · ${scene.dialogues.length} dialogue${scene.dialogues.length > 1 ? 's' : ''}` : ''}${scene.rules?.length ? ` · ${scene.rules.length} tips` : ''}`)),
            icon('next')),
          h('label.visually-hidden', { for: id }, `Study ${scene.title} phrases daily`),
          h('input.switch', { type: 'checkbox', id, checked: active.has(scene.id), onchange: (e) => state.updateSettings(withDeck(state.settings, scene.id, e.target.checked)) }));
      })));
    }
    if (!sections.length) sections.push(h('p.muted', 'No checked phrases yet.'));
    sections.push(h('div.section-title', h('h2', 'Also')),
      h('ul.list',
        h('li', h('a.list-link', { href: '#/kinship' }, icon('family'), h('span.grow', h('span.title', 'Family terms'), h('span.sub', 'Interactive kinship chart: who is who, and what to call them')), icon('next'))),
        h('li', h('a.list-link', { href: '#/facts' }, icon('plane'), h('span.grow', h('span.title', 'Travel facts'), h('span.sub', 'Visa, payment, trains, internet: with the date they were checked')), icon('next')))));
    replace(body, sections);
  };
  draw();
  return state.subscribe((e) => {
    if (e.type === 'settings' || e.type === 'merge') draw();
  });
}
