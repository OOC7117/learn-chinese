// User settings: defaults and cleaning of untrusted values (storage, another device). Pure logic.
// Settings sync as one flat value (marks.js mergeSettings / validateSettings: at most 32 keys, primitive
// values), so lists are stored as comma-separated strings.

export const SETTINGS_DEFAULTS = Object.freeze({
  newPerDay: 10, // new items (words, phrases, terms) per day
  reviewLimit: 300,
  dailyGoal: 50, // answers per day
  retention: 0.9, // FSRS desired retention: 0.85 lighter, 0.90 balanced, 0.95 intensive (docs/RESEARCH.md 4.3)
  pauseNewWhenOverdue: true, // no new words while reviews from earlier days wait
  // Card types, in the order they are introduced for each word (docs/RESEARCH.md: listen, speak, then characters).
  // Characters is off by default: with Listen + Speak, 10 new words a day settle at about 125-260 answers a
  // day; adding Characters raises that to about 190-400 (FSRS simulation, docs/RESEARCH.md 4.6).
  typeListen: true,
  typeSpeak: true,
  typeRead: false,
  typeCloze: true,
  // What "Study" draws from: deck ids (exam2025-1 ... , std2021-*, hsk20-*, scene ids, kinship).
  activeDecks: 'exam2025-1,exam2025-2,exam2025-3',
  levelSystem: 'exam2025', // which level system the app shows first: exam2025 | std2021 | hsk20
  autoplay: true, // play audio when a card is revealed (and on listen cards when shown)
  slowRate: 0.7,
  showPinyinOnRead: false, // characters card: show pinyin on the front
  toneCheck: true, // listen cards: ask for the tones before revealing
  ttsVoice: '', // voiceURI of the chosen zh-CN voice ('' = best available)
  dayStartHour: 4,
});

const NUMBER_RANGES = Object.freeze({
  newPerDay: [0, 100],
  reviewLimit: [10, 2000],
  dailyGoal: [5, 1000],
  retention: [0.8, 0.95], // the research's limit for the UI (inside FSRS's 0.70-0.97 'reasonable' range)
  slowRate: [0.5, 1],
  dayStartHour: [0, 12],
});
const BOOLEANS = ['typeListen', 'typeSpeak', 'typeRead', 'typeCloze', 'autoplay', 'showPinyinOnRead', 'toneCheck', 'pauseNewWhenOverdue'];
const SYSTEMS = ['exam2025', 'std2021', 'hsk20'];
const DECK_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;

/** Untrusted settings -> valid settings (unknown keys dropped, bad values -> default). */
export function cleanSettings(raw, { deckIds = null } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...SETTINGS_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
    const v = Number(src[key]);
    if (Number.isFinite(v) && v >= min && v <= max) out[key] = key === 'retention' || key === 'slowRate' ? Math.round(v * 100) / 100 : Math.round(v);
  }
  for (const key of BOOLEANS) if (typeof src[key] === 'boolean') out[key] = src[key];
  if (SYSTEMS.includes(src.levelSystem)) out.levelSystem = src.levelSystem;
  if (typeof src.ttsVoice === 'string' && src.ttsVoice.length <= 200) out.ttsVoice = src.ttsVoice;
  if (typeof src.activeDecks === 'string') {
    const list = src.activeDecks.split(',').map((s) => s.trim()).filter((s) => DECK_ID.test(s) && (!deckIds || deckIds.has(s)));
    out.activeDecks = [...new Set(list)].join(',');
  }
  return out;
}

export const activeDeckList = (settings) => (settings.activeDecks ? settings.activeDecks.split(',').filter(Boolean) : []);

export function withDeck(settings, deckId, on) {
  const list = activeDeckList(settings).filter((d) => d !== deckId);
  if (on) list.push(deckId);
  return { ...settings, activeDecks: list.join(',') };
}

/** Card types enabled, in introduction order, for an item kind. */
export function cardTypesFor(kind, settings) {
  const enabled = (t) => settings[`type${t[0].toUpperCase()}${t.slice(1)}`] !== false;
  if (kind === 'word') return ['listen', 'speak', 'read', 'cloze'].filter(enabled);
  if (kind === 'phrase') return ['listen', 'speak'].filter(enabled);
  if (kind === 'term') return ['speak', 'listen'].filter(enabled);
  return [];
}

export function sameSettings(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
