// Live algorithm comparison, the data side: raw sample packets streamed by the band ->
// exactly the windows the band analyses (same first sample, same 256/100 framing) -> all four
// detectors on each window, plus the band's own verdict for that window, matched by sample
// index so the page can prove its copy of our detector gives the band's answer.
// No DOM here: tools/check_live.mjs runs it in node.
import { TremorDetector, makeDecider, ALGORITHMS, N, HOP, FS } from './dsp.js';
import { LIVE } from './protocol.js';

// firmware/src/main.cpp converts in float32: do the same, so both sides analyse identical numbers
const f32 = Math.fround;
export const GYRO_TO_RADS = f32(f32(f32(Math.PI) / 180) / f32(16.4));
export const ACCEL_TO_G = f32(1 / 4096);
const GYRO_SAT_RAW = 32000;

export const LABELS = [
  { id: 'still', name: 'Holding still', tremor: false, code: 1 },
  { id: 'tremor', name: 'Imitating tremor', tremor: true, code: 2 },
  { id: 'movement', name: 'Everyday movement', tremor: false, code: 3, hint: 'brushing, stirring, waving' },
];
const LABEL_CODE = Object.fromEntries(LABELS.map((l) => [l.id, l.code]));

class Grow {  // growable typed array
  constructor(Type, n = 1 << 14) { this.T = Type; this.a = new Type(n); this.n = 0; }
  push(...v) {
    if (this.n + v.length > this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    for (const x of v) this.a[this.n++] = x;
  }
  view() { return this.a.subarray(0, this.n); }
}

export class LivePipeline {
  constructor({ keepSeconds = 60, maxSessionSamples = FS * 3600 * 2 } = {}) {
    this.keep = keepSeconds * FS;
    this.maxSession = maxSessionSamples;
    this.listeners = new Set();
    this.reset();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, data) { for (const fn of this.listeners) fn(kind, data); }

  reset() {
    this.aligned = false;     // seen the band's "window starts here" mark yet?
    this.expected = null;     // next u16 sample index we expect
    this.abs = 0;             // running sample number of the next sample (never wraps)
    this.winStart = 0;        // sample number where the band's current window run started
    this.validFrom = 0;       // first sample after the last hole (lost in transit)
    this.lastSat = -Infinity;
    this.gapPending = true;
    this.detector = new TremorDetector();
    this.decider = makeDecider();
    this.ring = Array.from({ length: 6 }, () => new Float64Array(N));
    this.windows = [];        // every window this session
    this.byEnd = new Map();   // window end sample -> window
    this.stats = { samples: 0, lost: 0, packets: 0, ignored: 0, compared: 0, same: 0, notCompared: 0,
      maxFreqDiff: 0, maxRatioDiff: 0, firstWall: null, lastWall: null };
    this.rate = [];           // [wallMs, samples] for the samples/s estimate
    this.trace = new Float32Array(this.keep).fill(NaN);  // |gyro| for the last keepSeconds
    this.labelLog = [{ from: 0, label: this.label ?? null }];
    this.session = { raw: new Grow(Int16Array, 6 << 14), idx: new Grow(Float64Array), lab: new Grow(Uint8Array) };
    this.score = Object.fromEntries(LABELS.map((l) => [l.id, Object.fromEntries(ALGORITHMS.map((a) => [a.id, { n: 0, flagged: 0 }]))]));
    this.spectrum = null;
    this.emit('reset');
  }

  // What the wearer says they are doing from sample `at` on (null = not labelled).
  setLabel(label, at = this.abs) {
    this.label = label;
    this.labelLog.push({ from: at, label });
  }
  labelAt(a) {
    for (let i = this.labelLog.length - 1; i >= 0; i--) if (this.labelLog[i].from <= a) return this.labelLog[i].label;
    return null;
  }
  labelFor(start, end) {  // the label only counts if it held for the whole window
    for (let i = this.labelLog.length - 1; i >= 0; i--) {
      const L = this.labelLog[i];
      if (L.from <= start) return L.label;
      if (L.from <= end) return undefined;  // changed mid-window: mixed, not scored
    }
    return null;
  }

