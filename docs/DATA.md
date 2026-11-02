# Data contract

One canonical source (`data/`, JSON, versioned, reviewable) → generated compact files the app loads
(`app/data/`, committed, so the site needs no build step). Nothing in `app/data/` is edited by hand.

```
raw/                     upstream downloads (gitignored)        scripts/fetch-sources.mjs (pinned, sha256 in data/sources.lock.json)
data/sources/            derived copies of sources               scripts/import-hsk.mjs
  hsk2025-syllabus.json  the official 2025 syllabus rows (11,000), parsed from the PDF
  cedict-subset.json     CC-CEDICT entries this project uses (offline validation)
  charset.json           simplified / traditional-only characters (validator)
data/hsk/                canonical HSK vocabulary                 scripts/import-hsk.mjs
  words-<level>.json     one file per 2025 exam level (1 … 6, 7-9) + words-other.json
  resolutions.json       explicit decision for every word whose pinyin differs from CC-CEDICT
data/situations/*.json   travel / family / work scenes, phrases, etiquette rules (sourced)
data/reference/*.json    kinship, grammar, pitfalls, facts that change
data/generated/*.json    AI-assembled content (dialogues), ai_generated: true, reviewed: false
app/data/                compact app files                         scripts/build-app-data.mjs, scripts/build-content.mjs
app/audio/s/<syl>.mp3    syllable recordings (audio-cmn, Chen Wang), e.g. ma3.mp3, lv4.mp3
app/audio/w/<id>.mp3     word recordings (audio-cmn, Yue Tan), named by item id
```

## Ids

Stable, ASCII, dot-separated, matching `^[a-z0-9][a-z0-9._-]{0,159}$` (the same rule as marks and sync):

- HSK words: `w.<hex code points>.<numbered pinyin>` — 爱好 àihào → `w.7231-597d.ai4hao4`. Derived from
  the characters and the source reading, so the same word gets the same id in every list and every
  re-import. A later pinyin correction (resolutions.json `use-cedict`) does not change the id.
- Phrases: `<situation>.<scene>.<slug>`, e.g. `travel.station.ticket-to`. Rules: `<scene>.rule.<slug>`.
- Kinship terms: `kinship.<slug>`; grammar `grammar.<slug>`; pitfalls `pitfalls.<slug>`; facts `facts.<slug>`.
- Spaced-repetition cards: `<item id>.<type>`, type ∈ listen | speak | read | cloze.

## Provenance (required, the validator fails without it)

| field | meaning |
| --- | --- |
| `source` | which list, dictionary or site the item comes from |
| `source_url` | where (a URL; pinned commit URL for datasets) |
| `verified_against` | the second source used to cross-check (e.g. `CC-CEDICT 2026-05-18`, or a second teaching site) |
| `sources[]` | phrases, rules, facts: `{ url, title, publisher, published, accessed, via, authority, evidence }` |
| `status` | `verified` (shown), `unverified` / `refuted` (never shown; listed in docs/UNVERIFIED.md) |
| `ai_generated`, `reviewed` | on everything an AI wrote or assembled; generated content lives in `data/generated/` |

## HSK word (data/hsk/words-*.json)

```json
{
  "id": "w.7231.ai4", "hanzi": "爱", "pinyin": "ài", "pinyin_official": "ài", "pinyin_alt": [],
  "pos": ["动"], "levels": { "exam2025": "1", "std2021": "1", "hsk20": 1 },
  "exam2025": [{ "seq": 1, "level": "1", "extra_levels": [], "sense": null, "pos": "动" }],
  "std2021": [{ "id": "L1-0001", "level": "1" }], "hsk20": [{ "id": 1, "level": 1 }],
  "meanings": ["to love; to be fond of; to like", "affection"], "classifiers": [],
  "cedict": { "match": "ok", "readings": ["ài"], "entries": ["愛|爱[ai4]"] },
  "freq": { "zipf": 5.41, "rank": 144 },
  "audio": { "kind": "syllable", "file": "s/ai4.mp3", "speaker": "Chen Wang", "source": "audio-cmn" },
  "source": "hsk2025-syllabus", "source_url": "https://github.com/docrealm/docs-hsk/…", "verified_against": "CC-CEDICT 2026-05-18",
  "resolution": null
}
```

- `pinyin` is in **citation tones** (一 yī, 不 bù, third tones unchanged); the official lists print the tone
  changes of 一/不, kept in `pinyin_official`. The app derives the spoken form (tone sandhi) for display.
