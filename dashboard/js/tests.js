// Active tests. Five run on the screen (finger tapping, one-finger tapping per hand,
// spiral drawing, follow the dot, reaction time); the other three are measured by the
// wristband (its gyroscope / tremor pipeline) and only displayed here.
// Everything above the TestRunner class is pure (no DOM), so node can import and test it
// (tools/test_screen_tests.mjs).
import { TEST, TEST_STATE } from './protocol.js';

export const TESTS = [
  {
    id: 'tapping', name: 'Finger tapping', where: 'screen', seconds: 10,
    blurb: 'Speed & rhythm of finger movement (slowness)',
    steps: [
      'Put the phone/laptop on a table.',
      'Use the index finger of the hand wearing the band.',
      'Tap the two circles one after the other — left, right, left, right — as fast as you can.',
      'Keep going for 10 seconds.',
    ],
  },
  {
    id: 'pronsup', name: 'Hand turning', where: 'band', type: TEST.PRONSUP, seconds: 10,
    blurb: 'Palm up / palm down as fast and wide as possible',
    steps: [
      'Sit, hold the arm with the band out in front of you, elbow bent.',
      'Turn your hand palm-up, then palm-down, as fast and as fully as you can.',
      'Keep going for 10 seconds. The band measures every turn.',
    ],
  },
  {
    id: 'rest', name: 'Rest tremor check', where: 'band', type: TEST.REST, seconds: 30,
    blurb: '30 s with the hand relaxed in your lap',
    steps: [
      'Sit comfortably with both hands resting in your lap.',
      'Let the hands relax completely. Don\'t try to stop any shaking.',
      'Stay like this for 30 seconds.',
    ],
  },
  {
    id: 'postural', name: 'Arms-out tremor check', where: 'band', type: TEST.POSTURAL, seconds: 30,
    blurb: '30 s with arms held straight out',
    steps: [
      'Stretch both arms straight out in front of you, palms down.',
      'Spread your fingers slightly and hold the position.',
      'Stay like this for 30 seconds.',
    ],
  },
  {
    id: 'spiral', name: 'Spiral drawing', where: 'screen', seconds: 30, durationText: 'about 30 seconds, no time limit',
    blurb: 'Trace a spiral with your finger — shows shakiness in the line',
    steps: [
      'Put the phone/tablet flat on a table, or rest it on your lap.',
      'Use the index finger of the hand wearing the band. A stylus is fine too.',
      'Put your finger on the dot in the middle and follow the line outward, round and round.',
      'Go at a comfortable speed and try to stay on the line.',
      'The test ends when you reach the end of the line, or when you press Done.',
    ],
  },
  {
    id: 'reaction', name: 'Reaction time', where: 'screen', seconds: 40, durationText: '10 rounds, about 40 seconds',
    blurb: 'How quickly you respond when the colour changes',
    steps: [
      'Sit comfortably with your finger resting close to the screen.',
      'A large box will say “Wait…”. After a few seconds it changes colour and says “Tap now!”.',
      'Tap the box as soon as the colour changes. Don\'t guess — tapping too early restarts that round.',
      'There are 10 rounds.',
    ],
  },
  {
    id: 'tracking', name: 'Follow the dot', where: 'screen', seconds: 20,
    blurb: 'Keep your finger on a slowly moving dot',
    steps: [
      'Put the phone/tablet flat on a table, or rest it on your lap.',
      'Put the index finger of the hand wearing the band on the dot. It starts moving when you touch it.',
      'Keep your finger on the dot and follow it for 20 seconds.',
      'If your finger slips off, just put it back on the dot.',
    ],
  },
  {
    id: 'singletap', name: 'Tapping, each hand', where: 'screen', seconds: 20, handSeconds: 10,
    durationText: '10 seconds per hand',
    blurb: 'Tapping speed of the right hand, then the left, compared',
    steps: [
      'Put the phone/laptop on a table.',
      'First your RIGHT hand: tap the big circle with your index finger as fast as you can for 10 seconds.',
      'Then rest a moment and do the same with your LEFT hand.',
      'The timer starts with your first tap.',
    ],
  },
];

export const byId = (id) => TESTS.find((t) => t.id === id);

const fixed = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

// Headline number for each test (used in history + trends).
export function headline(kind, r) {
  switch (kind) {
    case 'tapping': return { value: r.rate, unit: 'taps/s', text: `${r.rate.toFixed(1)} taps/s` };
    case 'pronsup': return { value: r.rateHz, unit: 'turns/s', text: r.tooFew ? 'too few turns' : `${r.rateHz.toFixed(2)} turns/s` };
    case 'spiral': return { value: r.wobblePct, unit: '% wobble', text: `Wobble ${fixed(r.wobblePct, 1)}% · error ${fixed(r.meanErrorPct)}%` };
    case 'reaction': return { value: r.medianMs, unit: 'ms', text: r.medianMs == null ? 'no valid rounds' : `Median ${Math.round(r.medianMs)} ms` };
    case 'tracking': return { value: r.onTargetPct, unit: '% on target', text: `${fixed(r.onTargetPct)}% on target · lag ${ms(r.lagMs)}` };
    case 'singletap': return {
      value: Math.abs(r.asymmetryPct), unit: '% L–R difference',
      text: `R ${r.right.rate.toFixed(1)}/s · L ${r.left.rate.toFixed(1)}/s`,
    };
    default: return { value: r.sevMean, unit: 'severity', text: `${r.tremorPct}% tremor · severity ${r.sevMax}` };
  }
}

