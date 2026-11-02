// Tiny DOM helpers. No framework: views build elements with h() and replace their root's content.

/**
 * h('button.primary#go', { type: 'button', onclick, aria: { pressed: 'true' }, data: { id }, lang }, ...children)
 * Children: strings, numbers, nodes, arrays, null/false (skipped). Attributes with value null/false are skipped.
 */
export function h(tag, attrs, ...children) {
  const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag) ?? [];
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  let kids = children;
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) kids = [attrs, ...children];
  else if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
      else if (key === 'aria') for (const [k, v] of Object.entries(value)) { if (v !== null && v !== undefined) el.setAttribute(`aria-${k}`, String(v)); }
      else if (key === 'data') for (const [k, v] of Object.entries(value)) { if (v !== null && v !== undefined) el.dataset[k] = String(v); }
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'text') el.textContent = value;
      // CSP style-src 'self' blocks style="" attributes but not CSSOM: styles are set property by property.
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, kids);
  return el;
}

// A run of Chinese inside other text: Han characters with the CJK punctuation between and around them.
const ZH_RUN = /[\u300A\u300C\u300E\uFF08\u201C]?\p{Script=Han}(?:[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]*\p{Script=Han})?[\u3001\u3002\u300B\u300D\u300F\uFF09\uFF0C\uFF01\uFF1A\uFF1B\uFF1F\u201D]*/gu;
const HAN = /\p{Script=Han}/u;
const PLAIN_TEXT_ONLY = new Set(['OPTION', 'TEXTAREA', 'TITLE', 'SCRIPT', 'STYLE']);

/** Text for `el`: Chinese inside English text (meanings, usage notes, source titles) gets lang="zh-Hans",
 * so phones choose Simplified Chinese glyphs and screen readers a Chinese voice for it. */
function textNode(el, text) {
  if (!HAN.test(text) || PLAIN_TEXT_ONLY.has(el.tagName) || /^zh(?!-Latn)/i.test(el.lang)) return text;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(ZH_RUN)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const span = document.createElement('span');
    span.lang = 'zh-Hans';
    span.textContent = m[0];
    frag.append(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

export function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : textNode(el, String(kid)));
  }
  return el;
}

/** Replace all children of `el`. */
export function replace(el, ...kids) {
  el.replaceChildren();
  return append(el, kids);
}

/** Chinese text with the right language tag, so browsers pick Simplified Chinese glyphs. */
export const zh = (text, cls = 'zh') => h('span', { class: cls, lang: 'zh-Hans' }, text);
/** Pinyin text (Latin with tone marks); lang zh-Latn-pinyin keeps screen readers from reading it as English words. */
export const py = (text, cls = 'pinyin') => h('span', { class: cls, lang: 'zh-Latn-pinyin' }, text);

const live = () => document.getElementById('live');
/** Screen-reader announcement (polite). */
export function announce(text) {
  const el = live();
  if (!el) return;
  el.textContent = '';
  // A new text node after a tick, so repeated messages are announced again.
  setTimeout(() => {
    el.textContent = text;
  }, 30);
}

/** Inline SVG icon from the sprite in index.html (<symbol id="i-name">). */
export function icon(name, label = null) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Format a number with thin grouping (12 345). */
export const num = (n) => new Intl.NumberFormat('en-GB').format(n);

/** A progress bar with an accessible label. */
export function bar(value, max, label) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return h('div.bar', { role: 'progressbar', aria: { valuemin: 0, valuemax: max, valuenow: value, label } },
    h('span.bar-fill', { style: { width: `${pct}%` } }));
}
