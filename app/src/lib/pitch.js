// Pitch (F0) tracking for the tone trainer's record-and-compare page (experimental). Pure ES module:
// Float32Array samples in, numbers out; no DOM and no Web Audio, so the same code runs in the browser and
// in the Node tests (app/tests/pitch.test.mjs, synthetic sines and chirps).
//
// Pipeline (contour() runs all of it):
//   1. downsample()      to about 16 kHz (windowed-sinc low-pass, then decimation): speech F0 is far below
//                        that Nyquist rate, and YIN costs O(window x lag) per frame.
//   2. trackPitch()      a frame every 10 ms, YIN (de Cheveigne & Kawahara 2002, JASA 111(4)): difference
//                        function, cumulative mean normalised difference (CMND), absolute threshold,
//                        parabolic interpolation. Voicing gate: the CMND dip (aperiodicity) must be low AND
//                        the frame energy within `minDb` of the loudest frame AND above an absolute floor,
//                        with hysteresis: weakly periodic frames (fast falls, breathy edges) join a voiced
//                        neighbour when their pitch continues it smoothly.
//   3. cleanTrack()      drop voiced runs shorter than 30 ms, fold octave jumps, running median filter.
//   4. mainRegion()      the utterance: the cluster of voiced runs with the most voiced frames (a click
//                        or a cough separated by silence is ignored).
//   5. semitones relative to the speaker's median F0 (so a low and a high voice are comparable), short
//      unvoiced gaps bridged, time-normalised to N points (normalizeTime) for drawing.
//
// Known limits (shown in the UI): creaky voice (common at the bottom of tone 3) is aperiodic, so the
// lowest part of a third tone is often missing; whispering has no pitch at all; background voices and
// music confuse any single-pitch tracker.

