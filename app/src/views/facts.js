// Travel facts that change (visa, payment, trains, internet, emergencies), each with the date it was
// checked and the official page to re-check before travelling.
import { h, replace, icon } from '../dom.js';
import { sourceList, lessCertainChip, confidenceNote } from './parts.js';

/** A fact with an end date (e.g. a visa policy) that has passed. */
const expired = (f) => Boolean(f.valid_until) && new Date().toISOString().slice(0, 10) > f.valid_until;

const TOPIC_LABEL = { visa: 'Entry and visa', accommodation: 'Staying with family or in hotels', payments: 'Paying', cash: 'Paying', foreign: 'Paying', trains: 'Trains', internet: 'Internet and apps', vpn: 'Internet and apps', apps: 'Internet and apps', emergency: 'Emergencies', dutch: 'Dutch embassy and travel advice', health: 'Entry and visa', online: 'Entry and visa', carry: 'Entry and visa', entry: 'Entry and visa' };

export async function render(root, ctx) {
  const content = await ctx.data.loadContent();
  const doc = content.facts;
  const facts = doc?.facts ?? [];
  const groups = new Map();
  for (const f of facts) {
    const label = TOPIC_LABEL[f.topic] ?? 'Other';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(f);
  }
  replace(root,
    h('h1', 'Travel facts'),
    h('p.callout.warn', h('strong', `Checked on ${doc?.checked_on ?? '–'}. `), 'Rules for visas, payments and trains change. Re-check each item on its official page before you travel.'),
    facts.length ? [...groups].map(([label, list]) => [
      h('h2', label),
      h('div.fact-list', list.map((f) => h('details.fact.panel',
        h('summary', h('strong', f.question), lessCertainChip(f) ? [' ', lessCertainChip(f)] : null, expired(f) ? [' ', h('span.chip.warn', 'out of date')] : null),
        expired(f) ? h('p.callout.warn', `This was valid until ${f.valid_until}. Check the official page for what applies now.`) : null,
        h('p', f.answer),
        h('p.small.muted', `Checked ${f.checked_on}`, f.recheck_url ? [' · ', h('a', { href: f.recheck_url, rel: 'noopener noreferrer', target: '_blank' }, 'Re-check here')] : null),
        sourceList(f.sources),
        confidenceNote(f)))),
    ]) : h('p.muted', 'No checked facts yet.'),
    openQuestions(doc?.open ?? []),
    h('p', h('a', { href: '#/speak' }, icon('back'), ' Speaking scenes')));
  return null;
}

/** Questions whose answers could not be double-checked: shown without an answer, with the official page. */
function openQuestions(list) {
  if (!list.length) return null;
  return [
    h('h2', 'Not double-checked yet'),
    h('p.small.muted', 'For these questions the answer found could not be confirmed by a second check, so it is not shown. Look them up yourself before you travel.'),
    h('ul.open-facts', list.map((f) => h('li',
      h('span', f.question),
      ' ',
      f.official_url ? h('a.small', { href: f.official_url, rel: 'noopener noreferrer', target: '_blank' }, 'Official page') : null))),
  ];
}
