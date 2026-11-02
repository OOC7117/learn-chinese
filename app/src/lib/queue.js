// The practice queue: which card to study next. Pure logic (no DOM, no storage), unit tested.
//
// Vocabulary is organised in items (an HSK word, a phrase, a kinship term) with one card per card type
// ("read": characters -> pinyin + meaning, "listen": audio -> meaning, "speak": English -> say it,
// "cloze": sentence with a gap). The card types of an item are introduced one at a time, on different
// days: a new item starts with its first type, and the next type unlocks the day after the previous
// one was first reviewed. "New words per day" counts items, not cards.
//
// Order of a session: learning/relearning cards that are due, then the day's reviews (most overdue
// first) with the new cards spread evenly between them. Siblings (other cards of an item that was
// already studied today) wait until tomorrow, so one session never asks the same word twice in
// different forms. Items marked "skip" (already known) are never scheduled.

import { decodeCard, splitCardId, State, DAY, MINUTE } from './srs.js';

export const DEFAULT_QUEUE = Object.freeze({
  newPerDay: 10, // new items per day
  reviewLimit: 300, // reviews per day (the rest waits; overdue cards are not lost)
  learnAheadMin: 20, // learning cards due within this many minutes may be shown early when nothing else is left
  siblingPerDay: 20, // extra card types of already-started items unlocked per day
  dayStartHour: 4, // a study day runs from 04:00 to 04:00 local time
});

/** Start of the study day containing `now` (local time, `hour` o'clock). */
export function dayStartOf(now = Date.now(), hour = DEFAULT_QUEUE.dayStartHour) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  if (d.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
  return start.getTime();
}

/** "2026-11-02": the local date of a study day (by its start). */
export function dayKey(dayStart) {
  const d = new Date(dayStart);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const markOf = (marks, id) => (marks && Object.hasOwn(marks, id) ? marks[id]?.m ?? null : null);

/**
 * Classify every card of the given items.
 * @returns {{ learning: object[], review: object[], newItems: object[], siblings: object[],
 *            introducedToday: Set<string>, studiedToday: Set<string> }}
 */
export function classify({ items, srs = {}, marks = {}, now = Date.now(), dayStart = dayStartOf(now) }) {
  const dayEnd = dayStart + DAY;
  const learning = [];
  const review = [];
  const newItems = [];
  const siblings = [];
  const introducedToday = new Set(); // items whose first card was first reviewed today
  const studiedToday = new Set(); // items with any card reviewed today
  for (const item of items) {
    if (markOf(marks, item.id) === 'skip') continue;
    const types = item.types ?? [];
    const cards = types.map((type) => {
      const id = `${item.id}.${type}`;
      const entry = Object.hasOwn(srs, id) ? srs[id] : null;
      const card = entry ? decodeCard(entry.s) : null;
      const first = entry && Number.isSafeInteger(entry.f) && entry.f > 0 ? entry.f : card?.last_review?.getTime() ?? null;
      return { id, itemId: item.id, type, card, first };
    });
    const started = cards.filter((c) => c.card && c.card.reps > 0);
    if (started.length === 0) {
      if (cards.length) newItems.push({ ...cards[0], kind: 'new' });
      continue;
    }
    // First review of the item's first card today = introduced today.
    if (cards[0].card && cards[0].card.reps > 0 && cards[0].first !== null && cards[0].first >= dayStart) introducedToday.add(item.id);
    for (const c of started) {
      const last = c.card.last_review ? c.card.last_review.getTime() : 0;
      if (last >= dayStart) studiedToday.add(item.id);
    }
    for (const c of started) {
      const due = c.card.due.getTime();
      if (c.card.state === State.Learning || c.card.state === State.Relearning) learning.push({ ...c, kind: 'learning', due });
      else if (c.card.state === State.Review && due < dayEnd) review.push({ ...c, kind: 'review', due });
    }
    // The next unstarted type unlocks once the previous type was first studied before today.
    const nextIndex = cards.findIndex((c) => !c.card || c.card.reps === 0);
    if (nextIndex > 0) {
      const prev = cards[nextIndex - 1];
      if (prev.card && prev.card.reps > 0 && prev.first !== null && prev.first < dayStart) siblings.push({ ...cards[nextIndex], kind: 'new' });
    }
  }
  learning.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due);
  return { learning, review, newItems, siblings, introducedToday, studiedToday };
}

