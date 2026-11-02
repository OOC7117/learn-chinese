// Travel facts that change (visa, payment, trains, internet, emergencies), each with the date it was
// checked and the official page to re-check before travelling.
import { h, replace, icon } from '../dom.js';
import { sourceList } from './parts.js';

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
        h('summary', h('strong', f.question)),
        h('p', f.answer),
        h('p.small.muted', `Checked ${f.checked_on}`, f.recheck_url ? [' · ', h('a', { href: f.recheck_url, rel: 'noopener noreferrer', target: '_blank' }, 'Re-check here')] : null),
        sourceList(f.sources)))),
    ]) : h('p.muted', 'No checked facts yet.'),
    h('p', h('a', { href: '#/speak' }, icon('back'), ' Speaking scenes')));
  return null;
}
