#!/usr/bin/env node
// Re-create app/src/vendor/ts-fsrs.mjs (and its licence file) from the pinned npm release, or check that the
// committed copy still equals it. The browser loads this single ES module directly (no build step).
//
//   node scripts/vendor-ts-fsrs.mjs           download, verify, write
//   node scripts/vendor-ts-fsrs.mjs --check   download, verify, compare with the committed files (exit 1 on a difference)
//
// The tarball's sha512 must equal the `dist.integrity` the npm registry publishes for that version. The
// vendored file is dist/index.mjs unmodified, except for the header below and the removed sourceMappingURL
// comment (the map is not shipped). To move to another version, change VERSION, run, read the changelog
// and run `npm test` (tests/srs.test.mjs compares scheduling with known results).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '5.4.2';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'app', 'src', 'vendor', 'ts-fsrs.mjs');
const LICENSE_OUT = join(ROOT, 'app', 'src', 'vendor', 'ts-fsrs.LICENSE.txt');
const HEADER = [
  `// ts-fsrs ${VERSION} (FSRS-6 scheduler), https://github.com/open-spaced-repetition/ts-fsrs`,
  '// Copyright (c) 2026 Open Spaced Repetition, MIT License (see ts-fsrs.LICENSE.txt).',
  `// Vendored unmodified from https://registry.npmjs.org/ts-fsrs/-/ts-fsrs-${VERSION}.tgz (dist/index.mjs),`,
  '// except this header and the removed sourceMappingURL comment. Update: scripts/vendor-ts-fsrs.mjs.',
].join('\n');

const curl = (url, ...args) => execFileSync('curl', ['-fsSL', '--retry', '4', '--retry-delay', '2', ...args, url]);

function main() {
  const check = process.argv.includes('--check');
  const meta = JSON.parse(curl(`https://registry.npmjs.org/ts-fsrs/${VERSION}`).toString());
  const [algo, expected] = meta.dist.integrity.split('-');
  const dir = mkdtempSync(join(tmpdir(), 'ts-fsrs-'));
  try {
    const tgz = join(dir, 'pkg.tgz');
    curl(meta.dist.tarball, '-o', tgz);
    const actual = createHash(algo).update(readFileSync(tgz)).digest('base64');
    if (actual !== expected) throw new Error(`integrity mismatch for ${meta.dist.tarball}: ${algo} ${actual} != ${expected}`);
    execFileSync('tar', ['-xzf', tgz, '-C', dir, 'package/dist/index.mjs', 'package/LICENSE']);
    const source = readFileSync(join(dir, 'package', 'dist', 'index.mjs'), 'utf8').replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, '\n');
    const vendored = `${HEADER}\n${source}`;
    const licence = readFileSync(join(dir, 'package', 'LICENSE'), 'utf8');
    if (check) {
      const same = readFileSync(OUT, 'utf8') === vendored && readFileSync(LICENSE_OUT, 'utf8') === licence;
      console.log(same ? `app/src/vendor/ts-fsrs.mjs equals ts-fsrs ${VERSION} (integrity verified)` : `app/src/vendor differs from ts-fsrs ${VERSION}: run node scripts/vendor-ts-fsrs.mjs`);
      process.exitCode = same ? 0 : 1;
      return;
    }
    writeFileSync(OUT, vendored);
    writeFileSync(LICENSE_OUT, licence);
    console.log(`wrote app/src/vendor/ts-fsrs.mjs and ts-fsrs.LICENSE.txt from ts-fsrs ${VERSION} (integrity verified)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