export const PITCH_DEFAULTS = Object.freeze({
  minHz: 60, // lowest F0 searched (deep male voices; creak below this is not tracked)
  maxHz: 500, // highest F0 searched (high female and children's voices)
  targetRate: 16000, // analysis sample rate after downsampling
  hopMs: 10, // one pitch value every 10 ms
  windowMs: 25, // YIN integration window
  threshold: 0.15, // YIN absolute threshold: first CMND dip below it is the period
  voicing: 0.3, // voicing gate: CMND at the chosen lag must be below this (0 = perfectly periodic)
  weakVoicing: 0.6, // hysteresis: frames up to this CMND join a voiced neighbour when the pitch continues
  maxStep: 3, // ... smoothly: at most this many semitones from that neighbour
  minDb: -35, // voicing gate: frame RMS within 35 dB of the loudest frame
  floor: 1e-4, // voicing gate: absolute RMS floor (about -80 dBFS), so digital silence is never voiced
  minRun: 3, // shortest voiced run kept, in frames (30 ms)
  medianSize: 5, // running median filter length, in frames
  octaveLimit: 13, // a run after a long gap is moved by an octave only when it lies further than this from the median
  maxGapMs: 250, // voiced runs closer than this belong to the same utterance
  fillMs: 60, // unvoiced gaps up to this long inside the utterance are bridged by linear interpolation
  minVoicedMs: 60, // less voiced speech than this: no contour
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Median of the finite numbers in `values` (null and NaN are ignored); null when there are none. */
export function median(values) {
  const list = [];
  for (const v of values) if (isNum(v)) list.push(v);
  if (!list.length) return null;
  list.sort((a, b) => a - b);
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Semitones from `refHz` to `hz` (12 per octave). */
export const semitones = (hz, refHz) => 12 * Math.log2(hz / refHz);

/** Root mean square of `x[from, to)`. */
export function rms(x, from = 0, to = x.length) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += x[i] * x[i];
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

/**
 * Downsample by an integer factor (round(sampleRate / targetRate), at least 1) with a Hamming-windowed sinc
 * low-pass at 0.45 x the new rate, so energy above the new Nyquist frequency does not fold back.
 * Returns { samples: Float32Array, sampleRate }.
 */
export function downsample(x, sampleRate, targetRate = PITCH_DEFAULTS.targetRate) {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return { samples: Float32Array.from(x), sampleRate };
  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const fc = 0.45 / factor; // cut-off in cycles per input sample
  const kernel = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - half;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * hamming;
    sum += kernel[i];
  }
  for (let i = 0; i < taps; i += 1) kernel[i] /= sum; // unity gain at DC
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let k = 0; k < out.length; k += 1) {
    const centre = k * factor;
    let acc = 0;
    for (let i = 0; i < taps; i += 1) {
      const j = centre + i - half;
      if (j >= 0 && j < x.length) acc += kernel[i] * x[j];
    }
    out[k] = acc;
  }
  return { samples: out, sampleRate: sampleRate / factor };
}

/** Samples one frame needs at this rate: the integration window plus the longest lag (+2 for interpolation). */
export function frameLength(sampleRate, { minHz = PITCH_DEFAULTS.minHz, windowMs = PITCH_DEFAULTS.windowMs } = {}) {
  return Math.round((sampleRate * windowMs) / 1000) + Math.ceil(sampleRate / minHz) + 2;
}

/**
 * YIN on one frame `x[offset, offset + frameLength)`. Returns { hz, aperiodicity }: hz null when no period
 * was found inside [minHz, maxHz]; aperiodicity = the CMND at the chosen lag (0 = perfectly periodic, about
 * 1 = noise). Step 4 of the paper: the first dip below `threshold`, else the global minimum (then usually
 * rejected by the voicing gate).
 */
export function yinPitch(x, sampleRate, {
  minHz = PITCH_DEFAULTS.minHz,
  maxHz = PITCH_DEFAULTS.maxHz,
  threshold = PITCH_DEFAULTS.threshold,
  windowMs = PITCH_DEFAULTS.windowMs,
  offset = 0,
} = {}) {
  const W = Math.round((sampleRate * windowMs) / 1000);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.ceil(sampleRate / minHz);
  if (offset + W + tauMax + 2 > x.length || tauMax <= tauMin + 2) return { hz: null, aperiodicity: 1 };
  // Difference function d(tau) = sum_j (x_j - x_{j+tau})^2 for tau = 1 .. tauMax + 1.
  const d = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau += 1) {
    let s = 0;
    for (let j = offset, end = offset + W; j < end; j += 1) {
      const diff = x[j] - x[j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // Cumulative mean normalised difference d'(tau) = d(tau) / ((1/tau) sum_{j=1..tau} d(j)), d'(0) = 1.
  const cmnd = new Float64Array(tauMax + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau += 1) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau += 1;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    best = tauMin;
    for (let tau = tauMin + 1; tau <= tauMax; tau += 1) if (cmnd[tau] < cmnd[best]) best = tau;
  }
  // A minimum on the edge of the search range means the real period lies outside it.
  if (best >= tauMax || (best === tauMin && cmnd[tauMin - 1] < cmnd[tauMin])) return { hz: null, aperiodicity: 1 };
  // Parabolic interpolation on the raw difference function (the paper's step 5; d' is biased).
  let lag = best;
  const a = d[best - 1];
  const b = d[best];
  const c = d[best + 1];
  const denom = a - 2 * b + c;
  if (denom > 0) {
    const shift = (0.5 * (a - c)) / denom;
    if (Math.abs(shift) < 1) lag = best + shift;
  }
  return { hz: sampleRate / lag, aperiodicity: cmnd[best] };
}

/**
 * Pitch track. Returns { sampleRate, hop (seconds), times[] (frame centres, seconds), hz[] (null =
 * unvoiced), aperiodicity[], rms[] }. Voicing: loud enough (within `minDb` of the loudest frame and above
 * `floor`) and periodic (CMND below `voicing`); a frame with CMND below `weakVoicing` also counts when it
 * continues a voiced neighbour within `maxStep` semitones (hysteresis, both directions); every voiced run
 * keeps at least `minRun` clearly periodic frames.
 */
export function trackPitch(input, inputRate, options = {}) {
  const o = { ...PITCH_DEFAULTS, ...options };
  const { samples: x, sampleRate } = downsample(input, inputRate, o.targetRate);
  const hopSamples = Math.max(1, Math.round((sampleRate * o.hopMs) / 1000));
  const length = frameLength(sampleRate, o);
  const W = Math.round((sampleRate * o.windowMs) / 1000);
  const count = x.length >= length ? Math.floor((x.length - length) / hopSamples) + 1 : 0;
  const times = [];
  const hz = [];
  const aperiodicity = [];
  const energy = [];
  let loudest = 0;
  for (let i = 0; i < count; i += 1) {
    const offset = i * hopSamples;
    const level = rms(x, offset, offset + W);
    const est = yinPitch(x, sampleRate, { ...o, offset });
    times.push((offset + length / 2) / sampleRate);
    hz.push(est.hz);
    aperiodicity.push(est.aperiodicity);
    energy.push(level);
    if (level > loudest) loudest = level;
  }
  const minLevel = Math.max(o.floor, loudest * 10 ** (o.minDb / 20));
  const candidate = hz.map((v, i) => v !== null && energy[i] >= minLevel);
  const voiced = candidate.map((ok, i) => ok && aperiodicity[i] < o.voicing);
  const joins = (i, from) => !voiced[i] && candidate[i] && aperiodicity[i] < o.weakVoicing && Math.abs(semitones(hz[i], hz[from])) <= o.maxStep;
  for (let i = 1; i < count; i += 1) if (voiced[i - 1] && joins(i, i - 1)) voiced[i] = true;
  for (let i = count - 2; i >= 0; i -= 1) if (voiced[i + 1] && joins(i, i + 1)) voiced[i] = true;
  const out = hz.map((v, i) => (voiced[i] ? v : null));
  // Weak frames only extend voicing: a run needs `minRun` clearly periodic frames of its own (a burst of
  // creak with one lucky frame is not speech pitch).
  for (const [s, e] of voicedRuns(out)) {
    let strong = 0;
    for (let i = s; i <= e; i += 1) if (aperiodicity[i] < o.voicing) strong += 1;
    if (strong < o.minRun) for (let i = s; i <= e; i += 1) out[i] = null;
  }
  return { sampleRate, hop: hopSamples / sampleRate, times, hz: out, aperiodicity, rms: energy };
}

/** Voiced runs (maximal stretches of non-null values) as [start, end] index pairs, end inclusive. */
export function voicedRuns(values) {
  const runs = [];
  let start = -1;
  values.forEach((v, i) => {
    if (isNum(v)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, values.length - 1]);
  return runs;
}

/** Remove voiced runs shorter than `minRun` frames (isolated detections are usually noise). */
export function dropShortRuns(values, minRun = PITCH_DEFAULTS.minRun) {
  const out = values.map((v) => (isNum(v) ? v : null));
  for (const [s, e] of voicedRuns(out)) if (e - s + 1 < minRun) for (let i = s; i <= e; i += 1) out[i] = null;
  return out;
}

/** Index of the longest [start, end] pair (the first one on ties). */
const longest = (pairs) => pairs.reduce((best, [a, b], k) => (b - a > pairs[best][1] - pairs[best][0] ? k : best), 0);

/**
 * Octave-error repair. Real F0 never jumps more than a few semitones in 10 ms, while YIN's errors are
 * whole octaves (and, in creaky voice, a period two or three times too long).
 *   1. Inside each voiced run, split where adjacent frames differ by more than `split` semitones. The
 *      longest segment within `register` semitones of the median of all voiced frames is trusted (the
 *      longest of all when none is); walking outwards from it, each neighbouring segment is moved by one
 *      octave when that makes it continue smoothly (within `fit` semitones), and dropped (null) when no
 *      octave shift does.
 *   2. Between runs, walking outwards from the longest run: a run after a short gap (up to `bridge`
 *      frames) that starts at least `leap` semitones away from its neighbour is moved by one octave when
 *      that makes it continue within `fit`; a run after a longer gap (a new syllable may start anywhere
 *      in the voice's range) is moved only when its median lies more than `limit` semitones from the
 *      median of all voiced frames. A speaker's tones can span an octave (a fourth tone falling from the
 *      top of the range to the bottom, a half-third tone followed by a first tone), so the thresholds are
 *      wide and a fast real glide is left alone.
 */
export function fixOctaveJumps(values, { limit = PITCH_DEFAULTS.octaveLimit, split = 8, fit = 4, leap = 10, bridge = 8, register = 9 } = {}) {
  const out = values.map((v) => (isNum(v) && v > 0 ? v : null));
  const overall = median(out);
  const tolerance = (frames) => Math.min(fit + 2, fit + (frames - 1)); // a little more room across a gap
  const octavesFor = (step) => Math.max(-1, Math.min(1, Math.round(-step / 12)));
  for (const [s, e] of voicedRuns(out)) {
    const segments = [];
    let start = s;
    for (let i = s + 1; i <= e + 1; i += 1) {
      if (i > e || Math.abs(semitones(out[i], out[i - 1])) > split) {
        segments.push([start, i - 1]);
        start = i;
      }
    }
    if (segments.length < 2) continue;
    const plausible = segments.filter(([a, b]) => Math.abs(semitones(median(out.slice(a, b + 1)), overall)) <= register);
    const anchor = plausible.length ? segments.indexOf(plausible[longest(plausible)]) : longest(segments);
    const shiftSegment = ([a, b], from, to) => {
      // from: index of the kept frame next to the segment; to: the segment's frame next to it.
      const step = semitones(out[to], out[from]);
      const octaves = octavesFor(step);
      if (Math.abs(step + 12 * octaves) > tolerance(Math.abs(to - from))) {
        for (let i = a; i <= b; i += 1) out[i] = null;
        return false;
      }
      if (octaves) for (let i = a; i <= b; i += 1) out[i] *= 2 ** octaves;
      return true;
    };
    let edge = segments[anchor][1];
    for (let k = anchor + 1; k < segments.length; k += 1) if (shiftSegment(segments[k], edge, segments[k][0])) edge = segments[k][1];
    edge = segments[anchor][0];
    for (let k = anchor - 1; k >= 0; k -= 1) if (shiftSegment(segments[k], edge, segments[k][1])) edge = segments[k][0];
  }
  const runs = voicedRuns(out);
  if (runs.length < 2) return out;
  const global = median(out);
  const shiftRun = ([a, b], from, to) => {
    const gap = Math.abs(to - from);
    let octaves = 0;
    if (gap - 1 <= bridge) {
      const step = semitones(out[to], out[from]);
      const k = octavesFor(step);
      if (k && Math.abs(step) >= leap && Math.abs(step + 12 * k) <= tolerance(gap)) octaves = k;
    } else {
      let dist = semitones(median(out.slice(a, b + 1)), global);
      while (dist > limit && Math.abs(dist - 12) < Math.abs(dist)) {
        octaves -= 1;
        dist -= 12;
      }
      while (dist < -limit && Math.abs(dist + 12) < Math.abs(dist)) {
        octaves += 1;
        dist += 12;
      }
    }
    if (octaves) for (let i = a; i <= b; i += 1) out[i] *= 2 ** octaves;
  };
  const anchor = longest(runs);
  for (let k = anchor + 1; k < runs.length; k += 1) shiftRun(runs[k], runs[k - 1][1], runs[k][0]);
  for (let k = anchor - 1; k >= 0; k -= 1) shiftRun(runs[k], runs[k + 1][0], runs[k][1]);
  return out;
}

/**
 * Running median of `size` frames inside each voiced run: the window shrinks symmetrically at the run's
 * edges and never reaches across a gap (two syllables are never mixed). Removes spikes inside a run and
 * keeps ramps exactly; unvoiced frames stay null.
 */
export function medianFilter(values, size = PITCH_DEFAULTS.medianSize) {
  const half = Math.max(0, Math.floor(size / 2));
  const src = values.map((v) => (isNum(v) ? v : null));
  const out = src.slice();
  for (const [s, e] of voicedRuns(src)) {
    for (let i = s; i <= e; i += 1) {
      const k = Math.min(half, i - s, e - i);
      out[i] = median(src.slice(i - k, i + k + 1));
    }
  }
  return out;
}

/** Short runs dropped, octave jumps folded, median filtered (options as PITCH_DEFAULTS). */
export function cleanTrack(hz, options = {}) {
  const o = { ...PITCH_DEFAULTS, ...options };
  let out = dropShortRuns(hz, o.minRun);
  out = fixOctaveJumps(out, { limit: o.octaveLimit });
  out = medianFilter(out, o.medianSize);
  return dropShortRuns(out, o.minRun);
}

/**
 * The utterance: voiced runs separated by at most `maxGap` unvoiced frames form a cluster; the cluster
 * with the most voiced frames wins. Returns { start, end, voiced } (indices inclusive) or null.
 */
export function mainRegion(values, maxGap = 25) {
  const runs = voicedRuns(values);
  if (!runs.length) return null;
  let best = null;
  let current = { start: runs[0][0], end: runs[0][1], voiced: runs[0][1] - runs[0][0] + 1 };
  for (let k = 1; k < runs.length; k += 1) {
    const [s, e] = runs[k];
    if (s - current.end - 1 <= maxGap) {
      current.end = e;
      current.voiced += e - s + 1;
    } else {
      if (!best || current.voiced > best.voiced) best = current;
      current = { start: s, end: e, voiced: e - s + 1 };
    }
  }
  if (!best || current.voiced > best.voiced) best = current;
  return best;
}

/** Bridge gaps of at most `maxGap` nulls between two values by linear interpolation; longer gaps stay. */
export function fillGaps(values, maxGap = 6) {
  const out = values.map((v) => (isNum(v) ? v : null));
  let last = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === null) continue;
    const gap = i - last - 1;
    if (last >= 0 && gap > 0 && gap <= maxGap) {
      for (let j = last + 1; j < i; j += 1) out[j] = out[last] + ((out[i] - out[last]) * (j - last)) / (i - last);
    }
    last = i;
  }
  return out;
}

/**
 * Resample a track to `n` evenly spaced points from its first to its last value (leading and trailing
 * nulls are trimmed), with linear interpolation. A point between a value and a gap takes the nearer
 * frame's value or null, so real gaps survive as nulls. Returns [] when there is no value.
 */
export function normalizeTime(values, n) {
  const idx = [];
  values.forEach((v, i) => {
    if (isNum(v)) idx.push(i);
  });
  if (!idx.length || n < 1) return [];
  const first = idx[0];
  const last = idx[idx.length - 1];
  if (n === 1 || first === last) return Array.from({ length: n }, () => values[first]);
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const p = first + ((last - first) * k) / (n - 1);
    const lo = Math.floor(p);
    const hi = Math.min(last, Math.ceil(p));
    const a = values[lo];
    const b = values[hi];
    if (isNum(a) && isNum(b)) out.push(a + (b - a) * (p - lo));
    else {
      const near = values[Math.round(p)];
      out.push(isNum(near) ? near : null);
    }
  }
  return out;
}

