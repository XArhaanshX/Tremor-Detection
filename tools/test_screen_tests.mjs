// Checks the pure metric functions of the on-screen tests with synthetic input.
// Usage: node tools/test_screen_tests.mjs
import {
  TESTS, byId, headline, detailRows,
  spiralGeometry, spiralMetrics, reactionMetrics, trackingPath, trackingMetrics, singleTapMetrics, MIN_RT_MS,
} from '../dashboard/js/tests.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
const TAU = 2 * Math.PI;

// Deterministic pseudo-random numbers so failures are reproducible.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

// ---- spiral ----
const sp = spiralGeometry(500);
const total = TAU * sp.turns;
const loop = TAU * sp.b;

// Trace the spiral over `secs` seconds with irregular ~100 Hz pointer samples.
// radial(tSec) adds a radial offset in px; upTo is the fraction of the spiral traced.
function spiralTrace({ secs = 20, radial = () => 0, upTo = 1, strokeEvery = 0 } = {}) {
  const out = [];
  for (let t = 0; t <= secs * 1000; t += 7 + 6 * rand()) {
    const u = t / (secs * 1000);
    const th = total * upTo * (u * u * (3 - 2 * u) * 0.3 + u * 0.7);  // speed varies a bit
    const r = sp.a + sp.b * th + radial(t / 1000);
    out.push({ t, x: sp.cx + r * Math.cos(th), y: sp.cy + r * Math.sin(th), stroke: strokeEvery ? Math.floor(t / strokeEvery) : 0 });
  }
  return out;
}

const perfect = spiralMetrics(spiralTrace(), sp);
check('spiral perfect: meanErrorPct < 2', perfect.meanErrorPct < 2, perfect.meanErrorPct);
check('spiral perfect: wobblePct < 2', perfect.wobblePct < 2, perfect.wobblePct);
check('spiral perfect: coverage ≈ 100%', near(perfect.coveragePct, 100, 1), perfect.coveragePct);
check('spiral perfect: durationS ≈ 20', near(perfect.durationS, 20, 0.1), perfect.durationS);
check('spiral perfect: speed ≈ 3 loops / 20 s', near(perfect.speedLoopsPerS, 0.15, 0.005), perfect.speedLoopsPerS);
check('spiral perfect: no wobble frequency', perfect.wobbleHz === null, perfect.wobbleHz);

const shaky = spiralMetrics(spiralTrace({ radial: (s) => 0.15 * loop * Math.sin(TAU * 6 * s) }), sp);
check('spiral 6 Hz wobble: wobbleHz ≈ 6', near(shaky.wobbleHz, 6, 0.5), shaky.wobbleHz);
check('spiral 6 Hz wobble: wobblePct ≈ 10.6 (RMS of 15%)', near(shaky.wobblePct, 15 / Math.SQRT2, 1.5), shaky.wobblePct);
check('spiral 6 Hz wobble: wobblePct clearly above perfect', shaky.wobblePct > perfect.wobblePct + 5, `${shaky.wobblePct} vs ${perfect.wobblePct}`);

const shaky4 = spiralMetrics(spiralTrace({ radial: (s) => 0.1 * loop * Math.sin(TAU * 4.5 * s) }), sp);
check('spiral 4.5 Hz wobble: wobbleHz ≈ 4.5', near(shaky4.wobbleHz, 4.5, 0.5), shaky4.wobbleHz);

// A steady offset (drawing 20% of a loop inside the line) is error, not wobble.
const offset = spiralMetrics(spiralTrace({ radial: () => -0.2 * loop }), sp);
check('spiral offset: meanErrorPct ≈ 20', near(offset.meanErrorPct, 20, 1), offset.meanErrorPct);
check('spiral offset: wobblePct < 2', offset.wobblePct < 2, offset.wobblePct);

// Slow drift (0.3 Hz, 30% of a loop) is mostly removed by the high-pass.
const drift = spiralMetrics(spiralTrace({ radial: (s) => 0.3 * loop * Math.sin(TAU * 0.3 * s) }), sp);
check('spiral slow drift: wobblePct < 3', drift.wobblePct < 3, drift.wobblePct);

const half = spiralMetrics(spiralTrace({ upTo: 0.5, secs: 10 }), sp);
check('spiral half traced: coverage ≈ 50%', near(half.coveragePct, 50, 1.5), half.coveragePct);

