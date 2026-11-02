// Microphone recording for the tone trainer's record-and-compare page (beta). Audio never leaves the
// device: nothing is uploaded or stored; a recording lives in memory until the page is left.
//
// Capture: getUserMedia + MediaRecorder in the browser's own format (Opus in WebM or Ogg in Chrome and
// Firefox, AAC in MP4 in Safari), decoded with AudioContext.decodeAudioData into samples for playback
// and pitch analysis. Without MediaRecorder (Safari before 14.1) a ScriptProcessorNode collects the raw
// samples instead.
//
// Playback goes through Web Audio (an AudioBufferSourceNode), so it needs no blob: URL: the app's CSP
// allows media from 'self' only. Only when a browser cannot decode its own recording does it fall back to
// an <audio> element with a Blob URL, which works only if the CSP has media-src blob:.
//
// iOS Safari: the AudioContext must be created and resumed inside the tap handler, so unlockAudio() is
// called synchronously at the start of record() and of every play; navigator.audioSession (Safari 17+)
// is set to play-and-record while capturing and to playback afterwards, so the recording is audible with
// the ring/silent switch on, and back to auto when the page is left. The microphone is released (all
// tracks stopped) as soon as a recording ends.

const AudioCtor = () => globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
const OfflineCtor = () => globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext ?? null;

let shared = null; // the page's AudioContext (created on the first tap)
let offline = null; // decoding before any tap

/** Can this browser record? { ok, reason: null | 'insecure' | 'no-microphone-api' | 'no-web-audio' | 'no-recorder' }. */
export function recordingSupport() {
  if (globalThis.isSecureContext === false) return { ok: false, reason: 'insecure' };
  if (typeof globalThis.navigator?.mediaDevices?.getUserMedia !== 'function') return { ok: false, reason: 'no-microphone-api' };
  const Ctor = AudioCtor();
  if (!Ctor) return { ok: false, reason: 'no-web-audio' };
  if (typeof globalThis.MediaRecorder !== 'function' && typeof Ctor.prototype.createScriptProcessor !== 'function') return { ok: false, reason: 'no-recorder' };
  return { ok: true, reason: null };
}

function setAudioSession(type) {
  try {
    const session = globalThis.navigator?.audioSession;
    if (session && session.type !== type) session.type = type;
  } catch {
    // Not supported in this browser: nothing to do.
  }
}

/**
 * Create (once) and resume the page's AudioContext. Call it synchronously from a click or tap handler:
 * iOS only lets audio start from inside one. Returns the context, or null without Web Audio.
 */
export function unlockAudio() {
  const Ctor = AudioCtor();
  if (!Ctor) return null;
  try {
    if (!shared || shared.state === 'closed') shared = new Ctor();
    if (shared.state !== 'running') shared.resume().catch(() => {});
    // Older iOS also wants a sound started from the gesture: one silent sample.
    const source = shared.createBufferSource();
    source.buffer = shared.createBuffer(1, 1, shared.sampleRate);
    source.connect(shared.destination);
    source.start(0);
  } catch {
    // A context that cannot start yet still decodes; playback reports failure later.
  }
  return shared;
}

function decodeWith(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    // Old Safari only has the callback form; current browsers return a promise as well.
    const result = context.decodeAudioData(arrayBuffer, resolve, (error) => reject(error ?? new Error('could not decode audio')));
    if (result && typeof result.then === 'function') result.then(resolve, reject);
  });
}

/** Decode compressed audio (MP3, Opus, AAC...) into an AudioBuffer. Works before any tap (it then uses
 * an OfflineAudioContext). */
export function decodeAudio(arrayBuffer) {
  let context = shared;
  if (!context) {
    const Ctor = OfflineCtor();
    if (Ctor) {
      try {
        offline ??= new Ctor(1, 1, 44100);
      } catch {
        offline = null;
      }
    }
    context = offline;
  }
  if (!context) return Promise.reject(new Error('Web Audio is not available'));
  return decodeWith(context, arrayBuffer);
}

/** First channel of an AudioBuffer as a Float32Array (recordings are mono; stereo files use the left). */
export const monoSamples = (buffer) => buffer.getChannelData(0);

const loaded = new Map(); // url -> Promise<{ buffer, samples, sampleRate, duration }>
const MAX_LOADED = 24;