- `levels.exam2025` = the 2025 HSK exam syllabus (primary; first regular exam 2026-12-13);
  `levels.std2021` = GF 0025-2021; `levels.hsk20` = HSK 2.0 (2012), `null` = not in that list.
- `audio.kind`: `syllable` (one syllable, tones 1-4: the recording named by that exact syllable), `word`
  (a word recording whose characters have exactly one CC-CEDICT reading, equal to ours), or `tts` (the
  device's voice; `reason` says why).

## App files (app/data/)

- `manifest.json`: `{ version, decks[], files{ key: { file, hash, count } }, counts, sources }`
- `words-<level>.json`: `{ level, items: [{ i, h, p, sp?, alt?, m, c?, pos?, l: [exam2025, std2021, hsk20], f?, a?, r? }] }`
  — `a`: `"s:ma3"` syllable recording, `"w"` word recording (`audio/w/<i>.mp3`), absent = device voice;
  `sp` spoken form when tone sandhi changes it; `r` the resolution decision when pinyin differs from CC-CEDICT.
- `tones.json`: `{ syllables: ["a1", …], pairs: { "14": [word ids], … }, minimal: [[id, id], …] }` — only
  words pronounced with their citation tones (no 一/不/3-3 sandhi) are used for tone identification.
- `content.json` (`buildContent` in scripts/lib/content.mjs, called by scripts/build-app-data.mjs; verified items only):

```json
{
  "situations": [{ "id": "travel", "title": "Travel in China", "intro": "…", "scenes": [{
    "id": "travel.station", "title": "At the station", "description": "…",
    "phrases": [{ "id", "hanzi", "pinyin", "literal", "english", "usage", "register", "speaker": "me|them|either",
                  "regional_note", "slots": [{ "text", "meaning", "examples": [] }], "sources": [{ "url", "title", "publisher", "accessed" }], "audio": null,
                  "w": ["<HSK word id>"] }],
    "rules": [{ "id", "rule", "why", "regional_note", "sources": [] }],
    "dialogues": [{ "id", "title", "ai_generated": true, "reviewed": false, "lines": [{ "speaker": "me|them", "phrase": "<phrase id>" }] }]
  }] }],
  "kinship": { "intro": "…", "terms": [{ "id", "hanzi", "pinyin", "english", "literal", "usage", "regional_note",
    "relation_path": ["father", "older brother"], "side": "paternal|maternal|own|spouse", "generation": 1,
    "gender": "m|f", "address_form": true, "reference_form": false, "sources": [] }], "rules": [] },
  "grammar": { "items": [{ "id", "title", "rule", "details", "examples": [{ "hanzi", "pinyin", "spoken", "english", "correct": true, "source": { "url", "title" } }], "common_mistake", "sources": [] }] },
  "pitfalls": { "items": [ "same shape as grammar" ] },
  "facts": { "checked_on": "2026-11-02", "facts": [{ "id", "topic", "question", "answer", "checked_on", "recheck_url", "sources": [], "valid_until": "2026-12-31 (optional)", "confidence": "medium|low (optional)" }],
             "open": [{ "id", "topic", "question", "official_url": "…|null" }] }
}
```

`w` lists the HSK words a phrase or kinship term contains, matched by characters **and** reading, longest
first (`hskWordsIn` in scripts/build-app-data.mjs): 银行 yínháng links to 银行, never to 行 xíng. The app
shows them as links on the phrase and uses them to find example phrases for a word (cloze cards, word page).

Phrases, tips, kinship terms and facts carry `confidence` only when the research rated them below "high"
(the app shows a "less certain" chip for low and a note for medium). A fact with `valid_until` (a policy with
an end date, such as visa-free entry) is marked "out of date" in the app after that day.

`facts.open` are the travel questions whose answer could not be double-checked: only the question (the
fact's `open_label` in data/reference/facts.json, else its research question) and its official page reach
the app, never the unconfirmed answer; the validator fails if an open entry carries an answer.

## Browser storage (namespaced per app, version 1)

`learn-chinese:v1:marks`, `…:srs`, `…:settings`, `…:stats`, `…:account`, `…:synced`, `…:srs-revs`, `…:tones`
(see app/src/lib/storage.js). Server keys: `learn-chinese:user:<sha256(email)>` (marks, settings, stats)
and `learn-chinese:srs:<sha256(email)>:<bucket 00-31>` (card states), so the app can share the reference
project's Upstash database and accounts service.
