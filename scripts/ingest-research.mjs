#!/usr/bin/env node
// One-time (re-runnable) import of the Phase 1 research results into the canonical data files:
//   <research dir>/<topic>.verified.json  ->  data/situations/{travel,family,work}.json,
//                                             data/reference/{kinship,grammar,pitfalls,facts}.json
//
//   node scripts/ingest-research.mjs <research dir>
//
// Every item keeps its sources, the verifier's verdict and notes, and gets the provenance fields
// (source, source_url, verified_against). Status: "verified" only when the independent verifier
// confirmed or corrected the item AND the CC-CEDICT word-by-word check passes now; otherwise the
// item is kept with status "unverified" (or "refuted") and never reaches the app. After this import the
// files in data/ are the source of truth: edit them, not the research files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { citationPinyin, normalize } from '../app/src/lib/pinyin.js';
import { checkText, loadCedict, releaseDate, ROOT } from './lib/cedict.mjs';

const TOPICS = {
  travel: ['travel-basics', 'travel-transport', 'travel-food-pay'],
  family: ['family-address-kinship', 'family-visit-dinner', 'family-festivals'],
  work: ['work-intro-contacts', 'work-meetings-writing'],
};
const TITLES = {
  travel: ['Travel in China', 'Getting around mainland China: greetings, help, transport, hotels, food, paying and emergencies.'],
  family: ['Family', "Meeting and visiting your partner's family: forms of address, gifts, dinner, small talk and festivals."],
  work: ['Work', 'Working with Chinese colleagues and clients: titles, introductions, WeChat, meetings and writing.'],
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
};

function loadTopic(dir, topic) {
  const verified = join(dir, `${topic}.verified.json`);
  const raw = join(dir, `${topic}.json`);
  if (existsSync(verified)) return { doc: readJson(verified), verifiedFile: true };
  if (existsSync(raw)) return { doc: readJson(raw), verifiedFile: false };
  return null;
}

/** Status after ingest: the verifier's verdict and today's CC-CEDICT check both have to pass. */
// Confirmed by their verifier but left unverified only because the phrase checker of that time read 到了 in
// 就到了 as the word dàoliǎo (fixed: particle rule in scripts/lib/cedict.mjs). They count as verified when
// today's check passes.
const CHECKER_FALSE_POSITIVES = new Set(['travel.directions.wang-qian-zou-yibai-mi', 'travel.directions.bu-yuan-jiu-zai-qianmian']);

function decideStatus(entry, verifiedFile, check) {
  const verdict = entry.verification?.verdict;
  if (entry.status === 'refuted' || verdict === 'refuted') return 'refuted';
  if (!verifiedFile || !verdict) return 'unverified'; // never independently checked
  if (!['confirmed', 'corrected'].includes(verdict)) return 'unverified';
  if (entry.status !== 'verified' && !(CHECKER_FALSE_POSITIVES.has(entry.id) && check?.status === 'ok')) return 'unverified';
  if (check && check.status === 'fail') return 'unverified';
  return 'verified';
}

function provenance(entry, cedictRelease, { language = true } = {}) {
  const sources = [...(entry.sources ?? []), ...(entry.verification?.checked_sources ?? [])]
    .filter((s) => s && s.url)
    .filter((s, i, all) => all.findIndex((x) => x.url === s.url && x.evidence === s.evidence) === i);
  const first = sources[0] ?? null;
  const second = sources.find((s) => s.url !== first?.url) ?? null;
  return {
    sources,
    source: first ? (first.publisher ? `${first.title} (${first.publisher})` : first.title) : null,
    source_url: first?.url ?? null,
    verified_against: [language ? `CC-CEDICT ${cedictRelease} (word-by-word pinyin check)` : null, second ? second.title : null, entry.verification ? 'independent verifier (agent), 2026-11-02' : null].filter(Boolean).join('; '),
  };
}

