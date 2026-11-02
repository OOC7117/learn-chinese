// Which items "Study" draws from, and today's queue. Shared by the Study view, the Home view and the
// Study tab's badge.
//
// Active decks (settings.activeDecks) form streams: all active HSK decks together, in level order (so
// HSK 1 words come before HSK 2 words), and each scene or the kinship deck as its own stream. New
// items are taken from the streams in turn, so phrases and words are mixed (docs/RESEARCH.md: introduce
// words by situation, mix topics in reviews).

import { buildQueue } from './lib/queue.js';
import { activeDeckList, cardTypesFor } from './lib/settings.js';

/** Round-robin merge of several ordered lists (each list keeps its order). */
export function roundRobin(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i += 1) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

let phraseHanziCache = null;
/** Set of HSK word ids that occur inside a verified phrase (they get a cloze card). */
async function clozeWords(ctx, words) {
  const content = await ctx.data.loadContent().catch(() => null);
  const phrases = (content?.situations ?? []).flatMap((s) => s.scenes.flatMap((sc) => sc.items));
  if (!phrases.length) return new Set();
  phraseHanziCache ??= phrases.map((p) => p.hanzi);
  const out = new Set();
  for (const w of words) {
    if ([...w.hanzi].length < 2 && !['我', '你', '他', '她', '好', '是', '在', '有', '不', '要', '去', '吃', '喝'].includes(w.hanzi)) continue;
    if (phraseHanziCache.some((p) => p.includes(w.hanzi) && p !== w.hanzi)) out.add(w.id);
  }
  return out;
}

/** The items of the active decks (or one deck), in study order: { items, byId }. */
export async function activeItems(ctx, { deckId = null } = {}) {
  const decks = await ctx.data.loadDecks();
  const byDeck = new Map(decks.map((d) => [d.id, d]));
  const ids = deckId ? [deckId] : activeDeckList(ctx.state.settings);
  const hskDecks = ids.map((id) => byDeck.get(id)).filter((d) => d?.kind === 'hsk');
  const otherDecks = ids.map((id) => byDeck.get(id)).filter((d) => d && d.kind !== 'hsk');
  const hskStream = [];
  for (const deck of hskDecks) hskStream.push(...await ctx.data.deckItems(deck));
  const streams = [hskStream];
  for (const deck of otherDecks) streams.push(await ctx.data.deckItems(deck));
  const seen = new Set();
  const items = roundRobin(streams).filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
  return { items, byId: new Map(items.map((it) => [it.id, it])) };
}

/** Card types of an item for the current settings (cloze only for words that occur in a phrase). */
export function typesFor(item, settings, cloze) {
  const types = cardTypesFor(item.kind, settings);
  return item.kind === 'word' ? types.filter((t) => t !== 'cloze' || cloze.has(item.id)) : types;
}

/** Today's queue for the active decks (or one deck). Extra new items can be granted with `bonusNew`. */
export async function studyQueue(ctx, { deckId = null, bonusNew = 0, now = Date.now() } = {}) {
  const { items, byId } = await activeItems(ctx, { deckId });
  const settings = ctx.state.settings;
  const cloze = settings.typeCloze ? await clozeWords(ctx, items.filter((it) => it.kind === 'word')) : new Set();
  const queueItems = items.map((it) => ({ id: it.id, types: typesFor(it, settings, cloze) })).filter((x) => x.types.length);
  const result = buildQueue({
    items: queueItems,
    srs: ctx.state.srs,
    marks: ctx.state.marks,
    now,
    settings: { newPerDay: settings.newPerDay + bonusNew, reviewLimit: settings.reviewLimit, dayStartHour: settings.dayStartHour },
  });
  const firstType = new Map(queueItems.map((x) => [x.id, x.types[0]]));
  return { ...result, byId, firstType, total: items.length };
}
