// Hanyu Pinyin helpers. Pure ES module (no DOM, no dependencies): the browser app (display, search,
// tone-sandhi hints) and the build scripts (import, validator) import this same file, so both sides
// always agree on syllables, tone marks and search keys.
//
// Conventions
//   - "base": a syllable without tone, lower case, written with ü (never v or u:), e.g. "lü", "zhong".
//   - tone 1-4 = the four tones, 5 = neutral tone (unmarked). CC-CEDICT also writes 5; pinyin-pro writes 0.
//   - Marked pinyin uses precomposed tone marks (ā á ǎ à, ǖ ǘ ǚ ǜ) after NFC normalisation.
//   - Data keeps CITATION tones (dictionary tones: 一 yī, 不 bù, 你好 nǐ hǎo). spokenTones() derives the
//     tones as pronounced after tone sandhi, for display hints only.
//   - Erhua: a final r (一点儿 yīdiǎnr) is the pseudo-syllable "r" (CC-CEDICT writes it "r5").

/** Every syllable in CC-CEDICT (release 2026-05-18, 124,933 entries; its placeholder "xx" removed),
 * tone stripped, plus the syllabic nasals n and ng. Includes rare interjections (hm, hng, m) and the
 * erhua "r". Regenerate with `node scripts/gen-syllables.mjs` after updating CC-CEDICT. */
export const SYLLABLE_LIST = Object.freeze((
  'a ai an ang ao ba bai ban bang bao bei ben beng bi bia bian biang biao bie bin bing biu bo bu ca cai can cang '
  + 'cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun '
  + 'chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong '
  + 'dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen '
  + 'geng ging gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hm hng hong hou hu '
  + 'hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang '
  + 'kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian '
  + 'liang liao lie lin ling liu lo long lou lu luan lun luo lü lüe m ma mai man mang mao me mei men meng mi '
  + 'mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu '
  + 'nong nou nu nuan nun nuo nü nüe o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu '
  + 'qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun r ran rang rao re ren reng ri rong rou ru rua '
  + 'ruan rui run ruo sa sai san sang sao se sei sen seng sha shai shan shang shao she shei shen sheng shi shou '
  + 'shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti '
  + 'tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie '
  + 'xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang '
  + 'zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang '
  + 'zhui zhun zhuo zi zong zou zu zuan zui zun zuo'
  // Syllabic nasals of interjections (嗯 ńg / ňg / ǹg in the HSK lists; CC-CEDICT writes en):
  + ' n ng'
).split(' '));

export const SYLLABLES = new Set(SYLLABLE_LIST);
/** Syllables without an initial consonant (a, o, e, er, ai...). Inside a written word an apostrophe
 * comes before them (Xī'ān), so the splitter never starts one in the middle of a letter run. */
const VOWEL_INITIAL = /^[aoe]/;
/** Interjection syllables without a vowel (嗯 ǹg, 呣 ḿ, 哼 hng): only valid as a whole written word, never
 * inside one, otherwise "téngài" could split as té + n + gài. */
const STANDALONE = new Set(['n', 'ng', 'm', 'hm', 'hng']);
const MAX_SYLLABLE = 6; // chuang, zhuang, shuang

