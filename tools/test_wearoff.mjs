// Tests for the personal wearing-off model (dashboard/js/wearoff.js).
//   node tools/test_wearoff.mjs
import { kaplanMeier, kmQuantile, learnModel, predict, backtest, outcomes, BandWearOffMonitor, slotOf } from '../dashboard/js/wearoff.js';

let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL', msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- 1. Kaplan-Meier against the textbook example (Freireich 6-MP leukaemia trial) ----
console.log('Kaplan-Meier matches the textbook 6-MP example');
{
  const events = [6, 6, 6, 7, 10, 13, 16, 22, 23];
  const censored = [6, 9, 10, 11, 17, 19, 20, 25, 32, 32, 34, 35];
  const curve = kaplanMeier([...events.map((t) => ({ t, event: true })), ...censored.map((t) => ({ t, event: false }))]);
  const S = (t) => curve.filter((s) => s.t <= t).at(-1).S;
  check(near(S(6), 0.857, 0.001), `S(6)=${S(6)}`);
  check(near(S(7), 0.807, 0.001), `S(7)=${S(7)}`);
  check(near(S(13), 0.690, 0.001), `S(13)=${S(13)}`);
  check(near(S(23), 0.448, 0.001), `S(23)=${S(23)}`);
  check(kmQuantile(curve, 0.5) === 23, `median ${kmQuantile(curve, 0.5)}`);
  console.log(`  S(6)=${S(6).toFixed(3)} S(23)=${S(23).toFixed(3)} median=${kmQuantile(curve, 0.5)} (textbook: 0.857, 0.448, 23)`);
}

// ---- synthetic patient: doses at 8/12/16/20 h, band worn 07-23 h ----
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function patient({ days = 14, durationOf, kickIn = 35, seed = 1, skip16 = 0.2 }) {
  const r = rng(seed);
  const day0 = new Date(2026, 8, 1).getTime();
  const doses = [], epochs = [], truth = [];
  for (let d = 0; d < days; d++) {
    const base = day0 + d * 86400e3;
    for (const h of [8, 12, 16, 20]) {
      if (h === 16 && r() < skip16) continue;
      const t = base + h * 3600e3 + Math.round((r() - 0.5) * 30) * 60e3;
      doses.push({ id: `app-${t}`, t, source: 'app' });
      truth.push({ t, dur: durationOf(t, r) });
    }
    for (let t = base + 7 * 3600e3; t < base + 23 * 3600e3; t += 30e3) {
      const last = truth.filter((x) => x.t <= t).at(-1);
      const m = last ? (t - last.t) / 60e3 : 1e9;
      const prevOff = !last || m > last.dur || m < kickIn * 0.5 && (truth.filter((x) => x.t < last.t).at(-1)?.dur ?? 0) < (last.t - (truth.filter((x) => x.t < last.t).at(-1)?.t ?? 0)) / 60e3;
      const tremor = !last || m > last.dur || (m < kickIn && prevOff);
      epochs.push({ t, sevMean: tremor ? 2 + r() * 0.4 : r() * 0.1, sevMax: tremor ? 3 : 0, tremorPct: tremor ? 80 : 2, nWindows: 30, ampCm: tremor ? 2.5 : 0 });
    }
  }
  return { doses, epochs, truth, end: day0 + days * 86400e3 };
}

// ---- 2. learns the typical duration ----
console.log('Learns how long a dose lasts (true 165 +- 15 min)');
{
  const P = patient({ durationOf: (t, r) => 165 + (r() - 0.5) * 30 });
  const m = learnModel(P.epochs, P.doses, { now: P.end });
  console.log(`  doses used ${m.overall.n} (${m.overall.events} returns, ${m.overall.censored} censored), typical ${m.overall.typicalMin} min, warn after ${m.overall.warnAfterMin} min, works after ${m.overall.kickInMin} min`);
  check(m.ok, 'model not ok');
  // the "returned" rule needs 20 min of tremor-averaging to trip, so detection lags truth a little
  check(near(m.overall.typicalMin, 175, 20), `typical ${m.overall.typicalMin}`);
  check(m.overall.warnAfterMin < m.overall.typicalMin, 'warn must precede typical return');
  check(m.overall.censored > 0, 'expected some censored doses (tremor not back before next dose)');
}

