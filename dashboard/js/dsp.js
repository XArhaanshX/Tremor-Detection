// The band's tremor detector, ported line-for-line from firmware/src/dsp/{fft,tremor}.cpp
// (plus the comparison features in tools/dsp_cli.cpp), so the dashboard can run the SAME
// analysis on a recording or a benchmark scenario and compare it with other published
// approaches. tools/check_dsp_js.mjs checks this against the C++ window by window.

export const FS = 100, N = 256, HOP = 100;

// ---------------------------------------------------------------- FFT (fft.cpp)
class FFT {
  constructor(n) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { const a = (-2 * Math.PI * k) / n; this.cos[k] = Math.cos(a); this.sin[k] = Math.sin(a); }
  }
  forward(re, im) {
    const n = this.n;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = this.sin[k * step];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- detector (tremor.cpp)
export const DEFAULT_CONFIG = {
  fs: FS, n: N, band_lo_hz: 4, band_hi_hz: 6, search_lo_hz: 1, search_hi_hz: 15, hf_lo_hz: 6.5, hf_hi_hz: 12,
  min_ratio: 0.4, min_omega_amp: 0.1, consist_df_hz: 1, min_steadiness: 0.5, lever_m: 0.1, lobe_bins: 2,
  max_lever_eff_m: 0.15, min_axis_linearity: 0, low_lo_hz: 0.5, low_hi_hz: 3,
};

export const severityFromAmplitudeCm = (cm) => (cm < 1 ? 1 : cm < 3 ? 2 : cm < 10 ? 3 : 4);

function principalFraction(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  if (tr <= 0) return 0;
  let v = [0.57735, 0.57735, 0.57735], lambda = 0;
  for (let it = 0; it < 30; it++) {
    const w = [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
    lambda = Math.hypot(w[0], w[1], w[2]);
    if (lambda < 1e-12) return 0;
    v = w.map((x) => x / lambda);
  }
  return lambda / tr;
}

export class TremorDetector {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    const n = this.cfg.n;
    this.fft = new FFT(n);
    this.df = this.cfg.fs / n;
    this.win = new Float64Array(n);
    this.winPower = 0;
    for (let i = 0; i < n; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); this.winPower += this.win[i] ** 2; }
    this.psd = new Float64Array(n / 2 + 1);
    this.apsd = new Float64Array(n / 2 + 1);
    this.gre = [0, 1, 2].map(() => new Float64Array(n / 2 + 1));
    this.gim = [0, 1, 2].map(() => new Float64Array(n / 2 + 1));
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.reset();
  }
  reset() { this.prevCandidate = false; this.prevFreq = 0; }
  binOf(hz) { return Math.round(hz / this.df); }
  interpPeak(k, psd = this.psd) {
    const half = this.cfg.n / 2;
    if (k <= 0 || k >= half) return k * this.df;
    const eps = 1e-20;
    const a = Math.log(psd[k - 1] + eps), b = Math.log(psd[k] + eps), c = Math.log(psd[k + 1] + eps);
    const den = a - 2 * b + c;
    let d = den < 0 ? (0.5 * (a - c)) / den : 0;
    d = Math.max(-0.5, Math.min(0.5, d));
    return (k + d) * this.df;
  }
  bandRange(lo, hi) {
    const half = this.cfg.n / 2;
    return [Math.max(1, Math.ceil(lo / this.df - 0.5)), Math.min(half - 1, Math.floor(hi / this.df + 0.5))];
  }
  bandPeak(lo, hi) {
    const [k0, k1] = this.bandRange(lo, hi);
    let best = -1;
    for (let k = k0; k <= k1; k++) if (best < 0 || this.psd[k] > this.psd[best]) best = k;
    if (best < 0) return -1;
    if (this.psd[best] < this.psd[best - 1] || this.psd[best] < this.psd[best + 1]) return -1;
    return best;
  }
  lobe(k, psd = this.psd) {
    let p = 0;
    for (let j = k - this.cfg.lobe_bins; j <= k + this.cfg.lobe_bins; j++) if (j >= 1 && j < this.cfg.n / 2) p += psd[j];
    return p;
  }
  toneAmplitude(g, from, len, f) {
    const w = (2 * Math.PI * f) / this.cfg.fs;
    let power = 0;
    for (let ax = 0; ax < 3; ax++) {
      let mean = 0;
      for (let i = from; i < from + len; i++) mean += g[ax][i];
      mean /= len;
      let re = 0, im = 0;
      for (let i = from; i < from + len; i++) { const x = g[ax][i] - mean; re += x * Math.cos(w * i); im += x * Math.sin(w * i); }
      power += re * re + im * im;
    }
    return (2 * Math.sqrt(power)) / len;
  }
  detrendWindow(x) {
    const n = this.cfg.n, tm = 0.5 * (n - 1);
    let sx = 0, sxy = 0, stt = 0;
    for (let i = 0; i < n; i++) { const t = i - tm; sx += x[i]; sxy += t * x[i]; stt += t * t; }
    const mean = sx / n, slope = sxy / stt;
    for (let i = 0; i < n; i++) this.re[i] = (x[i] - mean - slope * (i - tm)) * this.win[i];
  }

  // g, a: [x[], y[], z[]] windows of length n (rad/s, g). Returns the same fields as WindowResult.
  analyze(g, a, saturated = false, gap = false) {
    const c = this.cfg, n = c.n, half = n / 2;
    const r = { candidate: false, confirmed: false, high_freq: false, saturated, gap, freq_hz: 0, dom_freq_hz: 0,
      omega_amp: 0, ratio: 0, steadiness: 0, amp_cm: 0, activity_mg: 0, accel_amp: 0, lever_eff_m: 0,
      axis_linearity: 0, lowband_omega: 0, arm_driven: false, severity: 0 };
    this.psd.fill(0); this.apsd.fill(0);
    for (let ax = 0; ax < 3; ax++) {
      this.detrendWindow(g[ax]); this.im.fill(0); this.fft.forward(this.re, this.im);
      for (let k = 0; k <= half; k++) { this.gre[ax][k] = this.re[k]; this.gim[ax][k] = this.im[k]; this.psd[k] += this.re[k] ** 2 + this.im[k] ** 2; }
      this.detrendWindow(a[ax]); this.im.fill(0); this.fft.forward(this.re, this.im);
      for (let k = 0; k <= half; k++) this.apsd[k] += this.re[k] ** 2 + this.im[k] ** 2;
    }
    let msum = 0, msq = 0;
    for (let i = 0; i < n; i++) { const m = Math.hypot(a[0][i], a[1][i], a[2][i]); msum += m; msq += m * m; }
    const v = msq / n - (msum / n) ** 2;
    r.activity_mg = 1000 * Math.sqrt(v > 0 ? v : 0);

    let s0 = Math.max(1, this.binOf(c.search_lo_hz)), s1 = Math.min(half - 1, this.binOf(c.search_hi_hz));
    let total = 0, dom = s0;
    for (let k = s0; k <= s1; k++) { total += this.psd[k]; if (this.psd[k] > this.psd[dom]) dom = k; }
    r.dom_freq_hz = this.interpPeak(dom);
    this.total = total; this.dom = dom;
    if (total <= 0) { this.reset(); return r; }
    const scale = 2 / (n * this.winPower);
    this.scale = scale;
    {
      const l0 = Math.max(1, this.binOf(c.low_lo_hz)), l1 = this.binOf(c.low_hi_hz);
      let p = 0;
      for (let k = l0; k <= l1 && k < half; k++) p += this.psd[k];
      r.lowband_omega = Math.sqrt(scale * p);
    }
    const kb = this.bandPeak(c.band_lo_hz, c.band_hi_hz);
    if (kb > 0) {
      const lobe = this.lobe(kb);
      r.ratio = lobe / total;
      r.omega_amp = Math.sqrt(2 * scale * lobe);
      r.freq_hz = this.interpPeak(kb);
      const a1 = this.toneAmplitude(g, 0, n / 2, r.freq_hz), a2 = this.toneAmplitude(g, n / 2, n / 2, r.freq_hz);
      const hi = Math.max(a1, a2);
      r.steadiness = hi > 0 ? Math.min(a1, a2) / hi : 0;
      const alobe = this.lobe(kb, this.apsd);
      r.accel_amp = 9.80665 * Math.sqrt(2 * scale * alobe);
      const wf = r.omega_amp * 2 * Math.PI * r.freq_hz;
      r.lever_eff_m = wf > 0 ? r.accel_amp / wf : 0;
      const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let j = kb - c.lobe_bins; j <= kb + c.lobe_bins; j++) {
        if (j < 1 || j >= half) continue;
        for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) m[p][q] += this.gre[p][j] * this.gre[q][j] + this.gim[p][j] * this.gim[q][j];
      }
      r.axis_linearity = principalFraction(m);
      const beat = !gap && r.ratio >= c.min_ratio && r.omega_amp >= c.min_omega_amp && r.steadiness >= c.min_steadiness;
      const wrist = r.lever_eff_m <= c.max_lever_eff_m && r.axis_linearity >= c.min_axis_linearity;
      r.candidate = beat && wrist;
      r.arm_driven = beat && !wrist;
    }
    const kh = this.bandPeak(c.hf_lo_hz, c.hf_hi_hz);
    if (kh > 0 && !r.candidate) {
      const lobe = this.lobe(kh);
      r.high_freq = lobe / total >= c.min_ratio && Math.sqrt(2 * scale * lobe) >= c.min_omega_amp;
    }
    r.confirmed = r.candidate && this.prevCandidate && Math.abs(r.freq_hz - this.prevFreq) <= c.consist_df_hz;
    this.prevCandidate = r.candidate;
    this.prevFreq = r.freq_hz;
    if (gap) this.reset();
    if (r.candidate && r.freq_hz > 0) r.amp_cm = 2 * (r.omega_amp / (2 * Math.PI * r.freq_hz)) * c.lever_m * 100;
    r.severity = r.confirmed ? severityFromAmplitudeCm(r.amp_cm) : 0;
    Object.assign(r, this.extraFeatures());
    return r;
  }

  // tools/dsp_cli.cpp extraFeatures(): inputs of the comparison detectors
  extraFeatures() {
    const e = { bp_ratio: 0, bp_omega: 0, bp_freq: 0, p37_freq: 0, p37_ratio: 0, p37_omega: 0, dom_ratio: 0, dom_omega: 0 };
    const total = this.total, psd = this.psd;
    if (!(total > 0)) return e;
    let [k0, k1] = this.bandRange(3.5, 7.5);
    let bp = 0, best = k0;
    for (let k = k0; k <= k1; k++) { bp += psd[k]; if (psd[k] > psd[best]) best = k; }
    e.bp_ratio = bp / total;
    e.bp_omega = Math.sqrt(2 * this.scale * bp);
    e.bp_freq = this.interpPeak(best);
    [k0, k1] = this.bandRange(3, 7);
    best = -1;
    for (let k = k0; k <= k1; k++) if (best < 0 || psd[k] > psd[best]) best = k;
    if (best > 0 && psd[best] >= psd[best - 1] && psd[best] >= psd[best + 1]) {
      const l = this.lobe(best);
      e.p37_freq = this.interpPeak(best);
      e.p37_ratio = l / total;
      e.p37_omega = Math.sqrt(2 * this.scale * l);
    }
    e.dom_ratio = this.lobe(this.dom) / total;
    e.dom_omega = Math.sqrt(2 * this.scale * this.lobe(this.dom));
    return e;
  }
}

