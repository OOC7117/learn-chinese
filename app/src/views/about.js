// About: where the content comes from, licences and attribution (CC BY-SA obligations), and how
// correctness is checked.

import { h, replace } from '../dom.js';

const ext = (href, text) => h('a', { href, rel: 'noopener noreferrer', target: '_blank' }, text);

export async function render(root, ctx) {
  const manifest = await ctx.data.loadManifest();
  replace(root,
    h('h1', 'About and sources'),
    h('p', 'Every word, phrase, tone and fact in this app comes from a source that was read and recorded; anything that could not be verified is not shown (it is listed in docs/UNVERIFIED.md in the project).'),
    h('p', 'How AI was used: research agents found and quoted the sources and wrote the English notes (literal glosses, usage notes) from them; a second agent re-checked each item. The Chinese text itself is never written by AI: it is quoted from a source and checked word by word against the CC-CEDICT dictionary. Practice dialogues are arranged by AI from checked phrases and say so. The full list is in docs/AI-CONTENT.md.'),
    h('h2', 'Vocabulary'),
    h('ul',
      h('li', h('strong', 'HSK 2025 exam syllabus'), ' — 《中文水平考试 HSK考试大纲》, Center for Language Education and Cooperation (CLEC), published 2025-11; the exam from 13 December 2026. Parsed from the official PDF.'),
      h('li', h('strong', 'GF 0025-2021 standard'), ' — 《国际中文教育中文水平等级标准》 word list, via ivankra/hsk30 (MIT).'),
      h('li', h('strong', 'HSK 2.0 (2012 revision)'), ' — word lists via glxxyz/hskhsk.com (MIT); only words and levels are used.'),
      h('li', h('strong', 'Meanings and pinyin check'), ' — ', ext('https://www.mdbg.net/chinese/dictionary?page=cc-cedict', 'CC-CEDICT'), ', community maintained free Chinese-English dictionary, published by MDBG; CEDICT – Copyright (C) 1997, 1998 Paul Andrew Denisowski. Licence ', ext('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'), `. Release ${'2026-05-18'}. Changes: only the entries this app needs, pinyin shown with tone marks, cross-references shortened to the simplified form.`),
      h('li', h('strong', 'Word frequency'), ' — ', ext('https://github.com/rspeer/wordfreq', 'wordfreq'), ' 3.1.1 by Robyn Speer, data ', ext('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'), ', used to order the words. Its Chinese data is built from Wikipedia, OpenSubtitles 2018 (attribution to OpenSubtitles), SUBTLEX-CH by Cai and Brysbaert (SUBTLEX is freely available data), NewsCrawl, GlobalVoices, ', ext('https://books.google.com/ngrams', 'Google Books Ngrams'), ', OSCAR, Twitter and the jieba word list.')),
    h('h2', 'Audio'),
    h('ul',
      h('li', 'Syllable recordings: © 2013 Wang Chen, Lopez Hugo, Vion Nicolas, ', ext('https://creativecommons.org/licenses/by-sa/3.0/', 'CC BY-SA 3.0'), ', from ', ext('https://github.com/hugolpz/audio-cmn', 'audio-cmn'), ' (Hugo Lopez). Used unmodified.'),
      h('li', 'Word recordings: Yue Tan, Shtooka project pack cmn-caen-tan, via audio-cmn; CC BY-SA (the source does not state the version). Used unmodified, and only where the file name fixes the reading.'),
      h('li', 'Everything else is read by your device\'s Chinese voice, marked "Device voice (synthetic)". It can misread characters with several readings. Clips marked "Generated voice (synthetic)" were made with Google Cloud Text-to-Speech with the reading set from the checked pinyin.')),
    h('h2', 'Software'),
    h('ul',
      h('li', 'Scheduling: ts-fsrs 5.4.2 (FSRS-6), Open Spaced Repetition, MIT.'),
      h('li', 'No third-party scripts, no analytics. Your data stays on this device unless you sign in to sync.')),
    h('h2', 'This version'),
    h('p.small.muted', `Data version ${manifest.version} · ${manifest.counts.words.toLocaleString('en-GB')} words · ${manifest.counts.audioFiles.toLocaleString('en-GB')} recordings.`),
    h('p.small.muted', 'Share-alike: the app\'s word data (data/words-*.json) is derived from CC-CEDICT and wordfreq and is available under CC BY-SA 4.0. The recordings keep their own licences (above). The code is MIT.'));
  return null;
}