export function detailRows(kind, r) {
  switch (kind) {
    case 'tapping': return [
      ['Correct taps', r.taps], ['Speed', `${r.rate.toFixed(1)} taps/s`],
      ['Rhythm variability', `${r.cvPct.toFixed(0)}%`, 'lower = more regular'],
      ['Slowing down (2nd half vs 1st)', `${r.fatiguePct.toFixed(0)}%`, 'positive = got slower'],
      ['Accuracy', `${r.accuracyPct.toFixed(0)}%`], ['Longest pause', `${r.longestPauseMs} ms`],
      ['Same-side repeats', r.alternationErrors],
    ];
    case 'pronsup': return [
      ['Half-turns', r.movements], ['Speed', `${r.rateHz.toFixed(2)} turns/s`],
      ['Rotation per turn', `${r.excursionDeg.toFixed(0)}°`], ['Peak turning speed', `${r.speedDps}°/s`],
      ['Getting smaller (decrement)', `${r.ampDecrementPct}%`, 'positive = turns shrank'],
      ['Getting slower', `${r.speedDecrementPct}%`], ['Rhythm variability', `${r.rhythmCvPct}%`],
      ['Hesitations', r.hesitations],
      ...(r.saturated ? [['Note', 'Sensor hit its limit — very fast turning']] : []),
    ];
    case 'spiral': return [
      ['Wobble in the line', `${fixed(r.wobblePct, 1)}%`, 'small quick shakes · lower = steadier'],
      ['Distance from the line', `${fixed(r.meanErrorPct)}%`, 'of the gap between loops · lower = more accurate'],
      ['Wobble speed', r.wobbleHz ? `${r.wobbleHz.toFixed(1)} Hz` : '—', 'shakes per second, when there is a clear wobble'],
      ['How far you got', `${fixed(r.coveragePct)}%`, 'of the whole spiral'],
      ['Time taken', `${fixed(r.durationS)} s`],
      ['Drawing speed', `${fixed(r.speedLoopsPerS, 2)} loops/s`],
    ];
    case 'reaction': return [
      ['Typical reaction time', ms(r.medianMs), 'the middle value · lower = quicker'],
      ['Average', ms(r.meanMs)],
      ['Fastest / slowest', `${fixed(r.fastestMs)} / ${ms(r.slowestMs)}`],
      ['How much it varied', ms(r.sdMs), 'lower = more even'],
      ['Too-early taps', r.falseStarts, 'taps before the colour changed'],
      ['Rounds counted', r.n],
    ];
    case 'tracking': return [
      ['Time on the dot', `${fixed(r.onTargetPct)}%`, 'higher = better'],
      ['Average distance from the dot\'s centre', fixed(r.meanErrorRadii, 1), 'in dot radii · below 1 = on the dot'],
      ['Delay behind the dot', ms(r.lagMs), 'lower = keeping up better'],
      ['Finger lifted', `${fixed(r.liftedPct)}%`, 'of the time'],
    ];
    case 'singletap': {
      const { right: R, left: L } = r;
      const a = r.asymmetryPct;
      return [
        ['Speed — right / left', `${R.rate.toFixed(1)} / ${L.rate.toFixed(1)} taps/s`],
        ['Difference between hands', Math.abs(a) < 0.5 ? '0% (even)' : `${Math.abs(a).toFixed(0)}% (${a > 0 ? 'right' : 'left'} faster)`, 'smaller = more even'],
        ['Taps — right / left', `${R.taps} / ${L.taps}`],
        ['Rhythm variability — right / left', `${R.cvPct.toFixed(0)}% / ${L.cvPct.toFixed(0)}%`, 'lower = more regular'],
        ['Slowing down — right / left', `${R.fatiguePct.toFixed(0)}% / ${L.fatiguePct.toFixed(0)}%`, 'positive = got slower'],
      ];
    }
    default: return [
      ['Time with tremor', `${r.tremorPct}%`], ['Severity (max)', r.sevMax], ['Severity (average)', r.sevMean.toFixed(1)],
      ['Frequency', r.freqHz ? `${r.freqHz.toFixed(1)} Hz` : '—'],
      ['Tremor size (avg / max)', r.ampMeanCm ? `${r.ampMeanCm.toFixed(1)} / ${r.ampMaxCm.toFixed(1)} cm` : '—'],
    ];
  }
}

// ---- finger tapping, measured on the screen ----
export function tappingMetrics(events, seconds) {
  const hits = events.filter((e) => e.target);
  const iti = [];
  let errors = 0;
  for (let i = 1; i < hits.length; i++) {
    iti.push(hits[i].t - hits[i - 1].t);
    if (hits[i].target === hits[i - 1].target) errors++;
  }
  const mean = iti.length ? iti.reduce((a, b) => a + b, 0) / iti.length : 0;
  const sd = iti.length ? Math.sqrt(iti.reduce((a, b) => a + (b - mean) ** 2, 0) / iti.length) : 0;
  const halfT = (seconds * 1000) / 2;
  const first = hits.filter((h) => h.t < halfT).length;
  const second = hits.length - first;
  return {
    taps: hits.length,
    rate: hits.length / seconds,
    cvPct: mean ? (100 * sd) / mean : 0,
    fatiguePct: first ? (100 * (first - second)) / first : 0,
    accuracyPct: events.length ? (100 * hits.length) / events.length : 0,
    longestPauseMs: Math.round(Math.max(0, ...iti)),
    alternationErrors: errors,
  };
}

