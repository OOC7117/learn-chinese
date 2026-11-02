#!/usr/bin/env node
// Download every upstream source this project is built from into raw/ (gitignored), at pinned
// versions, and verify their SHA-256 checksums. Uses curl and git (they honour HTTPS_PROXY).
//
//   node scripts/fetch-sources.mjs            fetch what is missing
//   node scripts/fetch-sources.mjs --force    fetch everything again
//   node scripts/fetch-sources.mjs cedict     only some sources (ids below)
//
// To update a source: change its pin below, run with --force, review the diff of data/ after
// `npm run import`, and update docs/SOURCES.md (version, date accessed).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RAW = join(ROOT, 'raw');

export const SOURCES = [
  {
    id: 'cedict',
    what: 'CC-CEDICT release 2026-05-18 (124,933 entries), parsed to JSON by the npm package @leonsilicon/cc-cedict 0.0.0 (header metadata kept). Licence CC BY-SA 4.0 (MDBG).',
    kind: 'npm-file',
    tarball: 'https://registry.npmjs.org/@leonsilicon/cc-cedict/-/cc-cedict-0.0.0.tgz',
    member: 'package/cedict_1_0_ts_utf-8_mdbg.json',
    dest: 'cedict/cedict.json',
    sha256: null, // filled from the first verified download (see sources.lock.json)
  },
  {
    id: 'hsk2025',
    what: 'Official 2025 HSK exam syllabus PDF 《中文水平考试 HSK考试大纲》 (CLEC, 2025-11), mirrored in docrealm/docs-hsk.',
    kind: 'git-file',
    repo: 'https://github.com/docrealm/docs-hsk.git',
    commit: 'bdff23362be0ffb4020505b7333a4443bcaa9ec1',
    path: 'HSK 3/HSK 3-2025/新版HSK考试大纲.pdf',
    dest: 'hsk2025/syllabus.pdf',
    sha256: 'ec74ce0439e837bbb15154be13e747ae798903b2fd3a331629df6c3b45504941',
  },
  {
    id: 'hsk2021',
    what: 'GF 0025-2021 word list (11,092 terms) with pinyin and POS, cleaned by ivankra/hsk30 (MIT).',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/ivankra/hsk30/4ff9e3915ce87baaecd7ebe263085573a4ea3192/hsk30-expanded.csv',
    dest: 'hsk2021/hsk30-expanded.csv',
    sha256: null,
  },
  {
    id: 'hsk20',
    what: 'HSK 2.0 word lists, late-2012 revision ("HSK Official With Definitions 2012" L1-L6), glxxyz/hskhsk.com (MIT). Only simplified word + level are used.',
    kind: 'url-set',
    urls: [1, 2, 3, 4, 5, 6].map((n) => `https://raw.githubusercontent.com/glxxyz/hskhsk.com/8a6f229c699e2fd7ac8708156c55c3afb2be7e1f/data/lists/HSK%20Official%20With%20Definitions%202012%20L${n}.txt`),
    dest: 'hsk20',
    sha256: null,
  },
  {
    id: 'wordfreq',
    what: 'wordfreq 3.1.1 Chinese "large" frequency list (data CC BY-SA 4.0), from the PyPI wheel.',
    kind: 'wheel-file',
    url: 'https://files.pythonhosted.org/packages/py3/w/wordfreq/wordfreq-3.1.1-py3-none-any.whl',
    pypi: 'wordfreq==3.1.1',
    member: 'wordfreq/data/large_zh.msgpack.gz',
    dest: 'wordfreq/large_zh.msgpack.gz',
    sha256: null,
  },
  {
    id: 'audio-cmn',
    what: 'Native-speaker Mandarin recordings (hugolpz/audio-cmn): 1,707 syllables (Chen Wang) and 8,596 HSK words (Yue Tan, Shtooka/SWAC). CC BY-SA.',
    kind: 'git-sparse',
    repo: 'https://github.com/hugolpz/audio-cmn.git',
    commit: 'f759a0f18f27690742957619e1248ed91e9b3f2c',
    paths: ['/README.md', '/64k/syllabs/*', '/24k-abr/hsk/*'],
    dest: 'audio-cmn',
    sha256: null,
  },
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });

function curl(url, dest) {
  mkdirSync(join(dest, '..'), { recursive: true });
  run('curl', ['-fsSL', '--retry', '4', '--retry-delay', '2', '-o', dest, url]);
}

function fetchSource(src) {
  const dest = join(RAW, src.dest);
  if (src.kind === 'url') curl(src.url, dest);
  else if (src.kind === 'url-set') src.urls.forEach((url) => curl(url, join(dest, decodeURIComponent(url.split('/').pop()))));
  else if (src.kind === 'npm-file' || src.kind === 'wheel-file') {
    const tmp = join(RAW, `.tmp-${src.id}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const archive = join(tmp, src.kind === 'npm-file' ? 'pkg.tgz' : 'pkg.whl');
    if (src.kind === 'wheel-file' && src.pypi) {
      // The wheel's URL is resolved through the PyPI JSON API (stable for a pinned version).
      const [name, version] = src.pypi.split('==');
      const meta = JSON.parse(run('curl', ['-fsSL', `https://pypi.org/pypi/${name}/${version}/json`]).toString());
      const wheel = meta.urls.find((u) => u.filename.endsWith('.whl'));
      curl(wheel.url, archive);
    } else curl(src.tarball ?? src.url, archive);
    if (src.kind === 'npm-file') run('tar', ['-xzf', archive, '-C', tmp, src.member]);
    else run('unzip', ['-q', '-o', archive, src.member, '-d', tmp]);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(join(tmp, src.member), dest);
    rmSync(tmp, { recursive: true, force: true });
  } else if (src.kind === 'git-file' || src.kind === 'git-sparse') {
    const dir = src.kind === 'git-file' ? join(RAW, `.git-${src.id}`) : dest;
    if (!existsSync(join(dir, '.git'))) {
      rmSync(dir, { recursive: true, force: true });
      run('git', ['clone', '--filter=blob:none', '--no-checkout', src.repo, dir]);
    }
    run('git', ['-C', dir, 'config', 'core.quotepath', 'off']);
    run('git', ['-C', dir, 'sparse-checkout', 'init', '--no-cone']);
    run('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...(src.paths ?? [`/${src.path}`])]);
    run('git', ['-C', dir, 'checkout', '--quiet', src.commit]);
    if (src.kind === 'git-file') {
      mkdirSync(join(dest, '..'), { recursive: true });
      copyFileSync(join(dir, src.path), dest);
    }
  } else throw new Error(`unknown kind ${src.kind}`);
}

/** sha256 of a file, or of a folder (sorted "name sha" lines). */
function checksum(path) {
  if (!existsSync(path)) return null;
  try {
    return sha256(path);
  } catch {
    const lines = [];
    const walk = (dir, prefix = '') => {
      for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (name.name.startsWith('.')) continue;
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p, `${prefix}${name.name}/`);
        else lines.push(`${prefix}${name.name} ${sha256(p)}`);
      }
    };
    walk(path);
    return createHash('sha256').update(lines.join('\n')).digest('hex');
  }
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--'));
  const lockPath = join(ROOT, 'data', 'sources.lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};
  let failed = false;
  for (const src of SOURCES) {
    if (only.length && !only.includes(src.id)) continue;
    const dest = join(RAW, src.dest);
    if (force || !existsSync(dest)) {
      process.stdout.write(`fetch ${src.id} ... `);
      fetchSource(src);
      process.stdout.write('done\n');
    }
    const sum = checksum(dest);
    const expected = src.sha256 ?? lock[src.id]?.sha256 ?? null;
    if (expected && sum !== expected) {
      console.error(`CHECKSUM MISMATCH for ${src.id}: expected ${expected}, got ${sum}`);
      failed = true;
      continue;
    }
    lock[src.id] = { what: src.what, pin: src.commit ?? src.tarball ?? src.url ?? src.urls?.[0], sha256: sum, verified: new Date().toISOString().slice(0, 10) };
    console.log(`ok ${src.id} ${sum}`);
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  if (failed) process.exit(1);
}

main();