  // p = {first: u16 index of first sample, gap: band restarted its window here, samples: [[ax,ay,az,gx,gy,gz]...]}
  ingest(p, wallMs = Date.now()) {
    this.stats.packets++;
    if (this.expected != null) {
      const delta = (p.first - this.expected) & 0xffff;
      const away = this.stats.lastWall != null ? wallMs - this.stats.lastWall : 0;
      if (p.gap && away > 300000) {
        // long disconnect: the 16-bit counter may have wrapped; estimate the time from the clock
        this.abs += Math.round((away * FS) / 1000);
      } else if (delta >= 0x8000) {
        this.stats.ignored++;  // old/duplicate packet
        return;
      } else if (delta) {
        for (let k = 0; k < Math.min(delta, this.keep); k++) this.trace[(this.abs + k) % this.keep] = NaN;  // hole
        this.abs += delta;
        this.stats.lost += delta;
        this.validFrom = this.abs;  // nothing before this can be analysed by the page
      }
    }
    this.expected = (p.first + p.samples.length) & 0xffff;
    this.stats.lastWall = wallMs;
    this.stats.firstWall ??= wallMs;
    if (p.gap) {
      // the band restarted its analysis at this packet's first sample: so do we
      this.aligned = true;
      this.winStart = this.validFrom = this.abs;
      this.gapPending = true;
      this.detector.reset();
      this.decider = makeDecider();
    }
    for (const s of p.samples) this.push(s);
    this.rate.push([wallMs, p.samples.length]);
    while (this.rate.length && wallMs - this.rate[0][0] > 5000) this.rate.shift();
  }

  // samples that arrived in the last 5 s (or since the start) per second of wall clock
  samplesPerSecond(now = Date.now()) {
    if (this.stats.firstWall == null) return null;
    const span = Math.min(5000, now - this.stats.firstWall) / 1000;
    const n = this.rate.reduce((p, r) => p + (now - r[0] < 5000 ? r[1] : 0), 0);
    return span >= 1 ? n / span : null;
  }

  push(v) {
    const a = this.abs++;
    this.stats.samples++;
    const k = a % N;
    for (let j = 0; j < 3; j++) {
      this.ring[j][k] = f32(v[3 + j] * GYRO_TO_RADS);  // gyro x,y,z
      this.ring[3 + j][k] = f32(v[j] * ACCEL_TO_G);    // accel x,y,z
    }
    if (Math.abs(v[3]) > GYRO_SAT_RAW || Math.abs(v[4]) > GYRO_SAT_RAW || Math.abs(v[5]) > GYRO_SAT_RAW) this.lastSat = a;
    this.trace[a % this.keep] = Math.hypot(this.ring[0][k], this.ring[1][k], this.ring[2][k]);
    if (this.session.idx.n < this.maxSession) {
      this.session.raw.push(...v);
      this.session.idx.push(a);
      this.session.lab.push(LABEL_CODE[this.labelAt(a)] ?? 0);
    }
    if (!this.aligned) return;
    const since = a - this.winStart;
    if (since >= N - 1 && (since - (N - 1)) % HOP === 0) this.analyzeAt(a);
  }

  analyzeAt(end) {
    const start = end - N + 1;
    const gap = this.gapPending;
    this.gapPending = false;
    const w = { n: this.windows.length + 1, end, t: (end + 1) / FS, label: this.labelFor(start, end), r: null, d: null, band: null, cmp: null };
    if (start >= this.validFrom) {
      const g = [0, 1, 2].map(() => new Float64Array(N)), acc = [0, 1, 2].map(() => new Float64Array(N));
      for (let i = 0; i < N; i++) {
        const k = (start + i) % N;
        for (let j = 0; j < 3; j++) { g[j][i] = this.ring[j][k]; acc[j][i] = this.ring[3 + j][k]; }
      }
      w.r = this.detector.analyze(g, acc, end - this.lastSat < N, gap);
      w.d = this.decider(w.r);
      const tot = this.detector.total, half = N / 2;
      this.spectrum = { end, df: FS / N, share: Float64Array.from({ length: half + 1 }, (_, i) => (tot > 0 ? this.detector.psd[i] / tot : 0)) };
      if (w.label) for (const a of ALGORITHMS) { const s = this.score[w.label][a.id]; s.n++; if (w.d[a.id].flag) s.flagged++; }
    } else {
      // samples of this window were lost on the way: the band still judged it, we can't
      this.decider = makeDecider();
    }
    this.windows.push(w);
    this.byEnd.set(end, w);
    if (this.byEnd.size > 400) this.byEnd.delete(this.byEnd.keys().next().value);
    this.emit('window', w);
  }

