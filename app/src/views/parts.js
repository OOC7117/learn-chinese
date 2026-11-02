// Building blocks shared by the views: audio buttons, mark buttons, pinyin with spoken-tone hints,
// meanings, level chips, source lists.

import { h, icon, zh, py, announce } from '../dom.js';
import { SYSTEM_LABEL, refOf } from '../data.js';

/** Play + slow-play buttons for an item, with the audio source named (recording or device voice). */
export function audioButtons(item, ctx, { label = true } = {}) {
  const play = h('button.play-btn', { type: 'button', aria: { label: `Play ${item.hanzi}` }, onclick: () => ctx.audio.play(item) }, icon('play'));
  const slow = h('button.play-btn', { type: 'button', aria: { label: `Play ${item.hanzi} slowly` }, onclick: () => ctx.audio.play(item, { slow: true }) }, icon('slow'));
  const off = ctx.audio.onChange((p) => {
    if (!play.isConnected) {
      off(); // the view was replaced
      return;
    }
    play.classList.toggle('is-playing', Boolean(p && p.id === item.id));
  });
  const src = ctx.audio.sourceOf(item);
  return h('div.audio-row', play, slow, label ? h('span.audio-src', sourceLabel(src, item)) : null);
}

/** The label next to a play button: who or what speaks. */
export function sourceLabel(src, item) {
  if (src === 'recording') return `Recording · ${item.audio.speaker}`;
  if (src === 'generated') return 'Generated voice (synthetic)';
  return src === 'device' ? 'Device voice (synthetic)' : 'No audio on this device';
}

/** Star (hard) and skip (already known) toggles for an item. */
export function markButtons(item, ctx, { onChange } = {}) {
  const star = h('button.mark-btn.star', { type: 'button' }, icon('star'));
  const skip = h('button.mark-btn.skip', { type: 'button' }, icon('skip'));
  const sync = () => {
    const m = ctx.state.markOf(item.id);
    star.setAttribute('aria-pressed', String(m === 'star'));
    star.setAttribute('aria-label', m === 'star' ? `Unstar ${item.hanzi}` : `Star ${item.hanzi} (hard)`);
    skip.setAttribute('aria-pressed', String(m === 'skip'));
    skip.setAttribute('aria-label', m === 'skip' ? `Unskip ${item.hanzi}` : `Skip ${item.hanzi} (already known)`);
  };
  star.addEventListener('click', () => {
    ctx.state.toggleMark(item.id, 'star');
    sync();
    announce(ctx.state.markOf(item.id) === 'star' ? `${item.hanzi} starred` : `${item.hanzi} unstarred`);
    onChange?.();
  });
  skip.addEventListener('click', () => {
    ctx.state.toggleMark(item.id, 'skip');
    sync();
    announce(ctx.state.markOf(item.id) === 'skip' ? `${item.hanzi} skipped: marked as known` : `${item.hanzi} back in practice`);
    onChange?.();
  });
  sync();
  return h('span.marks', star, skip);
}

/** Pinyin (citation tones) and, when tone sandhi changes it, the spoken form. */
export function pinyinBlock(item, { big = false } = {}) {
  return h('div.pinyin-block',
    py(item.pinyin, big ? 'pinyin big-pinyin' : 'pinyin'),
    item.alt?.length ? h('div.note', 'Also: ', item.alt.map((a, i) => [i ? ', ' : '', py(a)])) : null,
    item.spoken ? h('div.spoken', 'Spoken: ', py(item.spoken), ' ', h('a', { href: '#/pitfalls/pitfalls.tone3-sandhi' }, 'tone change')) : null);
}

export function meaningList(meanings, { max = 6 } = {}) {
  const list = (meanings ?? []).slice(0, max);
  if (!list.length) return h('p.muted', 'No dictionary meaning for this reading.');
  if (list.length === 1) return h('p.meaning', list[0]);
  return h('div.meaning', h('ol', list.map((m) => h('li', m))));
}

export function levelChips(word, primary = 'exam2025') {
  const order = [primary, ...['exam2025', 'std2021', 'hsk20'].filter((s) => s !== primary)];
  return h('div.row', order.map((sys) => {
    const v = word.levels?.[sys];
    return h(`span.chip${sys === primary ? '.accent' : ''}`, v === null || v === undefined ? `${SYSTEM_LABEL[sys]}: not listed` : `${SYSTEM_LABEL[sys]} ${v}`);
  }));
}

export function sourceList(sources = []) {
  if (!sources.length) return null;
  return h('ul.source-list', sources.map((s) => h('li',
    s.url ? h('a', { href: s.url, rel: 'noopener noreferrer', target: '_blank' }, s.title || s.url) : (s.title ?? ''),
    s.publisher ? ` · ${s.publisher}` : '',
    s.accessed ? ` · checked ${s.accessed}` : '')));
}

export function backLink(href, text = 'Back') {
  return h('a.btn.small', { href }, icon('back'), text);
}

export { zh, py };

const REF = /\b(?:travel|family|work|grammar|pitfalls|facts|kinship)\.[a-z0-9.-]*[a-z0-9]/g;
/** Text with references to other content ids ("see travel.taxi.rule.receipt") turned into readable links. */
export function richText(text) {
  if (!text) return text;
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(REF)) {
    const ref = refOf(m[0]);
    if (!ref) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: ref.href }, ref.label));
    last = m.index + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The same text with id references replaced by their readable label, without links (for previews that
 * are themselves inside a link). */
export function plainText(text) {
  if (!text) return text;
  return String(text).replace(REF, (id) => refOf(id)?.label ?? id);
}
