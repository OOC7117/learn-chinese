// About: where the content comes from, licences and attribution (CC BY-SA obligations), and how
// correctness is checked.

import { h, replace } from '../dom.js';

export async function render(root, ctx) {
  const manifest = await ctx.data.loadManifest();
  replace(root,
    h('h1', 'About and sources'),
    h('p', 'Every word, phrase, tone and fact in this app comes from a source that was read and recorded; anything that could not be verified is not shown (it is listed in docs/UNVERIFIED.md in the project). AI was used for research and to assemble dialogues from checked phrases; such content is labelled.'),
    h('h2', 'Vocabulary'),
    h('ul',
      h('li', h('strong', 'HSK 2025 exam syllabus'), ' — 《中文水平考试 HSK考试大纲》, Center for Language Education and Cooperation (CLEC), published 2025-11; the exam from 13 December 2026. Parsed from the official PDF.'),
      h('li', h('strong', 'GF 0025-2021 standard'), ' — 《国际中文教育中文水平等级标准》 word list, via ivankra/hsk30 (MIT).'),
      h('li', h('strong', 'HSK 2.0 (2012)'), ' — word lists via clem109/hsk-vocabulary (MIT).'),
      h('li', h('strong', 'Meanings and pinyin check'), ' — CC-CEDICT (MDBG), ', h('a', { href: 'https://creativecommons.org/licenses/by-sa/4.0/', rel: 'noopener noreferrer', target: '_blank' }, 'CC BY-SA 4.0'), `. Release ${'2026-05-18'}.`),
      h('li', h('strong', 'Word frequency'), ' — wordfreq 3.1.1 by Robyn Speer, data CC BY-SA 4.0.')),
    h('h2', 'Audio'),
    h('ul',
      h('li', 'Syllable recordings: Chen Wang; word recordings: Yue Tan (Shtooka/SWAC); curated by Hugo Lopez in ', h('a', { href: 'https://github.com/hugolpz/audio-cmn', rel: 'noopener noreferrer', target: '_blank' }, 'audio-cmn'), ', CC BY-SA. A recording is used only where its file name fixes the reading.'),
      h('li', 'Everything else is read by your device\'s Chinese voice, marked "Device voice (synthetic)". It can misread characters with several readings.')),
    h('h2', 'Software'),
    h('ul',
      h('li', 'Scheduling: ts-fsrs 5.4.2 (FSRS-6), Open Spaced Repetition, MIT.'),
      h('li', 'No third-party scripts, no analytics. Your data stays on this device unless you sign in to sync.')),
    h('h2', 'This version'),
    h('p.small.muted', `Data version ${manifest.version} · ${manifest.counts.words.toLocaleString('en-GB')} words · ${manifest.counts.audioFiles.toLocaleString('en-GB')} recordings.`),
    h('p.small.muted', 'Share-alike: the app\'s word data and recordings are derived from CC BY-SA sources and are available under CC BY-SA 4.0.'));
  return null;
}