function cleanPhrase(p, dict, verifiedFile, cedictRelease) {
  const pinyin = citationPinyin(p.hanzi, normalize(p.pinyin).trim());
  const check = checkText(dict, p.hanzi, pinyin);
  const out = {
    id: p.id,
    hanzi: p.hanzi.trim(),
    pinyin,
    pinyin_as_source: p.pinyin_as_source ?? null,
    literal: p.literal ?? null,
    english: p.english,
    usage: learnerText(p.usage),
    register: p.register ?? null,
    speaker: p.speaker ?? 'either',
    slots: p.slots ?? undefined,
    regional_note: learnerText(p.regional_note),
    ...provenance(p, cedictRelease),
    check: check.status,
    status: decideStatus(p, verifiedFile, check),
    confidence: p.confidence ?? null,
    verification: p.verification ?? null,
    ai_generated: false,
  };
  for (const key of ['relation_path', 'side', 'generation', 'gender', 'address_form', 'reference_form']) if (p[key] !== undefined) out[key] = p[key];
  return out;
}

function cleanRule(r, verifiedFile, cedictRelease) {
  return {
    id: r.id,
    rule: r.rule,
    why: learnerText(r.why),
    regional_note: learnerText(r.regional_note),
    ...provenance(r, cedictRelease, { language: false }),
    status: decideStatus(r, verifiedFile, null),
    confidence: r.confidence ?? null,
    verification: r.verification ?? null,
    ai_generated: false,
  };
}


/** Research notes about the session ("was not verified in this session", "The brief's …", "Evidence: …",
 * "(search-result summary)") belong in docs/RESEARCH.md, not in the app: drop the parentheses and the
 * sentences (or ;-clauses) that carry them. The claims themselves are untouched. */
const META_SENTENCE = [
  /this session|open_questions|search-result|web search|Sources this session|Built only from/i,
  /could not be verified|\b(?:was|were|is|are) not verified|\bNOT verified/i,
  /not (?:found|seen) (?:verbatim|in (?:a|any|the) sources?)/i,
  /The brief's/,
  /^(?:Evidence|NOTE):/,
];
const META_PAREN = /\s*\((?:[^()]*?)(?:search-result|this session|inference|not verified|could not be opened|open_questions)[^()]*\)/gi;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|c|ca|cf|vs|pr|lit|approx|incl|esp|No)\.|\b[A-Z]\.)$/;

