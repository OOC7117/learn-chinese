// Tests for src/lib/pitch.js with synthetic signals: sines, harmonic tones, a missing fundamental, linear
// and exponential chirps, silence and noise.  Run: node --test app/tests/pitch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PITCH_DEFAULTS, median, semitones, rms, downsample, frameLength, yinPitch, trackPitch, voicedRuns,
  dropShortRuns, fixOctaveJumps, medianFilter, cleanTrack, mainRegion, fillGaps, normalizeTime, contour,
  describeContour,
} from '../src/lib/pitch.js';

// ---------- signal generators ----------

/** Sum of sinusoids with phase function phase(t) (radians of the fundamental) and partial amplitudes. */
function synth(seconds, sr, phase, partials = [1], amp = 0.5) {
  const out = new Float32Array(Math.round(seconds * sr));
  const norm = partials.reduce((a, b) => a + Math.abs(b), 0) || 1;
  for (let i = 0; i < out.length; i += 1) {
    const p = phase(i / sr);
    let s = 0;
    partials.forEach((a, k) => {
      if (a) s += a * Math.sin((k + 1) * p);
    });
    out[i] = (amp * s) / norm;
  }
  return out;
}
const sine = (hz, seconds, sr = 48000, amp = 0.5) => synth(seconds, sr, (t) => 2 * Math.PI * hz * t, [1], amp);
const tone = (hz, seconds, sr, partials, amp = 0.5) => synth(seconds, sr, (t) => 2 * Math.PI * hz * t, partials, amp);
/** Linear chirp f(t) = f0 + (f1 - f0) t / T. */
const linearChirp = (f0, f1, T, sr = 48000, partials = [1]) => synth(T, sr, (t) => 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T)), partials);
/** Exponential chirp f(t) = f0 * (f1/f0)^(t/T): a straight line in semitones. */
function expChirp(f0, f1, T, sr = 48000, partials = [1]) {
  const k = Math.log(f1 / f0) / T;
  return synth(T, sr, (t) => (2 * Math.PI * f0 * (Math.exp(k * t) - 1)) / k, partials);
}
function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const silence = (seconds, sr = 48000) => new Float32Array(Math.round(seconds * sr));
/** Deterministic white noise (mulberry32). */
function noise(seconds, sr = 48000, amp = 0.3, seed = 7) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Float32Array.from({ length: Math.round(seconds * sr) }, () => amp * (rand() * 2 - 1));
}

const voicedValues = (hz) => hz.filter((v) => v !== null);
const within = (actual, expected, relTol, message) => {
  assert.ok(Math.abs(actual - expected) <= expected * relTol, `${message ?? ''} expected ${expected} ±${(relTol * 100).toFixed(1)}%, got ${actual}`);
};

// ---------- helpers ----------

test('median ignores null and NaN, handles even and odd counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, 5, NaN, 1, null, 3]), 3);
  assert.equal(median([]), null);
  assert.equal(median([null, null]), null);
});

test('semitones: an octave is 12, a fifth about 7', () => {
  assert.equal(semitones(440, 220), 12);
  assert.equal(semitones(110, 220), -12);
  assert.ok(Math.abs(semitones(330, 220) - 7.02) < 0.01);
});

test('rms of a sine is amplitude / sqrt(2)', () => {
  const x = sine(100, 1, 8000, 0.8);
  assert.ok(Math.abs(rms(x) - 0.8 / Math.SQRT2) < 1e-3);
  assert.equal(rms(new Float32Array(0)), 0);
});

// ---------- downsampling ----------

test('downsample 48 kHz -> 16 kHz keeps a low tone and removes energy above the new Nyquist rate', () => {
  const low = downsample(sine(200, 0.5, 48000, 0.5), 48000);
  assert.equal(low.sampleRate, 16000);
  assert.equal(low.samples.length, 8000);
  // Skip the filter's edge samples.
  const inner = low.samples.subarray(100, 7900);
  assert.ok(Math.abs(rms(inner) - 0.5 / Math.SQRT2) < 0.01, `200 Hz kept, rms ${rms(inner)}`);
  const high = downsample(sine(10000, 0.5, 48000, 0.5), 48000);
  assert.ok(rms(high.samples.subarray(100, 7900)) < 0.03, `10 kHz must not alias into the band, rms ${rms(high.samples)}`);
});

