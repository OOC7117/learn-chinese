// Search every word, phrase and kinship term: characters, pinyin (tones optional: "nihao", "ni3hao3",
// "nǐ hǎo"), or English.

import { h, replace, zh, py, icon } from '../dom.js';
import { indexEntry, search } from '../lib/search.js';

let index = null;

async function buildIndex(data) {
  const [words, content] = await Promise.all([data.loadAllWords(), data.loadContent().catch(() => null)]);
  const items = [...words];
  for (const s of content?.situations ?? []) for (const scene of s.scenes) items.push(...scene.items);
  if (content?.kinship) items.push(...content.kinship.items);
  return items.map(indexEntry);
}

export async function render(root, ctx) {
  const { data, query, audio } = ctx;
  const input = h('input.field', { type: 'search', placeholder: '汉字, pinyin (nihao, ni3hao3) or English', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', aria: { label: 'Search' }, value: query.q ?? '' });
  const status = h('p.small.muted', { aria: { live: 'polite' } });
  const results = h('ul.list');
  replace(root, h('h1', 'Search'), h('div.search-box', input), status, results);

  if (!index) {
    status.textContent = 'Loading all words…';
    try {
      index = await buildIndex(data);
    } catch (error) {
      status.textContent = `Could not load the word lists: ${error.message}`;
      return null;
    }
  }
  const run = () => {
    const q = input.value;
    history.replaceState(null, '', q ? `#/search?q=${encodeURIComponent(q)}` : '#/search');
    if (!q.trim()) {
      replace(results);
      status.textContent = `${index.length.toLocaleString('en-GB')} words and phrases. Type to search.`;
      return;
    }
    const found = search(index, q);
    status.textContent = found.length ? `${found.length}${found.length === 50 ? '+' : ''} results` : 'No results';
    replace(results, found.map((it) => {
      const href = it.kind === 'word' ? `#/word/${it.id}` : it.kind === 'phrase' ? `#/scene/${it.scene}` : '#/kinship';
      return h('li.word-row',
        h('a.hz', { href, lang: 'zh-Hans' }, it.hanzi),
        h('a.meta', { href }, py(it.pinyin), h('span.gloss', it.kind === 'word' ? it.meanings.slice(0, 2).join('; ') : it.english)),
        h('button.play-btn', { type: 'button', aria: { label: `Play ${it.hanzi}` }, onclick: () => audio.play(it) }, icon('play')));
    }));
  };
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  run();
  input.focus();
  return () => clearTimeout(timer);
}

export { zh };