// Lifting the finger every 2 s must not confuse the loop counting.
const lifted = spiralMetrics(spiralTrace({ strokeEvery: 2000 }), sp);
check('spiral with lifts: coverage ≈ 100%', near(lifted.coveragePct, 100, 1), lifted.coveragePct);
check('spiral with lifts: meanErrorPct < 2', lifted.meanErrorPct < 2, lifted.meanErrorPct);

// Straying more than half a loop off the line must still count against the right loop.
const wide = spiralMetrics(spiralTrace({ radial: (s) => (s > 8 && s < 10 ? 0.7 * loop : 0) }), sp);
check('spiral far off the line: coverage still ≈ 100%', near(wide.coveragePct, 100, 1), wide.coveragePct);
check('spiral far off the line: error reflects the stray (≈ 7%)', near(wide.meanErrorPct, 7, 1.5), wide.meanErrorPct);

// Size independence: same trace on a smaller screen gives the same percentages.
const sp2 = spiralGeometry(300);
const scaled = spiralMetrics(spiralTrace({ radial: (s) => 0.15 * loop * Math.sin(TAU * 6 * s) }).map((p) => ({
  ...p, x: sp2.cx + (p.x - sp.cx) * 0.6, y: sp2.cy + (p.y - sp.cy) * 0.6,
})), sp2);
check('spiral size-independent wobble', near(scaled.wobblePct, shaky.wobblePct, 0.3), `${scaled.wobblePct} vs ${shaky.wobblePct}`);

const short = spiralMetrics(spiralTrace({ secs: 1.5, upTo: 0.2 }), sp);
check('spiral < 2 s: wobbleHz null', short.wobbleHz === null, short.wobbleHz);
const empty = spiralMetrics([], sp);
check('spiral empty: zeros', empty.coveragePct === 0 && empty.wobbleHz === null);

// ---- reaction ----
const rx = reactionMetrics([
  { rtMs: 300, falseStart: false }, { rtMs: 400, falseStart: false }, { rtMs: null, falseStart: true },
  { rtMs: 350, falseStart: false }, { rtMs: 50, falseStart: false }, { rtMs: 500, falseStart: false },
]);
check('reaction mean', rx.meanMs === 387.5, rx.meanMs);
check('reaction median (even n)', rx.medianMs === 375, rx.medianMs);
check('reaction fastest/slowest', rx.fastestMs === 300 && rx.slowestMs === 500);
check('reaction falseStarts (incl. < 100 ms)', rx.falseStarts === 2, rx.falseStarts);
check('reaction n', rx.n === 4, rx.n);
check('reaction sample SD', near(rx.sdMs, Math.sqrt(21875 / 3), 1e-9), rx.sdMs);
const rxOdd = reactionMetrics([250, 310, 270, 900, 280].map((rtMs) => ({ rtMs, falseStart: false })));
check('reaction median (odd n)', rxOdd.medianMs === 280, rxOdd.medianMs);
check('reaction mean (odd n)', rxOdd.meanMs === 402, rxOdd.meanMs);
check('reaction exactly 100 ms counts', reactionMetrics([{ rtMs: MIN_RT_MS, falseStart: false }]).n === 1);
const rxNone = reactionMetrics([{ rtMs: null, falseStart: true }]);
check('reaction no valid rounds → nulls', rxNone.n === 0 && rxNone.medianMs === null && rxNone.falseStarts === 1);

// ---- follow the dot ----
const W = 500, H = 400, RAD = 28;
const path = trackingPath(W, H, RAD, 20);
let peak = 0;
for (let s = 0.01; s <= 20; s += 0.01) {
  const a = path(s - 0.01), b = path(s);
  peak = Math.max(peak, Math.hypot(b.x - a.x, b.y - a.y) / 0.01);
}
check('tracking path: peak speed ≤ width per 3 s', peak <= (W / 3) * 1.01, `${peak.toFixed(1)} px/s`);
let inside = true;
for (let s = 0; s <= 20; s += 0.05) {
  const p = path(s);
  if (p.x < RAD || p.x > W - RAD || p.y < RAD || p.y > H - RAD) inside = false;
}
check('tracking path: dot stays inside the canvas', inside);

function trackTrace({ delayMs = 0, offset = [0, 0], liftedFrom = Infinity, jitter = 0 } = {}) {
  const out = [];
  for (let t = 0; t <= 20000; t += 1000 / 60) {
    const tp = path(t / 1000), fp = path(Math.max(0, t - delayMs) / 1000);
    out.push({
      t, tx: tp.x, ty: tp.y,
      fx: fp.x + offset[0] + jitter * (rand() - 0.5), fy: fp.y + offset[1] + jitter * (rand() - 0.5), down: t < liftedFrom,
    });
  }
  return out;
}
const tPerfect = trackingMetrics(trackTrace(), RAD);
check('tracking perfect: onTargetPct ≈ 100', near(tPerfect.onTargetPct, 100, 0.01), tPerfect.onTargetPct);
check('tracking perfect: lag ≈ 0', near(tPerfect.lagMs, 0, 16), tPerfect.lagMs);
check('tracking perfect: error 0, lifted 0', tPerfect.meanErrorPx < 1e-9 && tPerfect.liftedPct === 0);

