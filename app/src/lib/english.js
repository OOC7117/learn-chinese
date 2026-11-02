// The English side of a flashcard shows English only. Dictionary glosses (CC-CEDICT) often carry Chinese in
// them: cross-references "(as in 有意 [yǒuyì] intentional)", pronunciation notes "(Taiwan pr. [hàn])",
// "also pr. [zhīdao]". This removes those asides and drops glosses that cannot be made English-only. Pure logic.

const CHINESE = /\p{Script=Han}|\[[^\]]*\]/u; // characters, or pinyin in CC-CEDICT's [brackets]

/** Remove every top-level "( ... )" group whose text contains Chinese; nested parentheses stay balanced. */
function dropChineseAsides(text) {
  let out = '';
  let depth = 0;
  let group = '';
  for (const ch of text) {
    if (ch === '(') {
      if (depth === 0) group = '';
      depth += 1;
    }
    if (depth > 0) group += ch;
    else out += ch;
    if (ch === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0 && !CHINESE.test(group)) out += group;
    }
  }
  if (depth > 0) out += group; // unbalanced: keep the rest as it was (the final check below decides)
  return out;
}

/** One gloss -> its English-only form, or null when nothing English-only is left. */
export function englishOnly(text) {
  if (typeof text !== 'string') return null;
  const cleaned = dropChineseAsides(text)
    .replace(/\s+([;,])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s;,]+|[\s;,:]+$/g, '');
  if (!cleaned || CHINESE.test(cleaned) || !/[a-z0-9]/i.test(cleaned)) return null;
  return cleaned;
}

/** The English-only glosses of a word, at most `max`, without duplicates. */
export function englishMeanings(meanings, { max = 4 } = {}) {
  const out = [];
  for (const m of meanings ?? []) {
    const e = englishOnly(m);
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/** The words a gloss points to: "erhua variant of 一点 [yīdiǎn]" -> ['一点']. */
export function referencedWords(meanings) {
  const out = [];
  for (const m of meanings ?? []) {
    for (const [, hanzi] of String(m).matchAll(/(\p{Script=Han}+) ?\[/gu)) if (!out.includes(hanzi)) out.push(hanzi);
  }
  return out;
}

/**
 * What the English side of a word card shows: { list, crossRef }.
 * 1. the word's own glosses, made English-only;
 * 2. else, for a gloss that only points to another word ("variant of", "see", "abbr. for"), that word's
 *    English-only glosses, when `lookup(hanzi)` knows it (-> [{ hanzi, meanings }]);
 * 3. else the glosses as they are, flagged crossRef (a few rare words; CC-CEDICT gives nothing else).
 */
export function englishGlosses(meanings, { max = 4, lookup = null, self = null } = {}) {
  const own = englishMeanings(meanings, { max });
  if (own.length) return { list: own, crossRef: false };
  for (const hanzi of referencedWords(meanings)) {
    if (hanzi === self) continue;
    for (const target of lookup?.(hanzi) ?? []) {
      const borrowed = englishMeanings(target.meanings, { max });
      if (borrowed.length) return { list: borrowed, crossRef: false };
    }
  }
  const list = (meanings ?? []).slice(0, max);
  return { list, crossRef: list.length > 0 };
}

