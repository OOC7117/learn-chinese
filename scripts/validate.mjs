#!/usr/bin/env node
// Validator: fails (exit code 1) when the data could teach something wrong or unsourced.
//
//   node scripts/validate.mjs            check data/ and app/data/, write build/validation-report.json
//                                        and docs/UNVERIFIED.md (every item the app does not show and why)
//
// Fails on:
//   - invalid pinyin syllables, tone-mark errors (wrong vowel, two marks, tone numbers, v/u: for ü)
//   - duplicate ids (across HSK words, phrases, kinship terms, grammar and pitfall items, dialogues)
//   - words or phrases with no audio (no recording and no text the browser voice can read)
//   - phrases with characters outside the character set (not simplified, or unknown to CC-CEDICT)
//   - entries missing provenance (source/sources, source_url, verified_against; AI flags on generated content)
//   - HSK words whose pinyin disagrees with CC-CEDICT without an explicit, non-pending resolution
//   - phrases/examples whose characters and citation pinyin fail the CC-CEDICT word-by-word check
//   - app/data that is out of date with data/ (run scripts/build-app-data.mjs)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pinyinProblems, syllablesOf } from '../app/src/lib/pinyin.js';
import { checkText, loadCedict, releaseDate, ROOT } from './lib/cedict.mjs';

const DATA = join(ROOT, 'data');
const APP = join(ROOT, 'app');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const isHan = (ch) => /\p{Script=Han}/u.test(ch);

