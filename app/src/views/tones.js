// Tone trainer: #/tones (hub) and its pages #/tones/<page>:
//   chart      pinyin chart (finals x initials) of every syllable that has recordings; tap a syllable, pick
//              a tone, hear it
//   syllables  identification drill: 20 single syllables per round, answer 1-4, immediate feedback
//   pairs      20 two-syllable words per round: first tone 1-4, second tone 1-4 or neutral
//   minimal    minimal pairs: which of two words that differ only in their tones was played
//   record     beta: record yourself and compare pitch contours with the recording (no score)
// Rounds, statistics and the chart layout: src/lib/tonedrill.js; pitch tracking: src/lib/pitch.js;
// microphone: src/recorder.js (both loaded only by the record page). Statistics stay on this device
// (learn-chinese:v1:tones). Every sound is a native recording; the device voice is never used here,
// because a synthetic voice may get the tones wrong.

import { h, replace, icon, zh, py, announce, bar } from '../dom.js';
import { backLink } from './parts.js';
import { markSyllable, parseSyllable, syllablesOf } from '../lib/pinyin.js';
import * as drill from '../lib/tonedrill.js';

const SYLLABLE_SPEAKER = 'Chen Wang'; // app/audio/s/ (audio-cmn), as in data.js
// Labels as TONE_NAMES in lib/pinyin.js; contours and rules as in the sourced pitfalls the cards link to.
const TONE_INFO = Object.freeze({
  1: { label: 'high', code: '55', text: 'High and level.' },
  2: { label: 'rising', code: '35', text: 'Rises from the middle to high.' },
  3: { label: 'dipping', code: '214', text: 'Low. On its own it dips and rises again; before another tone it usually stays low (21), and before another third tone it is said as a second tone.', more: ['#/pitfalls/pitfalls.tone3-sandhi', 'Tone changes'] },
  4: { label: 'falling', code: '51', text: 'Falls from high to low.' },
  5: { label: 'neutral', code: null, text: 'Short and light, written without a tone mark. Its pitch depends on the tone before it.', more: ['#/pitfalls/pitfalls.neutral-tone', 'More about the neutral tone'] },
});
const toneText = (t) => (t === 5 ? 'neutral tone' : `tone ${t}`);
const ToneText = (t) => (t === 5 ? 'Neutral tone' : `Tone ${t}`);
const percent = (x) => `${Math.round(x * 100)} %`;
const tonePattern = (tones) => tones.map((t) => (t === 5 ? 'neutral' : t)).join(' + ');

const PAGES = { '': hubPage, chart: chartPage, syllables: syllablesPage, pairs: pairsPage, minimal: minimalPage, record: recordPage };

export function render(root, ctx) {
  const page = ctx.params[0] ?? '';
  if (!Object.hasOwn(PAGES, page)) {
    replace(root, backToHub(), h('h1', 'Page not found'), h('p', h('a', { href: '#/tones' }, 'All tone drills')));
    return null;
  }
  return PAGES[page](root, ctx);
}

// ---------- Shared pieces ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
}

/** The pitch shape of a tone on Chao's five-level scale, with the reference bar of his tone letters on the
 * right. Decorative: the text next to it always names the tone. */
function toneGlyph(tone, cls = '') {
  const y = (level) => 21 - (level - 1) * 4.5;
  const shape = {
    1: svg('path', { d: `M4 ${y(5)}H31` }),
    2: svg('path', { d: `M4 ${y(3)}L31 ${y(5)}` }),
    3: svg('path', { d: `M4 ${y(2)}Q15 ${y(1) + 7} 31 ${y(4)}` }),
    4: svg('path', { d: `M4 ${y(5)}L31 ${y(1)}` }),
    5: svg('circle', { cx: 17, cy: y(2.5), r: 3, class: 'tn-glyph-dot' }),
  }[tone];
  return svg('svg', { class: `tn-glyph ${cls}`.trim(), viewBox: '0 0 36 24', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: 'M34 3V21', class: 'tn-glyph-bar' }), shape);
}

const loadStats = (ctx) => drill.cleanToneStats(ctx.store.getJSON('tones'));
const saveStats = (ctx, stats) => ctx.store.setJSON('tones', stats);

const tonesOfItem = (item) => syllablesOf(item.pinyin, { strict: false }).map((s) => s.tone);
const sameTones = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
/** A recorded word whose tones are certain: its pinyin has `tones` and the dictionary notes no other
 * pronunciation with other tones (上面 shàngmiàn, also shàngmian: the speaker may have said either). */
const clearTones = (item, tones) => Boolean(item?.audio?.file) && sameTones(tonesOfItem(item), tones) && !drill.tonesInDoubt(tones, item.meanings);
/** The last item of a list that passes `test` (Array.prototype.findLast needs Safari 15.4). */
const lastOf = (list, test) => {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return list[i];
  return undefined;
};

/** Words by id, loading the word files level by level (drill words are HSK 1-5) instead of all at once. */
async function loadItems(ctx, ids, batches = [['1', '2', '3', '4'], ['5'], ['6'], ['7-9', 'other']]) {
  const out = new Map();
  const missing = () => ids.filter((id) => !out.has(id));
  const take = () => {
    for (const id of missing()) {
      const item = ctx.data.cachedItem(id);
      if (item) out.set(id, item);
    }
  };
  take();
  for (const batch of batches) {
    if (!missing().length) break;
    await Promise.all(batch.map((f) => ctx.data.loadWordFile(f).catch(() => null)));
    take();
  }
  return out;
}

/** playFile() also resolves false when a newer sound (a quick second tap) interrupts one that is still
 * loading; only a failure with nothing else playing, while offline, is worth a message. */
function reportPlay(ctx, ok) {
  if (!ok && !ctx.audio.playing && globalThis.navigator?.onLine === false) ctx.toast('This recording is not saved on this device yet, and you are offline.');
  return ok;
}

function playSyllable(ctx, base, tone) {
  return ctx.audio.playFile(drill.syllableUrl(base, tone), { id: `${base}${tone}` }).then((ok) => reportPlay(ctx, ok));
}

function playWord(ctx, item) {
  if (!item?.audio?.file) return Promise.resolve(false);
  return ctx.audio.playFile(item.audio.file, { id: item.id }).then((ok) => reportPlay(ctx, ok));
}

/** Plays a list of async steps one after the other; a newer sequence (or stop()) cancels the rest. */
function sequencer() {
  let token = 0;
  return {
    async run(steps) {
      const mine = ++token;
      for (const step of steps) {
        if (mine !== token) return false;
        await step();
      }
      return mine === token;
    },
    stop() {
      token += 1;
    },
  };
}

function errorPanel(text, error, retry) {
  return h('div.panel',
    h('p', text, ' ', navigator.onLine ? '' : 'You are offline and it is not saved on this device yet.'),
    error ? h('p.small.muted', String(error.message ?? error)) : null,
    retry ? h('button.btn', { type: 'button', onclick: retry }, 'Try again') : null);
}

/**
 * Tone answer buttons (number, contour glyph and name; never colour alone). Before the answer:
 * onPick(tone); `selected` (when given, even null) makes them toggle buttons showing a provisional choice
 * (aria-pressed). After it (`correct` set): the right tone gets a check mark, a wrong choice a cross, and
 * the buttons stop responding.
 */