/**
 * Spread `b` evenly between the elements of `a`: [r r r n r r r n ...]. Keeps both orders.
 */
export function interleave(a, b) {
  if (!b.length) return [...a];
  if (!a.length) return [...b];
  const out = [];
  const step = (a.length + b.length) / b.length;
  let next = step / 2;
  let i = 0;
  let j = 0;
  for (let pos = 0; pos < a.length + b.length; pos += 1) {
    if (j < b.length && (pos + 1 >= next || i >= a.length)) {
      out.push(b[j]);
      j += 1;
      next += step;
    } else {
      out.push(a[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Today's queue.
 * @param {object} p
 * @param {Array<{id: string, types: string[]}>} p.items  study order (selected decks, most useful first)
 * @param {object} p.srs     { cardId: { s, t } }
 * @param {object} p.marks   { itemId: { m, t } }
 * @param {number} [p.now]
 * @param {object} [p.settings] see DEFAULT_QUEUE
 * @returns {{ queue: object[], waiting: object[], counts: { learning: number, review: number, new: number },
 *            newLeft: number, nextDue: number | null }}
 *   queue: cards to show now, in order; waiting: learning cards due later today (shown when due).
 */
export function buildQueue({ items, srs = {}, marks = {}, now = Date.now(), settings = {} }) {
  const cfg = { ...DEFAULT_QUEUE, ...settings };
  const dayStart = dayStartOf(now, cfg.dayStartHour);
  const c = classify({ items, srs, marks, now, dayStart });
  const learnAhead = now + cfg.learnAheadMin * MINUTE;

  const dueLearning = c.learning.filter((x) => x.due <= now);
  const laterLearning = c.learning.filter((x) => x.due > now);
  // Siblings of items already studied today wait for tomorrow (learning steps of the same card do not).
  const reviews = c.review.filter((x) => !c.studiedToday.has(x.itemId) || x.card.last_review.getTime() < dayStart)
    .filter((x, i, all) => all.findIndex((y) => y.itemId === x.itemId) === i) // one review per item per session
    .slice(0, cfg.reviewLimit);
  const reviewItems = new Set(reviews.map((x) => x.itemId));
  const newLeft = Math.max(0, cfg.newPerDay - c.introducedToday.size);
  const fresh = c.newItems.slice(0, newLeft);
  const siblings = c.siblings
    .filter((x) => !c.studiedToday.has(x.itemId) && !reviewItems.has(x.itemId))
    .slice(0, cfg.siblingPerDay);
  const newCards = interleave(fresh, siblings);

  const queue = [...dueLearning, ...interleave(reviews, newCards)];
  // Nothing else left: learning cards due within learnAheadMin may come early.
  if (queue.length === 0) queue.push(...laterLearning.filter((x) => x.due <= learnAhead));
  const shown = new Set(queue.map((x) => x.id));
  const waiting = laterLearning.filter((x) => !shown.has(x.id));
  return {
    queue,
    waiting,
    counts: { learning: c.learning.length, review: reviews.length, new: newCards.length },
    newLeft,
    nextDue: waiting.length ? waiting[0].due : null,
  };
}

/** Items of `items` whose id is in `ids` (Set), in the items' order. */
export function pick(items, ids) {
  return items.filter((item) => ids.has(item.id));
}

/** Progress of one deck: { total, skipped, learning, learned, mature, unseen } where learned = the item's
 * first card has graduated (Review state) and mature = its stability is at least 21 days. */
export function deckProgress(items, srs = {}, marks = {}) {
  const out = { total: items.length, skipped: 0, learning: 0, learned: 0, mature: 0, unseen: 0 };
  for (const item of items) {
    if (markOf(marks, item.id) === 'skip') {
      out.skipped += 1;
      continue;
    }
    const type = item.types?.[0];
    const entry = type ? srs[`${item.id}.${type}`] : null;
    const card = entry ? decodeCard(entry.s) : null;
    if (!card || card.reps === 0) out.unseen += 1;
    else if (card.state === State.Review) {
      out.learned += 1;
      if (card.stability >= 21) out.mature += 1;
    } else out.learning += 1;
  }
  return out;
}

/** Card ids of an item that exist in srs (for resetting an item). */
export function cardIdsOfItem(srs, itemId) {
  return Object.keys(srs).filter((id) => splitCardId(id).itemId === itemId);
}
