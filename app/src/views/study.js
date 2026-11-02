// Study: today's spaced-repetition queue (FSRS). One card at a time:
//   read    Chinese -> English: characters (pinyin too when the setting is on) -> meaning
//   speak   English -> Chinese: recall the word (say it aloud if you like) -> reveal and hear the model
//   listen  audio -> meaning (with an optional tone check before revealing; off by default)
//   cloze   a verified phrase with the word blanked -> the word
// Keyboard: Space/Enter reveal; 1-4 grade (Again, Hard, Good, Easy); R replay; S star; X skip.

import { h, replace, icon, zh, py, announce } from '../dom.js';
import { studyQueue } from '../study-items.js';
import { intervalLabel } from '../lib/srs.js';
import { syllablesOf, stripTones } from '../lib/pinyin.js';
import { audioButtons, markButtons, pinyinBlock, meaningList, sourceLabel, richText } from './parts.js';
import { recordingSupport, createRecorder, playBuffer, playBlob, releaseAudio, describeError } from '../recorder.js';

const TYPE_LABEL = { read: 'Chinese → English', speak: 'English → Chinese', listen: 'Listen', cloze: 'In a phrase' };
const GRADE_KEYS = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

export async function render(root, ctx) {
  const { state, audio, query } = ctx;
  const deckId = query.deck || null;
  let bonusNew = 0;
  let current = null; // queue entry { id, itemId, type, kind, card }
  let item = null;
  let revealed = false;
  let shownAt = 0;
  let firstType = new Map();
  let counts = { learning: 0, review: 0, new: 0 };
  let pausedNote = null;
  let answered = 0;
  let waitTimer = null;
  let disposed = false;

  const container = h('div.study');
  replace(root, h('h1.visually-hidden', 'Study'), container);

  async function next() {
    clearTimeout(waitTimer);
    let q;
    try {
      q = await studyQueue(ctx, { deckId, bonusNew });
    } catch (error) {
      replace(container, h('div.panel', h('h2', 'Could not load your decks'), h('p', String(error.message ?? error)), h('a.btn', { href: '#/' }, 'Home')));
      return;
    }
    if (disposed) return;
    counts = q.counts;
    firstType = q.firstType;
    pausedNote = q.paused && q.overdue ? h('p.small.muted.paused-note', 'New words wait until the overdue reviews are done.') : null;
    if (!q.queue.length) {
      current = null;
      item = null;
      drawDone(q);
      if (q.nextDue) waitTimer = setTimeout(next, Math.max(1000, q.nextDue - Date.now() + 500));
      return;
    }
    current = q.queue[0];
    item = q.byId.get(current.itemId);
    revealed = false;
    take = null;
    clozeExample = null;
    shownAt = Date.now();
    draw();
    if (state.settings.autoplay && current.type === 'listen') audio.play(item);
  }

  function header() {
    return [h('div.study-top',
      h('div.counts', { aria: { label: `${counts.new} new, ${counts.learning} learning, ${counts.review} to review` } },
        h('span.count-new', `${counts.new} new`), h('span.count-learn', `${counts.learning} learning`), h('span.count-review', `${counts.review} review`)),
      h('a.btn.small', { href: '#/settings' }, 'Settings')), pausedNote];
  }

  function prompt() {
    const t = current.type;
    if (t === 'listen') {
      return h('div.prompt',
        h('button.btn.primary', { type: 'button', onclick: () => audio.play(item), aria: { label: 'Play again' } }, icon('play'), 'Play'),
        h('button.btn.small', { type: 'button', onclick: () => audio.play(item, { slow: true }) }, icon('slow'), 'Slowly'),
        h('p.muted', 'What does it mean?'),
        state.settings.toneCheck ? toneCheck() : null,
        h('p.audio-src', sourceLabel(audio.sourceOf(item), item)));
    }
    if (t === 'speak') {
      // Only the English: usage notes often contain the Chinese answer, so they are shown after revealing.
      const en = item.kind === 'word' ? item.meanings.slice(0, 2).join('; ') : item.english;
      return h('div.prompt',
        h('p.meaning', en),
        item.kind === 'phrase' && item.register && item.register !== 'neutral' ? h('span.chip', item.register) : null,
        h('p.muted', 'What is it in Chinese? Say it out loud, then check.'),
        recordControls());
    }
    if (t === 'read') {
      const showPinyin = state.settings.showPinyinOnRead;
      return h('div.prompt',
        zh(item.hanzi, item.kind === 'word' ? 'big-hanzi' : 'mid-hanzi'),
        showPinyin ? py(item.pinyin, 'pinyin big-pinyin') : null,
        h('p.muted', showPinyin ? 'What does it mean?' : 'What does it mean, and how is it read?'),
        h('button.btn.small.pinyin-toggle', { type: 'button', aria: { pressed: String(showPinyin) },
          onclick: () => { state.updateSettings({ showPinyinOnRead: !showPinyin }); draw(); } },
        showPinyin ? 'Hide pinyin' : 'Show pinyin'));
    }
    if (t === 'cloze') return clozePrompt();
    return h('div.prompt', zh(item.hanzi, 'big-hanzi'));
  }

  // Record and compare (speak cards, optional): record yourself before revealing, then play your take and
  // the model one after the other. The recording stays in memory on this device (src/recorder.js).
  let recorder = null;
  let take = null;
  const playTake = () => (take?.buffer ? playBuffer(take.buffer) : playBlob(take?.blob));
  function recordControls() {
    if (!recordingSupport().ok) return null;
    recorder ??= createRecorder({ maxMs: 8000 });
    const wrap = h('div.record-row');
    const drawRecord = (live = recorder.recording) => {
      replace(wrap,
        live
          ? h('button.btn.small.is-recording', { type: 'button', onclick: () => recorder.stop() }, icon('stop'), 'Stop')
          : h('button.btn.small', { type: 'button', onclick: startRecording }, icon('mic'), take ? 'Record again' : 'Record yourself'),
        !live && take && revealed ? [
          h('button.btn.small', { type: 'button', onclick: () => playTake() }, icon('play'), 'Mine'),
          h('button.btn.small', { type: 'button', onclick: async () => { if (await playTake()) audio.play(item); } }, icon('play'), 'Mine, then the model'),
        ] : null,
        !live && take && !revealed ? h('span.small.muted', 'Recorded. Check to compare.') : null);
    };
    function startRecording() {
      const forCard = current?.id;
      // record() must start inside the tap (iOS); it resolves when the recording ends.
      recorder.record({ onStart: () => drawRecord(true) })
        .then((result) => {
          if (result && current?.id === forCard) take = result;
        })
        .catch((error) => announce(describeError(error).message))
        .finally(() => drawRecord(false));
    }
    drawRecord();
    return wrap;
  }

  let clozeExample = null;
  function clozePrompt() {
    return h('div.prompt', h('p.muted', 'Which word fits the gap?'), loadCloze());
  }
  function loadCloze() {
    const slot = h('div');
    ctx.data.examplesFor(item.hanzi, { id: item.id, limit: 10 }).then((examples) => {
      if (!examples.length) {
        replace(slot, h('p', item.meanings[0] ?? ''));
        return;
      }
      clozeExample = examples[(item.id.length + answered) % examples.length];
      const gap = '＿'.repeat([...item.hanzi].length);
      replace(slot, zh(clozeExample.hanzi.split(item.hanzi).join(gap), 'mid-hanzi'), h('p.meaning', clozeExample.english), h('p.note', `Hint: ${item.meanings[0] ?? ''}`));
    });
    return slot;
  }

  // Tone check: one row of tone buttons per syllable; the answer is the tone as SPOKEN (sandhi applied).
  let toneGuess = [];
  function toneCheck() {
    const spoken = syllablesOf(item.spoken ?? item.pinyin, { strict: false });
    if (!spoken.length || spoken.length > 3) return null;
    toneGuess = spoken.map(() => null);
    return h('div.tone-check', { role: 'group', aria: { label: 'Optional: which tones did you hear?' } },
      spoken.map((syl, k) => h('div.seg-group', { role: 'group', aria: { label: `Syllable ${k + 1}` } },
        [1, 2, 3, 4, 5].map((tone) => h('button.tone-btn', {
          type: 'button',
          aria: { label: `Syllable ${k + 1}: ${tone === 5 ? 'neutral tone' : `tone ${tone}`}` },
          onclick: (event) => {
            if (toneGuess[k] !== null) return;
            toneGuess[k] = tone;
            const right = tone === syl.tone;
            event.currentTarget.classList.add(right ? 'is-right' : 'is-wrong');
            if (!right) {
              const correct = event.currentTarget.parentElement.children[syl.tone - 1];
              correct?.classList.add('is-right');
            }
            announce(right ? 'Right tone' : `Not quite: it is ${syl.tone === 5 ? 'the neutral tone' : `tone ${syl.tone}`}`);
          },
        }, tone === 5 ? '·' : String(tone))))));
  }

  function answerBlock() {
    const parts = [zh(item.hanzi, item.kind === 'word' ? 'big-hanzi' : 'mid-hanzi'), pinyinBlock(item, { big: true })];
    if (item.kind === 'word') parts.push(meaningList(item.meanings, { max: 4 }));
    else {
      parts.push(h('p.meaning', item.english));
      if (item.literal) parts.push(h('p.note', `Literally: ${item.literal}`));
      if (item.usage) parts.push(h('details.card-usage', h('summary', 'When to use it'), h('p.note', richText(item.usage))));
    }
    parts.push(audioButtons(item, ctx));
    if (current.type === 'cloze' && clozeExample) parts.push(h('p', zh(clozeExample.hanzi), ' ', h('span.muted', clozeExample.english)));
    parts.push(h('a.small', { href: item.kind === 'word' ? `#/word/${item.id}` : item.kind === 'phrase' ? `#/scene/${item.scene}` : '#/kinship' }, 'Details'));
    return h('div.answer', parts);
  }

  function gradeButtons() {
    const preview = state.scheduler.preview(current.card, Date.now());
    return h('div.grades', { role: 'group', aria: { label: 'How well did you know it?' } },
      ['again', 'hard', 'good', 'easy'].map((g, i) => h(`button.grade.${g}`, {
        type: 'button',
        onclick: () => grade(g),
        aria: { keyshortcuts: String(i + 1), label: `${g[0].toUpperCase()}${g.slice(1)}, next in ${intervalLabel(preview[g].due)}` },
      }, `${g[0].toUpperCase()}${g.slice(1)}`, h('span.when', intervalLabel(preview[g].due)))));
  }

  function draw() {
    const card = h('section.flashcard', { aria: { label: `${TYPE_LABEL[current.type]} card` } },
      h('span.card-kind', `${TYPE_LABEL[current.type]}${current.kind === 'new' ? ' · new' : ''}`),
      h('div.card-marks', markButtons(item, ctx, { onChange: () => {
        if (state.markOf(item.id) === 'skip') {
          announce('Skipped. Next card.');
          next();
        }
      } })),
      revealed && current.type === 'read' ? null : prompt(), // the answer repeats the characters and pinyin
      revealed ? answerBlock() : null);
    const actions = revealed
      ? gradeButtons()
      : h('button.btn.primary.reveal-btn', { type: 'button', onclick: reveal, aria: { keyshortcuts: 'Space' } }, current.type === 'speak' ? 'Show answer' : 'Reveal');
    replace(container, header(), card, actions, h('p.note.center', 'Keys: Space reveal · 1–4 grade · R replay · S star · X skip'));
  }

  function reveal() {
    if (revealed || !current) return;
    revealed = true;
    draw();
    container.querySelector('.grades button.good')?.focus();
    if (state.settings.autoplay && current.type !== 'listen') audio.play(item);
    announce(`${item.hanzi}, ${stripTones(item.pinyin)}`);
  }

  function grade(g) {
    if (!current || !revealed) return;
    const ms = Date.now() - shownAt;
    // A new word = the first card of an item never studied (not a further card type of a started item).
    const newItem = current.kind === 'new' && !current.sibling && firstType.get(item.id) === current.type;
    state.answer(current.id, g, { ms, newItem });
    answered += 1;
    if ('storage' in navigator && answered === 1) navigator.storage.persist?.().catch(() => {});
    next();
  }

  function drawDone(q) {
    const nextIn = q.nextDue ? intervalLabel(q.nextDue) : null;
    replace(container,
      h('div.panel.center',
        h('h2', answered ? 'Done for now' : 'Nothing due right now'),
        h('p', answered ? `You answered ${answered} card${answered === 1 ? '' : 's'}.` : 'All cards of your active decks are up to date.'),
        nextIn ? h('p.muted', `Next learning card in about ${nextIn}. This page shows it when it is due.`) : null,
        q.paused ? h('p.note', `New words are paused: ${q.overdue} overdue ${q.overdue === 1 ? 'review waits' : 'reviews wait'} beyond today's limit. Catch up first (or raise the limit in Settings); “Learn 5 more new” still works.`) : null,
        q.total === 0 ? h('p', 'No active decks yet. ', h('a', { href: '#/decks' }, 'Choose decks to study')) : null,
        h('div.row.center-row',
          h('button.btn.primary', { type: 'button', onclick: () => { bonusNew += 5; next(); } }, 'Learn 5 more new'),
          h('a.btn', { href: '#/tones' }, 'Tone practice'),
          h('a.btn', { href: '#/speak' }, 'Speaking scenes'))));
  }

  function onKey(event) {
    if (event.target.closest('input, textarea, select, [contenteditable], dialog') || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!current || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    if ((key === ' ' || key === 'enter') && !revealed) {
      if (event.target.closest('a, button, summary')) return; // the focused link or button does its own thing
      event.preventDefault();
      reveal();
    } else if (revealed && GRADE_KEYS[key]) {
      event.preventDefault();
      grade(GRADE_KEYS[key]);
    } else if (key === 'r' && !event.repeat) audio.play(item);
    else if (key === 's' && !event.repeat) container.querySelector('.mark-btn.star')?.click();
    else if (key === 'x' && !event.repeat) container.querySelector('.mark-btn.skip')?.click();
  }
  document.addEventListener('keydown', onKey);

  await next();
  return () => {
    disposed = true;
    clearTimeout(waitTimer);
    document.removeEventListener('keydown', onKey);
    if (recorder) {
      recorder.cancel();
      releaseAudio();
    }
  };
}