function answerGroup({ tones, label, onPick = null, selected, chosen = null, correct = null }) {
  const answered = correct !== null;
  const pressable = selected !== undefined && !answered;
  return h('div.tn-answers', { role: 'group', aria: { label }, class: tones.length === 5 ? 'tn-five' : null },
    tones.map((t) => {
      const isRight = answered && t === correct;
      const isWrong = answered && t === chosen && t !== correct;
      return h('button.tn-answer', {
        type: 'button',
        class: isRight ? 'is-right' : isWrong ? 'is-wrong' : null,
        aria: { pressed: pressable ? String(selected === t) : null, disabled: answered ? 'true' : null, keyshortcuts: t === 5 ? '5' : String(t) },
        data: { tone: t },
        onclick: answered || !onPick ? null : () => onPick(t),
      },
      toneGlyph(t),
      // Accessible name "Tone 3, dipping" / "neutral tone": the big number is visual only.
      h('span.tn-answer-num', { aria: { hidden: 'true' } }, t === 5 ? '·' : String(t)),
      h('span.tn-answer-label', h('span.visually-hidden', t === 5 ? '' : `Tone ${t}, `), TONE_INFO[t].label, t === 5 ? h('span.visually-hidden', ' tone') : null),
      isRight ? h('span.tn-mark', icon('check'), h('span.visually-hidden', t === chosen ? ', your answer, right' : ', right answer')) : null,
      isWrong ? h('span.tn-mark', icon('x'), h('span.visually-hidden', ', your answer')) : null);
    }));
}

/** The shared back link, with a full 44 px tap target on these pages. */
function backToHub() {
  const link = backLink('#/tones', 'Tones');
  link.classList.add('tn-back');
  return link;
}

function keysNote(text) {
  return h('p.note.center.tn-keys', text);
}

// ---------- Hub ----------