// ---- shared signal helpers (pure) ----
const TAU = 2 * Math.PI;
const FS = 60;  // uniform resampling rate for trace signals, Hz
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const wrapPi = (d) => d - TAU * Math.round(d / TAU);

// Linear interpolation of irregular (t ms, v) onto a uniform grid at fs Hz.
function resampleUniform(t, v, fs) {
  const dt = 1000 / fs;
  const n = Math.floor((t[t.length - 1] - t[0]) / dt) + 1;
  const out = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const tk = t[0] + k * dt;
    while (j < t.length - 2 && t[j + 1] <= tk) j++;
    const span = t[j + 1] - t[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (tk - t[j]) / span)) : 0;
    out[k] = v[j] + f * (v[j + 1] - v[j]);
  }
  return out;
}

// Signal minus its centred moving average (window `win` samples): removes slow drift.
function highPass(x, win) {
  const half = Math.max(1, Math.floor(win / 2));
  const c = [0];
  for (const v of x) c.push(c[c.length - 1] + v);
  return x.map((v, i) => {
    const lo = Math.max(0, i - half), hi = Math.min(x.length, i + half + 1);
    return v - (c[hi] - c[lo]) / (hi - lo);
  });
}

// Strongest frequency between lo and hi Hz (Hann-windowed DFT scan in `step` Hz steps).
function peakFrequency(x, fs, lo, hi, step) {
  const n = x.length;
  const w = x.map((v, i) => v * (0.5 - 0.5 * Math.cos((TAU * i) / (n - 1))));
  let best = null, bestP = -1;
  for (let f = lo; f <= hi + 1e-9; f += step) {
    const k = (TAU * f) / fs;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += w[i] * Math.cos(k * i); im -= w[i] * Math.sin(k * i); }
    const p = re * re + im * im;
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

// ---- spiral drawing ----
// Archimedean spiral r = a + b·θ, θ from 0 to 2π·turns, centred in a sizePx square.
// Screen y points down, so θ increases clockwise on screen. Starts at (cx + a, cy).
export function spiralGeometry(sizePx, turns = 3) {
  const a = 0.06 * sizePx, outer = 0.45 * sizePx;
  return { cx: sizePx / 2, cy: sizePx / 2, a, b: (outer - a) / (TAU * turns), turns, sizePx };
}

// Continuous angle unwrapping around the spiral centre. The first sample of each stroke
// is anchored to the loop whose radius is nearest; after that the angle only changes by
// small steps, so a trace that strays far from its loop still keeps the right loop.
function spiralTracker(sp) {
  let theta = null, prevPhi = 0;
  return (x, y, newStroke) => {
    const dx = x - sp.cx, dy = y - sp.cy;
    const r = Math.hypot(dx, dy), phi = Math.atan2(dy, dx);
    if (theta == null || newStroke) {
      const base = phi < 0 ? phi + TAU : phi;
      let bestErr = Infinity;
      for (let n = -1; n <= sp.turns; n++) {
        const th = base + TAU * n, err = Math.abs(r - (sp.a + sp.b * th));
        if (err < bestErr) { bestErr = err; theta = th; }
      }
    } else if (r > 0.25 * sp.a) {
      theta += wrapPi(phi - prevPhi);  // right at the centre the angle is meaningless
    }
    prevPhi = phi;
    return { theta, r, err: r - (sp.a + sp.b * theta) };
  };
}

// samples: [{t (ms), x, y, stroke?}] in canvas CSS px, in time order. `stroke` changes
// whenever the finger was lifted and put down again. spiral: from spiralGeometry().
// Errors are in % of the loop spacing (2πb), so results don't depend on screen size.
export function spiralMetrics(samples, spiral) {
  const out = { coveragePct: 0, meanErrorPct: 0, wobblePct: 0, wobbleHz: null, durationS: 0, speedLoopsPerS: 0 };
  const loop = TAU * spiral.b;
  if (!samples || samples.length < 2 || !(loop > 0)) return out;
  const track = spiralTracker(spiral);
  const t = [], e = [];
  let maxTheta = -Infinity;
  samples.forEach((s, i) => {
    const p = track(s.x, s.y, i > 0 && s.stroke !== samples[i - 1].stroke);
    if (p.theta > maxTheta) maxTheta = p.theta;
    t.push(s.t);
    e.push(p.err / loop);
  });
  const durationS = (t[t.length - 1] - t[0]) / 1000;
  const loops = Math.min(Math.max(0, maxTheta) / TAU, spiral.turns);
  const u = resampleUniform(t, e, FS);              // radial error, uniform 60 Hz, in loops
  const hp = highPass(u, Math.round(0.5 * FS));     // remove slow drift (0.5 s average)
  out.coveragePct = (100 * loops) / spiral.turns;
  out.meanErrorPct = 100 * avg(u.map(Math.abs));
  out.wobblePct = 100 * Math.sqrt(avg(hp.map((v) => v * v)));
  // A frequency only means something when there is a wobble to measure.
  out.wobbleHz = durationS >= 2 && out.wobblePct >= 0.5 ? peakFrequency(hp, FS, 3, 12, 0.25) : null;
  out.durationS = durationS;
  out.speedLoopsPerS = durationS > 0 ? loops / durationS : 0;
  return out;
}

// ---- reaction time ----
export const MIN_RT_MS = 100;  // faster than this is anticipation, not reaction

// trials: [{rtMs: number | null, falseStart: bool}]. Sample SD (n − 1).
export function reactionMetrics(trials) {
  const early = (t) => t.falseStart || (t.rtMs != null && t.rtMs < MIN_RT_MS);
  const rts = trials.filter((t) => !early(t) && t.rtMs != null).map((t) => t.rtMs).sort((a, b) => a - b);
  const n = rts.length;
  const m = n ? avg(rts) : null;
  return {
    n,
    meanMs: m,
    medianMs: n ? (n % 2 ? rts[(n - 1) / 2] : (rts[n / 2 - 1] + rts[n / 2]) / 2) : null,
    sdMs: n > 1 ? Math.sqrt(rts.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) : n ? 0 : null,
    fastestMs: n ? rts[0] : null,
    slowestMs: n ? rts[n - 1] : null,
    falseStarts: trials.filter(early).length,
  };
}

// ---- follow the dot ----
// Smooth, slow path inside a w×h canvas: a sum of two sines per axis. It starts in the
// centre almost at rest, and time is scaled so the peak speed is at most w per 3 s.
export function trackingPath(w, h, radiusPx, durationS = 20) {
  const ax = Math.max(0, w / 2 - radiusPx - 6), ay = Math.max(0, h / 2 - radiusPx - 6);
  const raw = (s) => ({
    x: w / 2 + ax * (0.6 * Math.sin(TAU * 0.08 * s) + 0.4 * Math.sin(TAU * 0.15 * s + Math.PI)),
    y: h / 2 + ay * (0.6 * Math.sin(TAU * 0.10 * s) + 0.4 * Math.sin(TAU * 0.19 * s + Math.PI)),
  });
  const dt = 0.01;
  let peak = 0, p = raw(0);
  for (let s = dt; s <= durationS + 1e-9; s += dt) {
    const q = raw(s);
    peak = Math.max(peak, Math.hypot(q.x - p.x, q.y - p.y) / dt);
    p = q;
  }
  const k = peak > 0 ? Math.min(1, w / 3 / peak) : 1;
  return (s) => raw(s * k);
}

// Lag (ms) that best lines the finger up with where the target was: finger(t) ≈ target(t − lag).
// Uses the spread of the finger–target difference, so a constant offset doesn't matter.
function trackingLag(all, down, maxLag = 600, step = 16) {
  const use = down.filter((s) => s.t - maxLag >= all[0].t);
  if (use.length < 30 || use[use.length - 1].t - use[0].t < 1000) return null;
  const targetAt = (t) => {
    let lo = 0, hi = all.length - 1;
    if (t <= all[lo].t) return all[lo];
    if (t >= all[hi].t) return all[hi];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (all[mid].t <= t) lo = mid; else hi = mid; }
    const f = (t - all[lo].t) / (all[hi].t - all[lo].t || 1);
    return { tx: all[lo].tx + f * (all[hi].tx - all[lo].tx), ty: all[lo].ty + f * (all[hi].ty - all[lo].ty) };
  };
  const costs = [];
  for (let lag = 0; lag <= maxLag; lag += step) {
    const dx = [], dy = [];
    for (const s of use) { const p = targetAt(s.t - lag); dx.push(s.fx - p.tx); dy.push(s.fy - p.ty); }
    const mx = avg(dx), my = avg(dy);
    costs.push(avg(dx.map((v, i) => (v - mx) ** 2 + (dy[i] - my) ** 2)));
  }
  const k = costs.indexOf(Math.min(...costs));
  let lag = k * step;
  if (k > 0 && k < costs.length - 1) {  // parabolic refinement between the 16 ms steps
    const den = costs[k - 1] - 2 * costs[k] + costs[k + 1];
    if (den > 0) lag += step * Math.max(-0.5, Math.min(0.5, (0.5 * (costs[k - 1] - costs[k + 1])) / den));
  }
  return Math.round(lag);
}