  // The band's own verdict (decoded LivePacket) for the window it just finished. It is sent right
  // after the raw packet that ends with that window's last sample, so it belongs to that window.
  bandResult(live) {
    if (!this.aligned) return;
    const last = this.abs - 1, since = last - this.winStart;
    if (since < N - 1) return;  // a verdict from before the restart
    const off = (since - (N - 1)) % HOP;
    const end = off === 0 ? last : last + (HOP - off);  // raw packet lost: it is the next boundary
    let w = this.byEnd.get(end);
    if (!w) {  // we couldn't analyse it (lost samples): record the band's word anyway
      w = { n: this.windows.length + 1, end, t: (end + 1) / FS, label: undefined, r: null, d: null, band: null, cmp: null };
      this.windows.push(w);
      this.byEnd.set(end, w);
    }
    if (w.band) return;
    w.band = {
      tremor: live.tremor, candidate: live.candidate, armRhythm: live.armRhythm, highFreq: live.highFreq,
      gap: !!(live.flags & LIVE.GAP), freqHz: live.freqHz, ratio: live.ratio, omega: live.omega, severity: live.severity, win: live.win,
    };
    if (w.r) {
      const r = w.r, b = w.band;
      const same = b.tremor === r.confirmed && b.candidate === r.candidate && b.armRhythm === r.arm_driven &&
        b.highFreq === r.high_freq && b.gap === r.gap;
      const fd = b.candidate && r.candidate ? Math.abs(b.freqHz - r.freq_hz) : 0;
      const rd = Math.abs(b.ratio - r.ratio);
      w.cmp = { same, freqDiff: fd, ratioDiff: rd };
      this.stats.compared++;
      if (same) this.stats.same++;
      this.stats.maxFreqDiff = Math.max(this.stats.maxFreqDiff, fd);
      this.stats.maxRatioDiff = Math.max(this.stats.maxRatioDiff, rd);
    } else {
      this.stats.notCompared++;
      // keep our detector's 2-in-a-row memory in step with the band's
      this.detector.prevCandidate = w.band.candidate;
      this.detector.prevFreq = w.band.freqHz;
    }
    this.emit('band', w);
  }

  // Samples as CSV: loads in the Compare tab and tools/dsp_cli (t in s; accel g; gyro rad/s).
  samplesCsv() {
    const { raw, idx, lab } = this.session, R = raw.view(), I = idx.view(), Lb = lab.view();
    const t0 = I.length ? I[0] : 0;
    const out = ['t,ax,ay,az,gx,gy,gz,label'];
    for (let i = 0; i < I.length; i++) {
      const o = i * 6;
      out.push(`${((I[i] - t0) / FS).toFixed(2)},${[0, 1, 2].map((j) => f32(R[o + j] * ACCEL_TO_G).toPrecision(7)).join(',')},${[3, 4, 5].map((j) => f32(R[o + j] * GYRO_TO_RADS).toPrecision(7)).join(',')},${Lb[i]}`);
    }
    return out.join('\n') + '\n';
  }

  // One row per window: every detector's answer, the band's own, and whether they matched.
  windowsCsv() {
    const t0 = this.session.idx.n ? this.session.idx.a[0] : 0;
    const head = ['window', 't_end_s', 'label', ...ALGORITHMS.flatMap((a) => [`${a.id}_tremor`, `${a.id}_hz`]),
      'freq_hz', 'ratio', 'omega', 'steadiness', 'lever_cm', 'lowband', 'band_tremor', 'band_hz', 'band_matches'];
    const rows = this.windows.map((w) => [w.n, ((w.end + 1 - t0) / FS).toFixed(2), w.label ?? (w.label === undefined ? 'mixed' : ''),
      ...ALGORITHMS.flatMap((a) => (w.d ? [w.d[a.id].flag ? 1 : 0, w.d[a.id].freq?.toFixed(2) ?? ''] : ['', ''])),
      ...(w.r ? [w.r.freq_hz.toFixed(3), w.r.ratio.toFixed(3), w.r.omega_amp.toFixed(3), w.r.steadiness.toFixed(3), (100 * w.r.lever_eff_m).toFixed(1), w.r.lowband_omega.toFixed(3)] : ['', '', '', '', '', '']),
      w.band ? (w.band.tremor ? 1 : 0) : '', w.band?.candidate ? w.band.freqHz.toFixed(2) : '', w.cmp ? (w.cmp.same ? 1 : 0) : '']);
    return [head, ...rows].map((r) => r.join(',')).join('\n') + '\n';
  }
}
