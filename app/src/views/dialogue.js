// Dialogue practice for a scene: you play "me". Their lines play and show; for your lines you see the
// English, say it aloud, then reveal and hear the model. The dialogue is assembled by AI from checked
// phrases (each line is a verified phrase) and says so.

import { h, replace, icon, zh, py, announce } from '../dom.js';

export async function render(root, ctx) {
  const { data, audio, params } = ctx;
  const content = await data.loadContent();
  let scene = null;
  for (const s of content.situations ?? []) for (const sc of s.scenes) if (sc.id === params[0]) scene = sc;
  const dialogue = scene?.dialogues?.find((d) => d.id === params[1]) ?? scene?.dialogues?.[0];
  if (!scene || !dialogue) {
    replace(root, h('h1', 'Dialogue not found'), h('a.btn', { href: '#/speak' }, 'All scenes'));
    return null;
  }
  const byId = new Map(scene.items.map((p) => [p.id, p]));
  const lines = dialogue.lines.map((l) => ({ ...l, phrase: byId.get(l.phrase) })).filter((l) => l.phrase);
  let step = 0;
  let revealed = false;
  let hideText = false;
  const log = h('ol.dialogue');
  const controls = h('div.dialogue-controls');

  function lineView(line, i) {
    const p = line.phrase;
    const mine = line.speaker === 'me';
    const showText = !mine ? !hideText || i < step : i < step || (i === step && revealed);
    return h(`li.bubble.${mine ? 'me' : 'them'}`,
      h('span.who', mine ? 'You' : 'Them'),
      showText ? [zh(p.hanzi, 'bubble-hanzi'), h('div', py(p.pinyin))] : null,
      mine || showText ? h('p.bubble-en', p.english) : h('p.bubble-en.muted', 'Listen…'),
      h('button.play-btn', { type: 'button', aria: { label: `Play: ${p.english}` }, onclick: () => audio.play(p) }, icon('play')));
  }

  function draw() {
    replace(log, lines.slice(0, step + 1).map(lineView));
    const line = lines[step];
    if (!line) {
      replace(controls, h('p', 'Done!'), h('div.row', h('button.btn.primary', { type: 'button', onclick: () => { step = 0; revealed = false; draw(); start(); } }, 'Again'), h('a.btn', { href: `#/scene/${scene.id}` }, 'Back to the scene')));
      return;
    }
    if (line.speaker === 'me' && !revealed) {
      replace(controls, h('p.muted', 'Say it in Chinese, out loud.'), h('button.btn.primary.block', { type: 'button', onclick: reveal }, 'Show and hear the answer'));
    } else {
      replace(controls, h('button.btn.primary.block', { type: 'button', onclick: next }, step === lines.length - 1 ? 'Finish' : 'Next line'));
    }
    controls.querySelector('button')?.focus();
  }

  function start() {
    const line = lines[step];
    if (line && line.speaker !== 'me') audio.play(line.phrase);
  }
  function reveal() {
    revealed = true;
    draw();
    audio.play(lines[step].phrase);
    announce(lines[step].phrase.hanzi);
  }
  function next() {
    step += 1;
    revealed = false;
    draw();
    start();
  }

  replace(root,
    h('a.btn.small', { href: `#/scene/${scene.id}` }, icon('back'), scene.title),
    h('h1', dialogue.title ?? 'Dialogue'),
    h('p.callout.small', 'Practice dialogue assembled by AI from this scene\'s checked phrases', dialogue.reviewed ? ' and reviewed.' : ' (not yet reviewed by a teacher). Every line is a verified phrase.'),
    h('label.row.small', h('input.switch', { type: 'checkbox', onchange: (e) => { hideText = e.target.checked; draw(); } }), 'Listening mode: hide their text'),
    log, controls);
  draw();
  start();
  return () => audio.stop();
}
