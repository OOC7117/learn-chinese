// data/situations/*.json + data/reference/*.json + data/generated/dialogues.json -> the app's
// content.json (docs/DATA.md). Only items with status "verified" are included; dialogue lines must
// point at verified phrases (dialogues are AI-assembled and keep their ai_generated / reviewed flags).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ORDER = ['travel', 'family', 'work'];

/** The fact's re-check page if it is an official source (a government or the operator itself), else null. */
const officialUrl = (f) => {
  const src = (f.sources ?? []).find((s) => s.url === f.recheck_url);
  return f.recheck_url && src?.authority === 'official' ? f.recheck_url : null;
};

const slimSources = (sources = []) => sources.slice(0, 4).map((s) => ({ url: s.url, title: s.title, publisher: s.publisher ?? null, accessed: s.accessed ?? null }));

/**
 * @param {string} root repository root
 * @param {{ includeUnverified?: boolean }} options  includeUnverified is for local UI work only
 *   (BUILD_INCLUDE_UNVERIFIED=1): the output then carries dev_unverified: true and the validator fails.
 */
export function buildContent(root, { includeUnverified = false } = {}) {
  const ok = (x) => x.status === 'verified' || (includeUnverified && x.status !== 'refuted');
  const data = join(root, 'data');
  const situations = [];
  const phraseIds = new Set();
  const counts = { phrases: 0, rules: 0, terms: 0, grammar: 0, pitfalls: 0, facts: 0, dialogues: 0 };
  const dialoguesDoc = existsSync(join(data, 'generated', 'dialogues.json')) ? readJson(join(data, 'generated', 'dialogues.json')) : null;
  const dialoguesByScene = new Map();
  for (const d of dialoguesDoc?.dialogues ?? []) {
    if (!dialoguesByScene.has(d.scene)) dialoguesByScene.set(d.scene, []);
    dialoguesByScene.get(d.scene).push(d);
  }
  const files = existsSync(join(data, 'situations')) ? readdirSync(join(data, 'situations')).filter((f) => f.endsWith('.json')) : [];
  files.sort((a, b) => ORDER.indexOf(a.replace('.json', '')) - ORDER.indexOf(b.replace('.json', '')));
  for (const file of files) {
    const doc = readJson(join(data, 'situations', file));
    const scenes = [];
    for (const scene of doc.scenes) {
      const phrases = scene.phrases.filter(ok).map((p) => {
        phraseIds.add(p.id);
        return {
          id: p.id, hanzi: p.hanzi, pinyin: p.pinyin, literal: p.literal, english: p.english, usage: p.usage,
          register: p.register, speaker: p.speaker, regional_note: p.regional_note, slots: p.slots,
          sources: slimSources(p.sources), audio: p.audio ?? null,
        };
      });
      const rules = (scene.rules ?? []).filter(ok).map((r) => ({ id: r.id, rule: r.rule, why: r.why, regional_note: r.regional_note, sources: slimSources(r.sources) }));
      const dialogues = (dialoguesByScene.get(scene.id) ?? [])
        .filter((d) => d.lines.every((l) => phraseIds.has(l.phrase)))
        .map((d) => ({ id: d.id, title: d.title, ai_generated: true, reviewed: d.reviewed === true, lines: d.lines.map((l) => ({ speaker: l.speaker, phrase: l.phrase })) }));
      counts.phrases += phrases.length;
      counts.rules += rules.length;
      counts.dialogues += dialogues.length;
      if (phrases.length || rules.length) scenes.push({ id: scene.id, title: scene.title, description: scene.description, phrases, rules, dialogues });
    }
    situations.push({ id: doc.situation, title: doc.title, intro: doc.intro, scenes });
  }
  const ref = (name) => (existsSync(join(data, 'reference', `${name}.json`)) ? readJson(join(data, 'reference', `${name}.json`)) : null);
  const kin = ref('kinship');
  const kinship = kin ? {
    intro: kin.intro,
    terms: kin.terms.filter(ok).map((t) => ({
      id: t.id, hanzi: t.hanzi, pinyin: t.pinyin, english: t.english, literal: t.literal, usage: t.usage, regional_note: t.regional_note,
      relation_path: t.relation_path ?? [], side: t.side ?? null, generation: t.generation ?? null, gender: t.gender ?? null,
      address_form: t.address_form ?? null, reference_form: t.reference_form ?? null, group: t.group ?? null, group_title: t.group_title ?? null,
      sources: slimSources(t.sources), audio: t.audio ?? null,
    })),
    rules: kin.rules.filter(ok).map((r) => ({ id: r.id, rule: r.rule, why: r.why, regional_note: r.regional_note, sources: slimSources(r.sources) })),
  } : null;
  if (kinship) counts.terms = kinship.terms.length;
  const reference = (name) => {
    const doc = ref(name);
    if (!doc) return null;
    const items = doc.items.filter(ok).map((it) => ({
      id: it.id, title: it.title, rule: it.rule, details: it.details, common_mistake: it.common_mistake,
      examples: it.examples.filter((ex) => ex.source?.url).map((ex) => ({ hanzi: ex.hanzi, pinyin: ex.pinyin, spoken: ex.spoken, english: ex.english, correct: ex.correct, source: { url: ex.source.url, title: ex.source.title } })),
      sources: slimSources(it.sources),
    }));
    counts[name] = items.length;
    return { title: doc.title, items };
  };
  const factsDoc = ref('facts');
  const facts = factsDoc ? {
    title: factsDoc.title,
    checked_on: factsDoc.checked_on,
    facts: factsDoc.facts.filter(ok).map((f) => ({ id: f.id, topic: f.topic, question: f.question, answer: f.answer, checked_on: f.checked_on, recheck_url: f.recheck_url, sources: slimSources(f.sources) })),
    // Questions whose answer could not be double-checked: only the question and the official page to look
    // it up on reach the app, never the unverified answer.
    open: factsDoc.facts.filter((f) => !ok(f) && f.status !== 'refuted').map((f) => ({ id: f.id, topic: f.topic, question: f.open_label ?? f.question, official_url: officialUrl(f) })),
  } : null;
  if (facts) counts.facts = facts.facts.length;
  const content = { situations, kinship, grammar: reference('grammar'), pitfalls: reference('pitfalls'), facts };
  if (includeUnverified) content.dev_unverified = true;
  return { content, counts };
}