// samples: one per animation frame, [{t (ms), tx, ty, fx, fy, down}] in canvas CSS px.
export function trackingMetrics(samples, radiusPx) {
  const n = samples.length;
  const down = samples.filter((s) => s.down && s.fx != null && s.fy != null);
  const err = down.map((s) => Math.hypot(s.fx - s.tx, s.fy - s.ty));
  const meanErrorPx = err.length ? avg(err) : null;
  return {
    meanErrorPx,
    meanErrorRadii: meanErrorPx == null ? null : meanErrorPx / radiusPx,
    onTargetPct: n ? (100 * err.filter((d) => d <= radiusPx).length) / n : 0,
    lagMs: n ? trackingLag(samples, down) : null,
    liftedPct: n ? (100 * (n - down.length)) / n : 0,
  };
}

// ---- one-finger tapping, each hand ----
// events: [{t (ms from first tap), target: truthy if the circle was hit}] per hand.
export function singleTapMetrics(rightEvents, leftEvents, seconds) {
  const hand = (ev) => {
    const m = tappingMetrics(ev, seconds);
    return { taps: m.taps, rate: m.rate, cvPct: m.cvPct, fatiguePct: m.fatiguePct };
  };
  const right = hand(rightEvents), left = hand(leftEvents);
  const top = Math.max(right.rate, left.rate);
  return { right, left, asymmetryPct: top ? (100 * (right.rate - left.rate)) / top : 0 };
}