/** Fetch and decode an audio file of the app (e.g. a reference recording), cached for the visit. */
export function loadAudio(url) {
  if (!loaded.has(url)) {
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(decodeAudio)
      .then((buffer) => ({ buffer, samples: monoSamples(buffer), sampleRate: buffer.sampleRate, duration: buffer.duration }))
      .catch((error) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, promise);
    if (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value);
  }
  return loaded.get(url);
}

function blobToArrayBuffer(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Response(blob).arrayBuffer();
}

function concatFloat32(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
const frame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 50));
const cancelFrame = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

/**
 * A recorder for one page. record() must be called from a tap handler; it resolves when the recording
 * ends (stop(), the time limit, or the microphone going away) with a take:
 *   { buffer: AudioBuffer | null, samples: Float32Array | null, sampleRate, durationMs, blob: Blob | null }
 * buffer is null when the browser could not decode its own recording (then only playBlob works).
 * cancel() ends a recording without a take (record() resolves null). Errors from getUserMedia reject
 * (see describeError).
 */
export function createRecorder({ maxMs = 4000 } = {}) {
  let session = null;
  let starting = false; // waiting for getUserMedia (the permission prompt)
  let abortStart = false; // cancel() came while starting: release the microphone as soon as it arrives

  async function finish(cancelled) {
    const s = session;
    if (!s || s.ending) return;
    s.ending = true;
    clearTimeout(s.timer);
    cancelFrame(s.frame);
    const durationMs = Math.round(now() - s.startedAt);
    let blob = null;
    let raw = null;
    if (s.recorder) {
      if (s.recorder.state !== 'inactive') {
        const stopped = new Promise((resolve) => s.recorder.addEventListener('stop', resolve, { once: true }));
        try {
          s.recorder.stop();
          await stopped;
        } catch {
          // already stopped
        }
      }
      blob = new Blob(s.chunks, { type: s.recorder.mimeType || s.chunks[0]?.type || '' });
    } else if (s.parts) raw = concatFloat32(s.parts);
    for (const track of s.stream.getTracks()) track.stop(); // release the microphone at once
    try {
      s.source?.disconnect();
      s.processor?.disconnect();
    } catch {
      // nodes already gone
    }
    session = null;
    if (cancelled) {
      s.resolve(null);
      return;
    }
    setAudioSession('playback');
    try {
      let buffer = null;
      if (blob?.size) buffer = await decodeAudio(await blobToArrayBuffer(blob)).catch(() => null);
      else if (raw?.length && shared) {
        buffer = shared.createBuffer(1, raw.length, shared.sampleRate);
        buffer.getChannelData(0).set(raw);
      }
      s.resolve({ buffer, samples: buffer ? monoSamples(buffer) : null, sampleRate: buffer?.sampleRate ?? null, durationMs, blob: blob?.size ? blob : null });
    } catch (error) {
      s.reject(error);
    }
  }

  return {
    get recording() {
      return Boolean(session);
    },

    /** Start recording (from a tap). onStart() once the microphone is live; onLevel(rms 0..1, elapsedMs)
     * about 60 times a second. */
    async record({ onStart, onLevel } = {}) {
      if (session || starting) throw new Error('already recording');
      const support = recordingSupport();
      if (!support.ok) throw Object.assign(new Error(`recording not supported: ${support.reason}`), { name: 'NotSupportedError', reason: support.reason });
      const ac = unlockAudio(); // synchronously, inside the tap
      setAudioSession('play-and-record');
      let stream;
      starting = true;
      abortStart = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      } catch (error) {
        setAudioSession('auto');
        throw error;
      } finally {
        starting = false;
      }
      if (abortStart) {
        for (const track of stream.getTracks()) track.stop();
        setAudioSession('auto');
        return null;
      }
      const s = { stream, chunks: [], parts: null, recorder: null, startedAt: now(), timer: 0, frame: 0, ending: false };
      const result = new Promise((resolve, reject) => {
        s.resolve = resolve;
        s.reject = reject;
      });
      session = s;
      try {
        if (ac) {
          if (ac.state !== 'running') await ac.resume().catch(() => {});
          // cancel() while the context resumed (the page was left): finish() has released the microphone.
          if (session !== s) return null;
          s.source = ac.createMediaStreamSource(stream);
          const analyser = ac.createAnalyser();
          analyser.fftSize = 1024;
          s.source.connect(analyser);
          const data = new Uint8Array(analyser.fftSize);
          const tick = () => {
            if (session !== s) return;
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i += 1) {
              const x = (data[i] - 128) / 128;
              sum += x * x;
            }
            onLevel?.(Math.sqrt(sum / data.length), now() - s.startedAt);
            s.frame = frame(tick);
          };
          s.frame = frame(tick);
        }
        if (typeof globalThis.MediaRecorder === 'function') {
          s.recorder = new MediaRecorder(stream);
          s.recorder.addEventListener('dataavailable', (event) => {
            if (event.data?.size) s.chunks.push(event.data);
          });
          s.recorder.start();
        } else {
          // Fallback: raw samples through a ScriptProcessorNode (it only runs while connected to the output;
          // it writes silence there).
          s.parts = [];
          s.processor = ac.createScriptProcessor(4096, 1, 1);
          s.processor.onaudioprocess = (event) => {
            s.parts.push(new Float32Array(event.inputBuffer.getChannelData(0)));
            event.outputBuffer.getChannelData(0).fill(0);
          };
          s.source.connect(s.processor);
          s.processor.connect(ac.destination);
        }
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        cancelFrame(s.frame);
        session = null;
        setAudioSession('auto');
        throw error;
      }
      s.startedAt = now();
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => finish(false), { once: true });
      s.timer = setTimeout(() => finish(false), maxMs);
      onStart?.({ maxMs });
      return result;
    },

    /** End the recording; record() resolves with the take. */
    stop() {
      return finish(false);
    },

    /** End the recording without a take (leaving the page); also while the microphone is still being
     * started (the stream is released the moment it arrives). */
    cancel() {
      if (!session && starting) {
        abortStart = true;
        return Promise.resolve();
      }
      return finish(true);
    },
  };
}