test('downsample picks the nearest integer factor and leaves low rates alone', () => {
  assert.equal(downsample(new Float32Array(441), 44100).sampleRate, 14700);
  assert.equal(downsample(new Float32Array(240), 24000).sampleRate, 12000);
  const same = downsample(new Float32Array([0.1, 0.2]), 16000);
  assert.equal(same.sampleRate, 16000);
  assert.deepEqual([...same.samples].map((v) => Math.round(v * 10) / 10), [0.1, 0.2]);
  assert.equal(downsample(new Float32Array(10), 8000).sampleRate, 8000);
});

// ---------- YIN on one frame ----------

test('yinPitch finds the period of pure sines within 0.3 %', () => {
  const sr = 16000;
  const n = frameLength(sr);
  for (const hz of [65, 82, 110, 147, 196, 220, 262, 330, 392, 440, 494]) {
    const x = sine(hz, (n + 10) / sr, sr);
    const est = yinPitch(x, sr);
    assert.ok(est.hz !== null, `${hz} Hz detected`);
    within(est.hz, hz, 0.003, `${hz} Hz:`);
    assert.ok(est.aperiodicity < 0.05, `${hz} Hz periodic, aperiodicity ${est.aperiodicity}`);
  }
});

test('yinPitch returns null outside the search range and for too short frames', () => {
  const sr = 16000;
  const n = frameLength(sr);
  assert.equal(yinPitch(sine(40, (n + 10) / sr, sr), sr).hz, null, '40 Hz is below minHz 60');
  assert.equal(yinPitch(new Float32Array(100), sr).hz, null);
});

test('yinPitch: the missing fundamental (harmonics 2-4 only) is still the pitch', () => {
  const sr = 16000;
  const x = tone(150, 0.06, sr, [0, 1, 1, 1]);
  within(yinPitch(x, sr).hz, 150, 0.01);
});

// ---------- tracks ----------

test('trackPitch follows steady sines at 48 kHz and 44.1 kHz', () => {
  for (const sr of [48000, 44100]) {
    for (const hz of [85, 120, 200, 310, 450]) {
      const track = trackPitch(sine(hz, 0.6, sr), sr);
      const voiced = voicedValues(track.hz);
      assert.ok(voiced.length >= track.hz.length * 0.9, `${hz} Hz @ ${sr}: ${voiced.length}/${track.hz.length} voiced`);
      within(median(voiced), hz, 0.005, `${hz} Hz @ ${sr}:`);
      assert.ok(voiced.every((v) => Math.abs(v - hz) < hz * 0.02), `${hz} Hz @ ${sr}: no outliers`);
    }
  }
});

test('trackPitch: frames every 10 ms with centre times', () => {
  const track = trackPitch(sine(200, 1, 48000), 48000);
  assert.ok(Math.abs(track.hop - 0.01) < 1e-9);
  assert.ok(track.hz.length > 90 && track.hz.length <= 100, `${track.hz.length} frames in 1 s`);
  assert.ok(Math.abs(track.times[1] - track.times[0] - 0.01) < 1e-9);
  assert.equal(track.hz.length, track.rms.length);
  assert.equal(track.hz.length, track.aperiodicity.length);
});

test('harmonic-rich tones (strong 2nd harmonic) give no octave errors', () => {
  const sr = 48000;
  for (const hz of [100, 180, 260]) {
    // Sawtooth-like spectrum plus a 2nd harmonic louder than the fundamental.
    const x = tone(hz, 0.5, sr, [0.6, 1, 0.33, 0.25, 0.2, 0.17]);
    const cleaned = cleanTrack(trackPitch(x, sr).hz);
    const voiced = voicedValues(cleaned);
    assert.ok(voiced.length > 30);
    assert.ok(voiced.every((v) => Math.abs(v - hz) < hz * 0.02), `${hz} Hz: ${Math.min(...voiced)}-${Math.max(...voiced)}`);
  }
});

test('a rising linear chirp (150 -> 300 Hz) is tracked monotonically and accurately', () => {
  const sr = 48000;
  const T = 0.8;
  const track = trackPitch(linearChirp(150, 300, T, sr), sr);
  const cleaned = cleanTrack(track.hz);
  let previous = 0;
  let checked = 0;
  cleaned.forEach((v, i) => {
    if (v === null) return;
    const expected = 150 + (150 * track.times[i]) / T;
    within(v, expected, 0.03, `t=${track.times[i].toFixed(3)}:`);
    assert.ok(v >= previous - 0.5, 'monotonic rise');
    previous = v;
    checked += 1;
  });
  assert.ok(checked > 60, `${checked} voiced frames`);
});