// ---------------------------------------------------------------- browser-only helpers
const SCREEN_RUNNERS = {
  tapping: 'runTapping', singletap: 'runSingleTap', spiral: 'runSpiral', tracking: 'runTracking', reaction: 'runReaction',
};

// Theme colours for canvas drawing (works in light and dark).
function themeColours(...names) {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim() || '#65747e']));
}

// Size a canvas in CSS px and scale its bitmap for sharp lines on high-density screens.
function fitCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

// Event time on the performance.now() clock; falls back to now() if a browser uses another clock.
function stamp(e) {
  const now = performance.now();
  return e && e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 5000 ? e.timeStamp : now;
}

// Finger / stylus / mouse input on a drawing surface. Follows one pointer at a time (a pen
// takes over from a resting palm), uses coalesced events for every sample the device
// reports, and keeps the page from scrolling. Returns a function that detaches everything.
function pointerSurface(el, { down, move, up }) {
  let id = null, type = null, rect = null, detached = false;
  const local = (ev) => ({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, t: stamp(ev) });
  const onDown = (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    if (id != null && !(e.pointerType === 'pen' && type !== 'pen')) return;
    id = e.pointerId;
    type = e.pointerType;
    try { el.setPointerCapture(id); } catch { /* pointer already gone */ }
    rect = el.getBoundingClientRect();
    down(local(e));
  };
  const onMove = (e) => {
    if (e.pointerId !== id) return;
    e.preventDefault();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of list.length ? list : [e]) move(local(ce));
  };
  const onUp = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    up?.();
  };
  const block = (e) => e.preventDefault();
  const on = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp],
    ['touchstart', block], ['touchmove', block], ['contextmenu', block]];
  for (const [ev, fn] of on) el.addEventListener(ev, fn, { passive: false });
  return () => {
    if (detached) return;
    detached = true;
    for (const [ev, fn] of on) el.removeEventListener(ev, fn, { passive: false });
    if (id != null) try { el.releasePointerCapture(id); } catch { /* already released */ }
  };
}

// Runs one test inside the modal. band may be null for the on-screen tests.
export class TestRunner {
  constructor(modal, { getBand, onSaved, getContext }) {
    this.modal = modal;
    this.getBand = getBand;
    this.onSaved = onSaved;
    this.getContext = getContext;
    this.session = 0;
  }

  open(id) {
    this.def = byId(id);
    this.cleanup?.();
    this.cleanup = null;
    this.session++;
    this.setWide(false);
    const d = this.def;
    this.render(`
      <h2>${d.name}</h2>
      <p class="muted">${d.where === 'band' ? 'Measured by the wristband' : 'Measured on this screen'} · ${d.durationText ?? `${d.seconds} seconds`}</p>
      <ol class="steps">${d.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <div class="modal-actions">
        <button class="btn" data-act="close">Cancel</button>
        <button class="btn primary" data-act="start">I'm ready — start</button>
      </div>`);
    this.modal.hidden = false;
    this.modal.querySelector('[data-act=start]').focus();
  }

