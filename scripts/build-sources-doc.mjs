#!/usr/bin/env node
// docs/SOURCES.md: every source cited anywhere in the project (research findings, phrases, rules, facts,
// pinyin resolutions, the pinned datasets), deduplicated by URL, with publisher, licence, access date and
// what it was used for. Run after the data or the research changes:
//   node scripts/build-sources-doc.mjs [<research dir>]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './lib/cedict.mjs';

const researchDir = process.argv[2] ?? null;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sources = new Map(); // url -> { url, title, publisher, licence, accessed, via, authority, used: Set }

function add(s, usedFor) {
  if (!s || !s.url) return;
  const url = String(s.url).trim();
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) || !/^https?:\/\//.test(url)) return; // sandbox-local, not a source
  const key = url.replace(/#.*$/, '');
  const cur = sources.get(key) ?? { url, title: s.title ?? null, publisher: s.publisher ?? null, licence: s.licence ?? null, accessed: s.accessed ?? null, via: s.via ?? null, authority: s.authority ?? null, used: new Set() };
  cur.title ??= s.title;
  cur.publisher ??= s.publisher;
  cur.licence ??= s.licence;
  cur.authority ??= s.authority;
  if (s.accessed && (!cur.accessed || s.accessed > cur.accessed)) cur.accessed = s.accessed;
  cur.used.add(usedFor);
  sources.set(key, cur);
}

function walk(value, usedFor) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, usedFor));
  else if (value && typeof value === 'object') {
    if (typeof value.url === 'string' && (value.title || value.evidence || value.accessed)) add(value, usedFor);
    for (const [k, v] of Object.entries(value)) if (k !== 'url') walk(v, usedFor);
  }
}

// Pinned datasets (the pipeline's own inputs).
const DATASETS = [
  { url: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict', title: 'CC-CEDICT (release 2026-05-18, 124,933 entries; obtained via npm @leonsilicon/cc-cedict 0.0.0)', publisher: 'MDBG', licence: 'CC BY-SA 4.0', accessed: '2026-11-02', authority: 'dictionary' },
  { url: 'https://github.com/docrealm/docs-hsk/blob/bdff23362be0ffb4020505b7333a4443bcaa9ec1/HSK%203/HSK%203-2025/%E6%96%B0%E7%89%88HSK%E8%80%83%E8%AF%95%E5%A4%A7%E7%BA%B2.pdf', title: '中文水平考试 HSK考试大纲 (2025), official PDF (sha256 ec74ce04…) mirrored in docrealm/docs-hsk', publisher: '中外语言交流合作中心 (CLEC)', licence: 'official publication, no licence stated', accessed: '2026-11-02', authority: 'official' },
  { url: 'https://github.com/ivankra/hsk30/tree/4ff9e3915ce87baaecd7ebe263085573a4ea3192', title: 'ivankra/hsk30: GF 0025-2021 word list with pinyin and POS', publisher: 'Ivan Krasilnikov', licence: 'MIT (data derived from an official publication)', accessed: '2026-11-02', authority: 'primary' },
  { url: 'https://github.com/clem109/hsk-vocabulary/tree/f3dc9d12ae00d04fa3676b0bd4c43cd58de2c264', title: 'clem109/hsk-vocabulary: HSK 2.0 word lists, levels 1-6', publisher: 'Clement Venard', licence: 'MIT', accessed: '2026-11-02', authority: 'secondary' },
  { url: 'https://pypi.org/project/wordfreq/3.1.1/', title: 'wordfreq 3.1.1, Chinese "large" list', publisher: 'Robyn Speer', licence: 'code Apache-2.0, data CC BY-SA 4.0', accessed: '2026-11-02', authority: 'primary' },
  { url: 'https://github.com/hugolpz/audio-cmn/tree/f759a0f18f27690742957619e1248ed91e9b3f2c', title: 'audio-cmn: Mandarin syllable (Chen Wang) and HSK word (Yue Tan, Shtooka/SWAC) recordings', publisher: 'Hugo Lopez et al.', licence: 'CC BY-SA', accessed: '2026-11-02', authority: 'primary' },
  { url: 'https://registry.npmjs.org/ts-fsrs/-/ts-fsrs-5.4.2.tgz', title: 'ts-fsrs 5.4.2 (FSRS-6), vendored as app/src/vendor/ts-fsrs.mjs', publisher: 'Open Spaced Repetition', licence: 'MIT', accessed: '2026-11-02', authority: 'primary' },
];
for (const d of DATASETS) add(d, 'pipeline input (pinned)');

for (const dir of ['situations', 'reference']) {
  const p = join(ROOT, 'data', dir);
  if (!existsSync(p)) continue;
  for (const f of readdirSync(p).filter((x) => x.endsWith('.json'))) walk(readJson(join(p, f)), `data/${dir}/${f}`);
}
walk(readJson(join(ROOT, 'data', 'hsk', 'resolutions.json')), 'data/hsk/resolutions.json');
if (researchDir && existsSync(researchDir)) {
  for (const f of readdirSync(researchDir).filter((x) => x.endsWith('.verified.json'))) walk(readJson(join(researchDir, f)), `research: ${f.replace('.verified.json', '')}`);
}

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'other';
  }
};
const list = [...sources.values()].sort((a, b) => domainOf(a.url).localeCompare(domainOf(b.url)) || a.url.localeCompare(b.url));
const byDomain = new Map();
for (const s of list) {
  const d = domainOf(s.url);
  if (!byDomain.has(d)) byDomain.set(d, []);
  byDomain.get(d).push(s);
}
const esc = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const lines = [
  '# Sources',
  '',
  'Every source cited in this project, generated by `node scripts/build-sources-doc.mjs` from the research',
  'files, `data/situations/`, `data/reference/`, `data/hsk/resolutions.json` and the pinned datasets.',
  'Grouped by site; "accessed" is the date the source was read. Licence is given where it matters for reuse',
  '(datasets and content shipped in the app); for pages that were only read to verify a fact, no licence',
  'applies to this project. The pinned datasets and their SHA-256 checksums are in `data/sources.lock.json`.',
  '',
  `Total: ${list.length} sources on ${byDomain.size} sites.`,
  '',
  '## Datasets and software shipped or used to build the app',
  '',
  '| Source | Publisher | Licence | Accessed |',
  '| --- | --- | --- | --- |',
  ...DATASETS.map((d) => `| [${esc(d.title)}](${d.url}) | ${esc(d.publisher)} | ${esc(d.licence)} | ${d.accessed} |`),
  '',
  '## All sources by site',
  '',
];
for (const [domain, items] of byDomain) {
  lines.push(`### ${domain} (${items.length})`, '', '| Source | Publisher | Authority | Licence | Accessed | Used for |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of items) {
    const used = [...s.used].slice(0, 4).join('; ') + (s.used.size > 4 ? `; +${s.used.size - 4} more` : '');
    lines.push(`| [${esc(s.title || s.url).slice(0, 140)}](${s.url}) | ${esc(s.publisher)} | ${esc(s.authority)} | ${esc(s.licence)} | ${esc(s.accessed)} | ${esc(used)} |`);
  }
  lines.push('');
}
writeFileSync(join(ROOT, 'docs', 'SOURCES.md'), `${lines.join('\n')}\n`);
console.log(`docs/SOURCES.md: ${list.length} sources on ${byDomain.size} sites`);
