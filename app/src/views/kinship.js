// Kinship chart: Chinese family terms by side and generation. Tap a term for its pinyin, audio, the
// relation in plain English, whether you use it to call the person (address) or to talk about them
// (reference), regional variants and sources. The terms are also a study deck ("Kinship terms").

import { h, replace, icon, zh, py } from '../dom.js';
import { activeDeckList, withDeck } from '../lib/settings.js';
import { audioButtons, markButtons, sourceList, richText, confidenceNote } from './parts.js';

const TABS = [
  ['family.kinship-paternal', "Father's side"],
  ['family.kinship-maternal', "Mother's side"],
  ['family.kinship-siblings-cousins', 'Siblings and cousins'],
  ['family.kinship-in-laws', 'In-laws and partner'],
];
const GENERATIONS = [[2, 'Grandparents'], [1, "Parents' generation"], [0, 'Your generation'], [-1, 'Children'], [-2, 'Grandchildren']];

export async function render(root, ctx) {
  const { data, state, query } = ctx;
  const content = await data.loadContent();
  const kin = content.kinship;
  if (!kin?.items?.length) {
    replace(root, h('h1', 'Family terms'), h('p.muted', 'No checked kinship terms yet.'));
    return null;
  }
  let tab = TABS.some(([id]) => id === query.tab) ? query.tab : TABS[0][0];
  let selected = null;
  const body = h('div');
  const detail = h('div.kin-detail', { aria: { live: 'polite' } });

  function chip(t) {
    const formal = t.reference_form && !t.address_form;
    return h(`button.kin-chip${formal ? '.formal' : ''}${selected?.id === t.id ? '.is-selected' : ''}`, {
      type: 'button',
      aria: { pressed: String(selected?.id === t.id), label: `${t.hanzi}, ${t.english}` },
      onclick: () => {
        selected = t;
        draw();
        ctx.audio.play(t);
        detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    }, zh(t.hanzi, 'kin-hanzi'), h('span.kin-en', shortEnglish(t.english)), formal ? h('span.kin-tag', 'formal') : null);
  }

  function draw() {
    const terms = kin.items.filter((t) => t.group === tab);
    const rows = GENERATIONS.map(([g, label]) => {
      const list = terms.filter((t) => t.generation === g);
      if (!list.length) return null;
      return h('div.kin-gen', h('h3', label), h('div.kin-row', list.map(chip)));
    }).filter(Boolean);
    const other = terms.filter((t) => !GENERATIONS.some(([g]) => g === t.generation));
    replace(body,
      h('div.segmented.kin-tabs', { role: 'group', aria: { label: 'Part of the family' } }, TABS.map(([id, label]) => h('button.seg', {
        type: 'button', aria: { pressed: String(id === tab) },
        onclick: () => { tab = id; selected = null; draw(); },
      }, label))),
      h('p.small.muted', 'Address = what you call the person; formal = used to talk about them or in writing.'),
      rows, other.length ? h('div.kin-gen', h('h3', 'Other'), h('div.kin-row', other.map(chip))) : null);
    replace(detail, selected ? termDetail(selected) : h('p.muted.small', 'Tap a term to hear it and see how it is used.'));
  }

  function termDetail(t) {
    return h('section.panel',
      h('div.row.spread', h('span.chip.accent', t.address_form ? (t.reference_form ? 'address + reference' : 'address') : 'reference / formal'), markButtons(t, ctx)),
      zh(t.hanzi, 'mid-hanzi'), h('div', py(t.pinyin)),
      h('p.meaning', t.english),
      audioButtons(t, ctx),
      t.usage ? h('p', richText(t.usage)) : null,
      t.regional_note ? h('p.note', h('strong', 'Regional: '), richText(t.regional_note)) : null,
      t.relation_path?.length ? h('p.small.muted', 'Path: ', t.relation_path.join(' → ')) : null,
      h('details', h('summary', 'Sources'), sourceList(t.sources), confidenceNote(t)));
  }

  const on = activeDeckList(state.settings).includes('kinship');
  replace(root,
    h('h1', 'Family terms'),
    h('p.muted', 'Chinese names relatives by side (father\'s or mother\'s), by age (older or younger than your parent or you) and by generation. With your partner\'s family you use the terms your partner uses.'),
    h('label.btn', h('input.switch', { type: 'checkbox', checked: on, onchange: (e) => state.updateSettings(withDeck(state.settings, 'kinship', e.target.checked)) }), 'Study these terms daily'),
    body, detail,
    kin.rules?.length ? [h('h2', 'Rules of thumb'), h('ul.rules', kin.rules.map((r) => h('li.rule', h('p', h('strong', richText(r.rule))), r.why ? h('p.note', richText(r.why)) : null, r.regional_note ? h('p.note', h('strong', 'Regional: '), richText(r.regional_note)) : null, h('details', h('summary', 'Sources'), sourceList(r.sources), confidenceNote(r)))))] : null);
  draw();
  return null;
}

/** "father's father (paternal grandfather); grandpa" -> "paternal grandfather" style short label. */
function shortEnglish(english) {
  const paren = /\(([^)]+)\)/.exec(english);
  const first = english.split(';')[0].replace(/\([^)]*\)/g, '').trim();
  // "father's father (paternal grandfather)" -> the parenthesis; "father's sister (formal)" -> the first part.
  const useParen = paren && paren[1].length < 28 && !/^(formal|written|north|south|coll\.?|informal)/i.test(paren[1]);
  const text = useParen ? paren[1] : first || english;
  return text.length > 30 ? `${text.slice(0, 28)}…` : text;
}
