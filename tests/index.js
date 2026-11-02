// Lets `node --test tests` (and `npm test`) work on every Node version:
// Node 18/20 expand the folder to its *.test.mjs files (this file is not one of them); Node 21+ treat
// the argument as a path, which resolves to this file, so it loads every *.test.mjs in the folder.
import { readdirSync } from 'node:fs';

const here = new URL('.', import.meta.url);
for (const name of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(new URL(name, here));
}
