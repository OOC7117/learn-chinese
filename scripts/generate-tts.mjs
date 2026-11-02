#!/usr/bin/env node
// Pre-generate neural audio with Google Cloud Text-to-Speech for every word and phrase that has no
// native recording, with the reading forced where it matters (docs/RESEARCH.md "Audio"):
//   - single characters and words whose characters have more than one CC-CEDICT reading are sent as
//     SSML <phoneme alphabet="pinyin" ph="hang2">行</phoneme> built from the app's own pinyin, so the voice
//     cannot pick the wrong reading;
//   - other words and all phrases are sent as plain text, so the engine applies its normal tone sandhi.
// Files: app/audio/g/<hash>.mp3 (hash of text + pinyin + voice + settings: a pinyin fix regenerates only
// that file); index: data/audio/tts-index.json (read by scripts/build-app-data.mjs). Resumable.
//
//   node scripts/generate-tts.mjs --dry-run                 count characters and estimate the cost
//   GOOGLE_TTS_API_KEY=... node scripts/generate-tts.mjs     generate (needs billing enabled on the project)
//   options: --voice cmn-CN-Wavenet-A  --rate 0.9  --limit 100 (first N only)  --only words|phrases
// Behind a proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node >= 22.21). The key is read from the
// environment only and never written anywhere. Google's terms allow storing and shipping the output
// (see docs/RESEARCH.md); the app labels it as a synthetic voice.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { syllablesOf } from '../app/src/lib/pinyin.js';
import { loadCedict, readings, ROOT } from './lib/cedict.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DRY = flag('dry-run');
const VOICE = opt('voice', 'cmn-CN-Wavenet-A');
const RATE = Number(opt('rate', '0.9'));
const LIMIT = Number(opt('limit', 'Infinity'));
const ONLY = opt('only', 'all');
const KEY = process.env.GOOGLE_TTS_API_KEY ?? '';
const OUT = join(ROOT, 'app', 'audio', 'g');
const INDEX = join(ROOT, 'data', 'audio', 'tts-index.json');
const PRICE_PER_M = VOICE.includes('Chirp3') ? 30 : VOICE.includes('Neural2') ? 16 : 4;
const FREE_M = VOICE.includes('Chirp3') || VOICE.includes('Neural2') ? 1 : 4;

const numbered = (pinyin) => syllablesOf(pinyin, { strict: false }).map((s) => `${s.base.replace(/ü/g, 'v')}${s.tone}`).join(' ');
const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function jobs(dict) {
  const out = [];
  if (ONLY !== 'phrases') {
    for (const file of readdirSync(join(ROOT, 'app', 'data')).filter((f) => /^words-.+\.json$/.test(f))) {
      for (const w of JSON.parse(readFileSync(join(ROOT, 'app', 'data', file), 'utf8')).items) {
        if (w.a) continue; // has a native recording
        const ambiguous = [...w.h].length === 1 || readings(dict, w.h).length > 1;
        out.push({ id: w.i, text: w.h, pinyin: w.p, ssml: ambiguous });
      }
    }
  }
  if (ONLY !== 'words' && existsSync(join(ROOT, 'app', 'data', 'content.json'))) {
    const content = JSON.parse(readFileSync(join(ROOT, 'app', 'data', 'content.json'), 'utf8'));
    for (const s of content.situations ?? []) for (const sc of s.scenes) for (const p of sc.phrases) out.push({ id: p.id, text: p.hanzi, pinyin: p.pinyin, ssml: false });
    for (const t of content.kinship?.terms ?? []) out.push({ id: t.id, text: t.hanzi, pinyin: t.pinyin, ssml: readings(dict, t.hanzi).length > 1 || [...t.hanzi].length === 1 });
    for (const key of ['grammar', 'pitfalls']) for (const it of content[key]?.items ?? []) it.examples.filter((ex) => ex.correct).forEach((ex, k) => out.push({ id: `${it.id}.ex${k + 1}`, text: ex.hanzi, pinyin: ex.pinyin, ssml: false }));
  }
  return out.slice(0, LIMIT);
}

function input(job) {
  if (!job.ssml) return { text: job.text };
  return { ssml: `<speak><phoneme alphabet="pinyin" ph="${escapeXml(numbered(job.pinyin))}">${escapeXml(job.text)}</phoneme></speak>` };
}

const hashOf = (job) => createHash('sha256').update(JSON.stringify([job.text, job.pinyin, job.ssml, VOICE, RATE, 'mp3-v1'])).digest('hex').slice(0, 16);

async function synthesize(job) {
  const body = { input: input(job), voice: { languageCode: 'cmn-CN', name: VOICE }, audioConfig: { audioEncoding: 'MP3', speakingRate: RATE } };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(KEY)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from((await res.json()).audioContent, 'base64');
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error('gave up after retries');
}

async function main() {
  const dict = loadCedict();
  const list = jobs(dict);
  const chars = list.reduce((n, j) => n + (input(j).ssml ?? input(j).text).length, 0);
  const cost = Math.max(0, chars / 1e6 - FREE_M) * PRICE_PER_M;
  console.log(`${list.length} clips (${list.filter((j) => j.ssml).length} with a forced pinyin reading), ${chars.toLocaleString('en-GB')} billed characters with ${VOICE}`);
  console.log(`estimated cost: US$${cost.toFixed(2)} beyond the monthly free tier of ${FREE_M}M characters (US$${(chars / 1e6 * PRICE_PER_M).toFixed(2)} at list price)`);
  if (DRY) return;
  if (!KEY) {
    console.error('Set GOOGLE_TTS_API_KEY (and enable billing on the Google Cloud project). Nothing generated.');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(INDEX, '..'), { recursive: true });
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { voice: VOICE, items: {} };
  let done = 0;
  let failed = 0;
  const queue = [...list];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const hash = hashOf(job);
      const file = join(OUT, `${hash}.mp3`);
      try {
        if (!existsSync(file)) writeFileSync(file, await synthesize(job));
        index.items[job.id] = { file: `g/${hash}.mp3`, voice: VOICE, rate: RATE, ssml: job.ssml, pinyin: job.pinyin, generated: new Date().toISOString().slice(0, 10) };
        done += 1;
        if (done % 100 === 0) {
          writeFileSync(INDEX, `${JSON.stringify(index, null, 1)}\n`);
          console.log(`${done}/${list.length}`);
        }
      } catch (error) {
        failed += 1;
        console.error(`${job.id}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  index.voice = VOICE;
  writeFileSync(INDEX, `${JSON.stringify(index, null, 1)}\n`);
  console.log(`done: ${done}, failed: ${failed}. Now run node scripts/build-app-data.mjs and listen to a sample before committing.`);
}

main();
