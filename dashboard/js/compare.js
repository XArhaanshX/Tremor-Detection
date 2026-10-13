// "Algorithms" tab: our detector vs published approaches, on real patients (PADS summary,
// computed by tools/eval_pads.py with the firmware's own C++) and on a simulated benchmark
// with ground truth (bench.js, run here with the JS port of the same detector).
import { ALGORITHMS, analyzeRecording, decide } from './dsp.js';
import { SCENARIOS, runBenchmark, parseRecording } from './bench.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const f1 = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));
const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : `${v.toFixed(d)}%`);
const swatch = (a) => `<span class="algo-sw" style="background:var(${a.color})" aria-hidden="true"></span>`;
const SVGNS = 'http://www.w3.org/2000/svg';

let summary = null, bench = null, rendered = false;

// ---------------------------------------------------------------- frequency map
// One shared 0-10 Hz axis: how often real Parkinson's tremor sits at each frequency (top),
// the band each detector listens to, and where its detections on real patients landed.
function frequencyMap(host, S) {
  const W = Math.max(560, Math.round(host.clientWidth || 760));
  const narrow = W < 700;
  const left = narrow ? 168 : 214, right = narrow ? 104 : 140, plotW = W - left - right;
  const histH = 120, rowH = 40, top = 14;
  const fMax = 10;
  const x = (f) => left + (f / fMax) * plotW;
  const rows = [
    { kind: 'ref', label: 'Everyday arm movement', sub: 'healthy people, moving tasks', q: S.observed.hcMoving },
    { kind: 'ref', label: 'Parkinson\'s rest tremor', sub: 'tremor-dominant patients at rest', q: S.observed.tdRest, strong: true },
    ...ALGORITHMS.map((a) => ({ kind: 'alg', a, s: S.algorithms[a.id] })),
  ];
  const H = top + histH + 28 + rows.length * rowH + 50;
  const td = S.observed.tdRest;
  const total = td.hist.reduce((p, c) => p + c, 0) || 1;
  const maxShare = Math.max(...td.hist) / total;
  const bins = S.bins;
  const bw = (bins[1] - bins[0]);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="fmap" role="img" aria-label="Frequency map: real Parkinson's tremor frequencies and the band each detector listens to">`;
  // grid + axis
  for (let f = 0; f <= fMax; f++) {
    svg += `<line x1="${x(f)}" x2="${x(f)}" y1="${top}" y2="${H - 44}" class="fm-grid"/>`;
    svg += `<text x="${x(f)}" y="${H - 28}" class="fm-tick" text-anchor="middle">${f}</text>`;
  }
  svg += `<text x="${left + plotW / 2}" y="${H - 6}" class="fm-axis" text-anchor="middle">frequency (Hz = beats per second)</text>`;
  // histogram of real Parkinson's tremor frequencies
  const hy = (share) => top + histH - (share / maxShare) * (histH - 18);
  td.hist.forEach((c, i) => {
    if (!c) return;
    const share = c / total, x0 = x(bins[i]) + 1, x1 = x(bins[i] + bw) - 1, y0 = hy(share);
    svg += `<rect x="${x0}" y="${y0}" width="${Math.max(1, x1 - x0)}" height="${top + histH - y0}" rx="2" class="fm-hist"><title>${bins[i].toFixed(2)}–${(bins[i] + bw).toFixed(2)} Hz: ${(100 * share).toFixed(1)}% of real Parkinson's tremor beats</title></rect>`;
  });
  svg += `<line x1="${left}" x2="${left + plotW}" y1="${top + histH}" y2="${top + histH}" class="fm-base"/>`;
  svg += `<text x="${left - 12}" y="${top + 16}" class="fm-label" text-anchor="end">Real Parkinson's tremor</text>`;
  svg += `<text x="${left - 12}" y="${top + 34}" class="fm-sub" text-anchor="end">share of ${td.n.toLocaleString()} beats, PADS</text>`;
  svg += `<text x="${left + plotW + 10}" y="${top + 16}" class="fm-val">${td.median.toFixed(1)} Hz</text>`;
  svg += `<text x="${left + plotW + 10}" y="${top + 34}" class="fm-sub">median</text>`;
  svg += `<text x="${left + plotW + 10}" y="${top + 50}" class="fm-sub">${td.q1}–${td.q3} Hz</text>`;
  svg += `<text x="${left + plotW + 10}" y="${top + 66}" class="fm-sub">middle half</text>`;
  // dashed guides at the middle half of real tremor (q1-q3), across every row
  const y0rows = top + histH + 28;
  for (const v of [td.q1, td.q3]) svg += `<line x1="${x(v)}" x2="${x(v)}" y1="${top}" y2="${y0rows + rows.length * rowH - 8}" class="fm-guide"/>`;
  rows.forEach((r, i) => {
    const yc = y0rows + i * rowH + rowH / 2 - 6;
    if (r.kind === 'ref') {
      svg += `<text x="${left - 12}" y="${yc - 2}" class="fm-label" text-anchor="end">${esc(r.label)}</text>`;
      svg += `<text x="${left - 12}" y="${yc + 14}" class="fm-sub" text-anchor="end">${esc(r.sub)}</text>`;
      svg += `<line x1="${x(r.q.q1)}" x2="${x(r.q.q3)}" y1="${yc}" y2="${yc}" class="fm-ref ${r.strong ? 'strong' : ''}"><title>${r.label}: middle half ${r.q.q1}–${r.q.q3} Hz, median ${r.q.median} Hz (n=${r.q.n})</title></line>`;
      svg += `<circle cx="${x(r.q.median)}" cy="${yc}" r="5" class="fm-refdot ${r.strong ? 'strong' : ''}"/>`;
      svg += `<text x="${left + plotW + 10}" y="${yc + 4}" class="fm-sub">median ${r.q.median.toFixed(1)} Hz</text>`;
      return;
    }
    const { a, s } = r;
    const [lo, hi] = a.band;
    svg += `<text x="${left - 12}" y="${yc - 2}" class="fm-label" text-anchor="end">${esc(a.short)}</text>`;
    svg += `<text x="${left - 12}" y="${yc + 14}" class="fm-sub" text-anchor="end">listens ${lo}–${hi} Hz${a.gate ? ' · skips movement' : a.leverCm ? ` · lever ≤ ${a.leverCm} cm` : ''}</text>`;
    if (a.gate) {
      svg += `<rect x="${x(a.gate[0])}" y="${yc - 7}" width="${x(a.gate[1]) - x(a.gate[0])}" height="14" rx="3" class="fm-gate"><title>Discards the whole window if the arm is moving in ${a.gate[0]}–${a.gate[1]} Hz</title></rect>`;
    }
    svg += `<rect x="${x(lo)}" y="${yc - 9}" width="${x(hi) - x(lo)}" height="18" rx="4" style="fill:var(${a.color});opacity:.22"/>`;
    svg += `<rect x="${x(lo)}" y="${yc - 9}" width="${x(hi) - x(lo)}" height="18" rx="4" fill="none" style="stroke:var(${a.color})" stroke-width="1.5"><title>${a.name}: listens ${lo}–${hi} Hz, covers ${s.coveragePct}% of real Parkinson's tremor beats</title></rect>`;
    const q = s.freqTdRest;
    if (q.n) {
      svg += `<line x1="${x(q.q1)}" x2="${x(q.q3)}" y1="${yc}" y2="${yc}" style="stroke:var(${a.color})" stroke-width="3" stroke-linecap="round"/>`;
      svg += `<circle cx="${x(q.median)}" cy="${yc}" r="5" style="fill:var(${a.color})" class="fm-ring"><title>${a.name}: its detections on tremor-dominant patients at rest — median ${q.median} Hz, middle half ${q.q1}–${q.q3} Hz (n=${q.n})</title></circle>`;
    }
    svg += `<text x="${left + plotW + 10}" y="${yc - 2}" class="fm-val">${s.coveragePct}%</text>`;
    svg += `<text x="${left + plotW + 10}" y="${yc + 14}" class="fm-sub">${narrow ? 'in band' : 'of real tremor in band'}</text>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;
}

// ---------------------------------------------------------------- bar rows (one measure each)
function barRows(title, sub, values, { fmt = (v) => pct(v), better = 'high', max } = {}) {
  const vals = ALGORITHMS.map((a) => values(a));
  const top = max ?? (Math.max(...vals.filter((v) => v != null)) * 1.1 || 1);
  const shown = vals.map((v) => fmt(v));
  const nums = shown.map((t) => parseFloat(t)).filter((x) => isFinite(x));
  const bestShown = better === 'high' ? Math.max(...nums) : Math.min(...nums);
  const best = better && nums.some((x) => x !== bestShown) ? bestShown : NaN;  // better: null = no ranking
  return `<div class="cmp-block"><div class="cmp-title">${title}</div><div class="cmp-sub">${sub}</div>
    ${ALGORITHMS.map((a, i) => `<div class="cmp-row"><span class="cmp-name">${swatch(a)}${esc(a.short)}</span>
      <span class="cmp-track"><span class="cmp-bar" style="width:${Math.max(0.5, (100 * (vals[i] ?? 0)) / top)}%;background:var(${a.color})"></span></span>
      <span class="cmp-val">${fmt(vals[i])}${parseFloat(shown[i]) === best ? ' <span class="cmp-best">best</span>' : ''}</span></div>`).join('')}</div>`;
}

function renderReal(S) {
  const A = S.algorithms;
  const ratio = (a) => (A[a.id].hcAllPct > 0 ? A[a.id].tdRestPct / A[a.id].hcAllPct : null);
  $('#padsBars').innerHTML = [
    barRows('Tremor caught', 'tremor-dominant Parkinson\'s, rest windows flagged', (a) => A[a.id].tdRestPct),
    barRows('False alarms', 'healthy people, all windows flagged (lower is better)', (a) => A[a.id].hcAllPct, { fmt: (v) => pct(v, 2), better: 'low' }),
    barRows('Detections per false alarm', 'tremor caught ÷ false alarms (higher is better)', ratio, { fmt: (v) => (v == null ? '—' : `${Math.round(v)} : 1`) }),
  ].join('');
  const d = S.dataset;
  $('#padsNote').innerHTML = `<a href="${d.url}" target="_blank" rel="noopener">${esc(d.name)}</a> · ${d.subjects.PD} Parkinson's, ${d.subjects.HC} healthy, ${d.subjects.DD} other movement disorders · ${d.windows.toLocaleString()} windows · both wrists · same C++ code as the band. PADS has diagnosis labels, not second-by-second tremor labels, so "tremor caught" is how often each detector fires in patients whose neurologist recorded tremor-dominant Parkinson's — a sensitivity proxy, not a true sensitivity.`;
  const row = (label, hint, f, fmt = (v) => pct(v, 2)) => `<tr><th>${label}${hint ? `<small>${hint}</small>` : ''}</th>${ALGORITHMS.map((a) => `<td>${fmt(f(A[a.id]))}</td>`).join('')}</tr>`;
  $('#padsTable').innerHTML = `<div class="table-scroll cmp-scroll"><table class="data cmp-table"><tr><th></th>${ALGORITHMS.map((a) => `<th>${swatch(a)}${esc(a.short)}</th>`).join('')}</tr>
    ${row('Tremor-dominant PD, rest windows flagged', 'sensitivity proxy', (s) => s.tdRestPct)}
    ${row('Mixed-type PD, rest windows flagged', '', (s) => s.mixedRestPct)}
    ${row('Akinetic-rigid PD, rest windows flagged', 'little tremor expected', (s) => s.arRestPct)}
    ${row('Other movement disorders, rest', 'incl. essential tremor', (s) => s.ddRestPct)}
    ${row('Healthy, all windows flagged', 'false alarms', (s) => s.hcAllPct)}
    ${row('Healthy, moving tasks flagged', 'false alarms during movement', (s) => s.hcKineticPct)}
    ${row('Healthy, rest windows flagged', '', (s) => s.hcRestPct)}
    ${row('Tremor-dominant patients with any rest detection', 'subject level', (s) => s.tdSubjectsPct, (v) => pct(v))}
    ${row('Healthy people with any rest detection', 'subject level, lower is better', (s) => s.hcSubjectsPct, (v) => pct(v))}
    ${row('Real tremor frequencies inside its band', 'coverage', (s) => s.coveragePct, (v) => pct(v))}
    ${row('Median frequency it reports', 'tremor-dominant at rest', (s) => s.freqTdRest.median, (v) => (v == null ? '—' : `${v.toFixed(2)} Hz`))}
    </table></div>`;
}

// ---------------------------------------------------------------- simulated benchmark
function renderBench(B) {
  const M = B.metrics;
  // "best" only when it is better at the precision shown, and not everyone ties
  const cell = (a, key, fmt, better) => {
    const shown = ALGORITHMS.map((b) => fmt(M[b.id][key]));
    const nums = shown.map((t) => parseFloat(t)).filter((x) => isFinite(x));
    const top = better === 'high' ? Math.max(...nums) : Math.min(...nums);
    const mine = parseFloat(fmt(M[a.id][key]));
    const isBest = isFinite(mine) && mine === top && nums.some((x) => x !== top);
    return `<td>${fmt(M[a.id][key])}${isBest ? ' <span class="cmp-best">best</span>' : ''}</td>`;
  };
  const row = (label, hint, key, fmt, better) => `<tr><th>${label}<small>${hint}</small></th>${ALGORITHMS.map((a) => cell(a, key, fmt, better)).join('')}</tr>`;
  const inputs = { bandpower: ['gyro', 3], spectral: ['gyro', 3], gated: ['gyro', 3], ours: ['gyro + accel', 6] };
  $('#benchTable').innerHTML = `<div class="table-scroll cmp-scroll"><table class="data cmp-table"><tr><th></th>${ALGORITHMS.map((a) => `<th>${swatch(a)}${esc(a.short)}</th>`).join('')}</tr>
    ${row('Sensitivity', 'tremor windows caught', 'sensitivity', (v) => pct(v), 'high')}
    ${row('Specificity', 'non-tremor windows left alone', 'specificity', (v) => pct(v), 'high')}
    ${row('F1 score', 'balance of the two', 'f1', (v) => f1(v), 'high')}
    ${row('False tremor per hour', 'minutes, during non-tremor activity', 'falseMinPerHour', (v) => (v == null ? '—' : `${v.toFixed(1)} min`), 'low')}
    ${row('Rhythmic activities flagged', 'brushing, stirring, scrubbing, shaking', 'rhythmFalsePct', (v) => pct(v, 0), 'low')}
    ${row('Frequency error', 'reported vs true tremor frequency', 'freqErrHz', (v) => (v == null ? '—' : `${v.toFixed(3)} Hz`), 'low')}
    ${row('Onset latency', 'tremor start → first detection', 'latencyS', (v) => (v == null ? '—' : `${v.toFixed(1)} s`), 'low')}
    <tr><th>Sensors used<small>per 1-s window</small></th>${ALGORITHMS.map((a) => `<td>${inputs[a.id][0]}, ${inputs[a.id][1]} FFTs</td>`).join('')}</tr>
    </table></div>`;
  $('#benchNote').innerHTML = `${B.scenarios.length} scenarios × ${B.seconds} s, ${B.scenarios.reduce((p, s) => p + s.windows.length, 0).toLocaleString()} windows, analysed on this device in ${B.msPerWindow.toFixed(2)} ms per window.
    <strong>Read with care:</strong> the simulation models the physics our method relies on (a rhythm made by the whole arm has a long lever arm), so it shows how each detector behaves by design. The real-patient numbers above are the honest test.`;

  // scenario x algorithm grid: % of windows flagged, with right/wrong in words (not colour alone)
  const groups = [...new Set(SCENARIOS.map((s) => s.group))];
  $('#benchMatrix').innerHTML = `<div class="table-scroll cmp-scroll"><table class="data cmp-matrix"><tr><th>Scenario</th><th>Should flag?</th>${ALGORITHMS.map((a) => `<th>${swatch(a)}${esc(a.short)}</th>`).join('')}</tr>
    ${groups.map((g) => `<tr class="grp"><td colspan="${2 + ALGORITHMS.length}">${esc(g)}</td></tr>` + B.scenarios.filter((s) => s.group === g).map((s) =>
      `<tr><td>${esc(s.name)}</td><td>${s.tremor ? 'yes' : 'no'}</td>${ALGORITHMS.map((a) => {
        const v = s.perAlg[a.id].flaggedPct ?? 0;
        const ok = s.tremor ? v >= 50 : v <= 5;
        return `<td class="${ok ? 'ok' : 'bad'}">${v.toFixed(0)}% <span class="mark">${ok ? '✓ right' : '✗ wrong'}</span></td>`;
      }).join('')}</tr>`).join('')).join('')}</table></div>`;

  const sel = $('#benchScenario');
  if (!sel.options.length) {
    sel.innerHTML = B.scenarios.map((s) => `<option value="${s.id}">${esc(s.group)} — ${esc(s.name)}</option>`).join('');
    sel.value = 'brushing';
    sel.addEventListener('change', () => drawLanes($('#laneChart'), bench.scenarios.find((s) => s.id === sel.value)));
  }
  drawLanes($('#laneChart'), B.scenarios.find((s) => s.id === sel.value));
}

// Reported frequency over time, one lane per detector (small multiples share the time axis).
// Shaded band = 4-6 Hz Parkinsonian range; dashed line = the true tremor frequency (benchmark).
function drawLanes(host, run) {
  host.lastRun = run;
  const W = Math.max(520, Math.round(host.clientWidth || 760)), left = 150, right = 16, laneH = 74, gap = 20, top = 10;
  const t = run.windows.map((w) => w.t - 1.28);  // window centre
  const tMax = Math.max(...t, 1);
  const x = (v) => left + (v / tMax) * (W - left - right);
  const fMax = 10;
  const H = top + ALGORITHMS.length * (laneH + gap) + 30;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="lanes" role="img" aria-label="Reported tremor frequency over time for each detector">`;
  ALGORITHMS.forEach((a, li) => {
    const y0 = top + li * (laneH + gap);
    const y = (f) => y0 + laneH - (f / fMax) * laneH;
    const d = run.decisions[a.id];
    const n = d.flags.filter(Boolean).length;
    svg += `<rect x="${left}" y="${y(6)}" width="${W - left - right}" height="${y(4) - y(6)}" class="ln-band"/>`;
    for (const f of [0, 5, 10]) {
      svg += `<line x1="${left}" x2="${W - right}" y1="${y(f)}" y2="${y(f)}" class="${f ? 'ln-grid' : 'ln-base'}"/>`;
      if (f) svg += `<text x="${left - 6}" y="${y(f) + 4}" class="ln-tick" text-anchor="end">${f} Hz</text>`;
    }
    svg += `<text x="12" y="${y0 + 22}" class="ln-name">${esc(a.short)}</text><text x="12" y="${y0 + 40}" class="ln-sub">${n} of ${d.flags.length} windows</text>`;
    svg += `<circle cx="${12 + 1}" cy="${y0 + 54}" r="5" style="fill:var(${a.color})"/>`;
    if (run.freq) {  // true tremor frequency where tremor is present
      let path = '';
      run.windows.forEach((w, i) => {
        const tr = run.truth ? run.truth[i] : null;
        if (!tr) { path += ' '; return; }
        const p = `${x(t[i]).toFixed(1)},${y(run.freq(t[i])).toFixed(1)}`;
        path += path.endsWith(' ') || !path ? `M${p}` : `L${p}`;
      });
      if (path.trim()) svg += `<path d="${path.trim()}" class="ln-truth"/>`;
    }
    d.flags.forEach((fl, i) => { if (fl) svg += `<circle cx="${x(t[i]).toFixed(1)}" cy="${y(d.freqs[i]).toFixed(1)}" r="4" class="ln-dot" style="fill:var(${a.color})"/>`; });
  });
  const yb = top + ALGORITHMS.length * (laneH + gap);
  for (let s = 0; s <= tMax; s += tMax > 40 ? 10 : 5) svg += `<text x="${x(s)}" y="${yb + 6}" class="ln-tick" text-anchor="middle">${s}s</text>`;
  svg += `<line x1="0" x2="0" y1="${top}" y2="${yb - gap}" class="ln-cross" visibility="hidden"/></svg><div class="chart-tip" hidden></div>`;
  host.innerHTML = svg;
  host.classList.add('lanes-host');
  // hover: crosshair + what every detector reported at that moment
  const el = host.querySelector('svg'), cross = el.querySelector('.ln-cross'), tip = host.querySelector('.chart-tip');
  el.onpointermove = (e) => {
    const r = el.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * W;
    if (vx < left) { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
    let i = 0, bd = Infinity;
    t.forEach((tt, k) => { const dd = Math.abs(x(tt) - vx); if (dd < bd) { bd = dd; i = k; } });
    cross.setAttribute('x1', x(t[i])); cross.setAttribute('x2', x(t[i])); cross.setAttribute('visibility', 'visible');
    const truth = run.freq && run.truth?.[i] ? `<br>true tremor ${run.freq(t[i]).toFixed(2)} Hz` : run.truth && run.truth[i] === false ? '<br>no tremor here' : '';
    tip.innerHTML = `<b>${t[i].toFixed(0)} s</b>${truth}${ALGORITHMS.map((a) => `<br>${swatch(a)}${esc(a.short)}: ${run.decisions[a.id].flags[i] ? `${run.decisions[a.id].freqs[i].toFixed(2)} Hz` : 'no tremor'}`).join('')}`;
    tip.hidden = false;
    const px = ((x(t[i]) / W) * r.width) + 12;
    tip.style.left = `${Math.min(px, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = '8px';
  };
  el.onpointerleave = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
}

// ---------------------------------------------------------------- user recording
async function runRecording(file) {
  const out = $('#recResult');
  try {
    const s = parseRecording(await file.text());
    if (s.n < 300) throw new Error('recording is shorter than 3 seconds');
    const windows = analyzeRecording(s);
    const decisions = decide(windows);
    const run = { windows, decisions };
    out.innerHTML = `<p class="muted small">${esc(file.name)} · ${(s.n / 100).toFixed(0)} s · ${windows.length} windows</p>
      <div class="cmp-bars">${barRows('Windows flagged as tremor', 'same file, four detectors (no ground truth, so no ranking)', (a) => (100 * decisions[a.id].flags.filter(Boolean).length) / windows.length, { better: null, max: 100 })}</div>
      <div id="recLanes"></div>`;
    drawLanes($('#recLanes'), run);
  } catch (e) {
    out.innerHTML = `<p class="empty">Couldn't read that file: ${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- entry points
export async function renderAlgorithms() {
  if (!rendered) {
    rendered = true;
    $('#algoLegend').innerHTML = ALGORITHMS.map((a) => `<div class="algo-card"><div class="algo-name">${swatch(a)}${esc(a.name)}</div><div class="algo-origin">${esc(a.origin)}</div><div class="algo-rule">${esc(a.rule)}</div></div>`).join('');
    $('#recFile').addEventListener('change', (e) => e.target.files[0] && runRecording(e.target.files[0]));
  }
  if (!summary) {
    try {
      summary = await (await fetch('data/pads_summary.json')).json();
    } catch {
      $('#freqMap').innerHTML = '<p class="empty">Real-patient summary not found (data/pads_summary.json). Run tools/eval_pads.py.</p>';
    }
  }
  if (summary) {
    frequencyMap($('#freqMap'), summary);
    const td = summary.observed.tdRest;
    $('#freqMapNote').innerHTML = `Top: how often real Parkinson's rest tremor beats at each frequency (${td.n.toLocaleString()} strong, narrow oscillations in ${summary.dataset.pdSubtypeSubjects['tremor-dominant']} tremor-dominant patients at rest; median ${td.median} Hz, middle half ${td.q1}–${td.q3} Hz between the dashed lines). Each detector row: the band it listens to (outline), what share of real tremor falls inside it (right), and the median ± middle half of the frequencies it actually reported on those patients (dot and bar).`;
    renderReal(summary);
  }
  if (!bench) {
    $('#benchNote').textContent = 'Running the benchmark…';
    await new Promise((r) => setTimeout(r, 30));  // let the page paint first
    bench = runBenchmark({ seed: 1 });
  }
  renderBench(bench);
}

export function redrawAlgorithms() { if (rendered && bench) renderAlgorithms(); }

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (document.querySelector('#view-algorithms')?.hidden !== false) return;
    if (summary) frequencyMap($('#freqMap'), summary);
    for (const h of document.querySelectorAll('.lanes-host')) if (h.lastRun) drawLanes(h, h.lastRun);
  }, 200);
});