test('a falling chirp with harmonics (fourth-tone-like, 280 -> 140 Hz) is tracked', () => {
  const sr = 44100;
  const T = 0.4;
  const track = trackPitch(linearChirp(280, 140, T, sr, [1, 0.6, 0.4, 0.2]), sr);
  const cleaned = cleanTrack(track.hz);
  const pairs = cleaned.map((v, i) => [track.times[i], v]).filter(([, v]) => v !== null);
  assert.ok(pairs.length > 25);
  for (const [t, v] of pairs) within(v, 280 - (140 * t) / T, 0.04, `t=${t.toFixed(3)}:`);
  assert.ok(pairs[0][1] > pairs[pairs.length - 1][1] * 1.5, 'falls');
});

test('silence is never voiced, white noise hardly ever', () => {
  assert.equal(voicedValues(trackPitch(silence(0.5), 48000).hz).length, 0);
  const noisy = trackPitch(noise(1), 48000);
  const share = voicedValues(noisy.hz).length / noisy.hz.length;
  assert.ok(share < 0.1, `noise voiced share ${share}`);
  assert.equal(voicedValues(cleanTrack(noisy.hz)).length < noisy.hz.length * 0.05, true);
});

test('the energy gate drops a tone 50 dB below the loudest part', () => {
  const sr = 48000;
  const loud = sine(200, 0.3, sr, 0.5);
  const quiet = sine(300, 0.3, sr, 0.5 * 10 ** (-50 / 20));
  const track = trackPitch(concat(loud, quiet), sr);
  const late = track.hz.filter((v, i) => track.times[i] > 0.36);
  assert.ok(late.length > 10);
  assert.equal(voicedValues(late).length, 0);
  assert.ok(voicedValues(track.hz.filter((v, i) => track.times[i] < 0.25)).length > 10);
});

test('very quiet input below the absolute floor is unvoiced even when it is the loudest part', () => {
  const track = trackPitch(sine(200, 0.3, 48000, 5e-5), 48000);
  assert.equal(voicedValues(track.hz).length, 0);
});

// ---------- cleaning ----------

test('voicedRuns and dropShortRuns', () => {
  const v = [null, 1, 2, null, 3, null, 4, 5, 6, null];
  assert.deepEqual(voicedRuns(v), [[1, 2], [4, 4], [6, 8]]);
  assert.deepEqual(voicedRuns([1, 1]), [[0, 1]]);
  assert.deepEqual(dropShortRuns(v, 3), [null, null, null, null, null, null, 4, 5, 6, null]);
  assert.deepEqual(dropShortRuns([NaN, 1, undefined], 1), [null, 1, null]);
});

