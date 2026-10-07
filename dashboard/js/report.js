// Turning 30-s epochs into things a patient or neurologist can read.

export const DAY_MS = 86400000;
export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Totals for a set of epochs (time with tremor is weighted by analysed windows).
export function summarize(epochs) {
  const valid = epochs.filter((e) => e.t > 0);
  if (!valid.length) return null;
  let win = 0, trem = 0, sev = 0, max = 0, peakT = null, ampSum = 0, ampN = 0;
  for (const e of valid) {
    win += e.nWindows;
    trem += (e.tremorPct / 100) * e.nWindows;
    sev += e.sevMean * e.nWindows;
    if (e.sevMax > max || (e.sevMax === max && peakT === null)) { max = e.sevMax; peakT = e.t; }
    if (e.ampCm > 0) { ampSum += e.ampCm; ampN++; }
  }
  return {
    monitoredMin: (valid.length * 30) / 60,
    tremorPct: win ? (100 * trem) / win : 0,
    meanSev: win ? sev / win : 0,
    maxSev: max,
    peakT: max > 0 ? peakT : null,
    meanAmpCm: ampN ? ampSum / ampN : 0,
  };
}

// Group epochs into fixed bins (e.g. 10 minutes) for the day timeline.
export function bin(epochs, from, binMs) {
  const bins = new Map();
  for (const e of epochs) {
    if (e.t < 0) continue;
    const k = from + Math.floor((e.t - 30000 - from) / binMs) * binMs;  // e.t is the epoch END
    let b = bins.get(k);
    if (!b) bins.set(k, (b = { x: k, n: 0, sev: 0, max: 0, trem: 0, amp: 0, ampN: 0, act: 0 }));
    b.n++;
    b.sev += e.sevMean;
    b.trem += e.tremorPct;
    b.act += e.activityMg;
    b.max = Math.max(b.max, e.sevMax);
    if (e.ampCm > 0) { b.amp += e.ampCm; b.ampN++; }
  }
  return [...bins.values()].sort((a, b) => a.x - b.x).map((b) => ({
    x: b.x, y: b.sev / b.n, max: b.max, tremorPct: b.trem / b.n, ampCm: b.ampN ? b.amp / b.ampN : 0,
    activityMg: b.act / b.n, minutes: (b.n * 30) / 60,
  }));
}

// Average severity for each hour of the day across a date range — "the usual day".
export function hourlyPattern(epochs) {
  const h = Array.from({ length: 24 }, () => ({ sev: 0, n: 0, trem: 0 }));
  for (const e of epochs) {
    if (e.t < 0) continue;
    const b = h[new Date(e.t - 30000).getHours()];
    b.sev += e.sevMean;
    b.trem += e.tremorPct;
    b.n++;
  }
  return h.map((b, hour) => ({ x: hour, y: b.n ? b.sev / b.n : null, tremorPct: b.n ? b.trem / b.n : null, hours: b.n / 120 }));
}

// For each dose: when did it start working, and when did tremor come back?
// "Working" = 20-min rolling severity < 0.5; "worn off" = rolling severity >= 1.
export function wearOff(epochs, doses) {
  const ep = epochs.filter((e) => e.t > 0).sort((a, b) => a.t - b.t);
  const ds = [...doses].sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i].t;
    const next = i + 1 < ds.length ? ds[i + 1].t : d + 6 * 3600e3;
    const win = ep.filter((e) => e.t > d && e.t <= next);
    if (win.length < 20) continue;  // not enough wear time after this dose
    let onset = null, off = null, lo = 0, sum = 0;
    for (let j = 0; j < win.length; j++) {
      sum += win[j].sevMean;  // sliding 20-min window
      while (win[lo].t <= win[j].t - 20 * 60e3) sum -= win[lo++].sevMean;
      const avg = sum / (j - lo + 1);
      if (onset == null && avg < 0.5 && win[j].t - d >= 10 * 60e3) onset = win[j].t;
      if (onset != null && avg >= 1 && win[j].t - onset > 20 * 60e3) { off = win[j].t; break; }
    }
    out.push({
      dose: d,
      onsetMin: onset ? Math.round((onset - d) / 60e3) : null,
      wearOffMin: off ? Math.round((off - d) / 60e3) : null,
      untilNextMin: i + 1 < ds.length ? Math.round((next - d) / 60e3) : null,
    });
  }
  return out;
}

export const fmtDuration = (min) => {
  if (min == null) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} min`;
};

// ---- CSV export ----
function csv(rows, cols) {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(typeof c === 'function' ? c(r) : r[c])).join(','))].join('\n');
}

export function epochsCsv(epochs) {
  const rows = epochs.filter((e) => e.t > 0).sort((a, b) => a.t - b.t).map((e) => ({
    time: new Date(e.t).toISOString(), ...e, button: e.flags & 2 ? 1 : 0, demo: e.flags & 16 ? 1 : 0,
  }));
  return csv(rows, ['time', 'sevMean', 'sevMax', 'tremorPct', 'freqHz', 'ampCm', 'ampMaxCm', 'activityMg', 'nWindows', 'button', 'demo', 'seq']);
}

export function dosesCsv(doses) {
  return csv(doses.map((d) => ({ time: new Date(d.t).toISOString(), source: d.source })), ['time', 'source']);
}

export function testsCsv(tests) {
  const keys = [...new Set(tests.flatMap((t) => Object.keys(t.result)))].filter((k) => !['type', 'state'].includes(k));
  const rows = tests.map((t) => ({ time: new Date(t.t).toISOString(), test: t.kind, passiveSeverity: t.context?.severity, ...t.result }));
  return csv(rows, ['time', 'test', 'passiveSeverity', ...keys]);
}

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
