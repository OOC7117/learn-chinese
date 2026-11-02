// Audio: native-speaker recordings where the reading is guaranteed (audio-cmn), otherwise the device's
// Mandarin (zh-CN) voice through the Web Speech API. Recordings play through one <audio> element (works
// with the iPhone silent switch off, and is cached by the service worker for offline use).
//
// The device voice cannot be told which reading of a polyphonic character to use, so the UI labels it
// ("device voice") and the build never uses it where the data knows a recording is ambiguous; see
// docs/RESEARCH.md "Audio". scripts/generate-tts.mjs can replace it with pre-generated audio.

export function createAudio({ getSettings = () => ({}) } = {}) {
  const el = typeof Audio === 'function' ? new Audio() : null;
  if (el) el.preload = 'auto';
  const synth = globalThis.speechSynthesis ?? null;
  const Utterance = globalThis.SpeechSynthesisUtterance ?? null;
  let voicesCache = [];
  const listeners = new Set();
  let playing = null; // { id, kind: 'file' | 'tts' }

  const notify = () => {
    for (const fn of listeners) fn(playing);
  };

  function zhVoices() {
    if (!synth) return [];
    const all = synth.getVoices();
    if (all.length) voicesCache = all;
    const norm = (v) => (v.lang || '').replace('_', '-').toLowerCase();
    // Mainland Mandarin first (zh-CN), then other Mandarin voices; never Cantonese (zh-HK / yue).
    const cn = voicesCache.filter((v) => norm(v).startsWith('zh-cn') || norm(v) === 'zh' || norm(v).startsWith('cmn'));
    const other = voicesCache.filter((v) => (norm(v).startsWith('zh-tw') || norm(v).startsWith('zh-sg')) && !cn.includes(v));
    return [...cn, ...other];
  }

  function pickVoice() {
    const wanted = getSettings().ttsVoice;
    const voices = zhVoices();
    return voices.find((v) => v.voiceURI === wanted) ?? voices.find((v) => /premium|enhanced|natural|neural/i.test(v.name) && v.lang.toLowerCase().includes('cn')) ?? voices[0] ?? null;
  }

  synth?.addEventListener?.('voiceschanged', () => {
    voicesCache = synth.getVoices();
  });

  function stop() {
    if (el) {
      el.pause();
      el.removeAttribute('src');
    }
    if (synth) synth.cancel();
    if (playing) {
      playing = null;
      notify();
    }
  }

  function speak(text, { slow = false, id = null } = {}) {
    if (!synth || !Utterance) return Promise.resolve(false);
    synth.cancel();
    const u = new Utterance(text);
    u.lang = 'zh-CN';
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.rate = slow ? Math.max(0.5, (getSettings().slowRate ?? 0.7) - 0.1) : 0.9;
    return new Promise((resolve) => {
      playing = { id, kind: 'tts' };
      notify();
      const done = (ok) => {
        if (playing?.id === id) {
          playing = null;
          notify();
        }
        resolve(ok);
      };
      u.onend = () => done(true);
      u.onerror = () => done(false);
      synth.speak(u);
    });
  }

  async function playFile(file, { slow = false, id = null } = {}) {
    if (!el) return false;
    if (synth) synth.cancel();
    el.pause();
    el.src = file;
    el.playbackRate = slow ? getSettings().slowRate ?? 0.7 : 1;
    if ('preservesPitch' in el) el.preservesPitch = true;
    playing = { id, kind: 'file' };
    notify();
    try {
      await el.play();
      await new Promise((resolve) => {
        const end = () => {
          el.removeEventListener('ended', end);
          el.removeEventListener('pause', end);
          resolve();
        };
        el.addEventListener('ended', end);
        el.addEventListener('pause', end);
      });
      return true;
    } catch {
      return false;
    } finally {
      if (playing?.id === id) {
        playing = null;
        notify();
      }
    }
  }

  return {
    /** Play an item (word, phrase, term) or { hanzi, audio }. Recording if it has one, else the device voice.
     * Resolves to true when something played. */
    async play(item, { slow = false } = {}) {
      if (!item) return false;
      if (item.audio?.file) {
        const ok = await playFile(item.audio.file, { slow, id: item.id ?? item.audio.file });
        if (ok) return true;
        // Offline and not cached: fall back to the device voice.
      }
      return speak(item.hanzi ?? item.text ?? '', { slow, id: item.id ?? null });
    },
    playFile,
    speak,
    stop,
    /** 'recording' | 'generated' | 'device' | 'none': what play(item) will use (for the label next to the
     * button). 'generated' = a pre-generated neural voice clip (synthetic, reading checked). */
    sourceOf(item) {
      if (item?.audio?.file) return item.audio.synthetic ? 'generated' : 'recording';
      return synth && Utterance ? 'device' : 'none';
    },
    get hasDeviceVoice() {
      return Boolean(synth && Utterance) && (zhVoices().length > 0 || voicesCache.length === 0);
    },
    voices: zhVoices,
    get playing() {
      return playing;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
