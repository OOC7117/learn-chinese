// Search by characters, pinyin (with or without tones, with or without spaces; v or ü) or English.
// Pure logic: index entries are { id, hanzi, pinyin, english, kind, rank }.

import { searchKey, tonedKey } from './pinyin.js';

const HAN = /\p{Script=Han}/u;

export function indexEntry(item) {
  const english = item.kind === 'word' ? (item.meanings ?? []).join(' ; ') : item.english ?? '';
  return {
    id: item.id,
    item,
    hanzi: item.hanzi,
    py: searchKey(item.pinyin),
    pyTone: tonedKey(item.pinyin),
    en: english.toLowerCase(),
    rank: item.freq ?? 50_000,
  };
}

/** What kind of query this is: 'hanzi' | 'pinyin-toned' | 'pinyin' | 'english' (plain Latin words could
 * be either pinyin or English: both are searched). */
export function queryKind(q) {
  if (HAN.test(q)) return 'hanzi';
  if (/[0-5]|[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(q)) return 'pinyin-toned';
  return 'latin';
}

/** Ranked results (best first), at most `limit`. */
export function search(entries, rawQuery, { limit = 50 } = {}) {
  const q = rawQuery.trim();
  if (!q) return [];
  const kind = queryKind(q);
  const scored = [];
  // Digits without a syllable ("3", "10") give no toned key (it would match everything): they are searched
  // like Latin words below, where English meanings have them ("three; 3").
  const toned = kind === 'pinyin-toned' ? tonedKey(q.replace(/v/g, 'ü')) : '';
  if (kind === 'hanzi') {
    for (const e of entries) {
      if (e.hanzi === q) scored.push([0, e]);
      else if (e.hanzi.startsWith(q)) scored.push([1, e]);
      else if (e.hanzi.includes(q)) scored.push([2, e]);
    }
  } else if (toned) {
    // A syllable typed without a tone ("ni3hao") matches any tone: compare with a regex.
    const pattern = new RegExp(`^${toned.replace(/5(?=[a-z]|$)/g, '[1-5]')}`);
    for (const e of entries) {
      if (e.pyTone === toned) scored.push([0, e]);
      else if (pattern.test(e.pyTone)) scored.push([1, e]);
    }
  } else {
    const key = searchKey(q);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const wordRe = new RegExp(`(^|[^a-z])${words.join('.*')}`, 'i');
    // A meaning (or one of its senses after "; ", or an alternative after "/ ") that starts with the query as
    // whole words (a plural -s/-es allowed), also after "to " (CC-CEDICT writes verbs "to love"), ranks above
    // other matches ("lovely", "brother's son", "thank you" for "you").
    const startRe = new RegExp(`(^|[;/] )(to )?${words.join(' ')}(e?s)?(?![a-z0-9'’])`);
    for (const e of entries) {
      if (key && e.py === key) scored.push([0, e]);
      else if (key && e.py.startsWith(key)) scored.push([2, e]);
      else if (wordRe.test(e.en)) scored.push([startRe.test(e.en) ? 1 : 3, e]);
    }
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].rank - b[1].rank || a[1].hanzi.length - b[1].hanzi.length);
  return scored.slice(0, limit).map(([, e]) => e.item);
}