// Slide the detector over a whole recording, exactly like tools/dsp_cli (window 256, hop 100).
// samples: {t:[], ax:[], ay:[], az:[], gx:[], gy:[], gz:[]} at 100 Hz.
export function analyzeRecording(s, cfg = {}) {
  const det = new TremorDetector(cfg);
  const out = [];
  const len = s.gx.length;
  for (let start = 0; start + N <= len; start += HOP) {
    const g = [s.gx, s.gy, s.gz].map((x) => x.subarray ? x.subarray(start, start + N) : x.slice(start, start + N));
    const a = [s.ax, s.ay, s.az].map((x) => x.subarray ? x.subarray(start, start + N) : x.slice(start, start + N));
    const r = det.analyze(g, a);
    r.t = (start + N) / FS;
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- the four detectors compared
// Each rule turns the same window features into a yes/no + the frequency it reports.
// Mirrored in tools/eval_pads.py (ALGORITHMS) for the real-patient numbers.
export const ALGORITHMS = [
  {
    id: 'bandpower', name: 'Band-power threshold', short: 'Band power', color: '--algo-1',
    band: [3.5, 7.5], origin: 'Classic baseline (fixed threshold on tremor-band power)',
    rule: '≥ 50 % of 1–15 Hz power in 3.5–7.5 Hz, amplitude ≥ 0.10 rad/s, 2 windows in a row',
    cand: (w) => w.bp_ratio >= 0.5 && w.bp_omega >= 0.1, freq: (w) => w.bp_freq,
  },
  {
    id: 'spectral', name: 'Spectral peak, gyro only', short: 'Spectral peak', color: '--algo-2',
    band: [4, 6], origin: 'FFT peak detectors (ELENA-style; our own detector without the lever check)',
    rule: 'narrow, strong, steady 4–6 Hz peak, 2 windows in a row at the same frequency',
    cand: (w) => w.freq_hz > 0 && w.ratio >= 0.4 && w.omega_amp >= 0.1 && w.steadiness >= 0.5, freq: (w) => w.freq_hz,
  },
  {
    id: 'gated', name: 'Movement-gated (after Timmermans 2025)', short: 'Movement-gated', color: '--algo-3',
    band: [3, 7], gate: [0.5, 3], origin: 'Open-source free-living detector: peak 3–7 Hz, windows with arm movement discarded',
    rule: 'narrow, strong 3–7 Hz peak, and NO arm movement in 0.5–3 Hz (gate < 0.4 rad/s)',
    cand: (w) => w.p37_freq > 0 && w.p37_ratio >= 0.4 && w.p37_omega >= 0.1 && w.lowband_omega < 0.4, freq: (w) => w.p37_freq,
  },
  {
    id: 'ours', name: 'Ours: lever-arm check (ELA)', short: 'Ours (ELA)', color: '--algo-4',
    band: [4, 6], leverCm: 15, origin: 'This project: spectral peak + is the beat made at the wrist?',
    rule: 'spectral peak AND effective lever arm accel ÷ (gyro × 2πf) ≤ 15 cm',
    cand: (w) => w.candidate, freq: (w) => w.freq_hz,
  },
];

// Apply all four rules to a window sequence (same 2-in-a-row consistency for every rule).
export function decide(windows) {
  const res = {};
  for (const alg of ALGORITHMS) {
    const flags = new Array(windows.length).fill(false), freqs = new Array(windows.length).fill(null);
    let prev = false, prevF = 0;
    windows.forEach((w, i) => {
      const c = !!alg.cand(w), f = alg.freq(w);
      flags[i] = alg.id === 'ours' ? w.confirmed : c && prev && Math.abs(f - prevF) <= 1;
      if (flags[i]) freqs[i] = f;
      prev = c; prevF = f;
    });
    res[alg.id] = { flags, freqs };
  }
  return res;
}