test('fixOctaveJumps folds octave errors back and leaves real glides alone', () => {
  const up = [...Array(10).fill(200), 400, 401, 399, ...Array(10).fill(200)];
  assert.ok(fixOctaveJumps(up).every((v) => Math.abs(v - 200) < 1.5), 'one octave up');
  const down = [...Array(8).fill(180), 90, 90, ...Array(8).fill(180)];
  assert.ok(fixOctaveJumps(down).every((v) => Math.abs(v - 180) < 1), 'one octave down');
  // Two octaves off (or a period three times too long, as in creak): no octave shift fits, so dropped.
  const twice = [...Array(8).fill(150), 600, ...Array(8).fill(150)];
  assert.equal(fixOctaveJumps(twice)[8], null, 'two octaves up');
  const third = [...Array(8).fill(225), 75, 75, ...Array(8).fill(225)];
  assert.deepEqual(fixOctaveJumps(third).slice(7, 11), [225, null, null, 225]);
  // When a run breaks by an octave, the part in the speaker's register wins even if it is shorter
  // (a creaky subharmonic stretch before the real continuation).
  const creak = [...Array(30).fill(210), null, null, null, null, null, 98, 98, 100, 101, 70, 105, 210, 214, 213, 214];
  assert.deepEqual(fixOctaveJumps(creak).slice(35).map(Math.round), [196, 196, 200, 202, 140, 210, 210, 214, 213, 214]);
  // Subharmonics at the decaying end of a syllable are moved up by an octave when they continue smoothly.
  const tail = [...Array(10).fill(216), 113, 112, 111];
  assert.deepEqual(fixOctaveJumps(tail).slice(9), [216, 226, 224, 222]);
  // A whole run an octave off its neighbour across a short gap is moved as a whole.
  const runs = [...Array(10).fill(200), null, null, ...Array(5).fill(410), null, ...Array(10).fill(190)];
  assert.ok(fixOctaveJumps(runs).slice(12, 17).every((v) => v === 205));
  // A real fourth tone after a first tone can end an octave below it (wide-range speaker): kept as is.
  const fall = Array.from({ length: 8 }, (_, i) => 330 - i * 12);
  const tail2 = Array.from({ length: 7 }, (_, i) => 200 - i * 4);
  const wide = [...Array(20).fill(360), null, null, null, ...fall, null, null, null, ...tail2];
  assert.deepEqual(fixOctaveJumps(wide), wide);
  // After a long gap (a new syllable) only a run beyond `limit` semitones from the median is moved.
  const far = [...Array(20).fill(200), ...Array(20).fill(null), ...Array(5).fill(830)];
  assert.ok(fixOctaveJumps(far).slice(40).every((v) => v === 415));
  const low = [...Array(20).fill(200), ...Array(20).fill(null), ...Array(5).fill(110)];
  assert.deepEqual(fixOctaveJumps(low), low);
  // A real fourth tone falls about 7-10 semitones; a 6-semitone glide must survive untouched.
  const glide = Array.from({ length: 30 }, (_, i) => 240 * 2 ** (-(6 * i) / 29 / 12));
  assert.deepEqual(fixOctaveJumps(glide), glide);
  // An octave jump in the middle of a glide (pass 2, local neighbours).
  const broken = glide.map((v, i) => (i >= 14 && i <= 15 ? v * 2 : v));
  fixOctaveJumps(broken).forEach((v, i) => assert.ok(Math.abs(v - glide[i]) < 0.01, `frame ${i}`));
  assert.deepEqual(fixOctaveJumps([null, null]), [null, null]);
});

test('medianFilter removes spikes inside a run, keeps ramps exactly and never mixes runs', () => {
  assert.deepEqual(medianFilter([100, 100, 180, 100, 100]), [100, 100, 100, 100, 100]);
  const ramp = [100, 110, 120, 130, 140, 150, 160];
  assert.deepEqual(medianFilter(ramp), ramp);
  assert.deepEqual(medianFilter([100, null, 120, 121, 135, 123, 124]), [100, null, 120, 121, 123, 124, 124]);
  assert.deepEqual(medianFilter([null, 5, null]), [null, 5, null]);
  assert.deepEqual(medianFilter([NaN, 5, undefined, 6]), [null, 5, null, 6]);
});

test('cleanTrack: spikes, octave errors and isolated detections removed', () => {
  const raw = [null, 210, null, null, ...Array(12).fill(200), 400, ...Array(12).fill(200), null, null, 333, null];
  const out = cleanTrack(raw);
  assert.equal(out[1], null, 'isolated 1-frame detection dropped');
  assert.equal(out[out.length - 2], null);
  assert.ok(voicedValues(out).every((v) => v === 200));
});

test('mainRegion picks the cluster with most voiced frames and joins across short gaps', () => {
  const v = [5, 5, 5, null, ...Array(30).fill(null), 7, 7, 7, 7, null, null, 7, 7, 7, 7, null];
  assert.deepEqual(mainRegion(v, 25), { start: 34, end: 43, voiced: 8 });
  assert.deepEqual(mainRegion(v, 40), { start: 0, end: 43, voiced: 11 });
  assert.equal(mainRegion([null, null]), null);
});

test('fillGaps bridges short gaps only', () => {
  assert.deepEqual(fillGaps([1, null, null, 4]), [1, 2, 3, 4]);
  assert.deepEqual(fillGaps([1, null, null, 4], 1), [1, null, null, 4]);
  assert.deepEqual(fillGaps([null, 2, null]), [null, 2, null], 'edges are not extrapolated');
});