// ---- 3. censoring matters: naive mean of returns only would be biased short ----
console.log('Censoring: long-lasting doses are not ignored');
{
  // 70% of doses last 300 min (beyond the next dose 4 h later -> censored), 30% wear off at 150
  const P = patient({ durationOf: (t, r) => (r() < 0.7 ? 300 : 150), skip16: 0 });
  const m = learnModel(P.epochs, P.doses, { now: P.end });
  const o = outcomes(P.epochs, P.doses, P.end).filter((x) => x.wearOffMin != null);
  const naive = o.reduce((a, x) => a + x.wearOffMin, 0) / o.length;
  console.log(`  KM: lasts at least ${m.overall.typicalMin} min (median not reached), warn after ${m.overall.warnAfterMin} min; naive mean of observed returns ${naive.toFixed(0)} min`);
  check(m.overall.typicalMin > naive + 20, 'KM should not be dragged down to the observed-returns mean');
  check(m.overall.medianReached === false, 'most doses outlast the next one: median not reached');
  check(near(m.overall.warnAfterMin, 160, 25), `warn should target the early-wearing doses, got ${m.overall.warnAfterMin}`);
}

// ---- 4. time-of-day slots ----
console.log('Different duration by time of day (morning 220 min, rest 150 min)');
{
  const P = patient({ days: 21, durationOf: (t, r) => (new Date(t).getHours() < 11 ? 220 : 150) + (r() - 0.5) * 20, skip16: 0 });
  const m = learnModel(P.epochs, P.doses, { now: P.end });
  const morning = predict(m, new Date(2026, 8, 30, 8).getTime());
  const midday = predict(m, new Date(2026, 8, 30, 12).getTime());
  console.log(`  morning dose -> ${morning.typicalMin} min (slot-specific ${morning.slotSpecific}), midday -> ${midday.typicalMin} min`);
  check(morning.slotSpecific && midday.slotSpecific, 'slot models expected');
  check(morning.typicalMin > midday.typicalMin + 40, 'morning should last longer');
}

// ---- 5. backtest: learned model vs fixed 3-hour rule ----
console.log('Backtest (each dose predicted only from earlier doses)');
{
  const P = patient({ days: 21, durationOf: (t, r) => 140 + (r() - 0.5) * 30, seed: 7 });
  const b = backtest(P.epochs, P.doses, P.end);
  const L = b.learned, F = b.fixedRule;
  console.log(`  learned: error ${L.maeMin} min, warned before return ${L.warnedPct}%, lead ${L.medianLeadMin} min, unneeded ${L.unneededPct}%`);
  console.log(`  fixed ${b.fixedRuleMin} min rule: error ${F.maeMin} min, warned before return ${F.warnedPct}%`);
  check(L.doses >= 40, `backtest doses ${L.doses}`);
  check(L.maeMin < F.maeMin, 'learned model should beat the fixed rule on error');
  check(L.warnedPct >= 70, `warned ${L.warnedPct}%`);
  check(L.warnedPct > F.warnedPct, 'learned should warn in time more often than the fixed rule');
}

// ---- 6. too little data -> no prediction ----
{
  const P = patient({ days: 1, durationOf: () => 160 });
  check(!learnModel(P.epochs, P.doses.slice(0, 2), { now: P.end }).ok, 'should not predict from two doses');
}

// ---- 7. JS band monitor behaves like the firmware (same scenarios as test_dsp.cpp) ----
console.log('Demo-band monitor matches the firmware rules');
{
  const run = (m, from, to, tremorAt) => {
    for (let s = from * 60; s < to * 60; s++) { m.onWindow(s * 1000, tremorAt(s / 60)); const r = m.tick(s * 1000); if (r) return [Math.floor(s / 60), r]; }
    return [-1, null];
  };
  let m = new BandWearOffMonitor(); m.setModel(150, 170); m.onDose(0);
  let [at, r] = run(m, 0, 300, () => false);
  check(at === 150 && r === 'time', `time alert ${at} ${r}`);
  m = new BandWearOffMonitor(); m.setModel(150, 170); m.onDose(0);
  [at, r] = run(m, 0, 300, (min) => min >= 90);
  check(r === 'early' && at >= 94 && at <= 96, `early alert ${at} ${r}`);
  m = new BandWearOffMonitor(); m.onDose(0);
  [at] = run(m, 0, 200, (min) => min < 30);
  check(at === -1, `false alert during kick-in ${at}`);
  console.log('  time alert at 150 min, early alert ~95 min, none during kick-in (same as firmware)');
}

check(slotOf(new Date(2026, 0, 1, 10, 59).getTime()) === 'morning' && slotOf(new Date(2026, 0, 1, 19).getTime()) === 'evening', 'slots');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