  render(html) {
    const box = this.modal.querySelector('.modal-box');
    box.innerHTML = html;
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.action(b.dataset.act)));
  }

  // Wider modal for the drawing tests (bigger canvas on tablets/laptops).
  setWide(on) {
    this.modal.querySelector('.modal-box')?.classList.toggle('st-wide', on);
  }

  action(act) {
    if (act === 'close') this.close();
    if (act === 'start') this.countdown();
    if (act === 'again') this.open(this.def.id);
  }

  close() {
    if (this.running && this.def.where === 'band') this.getBand()?.abortTest();
    this.running = false;
    this.session++;
    this.cleanup?.();
    this.setWide(false);
    this.modal.hidden = true;
  }

  async countdown() {
    const session = ++this.session;  // a closed/reopened modal or a double press cancels this one
    for (const n of [3, 2, 1]) {
      this.render(`<div class="countdown" aria-live="assertive">${n}</div><p class="muted center">${this.def.name}</p>`);
      await new Promise((r) => setTimeout(r, 800));
      if (this.modal.hidden || session !== this.session) return;
    }
    if (this.def.where === 'band') this.runBand();
    else this[SCREEN_RUNNERS[this.def.id]]();
  }

  progressHtml(label) {
    return `<div class="progress"><div class="progress-bar" style="width:0%"></div></div>
      <p class="center big-timer" aria-live="polite">${label}</p>`;
  }

  setProgress(elapsed, total) {
    const bar = this.modal.querySelector('.progress-bar');
    const lab = this.modal.querySelector('.big-timer');
    if (bar) bar.style.width = `${Math.min(100, (100 * elapsed) / total)}%`;
    if (lab) lab.textContent = `${Math.max(0, Math.ceil(total - elapsed))} s`;
  }

  runTapping() {
    const d = this.def;
    this.render(`${this.progressHtml(`${d.seconds} s`)}
      <div class="tap-area" id="tapArea">
        <button class="tap-target" data-target="L" aria-label="Left target">L</button>
        <button class="tap-target" data-target="R" aria-label="Right target">R</button>
      </div>
      <p class="center"><span id="tapCount">0</span> taps · <span class="muted">the timer starts with your first tap</span></p>`);
    const area = this.modal.querySelector('#tapArea');
    const events = [];
    let start = null;
    const onDown = (e) => {
      e.preventDefault();
      const now = performance.now();
      if (start == null) start = now;  // the clock starts on the first tap
      const target = e.target.closest('[data-target]')?.dataset.target || null;
      events.push({ t: now - start, target });
      if (target) e.target.closest('[data-target]').classList.add('hit');
      setTimeout(() => area.querySelectorAll('.hit').forEach((b) => b.classList.remove('hit')), 80);
      this.modal.querySelector('#tapCount').textContent = events.filter((x) => x.target).length;
    };
    area.addEventListener('pointerdown', onDown);
    this.running = true;
    const tick = setInterval(() => {
      if (start == null) return;
      const el = (performance.now() - start) / 1000;
      this.setProgress(el, d.seconds);
      if (el >= d.seconds) {
        clearInterval(tick);
        area.removeEventListener('pointerdown', onDown);
        this.running = false;
        this.finish(tappingMetrics(events.filter((e) => e.t <= d.seconds * 1000), d.seconds));
      }
    }, 100);
    this.cleanup = () => clearInterval(tick);
  }

  // One big circle, right hand then left hand, each timed from its first tap.
  runSingleTap() {
    const secs = this.def.handSeconds;
    const events = { right: [], left: [] };
    this.running = true;
    const phase = (hand) => {
      this.render(`<h2 class="st-hand">${hand === 'right' ? 'Right' : 'Left'} hand</h2>${this.progressHtml(`${secs} s`)}
        <div class="tap-area" id="tapArea">
          <button class="tap-target st-single" data-target="T" aria-label="Tap here">Tap</button>
        </div>
        <p class="center"><span id="tapCount">0</span> taps · <span class="muted">the timer starts with your first tap</span></p>`);
      const area = this.modal.querySelector('#tapArea');
      const count = this.modal.querySelector('#tapCount');
      const ev = events[hand];
      let start = null, hits = 0;
      const onDown = (e) => {
        e.preventDefault();
        const now = performance.now();
        if (start == null) start = now;
        const target = e.target.closest('[data-target]') ? 'T' : null;
        ev.push({ t: now - start, target });
        if (target) count.textContent = ++hits;
      };
      area.addEventListener('pointerdown', onDown);
      const stop = () => { clearInterval(tick); area.removeEventListener('pointerdown', onDown); };
      const tick = setInterval(() => {
        if (start == null) return;
        const el = (performance.now() - start) / 1000;
        this.setProgress(el, secs);
        if (el < secs) return;
        stop();
        if (hand === 'right') pause();
        else {
          this.running = false;
          const inTime = (list) => list.filter((e) => e.t <= secs * 1000);
          this.finish(singleTapMetrics(inTime(events.right), inTime(events.left), secs));
        }
      }, 100);
      this.cleanup = stop;
    };
    const pause = () => {
      this.render(`<h2>Right hand done</h2>
        <p>Now switch to your <strong>left</strong> hand. Rest for a moment first if you like.</p>
        <p class="muted">Tap the big circle with your left index finger as fast as you can for ${secs} seconds. The timer starts with your first tap.</p>
        <div class="modal-actions"><button class="btn" data-act="close">Cancel</button>
          <button class="btn primary" id="stNext">Start left hand</button></div>`);
      const next = this.modal.querySelector('#stNext');
      next.addEventListener('click', () => phase('left'));
      next.focus();
      this.cleanup = null;
    };
    phase('right');
  }

  // Trace an Archimedean spiral from the centre outward. Ends at the outer end or on Done.
  runSpiral() {
    const MAX_MS = 120000;  // safety limit; the test normally ends long before
    this.setWide(true);
    this.render(`<h2>${this.def.name}</h2>
      <p class="st-status" id="stStatus">Put your finger on the dot in the middle and follow the line outward to the end.</p>
      <div class="st-canvas-wrap"><canvas class="st-canvas" id="stCanvas" role="img" aria-label="Spiral to trace with your finger"></canvas></div>
      <div class="modal-actions">
        <button class="btn" data-act="close">Cancel</button>
        <button class="btn" id="stClear">Start over</button>
        <button class="btn primary" id="stDone">Done</button>
      </div>`);
    const canvas = this.modal.querySelector('#stCanvas');
    const status = this.modal.querySelector('#stStatus');
    const size = Math.max(200, Math.floor(Math.min(canvas.parentElement.clientWidth, window.innerHeight * 0.55)));
    const ctx = fitCanvas(canvas, size, size);
    const sp = spiralGeometry(size);
    const total = TAU * sp.turns;
    const col = themeColours('--accent', '--accent-soft', '--text-muted', '--text-2');
    const at = (th) => { const r = sp.a + sp.b * th; return [sp.cx + r * Math.cos(th), sp.cy + r * Math.sin(th)]; };
    const dot = (x, y, r, fill, ring) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = 2.5; ctx.stroke(); }
    };
    const drawGuide = () => {
      ctx.clearRect(0, 0, size, size);
      const path = new Path2D();
      for (let th = 0; th <= total + 1e-9; th += 0.02) path[th ? 'lineTo' : 'moveTo'](...at(th));
      path.lineTo(...at(total));
      ctx.strokeStyle = col['--accent-soft'];
      ctx.lineWidth = 12;
      ctx.stroke(path);
      ctx.strokeStyle = col['--text-muted'];
      ctx.globalAlpha = 0.55;  // visible in light and dark themes, still quiet
      ctx.lineWidth = 2;
      ctx.stroke(path);
      ctx.globalAlpha = 1;
      dot(...at(total), 9, null, col['--text-2']);   // end: hollow ring
      dot(...at(0), 9, col['--accent']);              // start: filled dot
    };

    let samples, track, t0, stroke, last, ended = false;
    const reset = () => { samples = []; track = spiralTracker(sp); t0 = null; stroke = -1; last = null; drawGuide(); };
    const end = () => {
      if (ended) return;
      ended = true;
      detach();
      this.running = false;
      this.finish(spiralMetrics(samples, sp));
    };
    const add = (p, newStroke) => {
      if (ended) return;
      if (t0 == null) t0 = p.t;
      const s = { t: p.t - t0, x: p.x, y: p.y, stroke };
      samples.push(s);
      ctx.strokeStyle = ctx.fillStyle = col['--accent'];
      if (last && !newStroke) {
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else dot(p.x, p.y, 2);
      last = p;
      const { theta } = track(p.x, p.y, newStroke);
      if (theta >= total - 0.08 || s.t > MAX_MS) end();
    };
    const detach = pointerSurface(canvas, {
      down: (p) => { stroke++; add(p, true); },
      move: (p) => add(p, false),
      up: () => { last = null; },
    });
    this.modal.querySelector('#stClear').addEventListener('click', () => {
      reset();
      status.textContent = 'Put your finger on the dot in the middle and follow the line outward to the end.';
    });
    this.modal.querySelector('#stDone').addEventListener('click', () => {
      if (samples.length < 10) status.textContent = 'Trace along the line first, then press Done.';
      else end();
    });
    reset();
    this.running = true;
    this.cleanup = () => { ended = true; detach(); };
  }

  // Keep a finger on a slowly moving dot for def.seconds. The dot starts when touched.
  runTracking() {
    const d = this.def;
    this.setWide(true);
    this.render(`<h2>${d.name}</h2>${this.progressHtml(`${d.seconds} s`)}
      <div class="st-canvas-wrap"><canvas class="st-canvas" id="stCanvas" role="img" aria-label="Moving dot to follow with your finger"></canvas></div>
      <p class="st-status" id="stStatus">Put your finger on the dot. It starts moving when you touch it.</p>
      <div class="modal-actions"><button class="btn" data-act="close">Cancel</button></div>`);
    const canvas = this.modal.querySelector('#stCanvas');
    const status = this.modal.querySelector('#stStatus');
    const w = Math.max(240, Math.floor(canvas.parentElement.clientWidth));
    const h = Math.max(200, Math.floor(Math.min(w * 0.8, window.innerHeight * 0.45)));
    const ctx = fitCanvas(canvas, w, h);
    const R = window.matchMedia?.('(pointer: coarse)').matches ? 34 : 28;
    const path = trackingPath(w, h, R, d.seconds);
    const col = themeColours('--accent', '--accent-soft');
    const p0 = path(0);
    const samples = [];
    let finger = null, isDown = false, start = null, raf = 0, ended = false, shown = -1;

    const draw = (p) => {
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, TAU);
      ctx.fillStyle = col['--accent-soft'];
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = col['--accent'];
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, TAU);
      ctx.fillStyle = col['--accent'];
      ctx.fill();
    };
    const end = () => {
      if (ended) return;
      ended = true;
      cancelAnimationFrame(raf);
      detach();
      this.running = false;
      this.finish(trackingMetrics(samples, R));
    };
    const frame = () => {
      if (ended) return;
      const now = performance.now();
      if (start == null && isDown && finger && Math.hypot(finger.x - p0.x, finger.y - p0.y) <= 2 * R) {
        start = now;
        status.textContent = 'Keep your finger on the dot and follow it.';
      }
      const s = start == null ? 0 : Math.min((now - start) / 1000, d.seconds);
      const tp = path(s);
      if (start != null) {
        samples.push({ t: now - start, tx: tp.x, ty: tp.y, fx: finger ? finger.x : null, fy: finger ? finger.y : null, down: isDown });
        const tenth = Math.floor(s * 10);
        if (tenth !== shown) { shown = tenth; this.setProgress(s, d.seconds); }
        if (s >= d.seconds) { end(); return; }
      }
      draw(tp);
      raf = requestAnimationFrame(frame);
    };
    const detach = pointerSurface(canvas, {
      down: (p) => {
        finger = p;
        isDown = true;
        if (start == null && Math.hypot(p.x - p0.x, p.y - p0.y) > 2 * R) status.textContent = 'Put your finger on the dot itself to begin.';
      },
      move: (p) => { finger = p; },
      up: () => { isDown = false; },
    });
    this.running = true;
    this.cleanup = () => { ended = true; cancelAnimationFrame(raf); detach(); };
    raf = requestAnimationFrame(frame);
  }

  // 10 rounds: wait 1.5–4 s, the panel changes colour once, tap it. Early taps restart the round.
  runReaction() {
    const N = 10, MAX_TRIALS = 30;
    this.render(`<h2>${this.def.name}</h2>
      <div class="st-meta"><span id="stRound">Round 1 of ${N}</span><span id="stEarly"></span></div>
      <button type="button" class="st-panel" id="stPanel" data-state="wait">
        <span class="st-panel-main" id="stMain">Wait…</span><span class="st-panel-sub" id="stSub"></span>
      </button>
      <div class="modal-actions"><button class="btn" data-act="close">Stop</button></div>`);
    const $ = (s) => this.modal.querySelector(s);
    const panel = $('#stPanel'), main = $('#stMain'), sub = $('#stSub'), round = $('#stRound'), earlyEl = $('#stEarly');
    const trials = [];
    let state = 'pause', timer = 0, raf = 0, goAt = 0, valid = 0, early = 0, ended = false;
    const show = (st, a, b) => { panel.dataset.state = st; main.textContent = a; sub.textContent = b; };

    const arm = () => {
      if (ended) return;
      state = 'wait';
      round.textContent = `Round ${valid + 1} of ${N}`;
      show('wait', 'Wait…', 'Tap when the colour changes');
      timer = setTimeout(() => {
        raf = requestAnimationFrame(() => {
          if (state !== 'wait' || ended) return;
          state = 'go';
          show('go', 'Tap now!', '');
          goAt = performance.now();  // just before this frame is painted
        });
      }, 1500 + Math.random() * 2500);
    };
    const end = () => {
      if (ended) return;
      stop();
      this.running = false;
      this.finish(reactionMetrics(trials));
    };
    const tooSoon = () => {
      early++;
      earlyEl.textContent = `Too early: ${early}`;
      state = 'pause';
      show('early', 'Too soon', '— wait for the colour');
      timer = setTimeout(trials.length >= MAX_TRIALS ? end : arm, 1800);
    };
    const onTap = (e) => {
      if (e.type === 'pointerdown') {
        if (e.button > 0) return;
      } else if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
      e.preventDefault();
      const now = stamp(e);
      if (state === 'wait') {
        clearTimeout(timer);
        cancelAnimationFrame(raf);
        trials.push({ rtMs: null, falseStart: true });
        tooSoon();
      } else if (state === 'go') {
        const rt = now - goAt;
        trials.push({ rtMs: rt, falseStart: false });
        if (rt < MIN_RT_MS) { tooSoon(); return; }
        valid++;
        state = 'pause';
        show('done', `${Math.round(rt)} ms`, valid < N ? 'Next round coming…' : 'All done');
        timer = setTimeout(valid < N && trials.length < MAX_TRIALS ? arm : end, 1200);
      }
    };
    const block = (e) => e.preventDefault();
    panel.addEventListener('pointerdown', onTap);
    panel.addEventListener('keydown', onTap);
    panel.addEventListener('touchstart', block, { passive: false });
    panel.addEventListener('contextmenu', block);
    const stop = () => {
      ended = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      panel.removeEventListener('pointerdown', onTap);
      panel.removeEventListener('keydown', onTap);
      panel.removeEventListener('touchstart', block, { passive: false });
      panel.removeEventListener('contextmenu', block);
    };
    this.running = true;
    this.cleanup = stop;  // keyboard users reach the panel with Tab (it is the first control)
    arm();
  }

  runBand() {
    const band = this.getBand();
    const d = this.def;
    if (!band || band.state !== 'connected') {
      this.render(`<h2>Band not connected</h2><p>Connect the wristband (or start the demo) first.</p>
        <div class="modal-actions"><button class="btn" data-act="close">Close</button></div>`);
      return;
    }
    this.render(`<h2>${d.name}</h2>${this.progressHtml(`${d.seconds} s`)}
      <p class="center muted">${d.steps[d.steps.length - 2]}</p>
      <div class="modal-actions"><button class="btn" data-act="close">Stop</button></div>`);
    this.running = true;
    const onTest = (e) => {
      const r = e.detail;
      if (r.type !== d.type) return;
      if (r.state === TEST_STATE.RUNNING) this.setProgress(r.elapsedS, r.totalS);
      else {
        band.removeEventListener('test', onTest);
        this.running = false;
        if (r.state === TEST_STATE.DONE) this.finish(r);
        else this.render(`<h2>Test stopped</h2><p>The test didn't finish${r.state === TEST_STATE.ERROR ? ' (band reported an error)' : ''}.</p>
          <div class="modal-actions"><button class="btn" data-act="close">Close</button><button class="btn primary" data-act="again">Try again</button></div>`);
      }
    };
    band.addEventListener('test', onTest);
    this.cleanup = () => band.removeEventListener('test', onTest);
    band.startTest(d.type, d.seconds);
  }

  async finish(result) {
    const d = this.def;
    this.setWide(false);
    const saved = await this.onSaved({ t: Date.now(), kind: d.id, result, context: this.getContext() });
    const h = headline(d.id, result);
    this.render(`<h2>${d.name} — done</h2>
      <p class="result-headline">${h.text}</p>
      <table class="kv">${detailRows(d.id, result).map(([k, v, hint]) =>
        `<tr><th>${k}${hint ? `<small>${hint}</small>` : ''}</th><td>${v}</td></tr>`).join('')}</table>
      ${saved?.context?.severity != null ? `<p class="muted">Passive reading at the time: severity ${saved.context.severity}.</p>` : ''}
      <div class="modal-actions"><button class="btn" data-act="again">Do it again</button><button class="btn primary" data-act="close">Done</button></div>`);
  }
}