const tLag = trackingMetrics(trackTrace({ delayMs: 200 }), RAD);
check('tracking 200 ms behind: lag ≈ 200', near(tLag.lagMs, 200, 40), tLag.lagMs);
const tLagOff = trackingMetrics(trackTrace({ delayMs: 350, offset: [15, -10], jitter: 12 }), RAD);
check('tracking 350 ms behind + offset + jitter: lag ≈ 350', near(tLagOff.lagMs, 350, 40), tLagOff.lagMs);
check('tracking error in radii consistent', near(tLagOff.meanErrorRadii, tLagOff.meanErrorPx / RAD, 1e-9));

const tHalf = trackingMetrics(trackTrace({ liftedFrom: 10000 }), RAD);
check('tracking lifted half: liftedPct ≈ 50', near(tHalf.liftedPct, 50, 0.5), tHalf.liftedPct);
check('tracking lifted half: onTargetPct ≈ 50', near(tHalf.onTargetPct, 50, 0.5), tHalf.onTargetPct);
const tNone = trackingMetrics(trackTrace({ liftedFrom: 0 }), RAD);
check('tracking never touched: nulls', tNone.meanErrorPx === null && tNone.lagMs === null && tNone.onTargetPct === 0);

// ---- one-finger tapping, each hand ----
const taps = (perSec, secs = 10) => {
  const out = [];
  for (let t = 0; t < secs * 1000; t += 1000 / perSec) out.push({ t, target: 'T' });
  return out;
};
const st = singleTapMetrics(taps(6), taps(4), 10);
check('singletap rates 6 / 4', near(st.right.rate, 6, 0.01) && near(st.left.rate, 4, 0.01), `${st.right.rate} / ${st.left.rate}`);
check('singletap asymmetry ≈ 33%', near(st.asymmetryPct, 33.3, 0.5), st.asymmetryPct);
check('singletap regular rhythm: cv ≈ 0', st.right.cvPct < 1 && st.left.cvPct < 1);
check('singletap misses not counted', singleTapMetrics([...taps(5), { t: 500, target: null }], taps(5), 10).right.taps === 50);
const stL = singleTapMetrics(taps(4), taps(6), 10);
check('singletap left faster → negative', near(stL.asymmetryPct, -33.3, 0.5), stL.asymmetryPct);
check('singletap no taps → 0', singleTapMetrics([], [], 10).asymmetryPct === 0);

// ---- registry, headline and detail rows ----
for (const id of ['spiral', 'reaction', 'tracking', 'singletap']) {
  const t = byId(id);
  check(`TESTS has ${id} (screen)`, t && t.where === 'screen' && t.seconds > 0 && t.steps.length > 0);
}
check('TESTS ids unique', new Set(TESTS.map((t) => t.id)).size === TESTS.length);
const samplesByKind = { spiral: [shaky, empty, short], reaction: [rx, rxNone], tracking: [tLag, tNone], singletap: [st, stL] };
for (const [kind, list] of Object.entries(samplesByKind)) {
  for (const r of list) {
    let ok = true, why = '';
    try {
      const h = headline(kind, r);
      const rows = detailRows(kind, r);
      ok = typeof h.text === 'string' && !/undefined|NaN/.test(h.text) && typeof h.unit === 'string'
        && (h.value == null || Number.isFinite(h.value))
        && rows.length > 0 && rows.every(([k, v]) => k && v !== undefined && !/undefined|NaN/.test(String(v)));
      why = `${h.text} | ${rows.map((x) => x[1]).join(', ')}`;
    } catch (e) { ok = false; why = e.message; }
    check(`headline/detailRows ${kind}`, ok, why);
  }
}
check('spiral headline', headline('spiral', shaky).value === shaky.wobblePct && headline('spiral', shaky).unit === '% wobble');
check('reaction headline', headline('reaction', rx).text === 'Median 375 ms');
check('singletap headline', headline('singletap', st).text === 'R 6.0/s · L 4.0/s' && near(headline('singletap', stL).value, 33.3, 0.5));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