const MARKS = Object.freeze({ a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ' });
/** Syllabic nasals carry the mark on the m or n (ḿ, ń ň ǹ); there is no precomposed 1st-tone form. */
const NASAL_MARKS = Object.freeze({ m: ['m', 'ḿ', 'm', 'm'], n: ['n', 'ń', 'ň', 'ǹ'] });
/** marked vowel -> { v: the plain vowel (same case), tone } */
const MARKED = new Map();
for (const [vowel, marks] of Object.entries(MARKS)) {
  [...marks].forEach((mark, i) => {
    MARKED.set(mark, { v: vowel, tone: i + 1 });
    MARKED.set(mark.toUpperCase(), { v: vowel.toUpperCase(), tone: i + 1 });
  });
}
for (const [letter, marks] of Object.entries(NASAL_MARKS)) {
  marks.forEach((mark, i) => {
    if (mark === letter) return;
    MARKED.set(mark, { v: letter, tone: i + 1 });
    MARKED.set(mark.toUpperCase(), { v: letter.toUpperCase(), tone: i + 1 });
  });
}
const LETTER = /[a-zA-ZüÜ]/;
const isLetter = (ch) => LETTER.test(ch) || MARKED.has(ch);
const APOSTROPHES = new Set(["'", '’', '‘', '-']);

/** NFC (combining marks -> precomposed) and the ü spellings u: / U: -> ü. */
export function normalize(text) {
  return String(text ?? '').normalize('NFC').replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
}

/** Index of the vowel that carries the tone mark: a or e if present, the o of "ou", else the last
 * vowel (so iu -> u, ui -> i, uo -> o). -1 when there is no vowel (m, hm, hng, r). */
export function markIndex(base) {
  const s = String(base).toLowerCase();
  let at = s.indexOf('a');
  if (at < 0) at = s.indexOf('e');
  if (at < 0 && s.includes('ou')) at = s.indexOf('o');
  if (at < 0) {
    for (let i = s.length - 1; i >= 0; i -= 1) {
      if ('iouü'.includes(s[i])) {
        at = i;
        break;
      }
    }
  }
  return at;
}

/** ("zhong", 1) -> "zhōng"; tone 5 or 0 -> unmarked. Keeps the case of the base. */
export function markSyllable(base, tone) {
  const t = Number(tone);
  if (!(t >= 1 && t <= 4)) return base;
  const at = markIndex(base);
  if (at < 0) {
    const lower = String(base).toLowerCase();
    if (lower === 'n' || lower === 'ng' || lower === 'm') {
      const mark = NASAL_MARKS[lower[0]][t - 1];
      return (base[0] === lower[0] ? mark : mark.toUpperCase()) + base.slice(1);
    }
    return base;
  }
  const ch = base[at];
  const lower = ch.toLowerCase();
  const mark = MARKS[lower]?.[t - 1];
  if (!mark) return base;
  return base.slice(0, at) + (ch === lower ? mark : mark.toUpperCase()) + base.slice(at + 1);
}

/** One syllable "zhōng" | "zhong1" | "lv4" | "nu:3" | "r5" -> { base, tone, marks }. `marks` counts the
 * tone marks found (0 for numbered input), so callers can reject "hǎǒ". */
export function parseSyllable(text) {
  let s = normalize(text).trim();
  let tone = 5;
  let marks = 0;
  const numbered = /^([a-zA-ZüÜv]+)([0-5])$/.exec(s);
  if (numbered) {
    s = numbered[1];
    tone = Number(numbered[2]) || 5;
  } else {
    let plain = '';
    for (const ch of s) {
      const m = MARKED.get(ch);
      if (m) {
        marks += 1;
        tone = m.tone;
        plain += m.v;
      } else plain += ch;
    }
    s = plain;
  }
  return { base: s.toLowerCase().replace(/v/g, 'ü'), tone, marks };
}

/** "ni3 hao3" / "Ni3hao3" / "lv4" / "nu:3" -> "nǐ hǎo" / "Nǐhǎo" / "lǜ" / "nǚ". */
export function numberedToMarked(text) {
  return normalize(text).replace(/([a-zA-ZüÜv]+?)([0-5])/g, (_, syl, t) => markSyllable(syl.replace(/v/g, 'ü').replace(/V/g, 'Ü'), Number(t)));
}

/** Remove tone marks, keep ü: "Nǚ'ér" -> "Nü'er". */
export function stripTones(text) {
  let out = '';
  for (const ch of normalize(text)) out += MARKED.get(ch)?.v ?? ch;
  return out;
}

/**
 * Split a run of letters without spaces ("Shànghǎi", "yìdiǎnr") into syllables:
 * [{ text, base, tone, marks }], or null when it is not a sequence of valid syllables.
 * Vowel-initial syllables only at the start of the run (standard orthography writes an apostrophe
 * before them); "r" (erhua) only after another syllable. Longer syllables are tried first.
 */
export function splitChunk(chunk, { lenient = false } = {}) {
  const chars = [...normalize(chunk)];
  const plain = chars.map((ch) => (MARKED.get(ch)?.v ?? ch).toLowerCase().replace('v', 'ü'));
  const n = chars.length;
  const memo = new Map();
  function from(i) {
    if (i === n) return [];
    if (memo.has(i)) return memo.get(i);
    let result = null;
    for (let len = Math.min(MAX_SYLLABLE, n - i); len >= 1 && result === null; len -= 1) {
      const base = plain.slice(i, i + len).join('');
      if (!SYLLABLES.has(base)) continue;
      if (i > 0 && VOWEL_INITIAL.test(base) && !lenient) continue;
      if (STANDALONE.has(base) && !(i === 0 && len === n)) continue;
      if (base === 'r' && i === 0) continue;
      const rest = from(i + len);
      if (rest !== null) {
        const text = chars.slice(i, i + len).join('');
        const { tone, marks } = parseSyllable(text);
        result = [{ text, base, tone, marks }, ...rest];
      }
    }
    memo.set(i, result);
    return result;
  }
  return from(0);
}

/**
 * Tokenise pinyin text. Joining every token's `text` gives back the (normalised) input.
 * Token types: 'syllable' { text, base, tone, marks, word }, 'space', 'sep' (apostrophe or hyphen
 * inside a word), 'other' (punctuation, digits), 'unknown' (letters that are not pinyin, e.g. "WiFi").
 * `word` numbers the written words (0, 1, ...): syllables written together share a number.
 */
export function tokenize(text, { lenient = false } = {}) {
  const tokens = [];
  const chars = [...normalize(text)];
  let word = 0;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (isLetter(ch)) {
      let j = i;
      while (j < chars.length && isLetter(chars[j])) j += 1;
      const chunk = chars.slice(i, j).join('');
      const parts = splitChunk(chunk, { lenient });
      if (parts) {
        parts.forEach((p, k) => {
          // A vowel-initial syllable inside a run (only possible when lenient) gets its apostrophe back.
          if (k > 0 && VOWEL_INITIAL.test(p.base)) tokens.push({ type: 'sep', text: "'", added: true });
          tokens.push({ type: 'syllable', ...p, word });
        });
      }
      else tokens.push({ type: 'unknown', text: chunk, word });
      i = j;
      if (APOSTROPHES.has(chars[i]) && i + 1 < chars.length && isLetter(chars[i + 1])) {
        tokens.push({ type: 'sep', text: chars[i] });
        i += 1;
        continue; // same word
      }
      word += 1;
      continue;
    }
    tokens.push({ type: /\s/.test(ch) ? 'space' : 'other', text: ch });
    i += 1;
  }
  return tokens;
}

/** Syllables of a pinyin text as [{ base, tone }]; punctuation is dropped. With strict (default) a
 * letter run that is not pinyin throws. */
export function syllablesOf(text, { strict = true } = {}) {
  const out = [];
  for (const t of tokenize(text)) {
    if (t.type === 'syllable') out.push({ base: t.base, tone: t.tone });
    else if (t.type === 'unknown' && strict) throw new Error(`not pinyin: ${JSON.stringify(t.text)}`);
  }
  return out;
}

/** "Nǐ hǎo!" -> "ni3 hao3" (lower case, space separated, neutral tone 5). */
export function toNumbered(text) {
  return syllablesOf(text, { strict: false }).map((s) => `${s.base}${s.tone}`).join(' ');
}

/** CC-CEDICT pinyin "Bei3 jing1" | "lu:4" | "yi1 dian3 r5" -> [{ base, tone }]. Tokens that are not a
 * syllable with a tone digit (",", "·", Latin letters) are dropped. */
export function parseCedictPinyin(text) {
  const out = [];
  for (const part of String(text ?? '').split(/\s+/)) {
    const m = /^([a-zA-Zü:v]+)([1-5])$/.exec(part.replace(/u:/gi, 'ü'));
    if (m) out.push({ base: m[1].toLowerCase().replace(/v/g, 'ü'), tone: Number(m[2]) });
  }
  return out;
}

/** Display pinyin from syllables [{ base, tone }]: joined into one word with apostrophes where the
 * orthography needs them ("Xī'ān") and erhua attached ("yīdiǎnr"); `join: false` separates syllables. */
export function syllablesToMarked(syllables, { join = true } = {}) {
  const parts = syllables.map((s) => (s.base === 'r' ? 'r' : markSyllable(s.base, s.tone)));
  if (!join) return parts.join(' ');
  let out = '';
  parts.forEach((p, i) => {
    out += (i > 0 && p !== 'r' && VOWEL_INITIAL.test(stripTones(p).toLowerCase()) ? "'" : '') + p;
  });
  return out;
}

/** CC-CEDICT pinyin -> display pinyin: "yi1 dian3 r5" -> "yīdiǎnr", "Xi1 an1" -> "xī'ān". */
export function cedictToMarked(text, options) {
  return syllablesToMarked(parseCedictPinyin(text), options);
}

/** [{ base, tone }] equality, ignoring case. */
export function sameSyllables(a, b) {
  return a.length === b.length && a.every((s, i) => s.base === b[i].base && s.tone === b[i].tone);
}

/**
 * Problems in a marked pinyin text (for the validator): letter runs that are not valid syllables, more
 * than one tone mark in a syllable, a tone mark on the wrong vowel ("haǒ"), tone digits, v or u: for ü,
 * leftover combining diacritics. Returns [{ code, text, detail }]; empty = fine.
 */
export function pinyinProblems(text) {
  const raw = String(text ?? '');
  const s = normalize(raw);
  const problems = [];
  if (/[a-zü][0-5](?![0-9])/i.test(s)) problems.push({ code: 'tone-number', text: s, detail: 'tone numbers in marked pinyin' });
  if (/[\u0300-\u036f]/.test(s)) problems.push({ code: 'combining-mark', text: s, detail: 'combining diacritic that has no precomposed form' });
  if (/v|u:/i.test(raw)) problems.push({ code: 'v-for-u', text: s, detail: 'write ü, not v or u:' });
  for (const t of tokenize(s)) {
    if (t.type === 'unknown') problems.push({ code: 'not-pinyin', text: t.text, detail: 'not a sequence of valid syllables' });
    if (t.type !== 'syllable') continue;
    if (t.marks > 1) problems.push({ code: 'multiple-marks', text: t.text, detail: 'more than one tone mark in a syllable' });
    else if (t.marks === 1) {
      const expected = markSyllable(t.base, t.tone);
      if (expected !== t.text.toLowerCase()) problems.push({ code: 'mark-position', text: t.text, detail: `tone mark on the wrong letter, expected ${expected}` });
    }
  }
  return problems;
}

// ---------- Search keys ----------

/** Toneless search key: "Nǚ'ér" | "nv er" | "nu:3er2" | "nü er" -> "nver". */
export function searchKey(text) {
  return stripTones(normalize(text).replace(/[0-5]/g, '')).toLowerCase().replace(/ü/g, 'v').replace(/[^a-z]/g, '');
}

/** Toned search key: "Nǐ hǎo ma" | "ni3hao3 ma" -> "ni3hao3ma5" (ü as v; numbered input accepted). */
export function tonedKey(text) {
  const marked = /[0-5]/.test(String(text)) ? numberedToMarked(text) : text;
  return syllablesOf(marked, { strict: false }).map((s) => `${s.base.replace(/ü/g, 'v')}${s.tone}`).join('');
}

// ---------- Tone sandhi (display hints only) ----------

const NUMERALS = new Set([...'零〇一二三四五六七八九十百千万亿两几']);
const AFTER_YI_KEEPS = new Set([...'月号日']); // 一月 yīyuè, 一号 yīhào: dates and counting keep yī

/**
 * Tones as spoken after the standard sandhi rules, for one phrase. `chars` are the Han characters
 * and `tones` their citation tones (1-5), aligned 1:1. Conservative on purpose (only rules that hold
 * without knowing the phrase structure):
 *   - 不 bù -> bú before a 4th tone (不是 búshì); 不 already neutral stays neutral.
 *   - 一 yī -> yí before a 4th tone (一个 yígè), yì before tones 1, 2, 3 (一天 yìtiān); it keeps yī at the
 *     end, after 第 or another numeral, before a numeral or 月/号/日, and stays neutral when neutral.
 *   - Two 3rd tones in a row (and not part of a longer run) -> 2nd + 3rd (你好 níhǎo). Longer runs depend
 *     on how the phrase is grouped, so they get no hint.
 * Returns a new array of tones.
 */
export function spokenTones(chars, tones) {
  const out = [...tones];
  const n = Math.min(chars.length, tones.length);
  for (let i = 0; i < n; i += 1) {
    const next = i + 1 < n ? tones[i + 1] : null;
    if (chars[i] === '不' && tones[i] === 4 && next === 4) out[i] = 2;
    if (chars[i] === '一' && tones[i] === 1 && next !== null) {
      const prev = i > 0 ? chars[i - 1] : '';
      const nextChar = chars[i + 1];
      const keeps = prev === '第' || NUMERALS.has(prev) || NUMERALS.has(nextChar) || AFTER_YI_KEEPS.has(nextChar);
      if (!keeps && next !== 5) out[i] = next === 4 ? 2 : 4;
    }
  }
  // Third tones: runs of exactly two.
  let i = 0;
  while (i < n) {
    if (tones[i] !== 3) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && tones[j] === 3) j += 1;
    if (j - i === 2) out[i] = 2;
    i = j;
  }
  return out;
}