export function validate({ root = ROOT, dict = loadCedict() } = {}) {
  const data = join(root, 'data');
  const app = join(root, 'app');
  const errors = [];
  const warnings = [];
  const unverified = []; // { kind, id, text, why }
  const fail = (code, id, detail) => errors.push({ code, id, detail });
  const warn = (code, id, detail) => warnings.push({ code, id, detail });
  const ids = new Map();
  const claim = (id, where) => {
    if (!ID.test(id)) fail('invalid-id', id, where);
    if (ids.has(id)) fail('duplicate-id', id, `${ids.get(id)} and ${where}`);
    else ids.set(id, where);
  };

  const charset = existsSync(join(data, 'sources', 'charset.json')) ? readJson(join(data, 'sources', 'charset.json')) : null;
  const simplified = charset ? new Set(charset.simplified) : null;
  const tradOnly = charset ? new Set(charset.traditional_only) : new Set();
  function checkChars(id, text) {
    for (const ch of String(text)) {
      if (!isHan(ch)) continue;
      if (tradOnly.has(ch)) fail('traditional-character', id, `${ch} in ${text}`);
      else if (simplified && !simplified.has(ch)) fail('unknown-character', id, `${ch} in ${text}`);
    }
  }
  function checkPinyin(id, pinyin) {
    for (const p of pinyinProblems(pinyin)) fail(`pinyin-${p.code}`, id, `${p.text}: ${p.detail}`);
  }

  // ---------- HSK words ----------
  const resolutions = existsSync(join(data, 'hsk', 'resolutions.json')) ? readJson(join(data, 'hsk', 'resolutions.json')).resolutions : [];
  const decisionOf = new Map(resolutions.map((r) => [r.id, r]));
  const hskFiles = existsSync(join(data, 'hsk')) ? readdirSync(join(data, 'hsk')).filter((f) => /^words-.+\.json$/.test(f)) : [];
  let hskCount = 0;
  for (const file of hskFiles) {
    for (const item of readJson(join(data, 'hsk', file)).items) {
      hskCount += 1;
      claim(item.id, `data/hsk/${file}`);
      checkPinyin(item.id, item.pinyin);
      for (const alt of item.pinyin_alt ?? []) checkPinyin(item.id, alt);
      checkChars(item.id, item.hanzi);
      if (syllablesOf(item.pinyin, { strict: false }).length !== [...item.hanzi].filter(isHan).length) fail('pinyin-alignment', item.id, `${item.hanzi} ${item.pinyin}`);
      if (!item.source || !item.source_url || !item.verified_against) fail('missing-provenance', item.id, 'source, source_url and verified_against are required');
      if (!item.audio || !['syllable', 'word', 'tts'].includes(item.audio.kind)) fail('no-audio', item.id, item.hanzi);
      if (item.audio?.file && !existsSync(join(app, 'audio', item.audio.file))) {
        // Only words that reach the app need their file; build-app-data copies them.
        if (item.cedict.match === 'ok' || (item.resolution && item.resolution !== 'pending')) fail('audio-file-missing', item.id, item.audio.file);
      }
      if (!item.meanings?.length) warn('no-meaning', item.id, `${item.hanzi} ${item.pinyin}: no CC-CEDICT meaning for this reading`);
      if (item.cedict.match !== 'ok') {
        const d = decisionOf.get(item.id);
        if (!d) fail('cedict-disagreement-unresolved', item.id, `${item.hanzi} ${item.pinyin} vs CC-CEDICT ${item.cedict.readings.join(' | ')}`);
        else if (d.decision === 'pending' || !d.note) {
          fail('cedict-disagreement-pending', item.id, `${item.hanzi} ${item.pinyin} vs CC-CEDICT ${item.cedict.readings.join(' | ')}`);
          unverified.push({ kind: 'HSK word', id: item.id, text: `${item.hanzi} ${item.pinyin}`, why: `pinyin disagrees with CC-CEDICT (${item.cedict.readings.join(' | ')}); decision pending` });
        }
      }
    }
  }
  for (const r of resolutions) {
    if (r.decision !== 'pending' && (!r.note || !r.decided_by)) fail('resolution-without-note', r.id, 'every decision needs a note and decided_by');
    if (['use-cedict', 'alt-of'].includes(r.decision) && !r.sources?.length) fail('resolution-without-source', r.id, 'a reviewed decision needs at least one source');
  }

  // ---------- Situations, reference content ----------
  const contentFiles = [];
  for (const dir of ['situations', 'reference', 'generated']) {
    const p = join(data, dir);
    if (existsSync(p)) for (const f of readdirSync(p).filter((x) => x.endsWith('.json'))) contentFiles.push(join(dir, f));
  }
  const phraseIds = new Set();
  function checkLanguageItem(id, hanzi, pinyin, where, status) {
    claim(id, where);
    checkChars(id, hanzi);
    checkPinyin(id, pinyin);
    const report = checkText(dict, hanzi, pinyin);
    const shown = status === 'verified';
    if (report.status === 'fail') {
      const why = [...report.problems, ...report.words.filter((w) => w.verdict === 'mismatch' || w.verdict === 'not-in-dictionary').map((w) => `${w.word}: given ${w.given}, CC-CEDICT ${w.dict ?? w.verdict}`)].join('; ');
      if (shown) fail('cedict-check-failed', id, `${hanzi} | ${pinyin}: ${why}`);
      else unverified.push({ kind: where, id, text: `${hanzi} ${pinyin}`, why: `CC-CEDICT check failed: ${why}` });
    } else if (report.status === 'warn' && shown) {
      for (const w of report.words.filter((x) => x.verdict === 'sandhi')) fail('pinyin-not-citation', id, `${w.word}: write citation tones (${w.dict})`);
      for (const w of report.words.filter((x) => x.verdict === 'neutral')) warn('neutral-tone-differs', id, `${w.word}: ${w.given} vs CC-CEDICT ${w.dict}`);
    }
    return report;
  }
  // Provenance is required on everything the app shows. Unshown (unverified/refuted) items may lack it;
  // they are listed in docs/UNVERIFIED.md instead.
  const requireSources = (id, entry) => {
    const report = entry.status === 'verified' ? fail : () => {};
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) report('missing-provenance', id, 'sources are required');
    else for (const s of entry.sources) if (!s.url || !s.accessed) report('missing-provenance', id, 'every source needs url and accessed');
    if (!entry.source || !entry.source_url || !entry.verified_against) report('missing-provenance', id, 'source, source_url and verified_against are required');
  };
  const note = (kind, entry, text) => {
    if (entry.status !== 'verified') unverified.push({ kind, id: entry.id, text, why: `status ${entry.status ?? 'missing'}${entry.verification?.notes ? `: ${String(entry.verification.notes).slice(0, 300)}` : ''}` });
  };

  for (const rel of contentFiles) {
    const doc = readJson(join(data, rel));
    const generated = rel.startsWith('generated');
    if (generated && (doc.ai_generated !== true || doc.reviewed === undefined)) fail('ai-flags-missing', rel, 'generated content must say ai_generated: true and reviewed: true|false');
    for (const scene of doc.scenes ?? []) {
      claim(scene.id, rel);
      for (const p of scene.phrases ?? []) {
        checkLanguageItem(p.id, p.hanzi, p.pinyin, `phrase (${rel})`, p.status);
        phraseIds.add(p.id);
        requireSources(p.id, p);
        if (!p.english || !p.hanzi || !p.pinyin) fail('incomplete-phrase', p.id, 'hanzi, pinyin and english are required');
        if (!p.audio && !p.hanzi) fail('no-audio', p.id, 'no recording and no text');
        note('phrase', p, `${p.hanzi} ${p.pinyin}`);
      }
      for (const r of scene.rules ?? []) {
        claim(r.id, rel);
        requireSources(r.id, r);
        note('rule', r, r.rule);
      }
    }
    for (const t of doc.terms ?? []) {
      checkLanguageItem(t.id, t.hanzi, t.pinyin, `term (${rel})`, t.status);
      requireSources(t.id, t);
      note('kinship term', t, `${t.hanzi} ${t.pinyin} (${t.english})`);
    }
    for (const r of doc.rules ?? []) {
      claim(r.id, rel);
      requireSources(r.id, r);
      note('rule', r, r.rule);
    }
    for (const item of doc.items ?? []) {
      claim(item.id, rel);
      requireSources(item.id, item);
      note(doc.kind ?? 'reference item', item, item.title ?? item.rule);
      (item.examples ?? []).forEach((ex, k) => {
        const exId = `${item.id}.ex${k + 1}`;
        checkLanguageItem(exId, ex.hanzi, ex.pinyin, `example (${rel})`, item.status === 'verified' && ex.source ? 'verified' : 'unverified');
        if (!ex.source?.url) fail('missing-provenance', exId, 'every example needs its source');
      });
    }
    for (const f of doc.facts ?? []) {
      claim(f.id, rel);
      requireSources(f.id, f);
      if (!f.checked_on) fail('missing-date', f.id, 'facts that change need checked_on');
      note('fact', f, f.question ?? f.answer);
    }
    for (const d of doc.dialogues ?? []) {
      claim(d.id, rel);
      for (const line of d.lines ?? []) if (!phraseIds.has(line.phrase_id) && !line.hanzi) fail('dialogue-unknown-phrase', d.id, line.phrase_id);
    }
  }

  // ---------- app/data is current ----------
  const manifestPath = join(app, 'data', 'manifest.json');
  if (!existsSync(manifestPath)) fail('app-data-missing', 'app/data/manifest.json', 'run node scripts/build-app-data.mjs');
  const contentPath = join(app, 'data', 'content.json');
  if (existsSync(contentPath) && readJson(contentPath).dev_unverified) fail('unverified-content-in-app', 'app/data/content.json', 'built with BUILD_INCLUDE_UNVERIFIED=1: rebuild without it');

  return { errors, warnings, unverified, counts: { hsk: hskCount, ids: ids.size, contentFiles: contentFiles.length }, cedict: releaseDate(dict) };
}