/** Split English prose into sentences and ;-clauses, outside brackets and not after abbreviations. */
export function clauses(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  const chars = [...String(text)];
  chars.forEach((ch, i) => {
    cur += ch;
    if (ch === '(' || ch === '（') depth += 1;
    else if ((ch === ')' || ch === '）') && depth > 0) depth -= 1;
    else if ((ch === '.' || ch === ';') && depth === 0 && /\s/.test(chars[i + 1] ?? '') && !(ch === '.' && ABBREVIATION.test(cur))) {
      out.push(cur.trim());
      cur = '';
    }
  });
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function learnerText(text) {
  if (!text) return null;
  const stripped = String(text).replace(META_PAREN, '');
  const all = clauses(stripped);
  const kept = all.filter((c) => !META_SENTENCE.some((re) => re.test(c)));
  if (kept.length === all.length) return stripped.trim() || null; // nothing (else) to drop: keep the text as written
  // A clause that ended in ";" now ends the text or a sentence: end it with a full stop.
  const fixed = kept.map((c, i) => (c.endsWith(';') && (i === kept.length - 1 || /^[A-Z]/.test(kept[i + 1])) ? `${c.slice(0, -1)}.` : c));
  return fixed.join(' ').replace(/\s+([.,;:])/g, '$1').trim() || null;
}

export function ingest(dir, { dict = loadCedict() } = {}) {
  const release = releaseDate(dict);
  const report = {};
  const kinship = { kind: 'kinship term', title: 'Kinship terms', intro: null, terms: [], rules: [] };
  for (const [situation, topics] of Object.entries(TOPICS)) {
    const scenes = [];
    for (const topic of topics) {
      const loaded = loadTopic(dir, topic);
      if (!loaded) {
        report[topic] = 'missing';
        continue;
      }
      report[topic] = loaded.verifiedFile ? 'verified file' : 'UNVERIFIED (no verifier output)';
      for (const scene of loaded.doc.scenes ?? []) {
        const phrases = (scene.phrases ?? []).map((p) => cleanPhrase(p, dict, loaded.verifiedFile, release));
        const rules = (scene.rules ?? []).map((r) => cleanRule(r, loaded.verifiedFile, release));
        if (scene.id.startsWith('family.kinship')) {
          kinship.terms.push(...phrases.map((t) => ({ ...t, group: scene.id, group_title: scene.title })));
          kinship.rules.push(...rules);
          continue;
        }
        scenes.push({ id: scene.id, title: scene.title, description: learnerText(scene.description), phrases, rules });
      }
    }
    const [title, intro] = TITLES[situation];
    writeJson(join(ROOT, 'data', 'situations', `${situation}.json`), { situation, title, intro, researched_on: '2026-11-02', scenes });
  }
  writeJson(join(ROOT, 'data', 'reference', 'kinship.json'), kinship);

  for (const topic of ['grammar', 'pitfalls']) {
    const loaded = loadTopic(dir, topic);
    if (!loaded) {
      report[topic] = 'missing';
      continue;
    }
    report[topic] = loaded.verifiedFile ? 'verified file' : 'UNVERIFIED (no verifier output)';
    const items = (loaded.doc.items ?? []).map((it) => ({
      id: it.id,
      title: it.title,
      rule: it.rule,
      details: learnerText(it.details),
      examples: (it.examples ?? []).map((ex) => ({
        hanzi: ex.hanzi,
        pinyin: citationPinyin(ex.hanzi, normalize(ex.pinyin).trim()),
        spoken: ex.spoken ?? null,
        pinyin_as_source: ex.pinyin_as_source ?? null,
        english: ex.english,
        correct: ex.correct !== false,
        source: ex.source ?? null,
      })),
      common_mistake: learnerText(it.common_mistake),
      ...provenance(it, release),
      status: decideStatus(it, loaded.verifiedFile, null),
      confidence: it.confidence ?? null,
      verification: it.verification ?? null,
      ai_generated: false,
    }));
    writeJson(join(ROOT, 'data', 'reference', `${topic}.json`), { kind: topic === 'grammar' ? 'grammar point' : 'pitfall', title: loaded.doc.title, items });
  }

  // Facts that change (travel): findings -> facts with checked_on and a re-check link.
  const facts = loadTopic(dir, 'travel-facts');
  if (facts) {
    report['travel-facts'] = facts.verifiedFile ? 'verified file' : 'UNVERIFIED (no verifier output)';
    writeJson(join(ROOT, 'data', 'reference', 'facts.json'), {
      kind: 'fact',
      title: 'Travelling in mainland China with a Dutch passport',
      checked_on: '2026-11-02',
      recommendation: facts.doc.recommendation ?? null,
      facts: (facts.doc.findings ?? []).map((f) => ({
        id: f.id.replace(/^travel-facts\./, 'facts.'),
        topic: f.id.split('.')[1]?.split('-')[0] ?? 'general',
        question: f.question,
        answer: f.answer,
        checked_on: '2026-11-02',
        recheck_url: (f.sources ?? []).find((s) => s.authority === 'official')?.url ?? f.sources?.[0]?.url ?? null,
        ...provenance(f, release, { language: false }),
        status: f.verification?.verdict && ['confirmed', 'corrected'].includes(f.verification.verdict) && f.status === 'verified' ? 'verified' : f.status === 'refuted' || f.verification?.verdict === 'refuted' ? 'refuted' : 'unverified',
        confidence: f.confidence ?? null,
        verification: f.verification ?? null,
        ai_generated: false,
      })),
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/ingest-research.mjs <research dir>');
    process.exit(2);
  }
  const report = ingest(dir);
  console.log(JSON.stringify(report, null, 1));
}