/**
 * The spoken form of a pinyin text for its Han characters, or null when nothing changes or the
 * syllables do not line up with the characters. Keeps spacing, punctuation and capitals:
 * ("你好！", "Nǐ hǎo!") -> "Ní hǎo!".
 */
export function spokenPinyin(hanzi, pinyin) {
  const chars = [...String(hanzi ?? '')].filter((ch) => /\p{Script=Han}/u.test(ch));
  const tokens = tokenize(pinyin);
  const syl = tokens.filter((t) => t.type === 'syllable');
  if (!syl.length || syl.length !== chars.length) return null;
  const spoken = spokenTones(chars, syl.map((s) => s.tone));
  if (spoken.every((t, k) => t === syl[k].tone)) return null;
  let k = 0;
  return tokens.map((t) => {
    if (t.type !== 'syllable') return t.text;
    const tone = spoken[k];
    k += 1;
    if (tone === t.tone) return t.text;
    const plainText = stripTones(t.text);
    return markSyllable(plainText, tone);
  }).join('');
}

/** Rewrite the syllables of a pinyin text with new tones (one per syllable, in order); spacing,
 * punctuation and capitals are kept. Returns null when the counts differ. */
export function withTones(pinyin, tones) {
  const tokens = tokenize(pinyin);
  const count = tokens.filter((t) => t.type === 'syllable').length;
  if (count !== tones.length) return null;
  let k = 0;
  return tokens.map((t) => {
    if (t.type !== 'syllable') return t.text;
    const tone = tones[k];
    k += 1;
    return tone === t.tone ? t.text : markSyllable(stripTones(t.text), tone);
  }).join('');
}

/**
 * Undo the tone changes of 一 and 不 that official lists and many textbooks print (一下 yíxià, 一起 yìqǐ,
 * 不要 búyào): the citation form has yī and bù. Neutral-tone 一/不 (看一看, 对不起) are left alone.
 * Returns the pinyin unchanged when the syllables do not line up with the Han characters.
 */
export function citationPinyin(hanzi, pinyin) {
  const chars = [...String(hanzi ?? '')].filter((ch) => /\p{Script=Han}/u.test(ch));
  const syl = tokenize(pinyin).filter((t) => t.type === 'syllable');
  if (syl.length !== chars.length) return pinyin;
  const tones = syl.map((s, i) => {
    if (chars[i] === '一' && s.base === 'yi' && (s.tone === 2 || s.tone === 4)) return 1;
    if (chars[i] === '不' && s.base === 'bu' && s.tone === 2) return 4;
    return s.tone;
  });
  return withTones(pinyin, tones) ?? pinyin;
}

/** Human-readable tone names. */
export const TONE_NAMES = Object.freeze({ 1: 'first tone (high, level)', 2: 'second tone (rising)', 3: 'third tone (low, dipping)', 4: 'fourth tone (falling)', 5: 'neutral tone (short, light)' });