function writeUnverified(result) {
  const lines = [
    '# UNVERIFIED items',
    '',
    'Generated by `node scripts/validate.mjs`. These items are **not shown in the app** (or, for HSK',
    'words with a pending decision, not shown until the decision is recorded). Each needs a source or a',
    'correction before it can be used. See docs/RESEARCH.md for how items are verified.',
    '',
    `CC-CEDICT release used for checks: ${result.cedict}. Total: ${result.unverified.length}.`,
    '',
  ];
  const byKind = new Map();
  for (const u of result.unverified) {
    if (!byKind.has(u.kind)) byKind.set(u.kind, []);
    byKind.get(u.kind).push(u);
  }
  for (const [kind, list] of byKind) {
    lines.push(`## ${kind} (${list.length})`, '');
    for (const u of list) lines.push(`- \`${u.id}\` ${u.text}: ${u.why}`.replace(/\s+/g, ' ').trim());
    lines.push('');
  }
  writeFileSync(join(ROOT, 'docs', 'UNVERIFIED.md'), `${lines.join('\n')}\n`);
}

/** docs/AI-CONTENT.md: everything an AI assembled or wrote, for the learner to review (spec: AI content is
 * labelled, kept separate, automatically checked, and listed). The Chinese text of phrases is quoted from
 * sources and checked against CC-CEDICT; dialogues only arrange such phrases. */