/**
 * Everything at once: samples -> { ok, reason?, values (n points, semitones relative to the speaker's
 * median F0, null = gap), medianHz, start, end (seconds of the utterance), voicedMs, track }.
 * reason: 'short' (less audio than one analysis frame) | 'unvoiced' (too little voiced speech).
 */
export function contour(samples, sampleRate, { points = 64, ...options } = {}) {
  const o = { ...PITCH_DEFAULTS, ...options };
  const track = trackPitch(samples, sampleRate, o);
  if (!track.hz.length) return { ok: false, reason: 'short', values: [], medianHz: null, voicedMs: 0, track };
  const frameMs = track.hop * 1000;
  const cleaned = cleanTrack(track.hz, o);
  const region = mainRegion(cleaned, Math.round(o.maxGapMs / frameMs));
  const voicedMs = region ? region.voiced * frameMs : 0;
  if (!region || voicedMs < o.minVoicedMs) return { ok: false, reason: 'unvoiced', values: [], medianHz: null, voicedMs, track };
  const slice = cleaned.slice(region.start, region.end + 1);
  const medianHz = median(slice);
  const st = slice.map((v) => (v === null ? null : semitones(v, medianHz)));
  const values = normalizeTime(fillGaps(st, Math.round(o.fillMs / frameMs)), points);
  return { ok: true, values, medianHz, start: track.times[region.start], end: track.times[region.end], voicedMs, track };
}

/** Summary numbers of a contour for a text description: { start, end, min, max } in semitones (one
 * decimal), or null when there is no value. */
export function describeContour(values) {
  const nums = values.filter(isNum);
  if (!nums.length) return null;
  const r = (v) => Math.round(v * 10) / 10;
  return { start: r(nums[0]), end: r(nums[nums.length - 1]), min: r(Math.min(...nums)), max: r(Math.max(...nums)) };
}
