// Settings: pace, card types, scheduler retention, audio, level system, backup (export/import).

import { h, replace } from '../dom.js';
import { SETTINGS_DEFAULTS } from '../lib/settings.js';
import { mergeMarks, validateMarks } from '../lib/marks.js';
import { validateSrs } from '../lib/srs.js';
import { cleanStats } from '../lib/stats.js';
import { offlineSection } from '../offline.js';

export function render(root, ctx) {
  const { state, audio } = ctx;
  const body = h('div');
  const offline = offlineSection(ctx); // outside `body`, so redrawing the settings keeps a running download
  replace(root, h('h1', 'Settings'), body, offline.el);

  const number = (key, label, hint, { min, max, step = 1 }) => {
    const id = `set-${key}`;
    return h('li.setting', h('label', { for: id }, label, hint ? h('span.hint', hint) : null),
      h('input', { type: 'number', id, min, max, step, value: state.settings[key], inputmode: step < 1 ? 'decimal' : 'numeric',
        onchange: (e) => state.updateSettings({ [key]: Number(e.target.value) }) }));
  };
  const toggle = (key, label, hint) => {
    const id = `set-${key}`;
    return h('li.setting', h('label', { for: id }, label, hint ? h('span.hint', hint) : null),
      h('input.switch', { type: 'checkbox', id, checked: state.settings[key], onchange: (e) => state.updateSettings({ [key]: e.target.checked }) }));
  };

  const draw = () => {
    const voices = audio.voices();
    replace(body,
      h('h2', 'Pace'),
      h('ul.list',
        number('newPerDay', 'New words per day', '10 a day with Listen + Speak: about 125–260 answers a day after a few months (≈ 17–35 min). HSK 4 (2,000 words) in about 200 days.', { min: 0, max: 100 }),
        number('dailyGoal', 'Daily goal (answers)', null, { min: 5, max: 1000 }),
        number('reviewLimit', 'Maximum reviews per day', 'Overdue cards wait; nothing is lost.', { min: 10, max: 2000 }),
        number('retention', 'Desired retention', 'FSRS default 0.90. Higher = more reviews, fewer lapses (0.80–0.95 is sensible).', { min: 0.7, max: 0.97, step: 0.01 })),
      h('h2', 'Card types'),
      h('p.small.muted', 'Introduced one at a time per word, in this order, on different days.'),
      h('ul.list',
        toggle('typeListen', 'Listen', 'Hear the word, recall the meaning (with a tone check)'),
        toggle('typeSpeak', 'Speak', 'See the English, say it aloud, then compare'),
        toggle('typeRead', 'Characters', 'See the characters, recall pinyin and meaning. Needed for the HSK reading paper; adds about 50% more reviews.'),
        toggle('typeCloze', 'In a phrase', 'Fill the gap in a checked phrase (when the word occurs in one)'),
        toggle('toneCheck', 'Tone check on listen cards', 'Pick the tones you heard before revealing'),
        toggle('showPinyinOnRead', 'Pinyin on the characters card', 'Off is harder but trains reading')),
      h('h2', 'Audio'),
      h('ul.list',
        toggle('autoplay', 'Play audio automatically', 'On listen cards and when an answer is revealed'),
        number('slowRate', 'Slow speed', '0.5 – 1.0 of normal speed', { min: 0.5, max: 1, step: 0.05 }),
        h('li.setting', h('label', { for: 'set-voice' }, 'Device voice', h('span.hint', 'Used where no recording exists. Only Mandarin (zh-CN first) voices are listed.')),
          h('select', { id: 'set-voice', onchange: (e) => state.updateSettings({ ttsVoice: e.target.value }) },
            h('option', { value: '' }, 'Best available'),
            voices.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === state.settings.ttsVoice }, `${v.name} (${v.lang})`)))),
        h('li.setting', h('span', 'Test the device voice'), h('button.btn.small', { type: 'button', onclick: () => audio.speak('你好，很高兴认识你。') }, 'Play'))),
      h('h2', 'Levels'),
      h('ul.list', h('li.setting', h('label', { for: 'set-system' }, 'Show levels from', h('span.hint', 'The 2025 exam syllabus is used from 13 Dec 2026')),
        h('select', { id: 'set-system', onchange: (e) => state.updateSettings({ levelSystem: e.target.value }) },
          [['exam2025', 'HSK 2025 exam syllabus'], ['std2021', 'Standard 2021 (GF 0025)'], ['hsk20', 'HSK 2.0 (2012)']].map(([v, l]) => h('option', { value: v, selected: v === state.settings.levelSystem }, l))))),
      h('h2', 'Backup'),
      h('p.small.muted', 'Everything is saved on this device. Export a backup file now and then (or sign in to sync).'),
      h('div.row',
        h('button.btn', { type: 'button', onclick: exportBackup }, 'Export backup'),
        h('label.btn', { for: 'import-file' }, 'Import backup'),
        h('input.visually-hidden', { type: 'file', id: 'import-file', accept: 'application/json,.json', onchange: importBackup })),
      h('h2', 'Reset'),
      h('button.btn', { type: 'button', onclick: () => { if (confirm('Reset all settings to their defaults? Your progress is kept.')) state.updateSettings({ ...SETTINGS_DEFAULTS }); } }, 'Reset settings'),
      h('p.small.muted', `Storage used on this device: about ${Math.round(ctx.store.usage() / 1024)} KB.`));
  };

  function exportBackup() {
    const snap = state.snapshot();
    const blob = new Blob([JSON.stringify({ app: 'learn-chinese', version: 1, exported: new Date().toISOString(), ...snap }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `learn-chinese-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  async function importBackup(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      if (doc.app !== 'learn-chinese') throw new Error('not a Learn Chinese backup');
      const marks = mergeMarks(validateMarks(doc.marks ?? {}), null);
      const srs = validateSrs(doc.srs ?? {});
      state.merge({ marks, srs, stats: cleanStats(doc.stats), settings: doc.settings, settings_t: doc.settings_t });
      ctx.toast('Backup merged into this device (nothing was deleted).');
      draw();
    } catch (error) {
      ctx.toast(`Import failed: ${error.message}`, 5000);
    }
    e.target.value = '';
  }

  draw();
  const offVoices = () => {};
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', draw);
  return () => {
    offVoices();
    globalThis.speechSynthesis?.removeEventListener?.('voiceschanged', draw);
    offline.cleanup();
  };
}