function writeAiReview(root = ROOT) {
  const data = join(root, 'data');
  const lines = [
    '# AI-assembled content to review',
    '',
    'Generated by `node scripts/validate.mjs`. Nothing below contains Chinese text written by an AI: every',
    'Chinese line is a phrase quoted from a cited source and checked word by word against CC-CEDICT. What an',
    'AI did:',
    '',
    '1. **Dialogues** (`data/generated/dialogues.json`, `ai_generated: true`): an agent arranged verified phrases',
    '   of a scene into a short scripted conversation. The app labels them; set `reviewed: true` on a dialogue',
    '   once you have checked that it flows naturally.',
    '2. **English notes**: the `literal`, `english` and `usage` texts of phrases, terms and rules were written by',
    '   the research agents from the cited sources and re-checked by a second agent (see each item\'s',
    '   `verification`). They are explanations, not quotations.',
    '',
  ];
  const gen = join(data, 'generated', 'dialogues.json');
  const phrases = new Map();
  if (existsSync(join(data, 'situations'))) {
    for (const f of readdirSync(join(data, 'situations')).filter((x) => x.endsWith('.json'))) {
      for (const sc of readJson(join(data, 'situations', f)).scenes) for (const p of sc.phrases) phrases.set(p.id, p);
    }
  }
  if (existsSync(gen)) {
    const doc = readJson(gen);
    lines.push(`## Dialogues (${doc.dialogues.length})`, '');
    for (const d of doc.dialogues) {
      lines.push(`### ${d.title} (\`${d.id}\`, scene \`${d.scene}\`, reviewed: ${d.reviewed === true ? 'yes' : 'no'})`, '');
      for (const l of d.lines) {
        const p = phrases.get(l.phrase);
        lines.push(`- **${l.speaker === 'me' ? 'You' : 'Them'}:** ${p ? `${p.hanzi} ${p.pinyin} — ${p.english}${p.status === 'verified' ? '' : ' **(phrase not verified: dialogue hidden)**'}` : `missing phrase \`${l.phrase}\``}`);
      }
      lines.push('');
    }
  } else lines.push('No dialogues yet.', '');
  writeFileSync(join(root, 'docs', 'AI-CONTENT.md'), `${lines.join('\n')}\n`);
}

function main() {
  const result = validate();
  writeAiReview();
  mkdirSync(join(ROOT, 'build'), { recursive: true });
  writeFileSync(join(ROOT, 'build', 'validation-report.json'), `${JSON.stringify(result, null, 1)}\n`);
  writeUnverified(result);
  const byCode = {};
  for (const e of result.errors) byCode[e.code] = (byCode[e.code] ?? 0) + 1;
  console.log(`checked ${result.counts.hsk} HSK words, ${result.counts.ids} ids, ${result.counts.contentFiles} content files (CC-CEDICT ${result.cedict})`);
  console.log(`errors: ${result.errors.length} ${JSON.stringify(byCode)}; warnings: ${result.warnings.length}; unverified (not shown): ${result.unverified.length}`);
  for (const e of result.errors.slice(0, 40)) console.log(`  ERROR ${e.code} ${e.id}: ${e.detail}`);
  if (result.errors.length > 40) console.log(`  ... ${result.errors.length - 40} more in build/validation-report.json`);
  process.exit(result.errors.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
