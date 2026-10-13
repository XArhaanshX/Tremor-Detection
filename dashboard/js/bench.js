// Simulated benchmark with ground truth: physically modelled wrist-IMU signals for tremor and
// for everyday movements, run through the exact band detector (dsp.js) and scored for each of
// the four algorithms. The rotation model is the same one used by the firmware host tests
// (firmware/test/host/test_dsp.cpp): gyro = n·θ', accel = lever·θ'' + gravity tilt, plus
// MPU-6050 bias, noise and 16-bit quantisation.
//
// Honest caveat (shown in the UI): this model contains the lever-arm physics our method relies
// on, so it shows how each detector behaves by design - the real-patient numbers come from PADS.
import { analyzeRecording, decide, ALGORITHMS, FS } from './dsp.js';

const G = 9.80665, TWO_PI = 2 * Math.PI;
const GYRO_LSB = Math.PI / 180 / 16.4;  // rad/s per LSB at +-2000 dps

function rng(seed) {  // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * r()); }

function blank(seconds) {
  const n = Math.round(seconds * FS);
  const s = { n, t: new Float64Array(n) };
  for (const k of ['ax', 'ay', 'az', 'gx', 'gy', 'gz']) s[k] = new Float64Array(n);
  for (let i = 0; i < n; i++) s.t[i] = i / FS;
  return s;
}
const unit = (v) => { const m = Math.hypot(...v); return v.map((x) => x / m); };
const tangent = (n) => { let t = [n[1], -n[0], 0]; const m = Math.hypot(...t); return m < 1e-3 ? [1, 0, 0] : t.map((x) => x / m); };

// Rigid rotation θ(t) = A(t)·sin(φ(t)) about `axis`, sensor `leverM` from the axis.
function addRotation(s, { freq, amp, axis, leverM, from = 0, to = Infinity, phase = 0, ramp = 1 }) {
  const n = unit(axis), td = tangent(n);
  let ph = phase;
  for (let i = 0; i < s.n; i++) {
    const t = i / FS;
    const f = typeof freq === 'function' ? freq(t) : freq;
    const w = TWO_PI * f;
    ph += w / FS;
    if (t < from || t >= to) continue;
    const env = Math.min(1, (t - from) / ramp, (to - t) / ramp);
    const A = (typeof amp === 'function' ? amp(t) : amp) * Math.max(0, env);
    const th = A * Math.sin(ph), om = A * w * Math.cos(ph), al = -A * w * w * Math.sin(ph);
    s.gx[i] += om * n[0]; s.gy[i] += om * n[1]; s.gz[i] += om * n[2];
    const lin = (leverM * al) / G + th;  // tangential acceleration (g) + gravity re-projection of the tilt
    s.ax[i] += lin * td[0]; s.ay[i] += lin * td[1]; s.az[i] += lin * td[2];
  }
}
// Parkinsonian rest tremor: hand oscillates about the wrist; the band sits ~3 cm from that axis.
function addTremor(s, { freq, ppCm, from, to, handLeverM = 0.1 }) {
  addRotation(s, { freq, amp: ppCm / 100 / (2 * handLeverM), axis: [0.8, -0.5, 0.3], leverM: 0.03, from, to });
}
// Slow, large, non-rhythmic arm movement (reaching, waving): 0.3-1.7 Hz.
function addVoluntary(s, r, strength, from = 0, to = Infinity) {
  const f = [0.4, 0.9, 1.7], ph = [r() * TWO_PI, r() * TWO_PI, r() * TWO_PI];
  for (let i = 0; i < s.n; i++) {
    const t = i / FS;
    if (t < from || t >= to) continue;
    let v = 0;
    for (let j = 0; j < 3; j++) v += (strength / (j + 1)) * Math.sin(TWO_PI * f[j] * t + ph[j]);
    s.gx[i] += v * 0.3; s.gy[i] += v; s.gz[i] += v * 0.4;
    s.ax[i] += 0.06 * v; s.ay[i] += 0.03 * v;
  }
}
function addWobble(s, r, rms) {  // irregular fidgeting: energy spread over many frequencies
  for (const k of ['gx', 'gy', 'gz']) { let y = 0; for (let i = 0; i < s.n; i++) { y = 0.7 * y + rms * normal(r); s[k][i] += y; } }
}
function finish(s, r) {  // MPU-6050: gravity, bias, white noise, quantisation
  const bias = [0.05, -0.03, 0.02], gn = 0.005 * Math.sqrt(FS / 2) * Math.PI / 180, an = 0.0004 * Math.sqrt(FS / 2);
  ['gx', 'gy', 'gz'].forEach((k, j) => { for (let i = 0; i < s.n; i++) s[k][i] = Math.round((s[k][i] + bias[j] + gn * normal(r)) / GYRO_LSB) * GYRO_LSB; });
  ['ax', 'ay', 'az'].forEach((k, j) => { for (let i = 0; i < s.n; i++) s[k][i] += (j === 2 ? 1 : 0) + an * normal(r); });
  return s;
}

const drift = (f0) => (t) => f0 + 0.2 * Math.sin(TWO_PI * 0.05 * t);  // real tremor wanders a little

// tremor: true = Parkinsonian rest tremor present (ground truth); onset: tremor starts at this time
export const SCENARIOS = [
  { id: 'slight', group: 'Parkinson\'s rest tremor', name: 'Slight (0.6 cm, 4.3 Hz)', tremor: true, freq: drift(4.3),
    build: (s) => addTremor(s, { freq: drift(4.3), ppCm: 0.6 }) },
  { id: 'mild', group: 'Parkinson\'s rest tremor', name: 'Mild (2 cm, 5.0 Hz)', tremor: true, freq: drift(5.0),
    build: (s) => addTremor(s, { freq: drift(5.0), ppCm: 2 }) },
  { id: 'moderate', group: 'Parkinson\'s rest tremor', name: 'Moderate (6 cm, 5.8 Hz)', tremor: true, freq: drift(5.8),
    build: (s) => addTremor(s, { freq: drift(5.8), ppCm: 6 }) },
  { id: 'reach', group: 'Parkinson\'s rest tremor', name: 'While reaching (3 cm, 5 Hz + arm movement)', tremor: true, freq: drift(5.0),
    build: (s, r) => { addTremor(s, { freq: drift(5.0), ppCm: 3 }); addVoluntary(s, r, 0.5); } },
  { id: 'onset', group: 'Parkinson\'s rest tremor', name: 'Starts at 20 s (2.5 cm, 4.8 Hz)', tremor: true, onset: 20, freq: drift(4.8),
    build: (s) => addTremor(s, { freq: drift(4.8), ppCm: 2.5, from: 20 }) },
  { id: 'still', group: 'Everyday activity', name: 'Hand still', tremor: false, build: () => {} },
  { id: 'voluntary', group: 'Everyday activity', name: 'Slow arm movement (reach, wave)', tremor: false,
    build: (s, r) => addVoluntary(s, r, 2) },
  { id: 'walking', group: 'Everyday activity', name: 'Walking (arm swing)', tremor: false,
    build: (s) => { addRotation(s, { freq: 0.9, amp: 0.35, axis: [0, 1, 0.2], leverM: 0.6 }); addRotation(s, { freq: 1.8, amp: 0.03, axis: [1, 0, 0], leverM: 0.6 }); } },
  { id: 'brushing', group: 'Rhythmic activity in the tremor band', name: 'Brushing teeth (4.3 Hz, forearm about the elbow)', tremor: false,
    build: (s) => addRotation(s, { freq: drift(4.3), amp: 0.06, axis: [0.8, -0.5, 0.3], leverM: 0.28 }) },
  { id: 'stirring', group: 'Rhythmic activity in the tremor band', name: 'Stirring a cup (4.2 Hz, circular)', tremor: false,
    build: (s) => {
      addRotation(s, { freq: 4.2, amp: 0.12, axis: [0.8, -0.5, 0.3], leverM: 0.03 });
      for (let i = 0; i < s.n; i++) { const p = TWO_PI * 4.2 * (i / FS), a = (0.03 * (TWO_PI * 4.2) ** 2) / G; s.ax[i] -= a * Math.cos(p); s.ay[i] -= a * Math.sin(p); }
    } },
  { id: 'scrubbing', group: 'Rhythmic activity in the tremor band', name: 'Scrubbing (4.0 Hz, arm about the shoulder)', tremor: false,
    build: (s) => addRotation(s, { freq: drift(4.0), amp: 0.04, axis: [0.3, 0.9, 0.2], leverM: 0.4 }) },
  { id: 'bottle', group: 'Rhythmic activity in the tremor band', name: 'Shaking a bottle (5.5 Hz)', tremor: false,
    build: (s) => addRotation(s, { freq: drift(5.5), amp: 0.1, axis: [0.5, 0.2, 0.8], leverM: 0.22 }) },
  { id: 'fidget', group: 'Everyday activity', name: 'Fidgeting / typing (irregular)', tremor: false,
    build: (s, r) => addWobble(s, r, 0.25) },
  { id: 'essential', group: 'Other tremor', name: 'Faster tremor (8.5 Hz, essential/physiological)', tremor: false,
    build: (s) => addRotation(s, { freq: drift(8.5), amp: 0.03, axis: [0.8, -0.5, 0.3], leverM: 0.03 }) },
];

export function buildScenario(sc, seed = 1, seconds = 60) {
  const r = rng(seed * 7919 + sc.id.length * 31 + sc.id.charCodeAt(0));
  const s = blank(seconds);
  sc.build(s, r);
  return finish(s, r);
}

// Ground truth for a window ending at time t (window = 2.56 s): true, false, or null = ambiguous
// (partly before and partly after a tremor onset - not scored).
function truthOf(sc, tEnd) {
  if (!sc.tremor) return false;
  if (sc.onset == null) return true;
  const tStart = tEnd - 2.56;
  if (tStart >= sc.onset + 1) return true;   // one second of settling after onset
  if (tEnd <= sc.onset) return false;
  return null;
}

const pct = (a, b) => (b ? (100 * a) / b : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function runBenchmark({ seed = 1, seconds = 60 } = {}) {
  const t0 = performance.now();
  let windowsTotal = 0;
  const scenarios = SCENARIOS.map((sc) => {
    const sig = buildScenario(sc, seed, seconds);
    const windows = analyzeRecording(sig);
    windowsTotal += windows.length;
    const dec = decide(windows);
    const truth = windows.map((w, i) => (i === 0 ? null : truthOf(sc, w.t)));  // first window can't be consistent yet
    const perAlg = {};
    for (const alg of ALGORITHMS) {
      const d = dec[alg.id];
      // % flagged among the windows that carry this scenario's label (tremor windows of a tremor
      // scenario, all windows of an everyday-activity scenario)
      let flagged = 0, scored = 0;
      truth.forEach((tr, i) => { if (tr === sc.tremor) { scored++; if (d.flags[i]) flagged++; } });
      perAlg[alg.id] = { flaggedPct: pct(flagged, scored) };
      if (sc.onset != null) {
        const first = windows.findIndex((w, i) => d.flags[i] && w.t > sc.onset);
        perAlg[alg.id].latencyS = first >= 0 ? windows[first].t - sc.onset : null;
      }
    }
    return { ...sc, sig, windows, decisions: dec, truth, perAlg };
  });
  const msPerWindow = (performance.now() - t0) / windowsTotal;

  const metrics = {};
  for (const alg of ALGORITHMS) {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    const ferr = [];
    let rhythmFp = 0, rhythmN = 0;
    for (const sc of scenarios) {
      const d = sc.decisions[alg.id];
      sc.truth.forEach((tr, i) => {
        if (tr === null) return;
        const f = d.flags[i];
        if (tr && f) { tp++; if (sc.freq) ferr.push(Math.abs(d.freqs[i] - sc.freq(sc.windows[i].t - 1.28))); }
        else if (tr) fn++;
        else if (f) fp++;
        else tn++;
        if (!tr && sc.group.startsWith('Rhythmic')) { rhythmN++; if (f) rhythmFp++; }
      });
    }
    const sens = pct(tp, tp + fn), spec = pct(tn, tn + fp), prec = pct(tp, tp + fp);
    metrics[alg.id] = {
      tp, fn, fp, tn,
      sensitivity: sens, specificity: spec, precision: prec,
      f1: sens != null && prec != null && sens + prec > 0 ? (2 * sens * prec) / (sens + prec) : null,
      falseMinPerHour: fp + tn ? (60 * fp) / (fp + tn) : null,
      rhythmFalsePct: pct(rhythmFp, rhythmN),
      freqErrHz: ferr.length ? ferr.reduce((a, b) => a + b, 0) / ferr.length : null,
      freqErrMedHz: median(ferr),
      latencyS: scenarios.find((s) => s.id === 'onset').perAlg[alg.id].latencyS,
    };
  }
  return { scenarios, metrics, msPerWindow, seed, seconds };
}

// Parse a recording CSV (t,ax,ay,az,gx,gy,gz - from tools/record.py / tools/experiment.py / PADS)
export function parseRecording(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let cols = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'];
  if (/[a-z]/i.test(lines[0])) cols = lines.shift().split(',').map((c) => c.trim().toLowerCase());
  const idx = Object.fromEntries(['ax', 'ay', 'az', 'gx', 'gy', 'gz'].map((k) => [k, cols.indexOf(k)]));
  if (Object.values(idx).some((v) => v < 0)) throw new Error('CSV needs columns t,ax,ay,az,gx,gy,gz (accel in g, gyro in rad/s)');
  const s = blank(0);
  const rows = lines.map((l) => l.split(',').map(Number)).filter((v) => v.length >= cols.length && v.every(Number.isFinite));
  s.n = rows.length;
  s.t = Float64Array.from(rows, (_, i) => i / FS);
  for (const k of ['ax', 'ay', 'az', 'gx', 'gy', 'gz']) s[k] = Float64Array.from(rows, (v) => v[idx[k]]);
  return s;
}
