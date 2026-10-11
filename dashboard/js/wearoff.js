// Personal wearing-off model: how long does a dose last for THIS patient, and when
// should we warn that it is about to wear off?
//
// For every past dose we know (from the band's 30-s records, see report.js wearOff):
//   * when it started working (tremor settled), and
//   * when tremor came back - or that it had NOT come back by the next dose.
// The second kind is a censored observation ("lasted at least this long"). Dropping or
// treating it as a return would bias the estimate, so we use the Kaplan-Meier estimator,
// the standard tool for time-to-event data with censoring.
//   typical return  = KM median time to tremor returning
//   warn after      = KM 25th percentile (by then 1 in 4 doses has worn off), kept at
//                     least 15 min after the dose usually starts working
// Wear-off often differs by time of day (meals, sleep, dose size), so each time-of-day
// slot gets its own estimate once it has enough doses.
import { wearOff as doseOutcomes } from './report.js';

export const SLOTS = [
  { id: 'morning', label: 'Morning doses (before 11:00)', from: 0, to: 11 },
  { id: 'midday', label: 'Midday doses (11:00–15:00)', from: 11, to: 15 },
  { id: 'afternoon', label: 'Afternoon doses (15:00–19:00)', from: 15, to: 19 },
  { id: 'evening', label: 'Evening doses (after 19:00)', from: 19, to: 24 },
];
export const slotOf = (t) => { const h = new Date(t).getHours(); return SLOTS.find((s) => h >= s.from && h < s.to).id; };

const MIN_DOSES = 4;        // observations needed before we predict at all
const MIN_EVENTS = 2;       // ...of which tremor actually came back
const MIN_SLOT_DOSES = 4;   // a time-of-day slot needs this many to override the overall estimate
const HISTORY_DAYS = 21;
const FIXED_RULE_MIN = 180; // naive comparison: "every dose lasts 3 hours"

// ---- Kaplan-Meier ----
// obs: [{t: minutes, event: true (tremor returned) | false (censored: next dose came first)}]
// returns the survival curve as steps [{t, S}] where S = P(dose still working after t min)
export function kaplanMeier(obs) {
  const sorted = [...obs].sort((a, b) => a.t - b.t || (b.event - a.event));  // events before censorings at ties
  let atRisk = sorted.length, S = 1;
  const curve = [{ t: 0, S: 1 }];
  for (let i = 0; i < sorted.length;) {
    const t = sorted[i].t;
    let d = 0, c = 0;
    while (i < sorted.length && sorted[i].t === t) { sorted[i].event ? d++ : c++; i++; }
    if (d) { S *= 1 - d / atRisk; curve.push({ t, S }); }
    atRisk -= d + c;
  }
  return curve;
}