function hubPage(root, ctx) {
  const stats = loadStats(ctx);
  const neutralExample = h('span.tn-example');
  const accuracy = h('div.tn-acc');
  const next = drill.suggestNext(stats);
  const roundLine = (code) => {
    const r = stats.rounds[code];
    return r ? ` · best ${r.best[0]}/${r.best[1]}` : '';
  };
  const drillLink = (href, ic, title, sub, chip = null) => h('li', h('a.list-link', { href },
    ic, h('span.grow', h('span.title', title, chip), h('span.sub', sub)), icon('next', null)));
  const chip = (text, cls = 'accent') => h(`span.chip.${cls}.tn-chip`, text);

  const toneCard = (t) => h('li.tn-tone',
    toneGlyph(t, 'tn-glyph-big'),
    h('div.tn-tone-text',
      h('h3', ToneText(t), t <= 4 ? h('span.tn-tone-label', ` · ${TONE_INFO[t].label}`) : null, TONE_INFO[t].code ? h('span.tn-tone-code', ` (${TONE_INFO[t].code})`) : null),
      h('p', TONE_INFO[t].text, TONE_INFO[t].more ? [' ', h('a', { href: TONE_INFO[t].more[0] }, TONE_INFO[t].more[1]), '.'] : null)),
    t <= 4
      ? h('button.btn.tn-example-btn', { type: 'button', aria: { label: `Play ${markSyllable('ma', t)}` }, onclick: () => playSyllable(ctx, 'ma', t) }, icon('play'), py(markSyllable('ma', t)))
      : neutralExample);

  const draw = () => {
    const s = loadStats(ctx);
    const acc = drill.toneAccuracy(s);
    const answers = s.recent.length;
    const confusions = drill.topConfusions(s, { limit: 2 });
    replace(accuracy,
      answers
        ? h('ul.list.tn-accuracy', [1, 2, 3, 4, 5].map((t) => {
          const a = acc[t];
          return h('li.tn-acc-row',
            toneGlyph(t),
            h('span.tn-acc-name', ToneText(t)),
            a.n ? bar(a.correct, a.n, `${ToneText(t)}: ${percent(a.rate)} right`) : h('span.tn-acc-none', 'no answers yet'),
            a.n ? h('span.tn-acc-value', percent(a.rate), h('span.tn-acc-n', ` of ${a.n}`)) : null);
        }))
        : h('p.muted', 'No answers yet. Your accuracy for each tone appears here after the first drill.'),
      confusions.length ? h('p.small', 'Most often mixed up: ', confusions.map((c, i) => [i ? '; ' : '',
        h('strong', `${toneText(c.target)} heard as ${toneText(c.answer)}`), ` (${c.count}×)`])) : null,
      answers ? h('p.small.muted', `From your last ${answers} answers on this device.`) : null,
      answers ? h('button.btn.small', {
        type: 'button',
        onclick: () => {
          if (!confirm('Reset your tone statistics on this device?')) return;
          ctx.store.remove('tones');
          draw();
          announce('Tone statistics reset');
        },
      }, 'Reset statistics') : null);
  };

  replace(root,
    h('h1', 'Tones'),
    h('p.tn-lead', 'Every Mandarin syllable has one of four tones or the light neutral tone, and the tone is part of the word: ',
      ['mā', 'má', 'mǎ', 'mà'].map((s, i) => [i ? ', ' : '', py(s)]), ' are four different syllables.'),
    h('ul.tn-tones', [1, 2, 3, 4, 5].map(toneCard)),
    h('p.small.muted', 'Numbers in brackets: pitch from 1 (lowest) to 5 (highest) within your own voice (Chao tone letters). See also ',
      h('a', { href: '#/pitfalls/pitfalls.tone3-sandhi' }, 'tone changes'), '.'),
    h('div.section-title', h('h2', 'Practise')),
    h('ul.list.tn-drills',
      drillLink('#/tones/syllables', icon('tones'), '1 · Single syllables', `Hear a syllable, choose its tone · 20 per round${roundLine('s')}`, next === 'syllables' ? chip(stats.recent.length ? 'Suggested' : 'Start here') : null),
      drillLink('#/tones/pairs', icon('speak'), '2 · Two-syllable words', `Both tones of a word · 20 per round${roundLine('p')}`, next === 'pairs' ? chip('Suggested') : null),
      drillLink('#/tones/minimal', icon('sync'), '3 · Minimal pairs', `Two words that differ only in tone: which one was it?${roundLine('m')}`, next === 'minimal' ? chip('Suggested') : null),
      drillLink('#/tones/chart', icon('book'), 'Pinyin chart', 'Every syllable with recordings of its tones'),
      drillLink('#/tones/record', icon('mic'), 'Record and compare', 'Say it, then see your pitch next to the speaker’s', chip('Beta', 'warn'))),
    h('div.section-title', h('h2', 'Your accuracy per tone')),
    accuracy,
    h('p.small.muted.tn-method', 'How the drills work: you hear native recordings of many different syllables and words and get the answer at once, the approach of high-variability phonetic training. Rounds include more of the tones you mix up. Start with single syllables and move on to words when about 8 in 10 answers are right.'));
  draw();

  // The neutral-tone example: the first recorded word of tones.json "15" (first tone + neutral) whose tones
  // are certain.
  ctx.data.loadTones().then(async (data) => {
    const ids = (data.pairs?.['15'] ?? []).slice(0, 6);
    if (!ids.length) return;
    const items = await loadItems(ctx, ids, [['1'], ['2'], ['3'], ['4'], ['5']]);
    const item = ids.map((id) => items.get(id)).find((it) => clearTones(it, [1, 5]));
    if (!item || !neutralExample.isConnected) return;
    replace(neutralExample, h('button.btn.tn-example-btn', { type: 'button', aria: { label: `Play ${item.hanzi} ${item.pinyin}` }, onclick: () => playWord(ctx, item) },
      icon('play'), zh(item.hanzi), ' ', py(item.pinyin)));
  }).catch(() => {});

  const onStorage = (event) => {
    if (event.key?.endsWith(':tones')) draw();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

// ---------- Drill engine (syllables, pairs, minimal pairs) ----------

/**
 * One drill page: intro -> items (play, answer, feedback, next) -> summary. `spec`:
 *   code, title, lead (nodes), keys (text), load(stats) -> Promise<items>, play(item),
 *   target(item) -> tones, prompt(item, submit, result) -> { node, digit?(d) -> handled },
 *   pairsFor?(item, answer) -> [[target, answer], ...] (default: every syllable),
 *   feedback(item, result) -> node, say(item, result) -> text, review(item, result) -> node,
 *   answered?(item, result) (after the feedback is shown), stop?() (round over or page left)
 * Statistics are read from storage again before every save, so another tab's answers (or a reset on the
 * hub) are never overwritten with this page's older copy.
 */
function runDrill(root, ctx, spec) {
  let stats = loadStats(ctx);
  let items = [];
  let results = [];
  let index = 0;
  let phase = 'intro';
  let pending = null;
  let controller = null;
  let disposed = false;
  let starting = false;
  const body = h('div.tn-drill');
  replace(root, backToHub(), h('h1', spec.title), body);

  const prepare = () => {
    pending = spec.load(stats);
    pending.catch(() => {}); // reported when the round starts
    return pending;
  };
  const play = (item) => {
    if (!disposed) spec.play(item);
  };
  const pairsFor = (item, answer) => (spec.pairsFor ? spec.pairsFor(item, answer) : spec.target(item).map((t, i) => [t, answer[i]]));

  function header() {
    const right = results.filter((r) => r?.correct).length;
    return h('div.tn-progress',
      h('span.tn-count', `${Math.min(index + 1, items.length)} / ${items.length}`),
      bar(index + (phase === 'answered' ? 1 : 0), items.length, 'Round progress'),
      h('span.tn-score', `${right} right`));
  }

  function drawIntro() {
    phase = 'intro';
    const r = stats.rounds[spec.code];
    replace(body,
      h('section.panel.tn-intro',
        spec.lead,
        r ? h('p.small.muted', `Rounds so far: ${r.n} · last ${r.last[0]}/${r.last[1]} · best ${r.best[0]}/${r.best[1]}`) : null,
        h('button.btn.primary.block.tn-start', { type: 'button', onclick: start }, icon('play'), 'Start round')),
      keysNote(spec.keys));
  }

  async function start() {
    if (starting) return; // a second tap on Start / Another round
    starting = true;
    const btn = body.querySelector('.tn-start');
    if (btn) {
      btn.disabled = true;
      replace(btn, 'Loading…');
    }
    let list;
    try {
      list = await (pending ?? prepare());
    } catch (error) {
      pending = null;
      if (!disposed) replace(body, errorPanel('This drill could not be loaded.', error, () => {
        drawIntro();
        prepare();
      }));
      return;
    } finally {
      starting = false;
    }
    pending = null;
    if (disposed) return;
    if (!list.length) {
      // Offline, the words of a drill may not be saved on this device yet (errorPanel then says so).
      const offline = navigator.onLine === false;
      replace(body, errorPanel(offline ? 'This drill could not be loaded.' : 'There are no recordings for this drill yet.', null, offline ? () => {
        drawIntro();
        prepare();
      } : null));
      return;
    }
    items = list;
    results = [];
    index = 0;
    announce(`Round started: ${items.length} items. Item 1.`);
    drawQuestion(true);
  }

  function stage(item, result) {
    controller = spec.prompt(item, result ? null : (answer) => submit(item, answer), result);
    return h('section.panel.tn-stage',
      h('button.tn-play', { type: 'button', aria: { label: 'Play again', keyshortcuts: 'R' }, onclick: () => play(item) }, icon('play')),
      controller.node,
      result ? spec.feedback(item, result) : null);
  }

  function drawQuestion(autoplay) {
    phase = 'question';
    const item = items[index];
    replace(body, header(), stage(item, null), keysNote(spec.keys));
    body.querySelector('.tn-play')?.focus({ preventScroll: true });
    if (autoplay) play(item);
  }

  function submit(item, answer) {
    if (phase !== 'question' || item !== items[index]) return;
    phase = 'answered';
    const check = drill.checkTones(spec.target(item), answer);
    stats = loadStats(ctx);
    for (const [t, a] of pairsFor(item, answer)) stats = drill.recordAnswer(stats, spec.code, t, a);
    saveStats(ctx, stats);
    const result = { answer, ...check };
    results[index] = result;
    const last = index + 1 >= items.length;
    const nextBtn = h('button.btn.primary.block.tn-next', { type: 'button', onclick: advance, aria: { keyshortcuts: 'Enter' } }, last ? 'See results' : 'Next', icon('next'));
    replace(body, header(), stage(item, result), nextBtn, keysNote(spec.keys));
    nextBtn.focus({ preventScroll: true });
    nextBtn.scrollIntoView?.({ block: 'nearest' }); // clear of the tab bar: scroll-margin in tones.css
    announce(spec.say(item, result));
    spec.answered?.(item, result);
  }

  function advance() {
    if (phase !== 'answered') return;
    index += 1;
    if (index >= items.length) {
      finish();
      return;
    }
    drawQuestion(true);
  }

  function finish() {
    phase = 'summary';
    spec.stop?.();
    ctx.audio.stop();
    const summary = drill.roundSummary(items.map((item, i) => {
      const pairs = pairsFor(item, results[i].answer);
      return { target: pairs.map((p) => p[0]), answer: pairs.map((p) => p[1]) };
    }));
    stats = drill.recordRound(loadStats(ctx), spec.code, summary.correct, summary.total, Date.now());
    saveStats(ctx, stats);
    const missed = items.map((item, i) => [item, results[i]]).filter(([, r]) => !r.correct);
    const title = h('h2', { tabindex: '-1' }, 'Round complete');
    const tones = Object.keys(summary.perTone).map(Number).sort();
    replace(body,
      h('section.panel.tn-summary',
        title,
        h('p.tn-result', h('strong', `${summary.correct} of ${summary.total}`), ' right'),
        h('ul.tn-per-tone', tones.map((t) => {
          const p = summary.perTone[t];
          return h('li', toneGlyph(t), h('span', ToneText(t)), h('span.tn-per-tone-value', `${p.correct} of ${p.n}`));
        })),
        summary.confusions.length
          ? h('p', 'Mixed up: ', summary.confusions.map((c, i) => [i ? '; ' : '', `${toneText(c.target)} heard as ${toneText(c.answer)} (${c.count}×)`]), '. The next round includes more of these.')
          : h('p', 'No mix-ups this round.'),
        h('div.row.tn-actions',
          h('button.btn.primary.tn-start', { type: 'button', onclick: start }, 'Another round'),
          h('a.btn', { href: '#/tones' }, 'All tone drills'))),
      missed.length ? [h('h3', 'Listen again'), h('ul.list.tn-review', missed.map(([item, r]) => spec.review(item, r)))] : null);
    title.focus({ preventScroll: false });
    announce(`Round complete: ${summary.correct} of ${summary.total} right.`);
    prepare(); // the next round, with the updated statistics
  }

  function onKey(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return; // e.g. the sign-in dialog is in front of the drill
    const key = event.key;
    if (phase === 'question') {
      if (/^[0-9]$/.test(key) && !event.repeat && controller?.digit?.(Number(key))) event.preventDefault();
      else if ((key === 'r' || key === 'R') && !event.repeat) {
        event.preventDefault();
        play(items[index]);
      }
    } else if (phase === 'answered') {
      if ((key === 'r' || key === 'R') && !event.repeat) {
        event.preventDefault();
        play(items[index]);
      } else if (((key === 'Enter' && !event.target.closest?.('button, a')) || key === 'n' || key === 'N') && !event.repeat) {
        // Enter on a focused button activates that button; N always moves on.
        event.preventDefault();
        advance();
      }
    }
  }
  document.addEventListener('keydown', onKey);

  drawIntro();
  prepare();
  return () => {
    disposed = true;
    spec.stop?.();
    document.removeEventListener('keydown', onKey);
  };
}

// ---------- Single syllables ----------

function syllablesPage(root, ctx) {
  let syllables = null;
  return runDrill(root, ctx, {
    code: drill.DRILLS.syllables,
    title: 'Single syllables',
    lead: [
      h('p', 'You hear one syllable. Choose its tone and you see the answer straight away. Each round has 20 different syllables.'),
      h('p.small.muted', 'Every tone comes up in each round, and more often the ones you mix up.')],
    keys: 'Keys: 1–4 answer · R replay · Enter next',
    async load(stats) {
      syllables ??= (await ctx.data.loadTones()).syllables;
      return drill.buildSyllableRound({ syllables, stats });
    },
    play: (item) => playSyllable(ctx, item.base, item.tone),
    target: (item) => [item.tone],
    prompt(item, submit, result) {
      return {
        node: [
          h('p.tn-question', 'Which tone? ', h('span.muted', 'Syllable: ', py(item.base))),
          answerGroup({ tones: [1, 2, 3, 4], label: 'Which tone?', onPick: submit && ((t) => submit([t])), chosen: result?.answer[0] ?? null, correct: result ? item.tone : null })],
        digit: (d) => {
          if (!submit || d < 1 || d > 4) return false;
          submit([d]);
          return true;
        },
      };
    },
    feedback(item, result) {
      const marked = markSyllable(item.base, item.tone);
      const chosen = result.answer[0];
      return h(`div.tn-feedback.${result.correct ? 'is-right' : 'is-wrong'}`,
        h('p.tn-verdict', icon(result.correct ? 'check' : 'x'), result.correct ? 'Right' : 'Not quite'),
        h('p.tn-solution', py(marked, 'pinyin tn-big'), h('span.tn-solution-tone', toneGlyph(item.tone), `tone ${item.tone}, ${TONE_INFO[item.tone].label}`)),
        result.correct ? null : h('p.small', 'You chose tone ', String(chosen), '. Listen to both:'),
        h('div.row.tn-actions',
          h('button.btn', { type: 'button', onclick: () => playSyllable(ctx, item.base, item.tone) }, icon('play'), py(marked)),
          result.correct ? null : h('button.btn', { type: 'button', onclick: () => playSyllable(ctx, item.base, chosen) }, icon('play'), py(markSyllable(item.base, chosen)), h('span.tn-yours', '(your answer)'))),
        h('p.audio-src', `Recording · ${SYLLABLE_SPEAKER}`));
    },
    say: (item, result) => (result.correct
      ? `Right: ${toneText(item.tone)}.`
      : `Not quite: it was ${toneText(item.tone)}. You chose ${toneText(result.answer[0])}.`),
    review(item, result) {
      const chosen = result.answer[0];
      const right = markSyllable(item.base, item.tone);
      const yours = markSyllable(item.base, chosen);
      return h('li.tn-review-row',
        h('span.grow', py(right, 'pinyin tn-review-main'), h('span.sub', `tone ${item.tone} · you chose ${chosen}`)),
        h('button.btn.small', { type: 'button', aria: { label: `Play ${right}` }, onclick: () => playSyllable(ctx, item.base, item.tone) }, icon('play'), py(right)),
        h('button.btn.small', { type: 'button', aria: { label: `Play ${yours}, your answer` }, onclick: () => playSyllable(ctx, item.base, chosen) }, icon('play'), py(yours)));
    },
  });
}

// ---------- Two-syllable words ----------

function wordBlock(item) {
  return h('div.tn-word',
    zh(item.hanzi, 'tn-hanzi'),
    py(item.pinyin, 'pinyin tn-big'),
    item.meanings?.length ? h('p.tn-meaning', item.meanings.slice(0, 2).join('; ')) : null);
}

function pairsPage(root, ctx) {
  return runDrill(root, ctx, {
    code: drill.DRILLS.pairs,
    title: 'Two-syllable words',
    lead: [
      h('p', 'You hear a word of two syllables. Choose the tone of each syllable; the second one can also be the neutral tone. 20 words per round.'),
      h('p.small.muted', 'Only words said with their dictionary tones are used (no tone changes), so the answer is always the tone that is written.')],
    keys: 'Keys: first digit 1–4, second 1–4 or 5 (neutral) · R replay · Enter next',
    async load(stats) {
      const data = await ctx.data.loadTones();
      // A few spare words: the ones whose tones are not certain (see clearTones) are dropped below.
      const round = drill.buildPairRound({ pairs: data.pairs, stats, size: drill.ROUND_SIZE.p + 8 });
      const items = await loadItems(ctx, round.map((r) => r.id));
      const usable = round.map((r) => ({ ...r, item: items.get(r.id) })).filter((r) => clearTones(r.item, r.tones));
      return drill.spread(usable, (r) => r.key, 1).slice(0, drill.ROUND_SIZE.p);
    },
    play: (entry) => playWord(ctx, entry.item),
    target: (entry) => entry.tones,
    prompt(entry, submit, result) {
      const choice = result ? [...result.answer] : [null, null];
      const holder = h('div.tn-pair-groups');
      const draw = () => replace(holder, [0, 1].map((pos) => h('div.tn-pair-group',
        h('p.tn-group-label', pos ? 'Second syllable' : 'First syllable'),
        answerGroup({
          tones: pos ? [1, 2, 3, 4, 5] : [1, 2, 3, 4],
          label: pos ? 'Second syllable' : 'First syllable',
          onPick: submit && ((t) => pick(pos, t)),
          selected: choice[pos],
          chosen: result ? result.answer[pos] : null,
          correct: result ? entry.tones[pos] : null,
        }))));
      function pick(pos, t) {
        choice[pos] = t;
        if (choice[0] !== null && choice[1] !== null) {
          submit([choice[0], choice[1]]);
          return;
        }
        draw();
        holder.querySelectorAll('.tn-answers')[pos]?.querySelector(`[data-tone="${t}"]`)?.focus({ preventScroll: true });
        announce(`${pos ? 'Second' : 'First'} syllable: ${toneText(t)}. Now the ${pos ? 'first' : 'second'} syllable.`);
      }
      draw();
      return {
        node: [h('p.tn-question', 'Which tones?'), holder],
        digit: (d) => {
          if (!submit) return false;
          if (choice[0] === null) {
            if (d < 1 || d > 4) return false;
            pick(0, d);
            return true;
          }
          if (d === 0 || d === 5) pick(1, 5);
          else if (d >= 1 && d <= 4) pick(1, d);
          else return false;
          return true;
        },
      };
    },
    feedback(entry, result) {
      const { item } = entry;
      const verdict = result.correct ? 'Right' : result.perSyllable.some(Boolean) ? 'One of two right' : 'Not quite';
      return h(`div.tn-feedback.${result.correct ? 'is-right' : 'is-wrong'}`,
        h('p.tn-verdict', icon(result.correct ? 'check' : 'x'), verdict),
        wordBlock(item),
        h('p.small', `Tones ${tonePattern(entry.tones)}`, result.correct ? '' : ` · you chose ${tonePattern(result.answer)}`),
        h('div.row.tn-actions', h('button.btn', { type: 'button', onclick: () => playWord(ctx, item) }, icon('play'), 'Play again')),
        h('p.audio-src', `Recording · ${item.audio.speaker}`));
    },
    say: (entry, result) => `${result.correct ? 'Right' : 'Not quite'}: ${entry.item.hanzi}, ${entry.tones.map((t) => toneText(t)).join(' and ')}.${result.correct ? '' : ` You chose ${result.answer.map((t) => toneText(t)).join(' and ')}.`}`,
    review(entry, result) {
      const { item } = entry;
      return h('li.tn-review-row',
        zh(item.hanzi, 'tn-review-hanzi'),
        h('span.grow', py(item.pinyin, 'pinyin tn-review-main'), h('span.sub', `tones ${tonePattern(entry.tones)} · you chose ${tonePattern(result.answer)}`)),
        h('button.play-btn', { type: 'button', aria: { label: `Play ${item.hanzi}` }, onclick: () => playWord(ctx, item) }, icon('play')));
    },
  });
}

// ---------- Minimal pairs ----------

function minimalPage(root, ctx) {
  const both = sequencer();
  const pause = (ms) => () => new Promise((resolve) => setTimeout(resolve, ms));
  /** Both words, one after the other. `quiet`: no announcement per word (after an answer the verdict is
   * being announced, and the feedback names the word that was played). */
  const playBoth = (entry, { quiet = false } = {}) => both.run(entry.items.flatMap((item, k) => [
    k ? pause(300) : null,
    async () => {
      if (!quiet) announce(`${k ? 'Second' : 'First'}: ${item.hanzi}`);
      await playWord(ctx, item);
    }].filter(Boolean)));
  return runDrill(root, ctx, {
    code: drill.DRILLS.minimal,
    title: 'Minimal pairs',
    lead: [
      h('p', 'Two words with the same syllables and different tones. You hear one of them: which one was it? Then listen to both.'),
      h('p.small.muted', `Up to ${drill.ROUND_SIZE.m} pairs per round, chosen more often when they contrast tones you mix up.`)],
    keys: 'Keys: 1 or 2 answer · R replay · Enter next',
    async load(stats) {
      const data = await ctx.data.loadTones();
      const ids = [...new Set(data.minimal.flat())];
      const items = await loadItems(ctx, ids);
      const tonesOf = (id) => {
        const item = items.get(id);
        return item?.audio?.file ? tonesOfItem(item) : null;
      };
      // A pair is left out when a word may also be said with other tones where the two words differ.
      const inDoubt = (id, positions) => drill.tonesInDoubt(tonesOf(id), items.get(id).meanings, positions);
      return drill.buildMinimalRound({ minimal: data.minimal, tonesOf, inDoubt, stats })
        .map((r) => ({ ...r, items: r.ids.map((id) => items.get(id)) }));
    },
    play: (entry) => {
      both.stop();
      return playWord(ctx, entry.items[entry.target]);
    },
    // "Pick which, then hear both": the contrast right after the answer.
    answered: (entry) => playBoth(entry, { quiet: true }),
    stop: () => both.stop(),
    target: (entry) => entry.tones[entry.target],
    pairsFor: (entry, answer) => drill.differingPositions(entry.tones[0], entry.tones[1]).map((i) => [entry.tones[entry.target][i], answer[i]]),
    prompt(entry, submit, result) {
      const chosen = result ? (sameTones(result.answer, entry.tones[0]) ? 0 : 1) : null;
      const options = entry.items.map((item, k) => {
        const isRight = result && k === entry.target;
        const isWrong = result && k === chosen && k !== entry.target;
        return h('button.tn-option', {
          type: 'button',
          class: isRight ? 'is-right' : isWrong ? 'is-wrong' : null,
          aria: { disabled: result ? 'true' : null, keyshortcuts: String(k + 1) },
          onclick: submit ? () => submit(entry.tones[k]) : null,
        },
        h('span.tn-option-key', { aria: { hidden: 'true' } }, String(k + 1)),
        h('span.tn-option-text', zh(item.hanzi, 'tn-option-hanzi'), py(item.pinyin, 'pinyin tn-option-pinyin'), h('span.tn-option-meaning', item.meanings?.[0] ?? '')),
        isRight ? h('span.tn-mark', icon('check'), h('span.visually-hidden', k === chosen ? ', your answer, right' : ', the word you heard')) : null,
        isWrong ? h('span.tn-mark', icon('x'), h('span.visually-hidden', ', your answer')) : null);
      });
      return {
        node: [h('p.tn-question', 'Which word did you hear?'), h('div.tn-options', { role: 'group', aria: { label: 'Which word did you hear?' } }, options)],
        digit: (d) => {
          if (!submit || (d !== 1 && d !== 2)) return false;
          submit(entry.tones[d - 1]);
          return true;
        },
      };
    },
    feedback(entry, result) {
      const heard = entry.items[entry.target];
      return h(`div.tn-feedback.${result.correct ? 'is-right' : 'is-wrong'}`,
        h('p.tn-verdict', icon(result.correct ? 'check' : 'x'), result.correct ? 'Right' : 'Not quite'),
        h('p', 'You heard ', zh(heard.hanzi), ' ', py(heard.pinyin), '.'),
        h('div.row.tn-actions',
          h('button.btn', { type: 'button', onclick: () => playBoth(entry) }, icon('play'), 'Play both'),
          entry.items.map((item) => h('button.btn', { type: 'button', aria: { label: `Play ${item.hanzi} ${item.pinyin}` }, onclick: () => {
            both.stop();
            playWord(ctx, item);
          } }, icon('play'), zh(item.hanzi)))),
        h('p.audio-src', `Recordings · ${[...new Set(entry.items.map((it) => it.audio.speaker))].join(', ')}`));
    },
    say: (entry, result) => `${result.correct ? 'Right' : 'Not quite'}: you heard ${entry.items[entry.target].hanzi}.`,
    review(entry) {
      const heard = entry.items[entry.target];
      return h('li.tn-review-row',
        zh(heard.hanzi, 'tn-review-hanzi'),
        h('span.grow', py(heard.pinyin, 'pinyin tn-review-main'), h('span.sub', 'not ', zh(entry.items[1 - entry.target].hanzi), ' ', py(entry.items[1 - entry.target].pinyin))),
        h('button.play-btn', { type: 'button', aria: { label: `Play both: ${entry.items.map((it) => it.hanzi).join(', ')}` }, onclick: () => playBoth(entry) }, icon('play')));
    },
  });
}

// ---------- Pinyin chart ----------

function chartPage(root, ctx) {
  const wrap = h('div.tn-chart-wrap', h('p.loading', 'Loading…'));
  const picker = h('div.tn-picker', { hidden: true });
  const all = sequencer();
  let selected = null; // { base, button }
  let disposed = false;
  replace(root,
    backToHub(),
    h('h1', 'Pinyin chart'),
    h('p', 'Every syllable that has recordings: finals down the side, initials across the top. Tap a syllable, then a tone to hear it.'),
    h('p.callout.tn-spelling', h('strong', 'Spelling. '),
      'Syllables without an initial are written with y or w (', py('yi'), ', ', py('wu'), ', ', py('yu'), ', ', py('yue'), '). After j, q and x, ü is written u: ',
      py('ju'), ', ', py('qu'), ', ', py('xu'), ' stand for ', py('jü'), ', ', py('qü'), ', ', py('xü'), '. ', h('a', { href: '#/pitfalls/pitfalls.u-umlaut' }, 'More about ü')),
    wrap,
    picker);

  function closePicker({ restoreFocus = false } = {}) {
    all.stop();
    picker.hidden = true;
    root.classList.remove('tn-has-picker');
    if (selected) {
      selected.button.removeAttribute('aria-current');
      if (restoreFocus) selected.button.focus();
    }
    selected = null;
  }

  function openPicker(base, button) {
    if (selected) selected.button.removeAttribute('aria-current');
    selected = { base, button };
    button.setAttribute('aria-current', 'true');
    replace(picker,
      h('div.tn-picker-head',
        h('p.tn-picker-title', py(base, 'pinyin'), h('span.muted.small', ' · choose a tone')),
        h('button.mark-btn', { type: 'button', aria: { label: 'Close the tone picker' }, onclick: () => closePicker({ restoreFocus: true }) }, icon('x'))),
      h('div.tn-picker-tones', { role: 'group', aria: { label: `Tones of ${base}` } }, [1, 2, 3, 4].map((t) => h('button.tn-pick', {
        type: 'button',
        aria: { label: `Play ${markSyllable(base, t)}, tone ${t}`, keyshortcuts: String(t) },
        onclick: () => {
          all.stop();
          playSyllable(ctx, base, t);
        },
      }, toneGlyph(t), py(markSyllable(base, t)), h('span.tn-pick-num', String(t))))),
      h('div.tn-picker-foot',
        h('button.btn.small', { type: 'button', onclick: () => all.run([1, 2, 3, 4].map((t) => () => playSyllable(ctx, base, t))) }, icon('play'), 'All four'),
        h('a.btn.small', { href: `#/tones/record?s=${encodeURIComponent(`${base}1`)}` }, icon('mic'), 'Record'),
        h('span.audio-src', `Recording · ${SYLLABLE_SPEAKER}`)));
    picker.hidden = false;
    root.classList.add('tn-has-picker');
    // Keep the chosen syllable visible above the picker (the page has room for it: tn-has-picker).
    const hiddenBy = button.getBoundingClientRect().bottom - picker.getBoundingClientRect().top + 12;
    if (hiddenBy > 0) window.scrollBy(0, hiddenBy);
    announce(`${base}. Press 1 to 4 to hear its tones, or use the tone buttons after the chart.`);
  }

  function onPickerKey(event) {
    if (event.key === 'Escape' && selected) {
      event.preventDefault();
      closePicker({ restoreFocus: true });
    }
  }
  picker.addEventListener('keydown', onPickerKey);

  ctx.data.loadTones().then((data) => {
    if (disposed) return;
    const layout = drill.chartLayout(data.syllables);
    const grid = []; // grid[row][col] = button | null
    let first = null;
    const head = h('tr', h('th.tn-corner', { scope: 'col' }, h('span.visually-hidden', 'Final')),
      layout.initials.map((i) => h('th', { scope: 'col', lang: i ? 'zh-Latn-pinyin' : null }, i || [h('span', { aria: { hidden: 'true' } }, '–'), h('span.visually-hidden', 'no initial')])));
    const rows = layout.finals.map((final, r) => {
      grid[r] = [];
      const group = drill.finalGroup(final);
      const prevGroup = r ? drill.finalGroup(layout.finals[r - 1]) : group;
      return h('tr', { class: group !== prevGroup ? 'tn-group-start' : null },
        h('th', { scope: 'row', lang: 'zh-Latn-pinyin' }, final),
        layout.initials.map((initial, c) => {
          const cell = layout.cell(final, initial);
          if (!cell) {
            grid[r][c] = null;
            return h('td');
          }
          const button = h('button.tn-cell', { type: 'button', tabindex: first ? '-1' : '0', data: { r, c, base: cell.base }, lang: 'zh-Latn-pinyin' }, cell.base);
          first ??= button;
          grid[r][c] = button;
          return h('td', button);
        }));
    });
    const table = h('table.tn-chart', h('caption.visually-hidden', `Pinyin chart: ${layout.count} syllables, finals in rows, initials in columns. Arrow keys move, 1 to 4 play a tone.`),
      h('thead', head), h('tbody', rows));
    replace(wrap, table);
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Pinyin chart, scrolls sideways');

    const focusCell = (button) => {
      for (const b of table.querySelectorAll('.tn-cell[tabindex="0"]')) b.tabIndex = -1;
      button.tabIndex = 0;
      button.focus();
    };
    const find = (r, c, dr, dc) => {
      if (dc) {
        for (let k = c + dc; k >= 0 && k < layout.initials.length; k += dc) if (grid[r][k]) return grid[r][k];
        return null;
      }
      for (let k = r + dr; k >= 0 && k < layout.finals.length; k += dr) if (grid[k][c]) return grid[k][c];
      return null;
    };
    table.addEventListener('click', (event) => {
      const button = event.target.closest('button.tn-cell');
      if (!button) return;
      for (const b of table.querySelectorAll('.tn-cell[tabindex="0"]')) b.tabIndex = -1;
      button.tabIndex = 0;
      openPicker(button.dataset.base, button);
    });
    table.addEventListener('keydown', (event) => {
      const button = event.target.closest('button.tn-cell');
      if (!button || event.metaKey || event.ctrlKey || event.altKey) return;
      const r = Number(button.dataset.r);
      const c = Number(button.dataset.c);
      let target = null;
      if (event.key === 'ArrowRight') target = find(r, c, 0, 1);
      else if (event.key === 'ArrowLeft') target = find(r, c, 0, -1);
      else if (event.key === 'ArrowDown') target = find(r, c, 1, 0);
      else if (event.key === 'ArrowUp') target = find(r, c, -1, 0);
      else if (event.key === 'Home') target = grid[r].find(Boolean);
      else if (event.key === 'End') target = lastOf(grid[r], Boolean);
      else if (/^[1-4]$/.test(event.key) && !event.repeat) {
        event.preventDefault();
        if (selected?.button !== button) openPicker(button.dataset.base, button);
        all.stop();
        playSyllable(ctx, button.dataset.base, Number(event.key));
        return;
      } else if (event.key === 'Escape' && selected) {
        event.preventDefault();
        closePicker({ restoreFocus: true });
        return;
      } else return;
      event.preventDefault();
      if (target) focusCell(target);
    });
  }).catch((error) => {
    if (!disposed) replace(wrap, errorPanel('The chart could not be loaded.', error, () => ctx.navigate(location.hash)));
  });

  return () => {
    disposed = true;
    all.stop();
    root.classList.remove('tn-has-picker');
  };
}

// ---------- Record and compare (beta) ----------

const PATTERNS = ['11', '12', '13', '14', '15', '21', '22', '23', '24', '25', '31', '32', '34', '35', '41', '42', '43', '44', '45'];
const patternLabel = (k) => `${k[0]} + ${k[1] === '5' ? 'neutral' : k[1]}`;

function recordPage(root, ctx) {
  const body = h('div.tn-record', h('p.loading', 'Loading…'));
  replace(root,
    backToHub(),
    h('div.tn-title-row', h('h1', 'Record and compare'), h('span.chip.warn', 'Beta')),
    h('p.callout.warn.tn-caveat', h('strong', 'Experimental. '),
      'The pitch lines are worked out on this device and can be wrong. A third tone often turns creaky at its lowest point, below the range the tracker can follow, so its line may break there. There is no score: compare the shapes yourself.'),
    body);

  // render() hands the router its cleanup at once and the page fills in when its modules have loaded. (An
  // async render would return its cleanup only then; after a quick tap elsewhere the router would store it
  // over the next page's cleanup, which would then never run.)
  let left = false;
  let leave = null;
  Promise.all([import('../lib/pitch.js'), import('../recorder.js'), ctx.data.loadTones()]).then(([pitch, rec, data]) => {
    if (!left) leave = recorderUi(body, ctx, pitch, rec, data);
  }, (error) => {
    if (!left) replace(body, errorPanel('The recorder could not be loaded.', error, () => ctx.navigate(location.hash)));
  });
  return () => {
    left = true;
    leave?.();
  };
}

/** The record page once pitch.js, recorder.js and tones.json are loaded. Returns its cleanup. */
function recorderUi(body, ctx, pitch, rec, data) {
  const recorded = new Set(data.syllables);
  const bases = [...new Set(data.syllables.map((s) => drill.parseSyllableKey(s)?.base).filter(Boolean))];
  const recorder = rec.createRecorder({ maxMs: 4000 });
  const sequence = sequencer();
  const support = rec.recordingSupport();
  let disposed = false;
  let target = null; // { kind: 'syllable', base, tone, url } | { kind: 'word', item, url, pattern }
  let reference = null; // contour result for the target, or { ok: false, reason }
  let take = null; // { buffer, blob, ... }
  let yours = null; // contour of the take
  let state = 'idle'; // idle | starting | recording | processing
  let message = null; // { text, error }
  let refToken = 0;
  let wordPattern = '';

  const modeBar = h('div.segmented.tn-mode', { role: 'group', aria: { label: 'What to say' } });
  const targetPanel = h('section.panel.tn-target');
  const recordPanel = h('section.panel.tn-recorder');
  const canvas = h('canvas.tn-canvas', { role: 'img', aria: { label: 'Pitch lines' } });
  const legend = h('div.tn-legend');
  const describe = h('p.small.muted.tn-describe');
  const chartPanel = h('section.panel.tn-plot',
    h('h2.tn-plot-title', 'Pitch'),
    canvas, legend, describe,
    h('p.small.muted', 'Up and down: semitones above or below each speaker’s own middle pitch (0), so a low and a high voice can be compared. Left to right: from the start to the end of the voiced sound.'));
  replace(body, modeBar, targetPanel, recordPanel, chartPanel,
    h('p.small.muted.tn-privacy', 'Your recording stays on this device and is deleted when you leave this page. Nothing is uploaded.'));

  // ----- target -----

  const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

  let lastSyllable = { base: 'ma', tone: 1 };
  let wordToken = 0; // a newer choice (word or syllable) wins over a word still loading
  function setSyllable(base, tone) {
    if (!recorded.has(`${base}${tone}`)) return false;
    wordToken += 1;
    lastSyllable = { base, tone };
    target = { kind: 'syllable', base, tone, url: drill.syllableUrl(base, tone) };
    onTargetChange();
    return true;
  }

  /** A random recorded word of a tone pattern ('' = any) whose tones are certain (clearTones), or the
   * word `id` (a link to this page) as it is. */
  async function setWord(pattern = wordPattern, id = null) {
    const mine = ++wordToken;
    wordPattern = pattern;
    replace(targetPanel, h('p.loading', 'Loading…'));
    let item = null;
    if (id) item = (await loadItems(ctx, [id])).get(id) ?? null;
    else {
      const pool = pattern ? data.pairs[pattern] ?? [] : PATTERNS.flatMap((k) => data.pairs[k] ?? []);
      const others = pool.filter((x) => x !== target?.item?.id);
      const candidates = drill.shuffle(others.length ? others : pool).slice(0, 6);
      const items = await loadItems(ctx, candidates);
      item = candidates.map((c) => items.get(c)).find((it) => it && clearTones(it, tonesOfItem(it))) ?? null;
    }
    if (disposed || mine !== wordToken) return false;
    if (!item?.audio?.file || !tonesOfItem(item).length) {
      replace(targetPanel, errorPanel('This word could not be loaded.', null, () => setWord(pattern)));
      return false;
    }
    target = { kind: 'word', item, url: item.audio.file };
    onTargetChange();
    return true;
  }

  function onTargetChange() {
    take = null;
    yours = null;
    message = null;
    sequence.stop();
    rec.stopPlayback();
    drawMode();
    drawTarget();
    drawRecorder();
    loadReference();
  }

  function drawMode() {
    const mode = target?.kind ?? 'syllable';
    replace(modeBar, [['syllable', 'Syllable'], ['word', 'Word']].map(([k, label]) => h('button.seg', {
      type: 'button',
      aria: { pressed: String(mode === k) },
      onclick: () => {
        if (mode === k) return;
        if (k === 'word') setWord('');
        else setSyllable(lastSyllable.base, lastSyllable.tone);
      },
    }, label)));
  }

  function drawTarget() {
    if (!target) return;
    const playRef = h('button.btn.primary', { type: 'button', onclick: playReference }, icon('play'), 'Play the recording');
    if (target.kind === 'syllable') {
      const { base, tone } = target;
      const input = h('input.field', { id: 'tn-syl', type: 'text', value: `${base}${tone}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', aria: { describedby: 'tn-syl-hint' } });
      const hint = h('p.field-hint', { id: 'tn-syl-hint' }, 'Type a syllable with its tone, e.g. ma3, mǎ or lv4.');
      const form = h('form.tn-syl-form', {
        onsubmit: (event) => {
          event.preventDefault();
          const p = parseSyllable(input.value);
          const tone = p.tone >= 1 && p.tone <= 4 ? p.tone : target.tone;
          const base = p.base.replace(/^([jqxy])ü/, '$1u'); // jü, qü, xü, yü are written ju, qu, xu, yu
          if (!base || !setSyllable(base, tone)) {
            hint.textContent = `No recording of “${input.value.trim()}”. Type a syllable with tone 1–4, e.g. ma3.`;
            hint.classList.add('error');
            input.setAttribute('aria-invalid', 'true');
            input.focus();
            announce(hint.textContent);
          }
        },
      },
      h('label.field-label', { for: 'tn-syl' }, 'Syllable'),
      h('div.tn-syl-row', input, h('button.btn', { type: 'submit' }, 'Show'), h('button.btn', { type: 'button', onclick: () => setSyllable(randomOf(bases), 1 + Math.floor(Math.random() * 4)) }, 'Random')),
      hint);
      replace(targetPanel,
        form,
        h('div.segmented.tn-tone-seg', { role: 'group', aria: { label: 'Tone' } }, [1, 2, 3, 4].map((t) => h('button.seg', {
          type: 'button',
          aria: { pressed: String(t === tone), label: `Tone ${t}: ${markSyllable(base, t)}` },
          onclick: () => setSyllable(base, t),
        }, toneGlyph(t), String(t)))),
        h('div.tn-say', py(markSyllable(base, tone), 'pinyin tn-say-main'), h('span.muted', `${toneText(tone)} · ${TONE_INFO[tone].label}`)),
        h('div.row.tn-actions', playRef, h('span.audio-src', `Recording · ${SYLLABLE_SPEAKER}`)));
    } else {
      const { item } = target;
      const select = h('select.field', { id: 'tn-pattern', onchange: (event) => setWord(event.target.value) },
        h('option', { value: '' }, 'Any'),
        PATTERNS.filter((k) => data.pairs[k]?.length).map((k) => h('option', { value: k, selected: k === wordPattern }, patternLabel(k))));
      replace(targetPanel,
        h('div.tn-word-pick', h('label.field-label', { for: 'tn-pattern' }, 'Tones'), h('div.tn-syl-row', select, h('button.btn', { type: 'button', onclick: () => setWord(wordPattern) }, 'Another word'))),
        h('div.tn-say', wordBlock(item), h('span.muted', tonesOfItem(item).map((t) => toneText(t)).join(' + '))),
        h('div.row.tn-actions', playRef, h('span.audio-src', `Recording · ${item.audio.speaker}`)));
    }
  }

  async function loadReference() {
    const mine = ++refToken;
    reference = { ok: false, reason: 'loading' };
    drawPlot();
    try {
      const audio = await rec.loadAudio(target.url);
      if (mine !== refToken || disposed) return;
      reference = pitch.contour(audio.samples, audio.sampleRate, { points: 64 });
    } catch (error) {
      if (mine !== refToken || disposed) return;
      reference = { ok: false, reason: 'error', error };
    }
    drawPlot();
  }

  // ----- playback -----

  function playReference() {
    sequence.stop();
    rec.stopPlayback();
    return target.kind === 'word' ? playWord(ctx, target.item) : playSyllable(ctx, target.base, target.tone);
  }

  function playYours() {
    if (!take) return Promise.resolve(false);
    sequence.stop();
    ctx.audio.stop();
    rec.unlockAudio();
    return take.buffer ? rec.playBuffer(take.buffer) : rec.playBlob(take.blob);
  }

  function playBoth() {
    rec.unlockAudio(); // inside the tap, for iOS
    sequence.run([
      () => {
        rec.stopPlayback();
        return target.kind === 'word' ? playWord(ctx, target.item) : playSyllable(ctx, target.base, target.tone);
      },
      () => new Promise((resolve) => setTimeout(resolve, 250)),
      () => (take.buffer ? rec.playBuffer(take.buffer) : rec.playBlob(take.blob)),
    ]);
  }

  // ----- recording -----

  const meterFill = h('span.tn-meter-fill');
  const meter = h('div.tn-meter', { aria: { hidden: 'true' } }, meterFill);
  const status = h('p.tn-rec-status');

  function drawRecorder() {
    if (!support.ok) {
      replace(recordPanel, h('p.callout', rec.describeError({ reason: support.reason }).message),
        h('p.small.muted', 'You can still play the recording and see its pitch line.'));
      return;
    }
    const recording = state === 'recording';
    const busy = state === 'starting' || state === 'processing';
    const button = h('button.btn.tn-rec-btn', {
      type: 'button',
      class: recording ? 'is-recording' : null,
      disabled: busy,
      onclick: toggleRecord,
    }, icon(recording ? 'stop' : 'mic'), recording ? 'Stop' : state === 'starting' ? 'Starting…' : state === 'processing' ? 'Analysing…' : take ? 'Record again' : 'Record');
    meterFill.style.width = '0%';
    status.textContent = recording ? 'Recording… say it now (up to 4 seconds).' : '';
    replace(recordPanel,
      h('div.tn-rec-row', button, recording ? meter : null),
      recording ? status : null,
      message ? h(`p.${message.error ? 'callout' : 'small'}`, { role: message.error ? 'alert' : null }, message.text) : null,
      take ? h('div.row.tn-actions',
        h('button.btn', { type: 'button', onclick: () => playYours() }, icon('play'), 'Play yours'),
        h('button.btn', { type: 'button', onclick: playBoth }, icon('play'), 'Play both')) : null,
      !take && !recording && !busy ? h('p.small.muted', 'Tap Record, say the syllable or word once, then tap Stop. Listen to the recording first.') : null);
    if (recording) button.focus({ preventScroll: true });
  }

  async function toggleRecord() {
    if (state === 'recording') {
      recorder.stop();
      return;
    }
    if (state !== 'idle') return;
    sequence.stop();
    ctx.audio.stop();
    rec.stopPlayback();
    message = null;
    state = 'starting';
    drawRecorder();
    let result;
    try {
      result = await recorder.record({ // called synchronously from the tap (iOS)
        onStart: () => {
          state = 'recording';
          drawRecorder();
          announce('Recording. Say it now, then tap Stop.');
        },
        onLevel: (level, ms) => {
          // -50 dBFS (quiet room) .. -10 dBFS (loud speech) -> empty .. full
          const db = level > 0 ? 20 * Math.log10(level) : -100;
          meterFill.style.width = `${Math.round(Math.max(0, Math.min(1, (db + 50) / 40)) * 100)}%`;
          if (state === 'recording') status.textContent = `Recording… ${(ms / 1000).toFixed(1)} of 4 seconds.`;
        },
      });
    } catch (error) {
      state = 'idle';
      message = { text: rec.describeError(error).message, error: true };
      if (!disposed) {
        drawRecorder();
        announce(message.text);
      }
      return;
    }
    if (disposed || !result) return;
    state = 'processing';
    drawRecorder();
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the page show "Analysing…"
    take = result;
    yours = take.samples ? pitch.contour(take.samples, take.sampleRate, { points: 64 }) : { ok: false, reason: 'undecodable' };
    state = 'idle';
    if (yours.ok) message = { text: `Recorded ${(take.durationMs / 1000).toFixed(1)} seconds.`, error: false };
    else if (yours.reason === 'undecodable') message = { text: 'This browser cannot analyse its own recording, so there is no pitch line. You can still listen to it.', error: false };
    else message = { text: 'No clear pitch found in your recording. Say it a little louder and closer to the microphone, and hold the vowel.', error: false };
    drawRecorder();
    drawPlot();
    announce(`${message.text} ${describeText()}`);
    recordPanel.querySelector('.tn-rec-btn')?.focus({ preventScroll: true });
  }

  // ----- plot -----

  const css = () => getComputedStyle(canvas);
  function lineSample(cls, dashed) {
    return svg('svg', { class: `tn-line ${cls}`, viewBox: '0 0 32 8', 'aria-hidden': 'true', focusable: 'false' },
      svg('path', { d: 'M2 4H30', 'stroke-dasharray': dashed ? '7 5' : null }));
  }

  function describeOne(name, result) {
    if (!result || result.reason === 'loading') return `${name}: loading.`;
    if (!result.ok) return `${name}: no pitch line.`;
    const d = pitch.describeContour(result.values);
    const fmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;
    return `${name}: starts at ${fmt(d.start)}, lowest ${fmt(d.min)}, highest ${fmt(d.max)}, ends at ${fmt(d.end)} semitones.`;
  }
  const describeText = () => [describeOne('Recording', reference), take ? describeOne('You', yours) : null].filter(Boolean).join(' ');

  function drawPlot() {
    const series = [];
    if (reference?.ok) series.push({ values: reference.values, color: css().getPropertyValue('--text').trim() || '#1d2125', dash: [], width: 3 });
    if (yours?.ok) series.push({ values: yours.values, color: css().getPropertyValue('--accent').trim() || '#a8231b', dash: [7, 5], width: 3 });
    drawContours(canvas, series);
    const refName = target?.kind === 'word' ? target.item.audio.speaker : SYLLABLE_SPEAKER;
    replace(legend,
      h('span.tn-legend-item', lineSample('is-ref', false), `Recording (${refName})`),
      take ? h('span.tn-legend-item', lineSample('is-you', true), 'You') : null);
    const text = describeText();
    canvas.setAttribute('aria-label', `Pitch lines. ${text}`);
    if (reference?.reason === 'error') {
      describe.textContent = navigator.onLine === false
        ? 'You are offline and this recording is not saved on this device yet, so there is no pitch line for it.'
        : 'This recording could not be analysed, so there is no pitch line for it.';
    } else describe.textContent = text;
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => drawPlot()) : null;
  ro?.observe(chartPanel);
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onScheme = () => drawPlot();
  scheme?.addEventListener?.('change', onScheme);
  const onHide = () => {
    if (document.visibilityState === 'hidden' && state === 'recording') recorder.stop();
  };
  document.addEventListener('visibilitychange', onHide);

  // ----- start -----

  const q = ctx.query;
  const fromQuery = q.s ? drill.parseSyllableKey(q.s) : null;
  if (q.w) {
    setWord('', q.w).then((ok) => {
      if (!ok && !disposed) setSyllable('ma', 1);
    });
  } else if (!(fromQuery && setSyllable(fromQuery.base, fromQuery.tone))) setSyllable('ma', 1);

  return () => {
    disposed = true;
    sequence.stop();
    ro?.disconnect();
    scheme?.removeEventListener?.('change', onScheme);
    document.removeEventListener('visibilitychange', onHide);
    recorder.cancel().finally(() => rec.releaseAudio());
  };
}

/** Draw pitch contours (semitones, time-normalised) on a canvas sized by CSS, crisp on high-DPI screens. */
function drawContours(canvas, series) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(160, Math.round(rect.width));
  const height = Math.max(120, Math.round(rect.height));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  const muted = style.getPropertyValue('--muted').trim() || '#5a6068';
  const grid = style.getPropertyValue('--border').trim() || '#ddd5c8';
  const values = series.flatMap((s) => s.values).filter(Number.isFinite);
  const range = Math.min(16, Math.max(6, Math.ceil(Math.max(0, ...values.map(Math.abs)) / 2) * 2));
  const left = 30;
  const right = 8;
  const top = 10;
  const bottom = 22;
  const w = width - left - right;
  const hgt = height - top - bottom;
  const X = (k, n) => left + (n > 1 ? (k / (n - 1)) * w : w / 2);
  const Y = (st) => top + (1 - (Math.max(-range, Math.min(range, st)) + range) / (2 * range)) * hgt;
  g.font = `12px ${style.fontFamily}`;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const st of [range, range / 2, 0, -range / 2, -range]) {
    g.strokeStyle = grid;
    g.lineWidth = st === 0 ? 1.5 : 1;
    g.setLineDash(st === 0 ? [] : [2, 4]);
    g.beginPath();
    g.moveTo(left, Y(st));
    g.lineTo(width - right, Y(st));
    g.stroke();
    g.fillStyle = muted;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText(st > 0 ? `+${st}` : st < 0 ? `−${-st}` : '0', left - 5, Y(st));
  }
  g.setLineDash([]);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillText('start', left, height - 5);
  g.textAlign = 'right';
  g.fillText('end', width - right, height - 5);
  if (!series.length) {
    g.textAlign = 'center';
    g.fillText('No pitch line yet', left + w / 2, top + hgt / 2 - 8);
    return;
  }
  for (const s of series) {
    g.strokeStyle = s.color;
    g.fillStyle = s.color;
    g.lineWidth = s.width;
    g.setLineDash(s.dash);
    const n = s.values.length;
    let run = [];
    const flush = () => {
      if (run.length === 1) {
        g.beginPath();
        g.arc(run[0][0], run[0][1], s.width / 2 + 0.5, 0, Math.PI * 2);
        g.fill();
      } else if (run.length > 1) {
        g.beginPath();
        run.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
      run = [];
    };
    s.values.forEach((v, k) => {
      if (Number.isFinite(v)) run.push([X(k, n), Y(v)]);
      else flush();
    });
    flush();
  }
  g.setLineDash([]);
}