test('normalizeTime resamples linearly between the first and the last value', () => {
  assert.deepEqual(normalizeTime([0, 1, 2, 3, 4], 9), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  assert.deepEqual(normalizeTime([null, null, 2, 4, null], 3), [2, 3, 4]);
  assert.deepEqual(normalizeTime([7], 4), [7, 7, 7, 7]);
  assert.deepEqual(normalizeTime([1, 3], 2), [1, 3]);
  assert.deepEqual(normalizeTime([null], 5), []);
  const gap = normalizeTime([0, 1, null, null, null, null, 6, 7], 8);
  assert.equal(gap.length, 8);
  assert.equal(gap[0], 0);
  assert.equal(gap[7], 7);
  assert.ok(gap.slice(2, 6).some((v) => v === null), 'a long gap stays a gap');
});

// ---------- contours ----------

test('contour of an exponential chirp: a straight line from -6 to +6 semitones around the median', () => {
  const sr = 48000;
  const c = contour(expChirp(150, 300, 0.6, sr, [1, 0.5, 0.3]), sr, { points: 25 });
  assert.equal(c.ok, true);
  assert.equal(c.values.length, 25);
  within(c.medianHz, 150 * Math.SQRT2, 0.03, 'median');
  assert.ok(Math.abs(c.values[0] + 6) < 1, `start ${c.values[0]}`);
  assert.ok(Math.abs(c.values[24] - 6) < 1, `end ${c.values[24]}`);
  c.values.forEach((v, k) => assert.ok(Math.abs(v - (-6 + k / 2)) < 1, `point ${k}: ${v}`));
});

test('contours are speaker-normalised: the same shape an octave apart gives the same semitones', () => {
  const sr = 44100;
  const low = contour(expChirp(110, 90, 0.4, sr, [1, 0.5]), sr, { points: 16 });
  const high = contour(expChirp(220, 180, 0.4, sr, [1, 0.5]), sr, { points: 16 });
  assert.ok(low.ok && high.ok);
  low.values.forEach((v, k) => assert.ok(Math.abs(v - high.values[k]) < 0.4, `point ${k}: ${v} vs ${high.values[k]}`));
});

test('contour finds the utterance inside silence and ignores a distant click', () => {
  const sr = 48000;
  const click = sine(400, 0.03, sr); // a short sound 0.6 s before the utterance
  const x = concat(silence(0.5), click, silence(0.6), sine(220, 0.4, sr), silence(0.5));
  const c = contour(x, sr, { points: 10 });
  assert.equal(c.ok, true);
  assert.ok(c.start > 1.1 && c.start < 1.2, `starts at ${c.start}`);
  assert.ok(c.end > 1.45 && c.end < 1.55, `ends at ${c.end}`);
  within(c.medianHz, 220, 0.01);
  assert.ok(c.values.every((v) => Math.abs(v) < 0.2), 'a level tone is flat at 0 st');
});

test('contour reports why it has no result', () => {
  assert.deepEqual([contour(new Float32Array(100), 48000).ok, contour(new Float32Array(100), 48000).reason], [false, 'short']);
  const quiet = contour(concat(silence(0.5), noise(0.5, 48000, 0.2)), 48000);
  assert.equal(quiet.ok, false);
  assert.equal(quiet.reason, 'unvoiced');
  assert.equal(contour(sine(200, 0.08, 48000), 48000).ok, false, 'less than 60 ms voiced');
});

test('a two-syllable pattern with a gap keeps both parts', () => {
  const sr = 48000;
  const x = concat(sine(200, 0.25, sr), silence(0.08), expChirp(200, 140, 0.25, sr));
  const c = contour(x, sr, { points: 40 });
  assert.equal(c.ok, true);
  const nums = c.values.filter((v) => v !== null);
  assert.ok(nums.length >= 30);
  assert.ok(c.values.slice(0, 15).every((v) => v !== null && Math.abs(v - c.values[0]) < 0.5), 'level first part');
  assert.ok(c.values[39] < c.values[0] - 4, 'falling second part');
});

test('describeContour summarises start, end and range', () => {
  assert.deepEqual(describeContour([null, 1.04, 3, -2.26, 0.5, null]), { start: 1, end: 0.5, min: -2.3, max: 3 });
  assert.equal(describeContour([null]), null);
});

test('defaults are frozen and four seconds of audio are analysed quickly', () => {
  assert.ok(Object.isFrozen(PITCH_DEFAULTS));
  const x = linearChirp(120, 240, 4, 48000, [1, 0.5, 0.3]);
  const t0 = performance.now();
  const c = contour(x, 48000);
  const ms = performance.now() - t0;
  assert.equal(c.ok, true);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
});