// time by which a fraction p of doses has worn off (p = 0.5 -> median); null if never reached
export function kmQuantile(curve, p) {
  const step = curve.find((s) => s.S <= 1 - p + 1e-9);
  return step ? step.t : null;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function estimate(outcomes) {
  const obs = outcomes.map((o) => ({ t: o.wearOffMin ?? o.censorMin, event: o.wearOffMin != null }));
  const events = obs.filter((o) => o.event).length;
  if (obs.length < MIN_DOSES || events < MIN_EVENTS) return { n: obs.length, events, ok: false };
  const curve = kaplanMeier(obs);
  const kickInMin = median(outcomes.map((o) => o.onsetMin).filter((v) => v != null)) ?? 30;
  let typicalMin = kmQuantile(curve, 0.5);
  const q25 = kmQuantile(curve, 0.25), q75 = kmQuantile(curve, 0.75);
  // median not reached = most doses lasted until the next one: report "at least" the longest
  // time we watched a dose (UI shows this as a lower bound)
  const medianReached = typicalMin != null;
  if (!medianReached) typicalMin = Math.max(...obs.map((o) => o.t));
  let warnAfterMin = q25 ?? typicalMin - 20;
  warnAfterMin = Math.max(Math.round(kickInMin + 15), Math.min(warnAfterMin, typicalMin - 10));
  return {
    ok: true, n: obs.length, events, censored: obs.length - events, medianReached,
    typicalMin: Math.round(typicalMin), warnAfterMin: Math.round(warnAfterMin), kickInMin: Math.round(kickInMin),
    earliestMin: q25 != null ? Math.round(q25) : null, latestMin: q75 != null ? Math.round(q75) : null, curve,
  };
}

// Per-dose outcomes. When tremor did not come back, censorMin = how long the dose was
// actually WATCHED without it coming back: up to the next dose, but never past the last
// record the band produced (band taken off at night) or `now` (dose still in progress).
export function outcomes(epochs, doses, now = Date.now()) {
  const ts = epochs.filter((e) => e.t > 0 && e.t <= now).map((e) => e.t).sort((a, b) => a - b);
  const lastBefore = (t) => {  // last record time <= t (binary search)
    let lo = 0, hi = ts.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { best = ts[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  };
  return doseOutcomes(epochs.filter((e) => e.t <= now), doses.filter((d) => d.t <= now)).map((o) => {
    const end = Math.min(o.untilNextMin != null ? o.dose + o.untilNextMin * 60e3 : o.dose + 360 * 60e3, now);
    const last = lastBefore(end);
    return { ...o, censorMin: Math.max(0, Math.round(((last ?? o.dose) - o.dose) / 60e3)) };
  });
}

// Build the model from outcomes known at time `now`. Doses that never seemed to take
// effect (onset null) can't tell us when they wore off; they're counted separately.
function fromOutcomes(all, now) {
  const recent = all.filter((o) => o.dose >= now - HISTORY_DAYS * 86400e3 && o.dose <= now - 30 * 60e3);
  const use = recent.filter((o) => o.onsetMin != null);
  const overall = estimate(use);
  const slots = {};
  for (const s of SLOTS) {
    const e = estimate(use.filter((o) => slotOf(o.dose) === s.id));
    if (e.ok && e.n >= MIN_SLOT_DOSES) slots[s.id] = e;
  }
  return { ok: overall.ok, overall, slots, noEffect: recent.length - use.length, observed: recent.length };
}

// Learn from epochs + doses. Returns {ok, overall, slots: {id: estimate}, noEffect, observed}.
export function learnModel(epochs, doses, { now = Date.now() } = {}) {
  return fromOutcomes(outcomes(epochs, doses, now), now);
}

// What to expect after a dose taken at doseT.
export function predict(model, doseT) {
  if (!model?.ok) return null;
  const slot = slotOf(doseT);
  const e = model.slots[slot] ?? model.overall;
  return {
    slot, slotSpecific: !!model.slots[slot],
    typicalMin: e.typicalMin, warnAfterMin: e.warnAfterMin, kickInMin: e.kickInMin,
    returnAt: doseT + e.typicalMin * 60e3, warnAt: doseT + e.warnAfterMin * 60e3,
    worksAt: doseT + e.kickInMin * 60e3,
  };
}

// Honest evaluation: walk through history in time order and predict each dose using
// ONLY what was known when it was taken (earlier doses, whose outcomes all end by the
// time of this dose), then compare with what actually happened.
export function backtest(epochs, doses, now = Date.now()) {
  const all = outcomes(epochs, doses, now).sort((a, b) => a.dose - b.dose);
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    const o = all[i];
    if (o.onsetMin == null) continue;
    const p = predict(fromOutcomes(all.slice(0, i), o.dose), o.dose);
    if (!p) continue;
    rows.push({ dose: o.dose, returned: o.wearOffMin != null, actualMin: o.wearOffMin, censorMin: o.censorMin,
      predictedMin: p.typicalMin, warnMin: p.warnAfterMin });
  }
  const score = (warnOf, predOf) => {
    const ret = rows.filter((r) => r.returned);
    const cen = rows.filter((r) => !r.returned);
    const warned = ret.filter((r) => warnOf(r) <= r.actualMin);
    return {
      doses: rows.length,
      returns: ret.length,
      maeMin: ret.length ? Math.round(ret.reduce((a, r) => a + Math.abs(predOf(r) - r.actualMin), 0) / ret.length) : null,
      warnedPct: ret.length ? Math.round((100 * warned.length) / ret.length) : null,
      medianLeadMin: warned.length ? Math.round(median(warned.map((r) => r.actualMin - warnOf(r)))) : null,
      // warned although tremor did not come back before the next dose
      unneededPct: cen.length ? Math.round((100 * cen.filter((r) => warnOf(r) < r.censorMin).length) / cen.length) : null,
    };
  };
  return {
    rows,
    learned: score((r) => r.warnMin, (r) => r.predictedMin),
    fixedRule: score(() => FIXED_RULE_MIN - 20, () => FIXED_RULE_MIN),
    fixedRuleMin: FIXED_RULE_MIN,
  };
}

// JS twin of firmware/src/dsp/wearoff.cpp, used by the demo band so the demo behaves
// like real hardware (same rules, same numbers).
export class BandWearOffMonitor {
  constructor() { this.warnAfter = 0; this.typical = 0; this.dose = null; this.alerted = false; this.active = null; this.minutes = new Map(); }
  setModel(warnAfter, typical) { this.warnAfter = warnAfter; this.typical = typical; }
  onDose(t) { if (this.dose != null && t <= this.dose) return; this.dose = t; this.alerted = false; this.active = null; }
  onWindow(t, tremor) {
    const m = Math.floor(t / 60e3);
    const b = this.minutes.get(m) ?? { seen: 0, trem: 0 };
    b.seen++; if (tremor) b.trem++;
    this.minutes.set(m, b);
    for (const k of this.minutes.keys()) if (k < m - 30) this.minutes.delete(k);
  }
  recentFraction(t) {
    const m = Math.floor(t / 60e3);
    let seen = 0, trem = 0;
    for (let k = m - 9; k <= m; k++) { const b = this.minutes.get(k); if (b) { seen += b.seen; trem += b.trem; } }
    return seen >= 360 ? trem / seen : 0;
  }
  tick(t) {
    if (this.active && t - this.activeSince >= 30 * 60e3) this.active = null;
    if (this.dose == null || this.alerted) return null;
    const since = (t - this.dose) / 60e3;
    let start = null;
    if (since >= 45 && this.recentFraction(t) >= 0.5) start = 'early';
    else if (this.warnAfter > 0 && since >= this.warnAfter && since < Math.min(360, Math.max(this.typical, this.warnAfter) + 30)) start = 'time';
    if (start) { this.alerted = true; this.active = start; this.activeSince = t; }
    return start;
  }
  dismiss() { this.active = null; }
}