// ---------- Playback ----------

let playing = null; // { source, resolve }
let blobAudio = null;
let blobUrl = null;

/** Stop whatever this module is playing. */
export function stopPlayback() {
  if (playing) {
    const { source, resolve } = playing;
    playing = null;
    try {
      source.onended = null;
      source.stop();
    } catch {
      // not started or already ended
    }
    resolve(false);
  }
  if (blobAudio && !blobAudio.paused) blobAudio.pause();
}

/** Play an AudioBuffer (call from a tap handler the first time on iOS). Resolves true when it played to
 * the end, false when it was stopped or could not start. */
export function playBuffer(buffer) {
  stopPlayback();
  const ac = unlockAudio();
  if (!ac || !buffer) return Promise.resolve(false);
  setAudioSession('playback');
  return new Promise((resolve) => {
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(ac.destination);
    const entry = { source, resolve };
    playing = entry;
    source.onended = () => {
      if (playing === entry) playing = null;
      resolve(true);
    };
    try {
      source.start();
    } catch {
      if (playing === entry) playing = null;
      resolve(false);
    }
  });
}

/** Fallback playback of an undecodable recording through <audio> and a Blob URL (needs media-src blob:
 * in the CSP). Resolves true when it played to the end. */
export function playBlob(blob) {
  stopPlayback();
  if (typeof Audio !== 'function' || !blob) return Promise.resolve(false);
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);
  blobAudio ??= new Audio();
  blobAudio.src = blobUrl;
  const el = blobAudio;
  return el.play().then(() => new Promise((resolve) => {
    const done = (event) => {
      el.removeEventListener('ended', done);
      el.removeEventListener('pause', done);
      resolve(event.type === 'ended');
    };
    el.addEventListener('ended', done);
    el.addEventListener('pause', done);
  })).catch(() => false);
}

/** Leaving the page: stop playback, free the Blob URL, hand the audio session back, let the context sleep. */
export function releaseAudio() {
  stopPlayback();
  if (blobAudio) blobAudio.removeAttribute('src');
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
  setAudioSession('auto');
  if (shared && shared.state === 'running') shared.suspend().catch(() => {});
}

// ---------- Errors ----------

/** A recording error as { code, message } for the page. */
export function describeError(error) {
  const name = error?.name ?? '';
  const reason = error?.reason ?? null;
  if (reason === 'insecure') return { code: 'insecure', message: 'Recording needs a secure (https) connection.' };
  if (reason) return { code: 'unsupported', message: 'This browser cannot record audio. A current Safari, Chrome or Firefox can.' };
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return { code: 'denied', message: 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return { code: 'no-microphone', message: 'No microphone was found on this device.' };
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return { code: 'busy', message: 'The microphone could not be started. Another app may be using it.' };
  if (name === 'NotSupportedError' || name === 'TypeError') return { code: 'unsupported', message: 'This browser cannot record audio. A current Safari, Chrome or Firefox can.' };
  return { code: 'failed', message: `Recording failed${error?.message ? `: ${error.message}` : '.'}` };
}
