// "Versus" view: the four detectors judging the band's live samples side by side, in real time.
// Trust comes from three things shown on screen: every detector gets the exact samples the band
// analyses (counted, losses shown), our detector's answer on this page is checked against the
// band chip's own answer for every window, and the wearer's labels score all four the same way.
import { ALGORITHMS, FS } from './dsp.js';
import { LivePipeline, LABELS } from './livepipe.js';
import { SCENARIOS, buildScenario } from './bench.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const swatch = (a) => `<span class="algo-sw" style="background:var(${a.color})" aria-hidden="true"></span>`;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const LABEL_NAME = Object.fromEntries(LABELS.map((l) => [l.id, l.name]));
const LABEL_SHORT = { still: 'still', tremor: 'tremor', movement: 'movement' };
const WINDOW_S = 60;

let opts = null;
let pipe = null;
let source = null;      // 'band' | 'sim' | null
let running = false;
let band = null;        // the BandConnection listeners are attached to
let sim = null;
let startedAt = null;
let pads = null;        // real Parkinson's tremor frequencies (Compare tab data)
let wired = false;
let drawQueued = false;

// ---------------------------------------------------------------- simulated wrist (no band)
// Physics-model scenarios from the benchmark, streamed at 100 Hz through the same pipeline,
// labelled automatically. No band chip here, so there is no band-vs-page check.
const SIM_PLAN = [['still', 15, 'still'], ['mild', 20, 'tremor'], ['brushing', 20, 'movement'], ['moderate', 15, 'tremor'],
  ['walking', 15, 'movement'], ['bottle', 15, 'movement'], ['slight', 20, 'tremor'], ['stirring', 20, 'movement']];
const GLSB = Math.PI / 180 / 16.4;
const clip = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

class SimFeed {
  constructor(p, onSegment) { this.pipe = p; this.onSegment = onSegment; this.seg = 0; this.buf = null; this.i = 0; this.idx = 0; this.first = true; }
  start() { this.t0 = performance.now(); this.sent = 0; this.timer = setInterval(() => this.tick(), 80); }
  stop() { clearInterval(this.timer); }
  next(queued) {
    const [id, sec, label] = SIM_PLAN[this.seg % SIM_PLAN.length];
    const sc = SCENARIOS.find((x) => x.id === id);
    const s = buildScenario(sc, 100 + this.seg, sec);
    this.seg++;
    this.buf = Array.from({ length: s.n }, (_, i) => [clip(s.ax[i] * 4096), clip(s.ay[i] * 4096), clip(s.az[i] * 4096), clip(s.gx[i] / GLSB), clip(s.gy[i] / GLSB), clip(s.gz[i] / GLSB)]);
    this.i = 0;
    this.pipe.setLabel(label, this.pipe.abs + queued);
    this.onSegment(sc, label);
  }
  tick() {
    let due = Math.min(400, Math.floor((performance.now() - this.t0) / 10) - this.sent);
    while (due > 0) {
      const k = Math.min(8, due), samples = [];
      for (let j = 0; j < k; j++) {
        if (!this.buf || this.i >= this.buf.length) this.next(samples.length);
        samples.push(this.buf[this.i++]);
      }
      this.pipe.ingest({ first: this.idx & 0xffff, gap: this.first, samples });
      this.first = false; this.idx += k; this.sent += k; due -= k;
    }
  }
}

// ---------------------------------------------------------------- session control
function newPipeline() {
  pipe = new LivePipeline({ keepSeconds: WINDOW_S });
  pipe.on((kind) => { if (kind === 'window' || kind === 'band') scheduleDraw(); });
  const sel = document.querySelector('#vsLabels [aria-pressed="true"]')?.dataset.label || null;
  pipe.setLabel(sel === 'none' ? null : sel);
}

async function startBand() {
  const b = opts.getBand();
  if (!b || b.state !== 'connected' || !b.rawSupported) return;
  stopAll();
  newPipeline();
  source = 'band';
  running = true;
  startedAt = Date.now();
  try {
    await b.setRawStream(true);
  } catch (e) {
    running = false;
    source = null;
    opts.toast?.(`Couldn't start the stream: ${e.message}`);
  }
  renderAll();
}

function startSim() {
  stopAll();
  newPipeline();
  source = 'sim';
  running = true;
  startedAt = Date.now();
  sim = new SimFeed(pipe, (sc, label) => {
    setLabelButtons(label, true);
    $('#vsSource').textContent = `Simulated wrist (no band): now playing “${sc.name}”. Labels are set by the simulation.`;
  });
  sim.start();
  renderAll();
}

function stopAll() {
  if (sim) { sim.stop(); sim = null; }
  if (source === 'band') opts.getBand()?.setRawStream(false).catch(() => {});
  running = false;
  setLabelButtons(pipe?.label ?? 'none', false);
}

function setLabelButtons(label, locked) {
  document.querySelectorAll('#vsLabels button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.label === (label ?? 'none')));
    b.disabled = locked;
  });
}

// ---------------------------------------------------------------- drawing
function scheduleDraw() {
  if (drawQueued || !opts.isVisible()) return;
  drawQueued = true;
  setTimeout(() => { drawQueued = false; renderAll(); }, 30);  // (rAF never fires in a background tab)
}

function latestJudged() {
  if (!pipe) return null;
  for (let i = pipe.windows.length - 1; i >= 0; i--) if (pipe.windows[i].r) return pipe.windows[i];
  return null;
}

function renderControls() {
  const b = opts.getBand();
  const real = !!b && typeof b.setRawStream === 'function';  // not the demo band
  const ready = real && b.state === 'connected' && b.rawSupported;
  const startBtn = $('#vsStart');
  startBtn.textContent = running && source === 'band' ? 'Stop' : 'Start with my band';
  startBtn.disabled = !(ready || (running && source === 'band'));
  $('#vsSim').textContent = running && source === 'sim' ? 'Stop simulation' : 'Play a simulated wrist';
  if (running && source === 'sim') return;  // SimFeed keeps the line up to date
  $('#vsSource').textContent = running && source === 'band'
    ? `Streaming every sample from ${b?.device?.name ?? 'the band'}${b?.state !== 'connected' ? ' — connection lost, it resumes by itself when the band is back in range' : ''}. Started ${new Date(startedAt).toLocaleTimeString()}.`
    : ready ? 'Band connected. Press start: the band streams the raw samples it analyses (about 1.3 kB/s) while this screen is running.'
    : real && b.state === 'connected' ? 'This band runs older firmware without live streaming: flash the latest firmware (firmware/ → pio run -t upload), then reconnect.'
    : 'Connect your band first (top of the page), or play a simulated wrist to see how it works.';
}

function renderTrust() {
  const s = pipe?.stats, rate = pipe?.samplesPerSecond();
  const judged = pipe ? pipe.windows.filter((w) => w.r).length : 0;
  const labelled = pipe ? pipe.windows.filter((w) => w.r && w.label).length : 0;
  const tile = (label, val, hint) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-val">${val}</div><div class="tile-hint">${hint}</div></div>`;
  const bandTile = source === 'sim'
    ? tile('Band chip = this page', '—', 'needs the real band: in simulation there is no chip to check against')
    : !s || !s.compared ? tile('Band chip = this page', '—', 'every window, our detector runs on the band <em>and</em> here; both answers are compared')
    : tile('Band chip = this page', `${s.same} / ${s.compared}`, `windows where the band's chip and this page gave the identical answer${s.maxFreqDiff ? ` · largest frequency difference ${s.maxFreqDiff.toFixed(3)} Hz` : ''}${s.notCompared ? ` · ${s.notCompared} not comparable (samples lost)` : ''}`);
  $('#vsTrust').innerHTML = [
    tile('Input', rate ? `${Math.round(rate)} / s` : '—', s ? `samples received${source === 'band' ? ' from the band' : ' (simulated)'} · <strong>${s.lost}</strong> lost in transit` : 'samples per second, and how many were lost'),
    tile('Windows judged', String(judged), '2.56 s windows, a new one every second: the band\'s own framing'),
    bandTile,
    tile('Labelled windows', String(labelled), 'scored against what you said you were doing'),
  ].join('');
}

// What each detector hears in the latest window: the frequency content of the wrist's rotation,
// the band each one listens to, the peak it picked and its verdict.
function drawNow(host, w) {
  if (!w) { host.innerHTML = `<p class="empty">${running ? 'Waiting for the first 2.56 s window…' : 'Start a session to see the detectors work.'}</p>`; $('#vsVerdicts').innerHTML = ''; return; }
  const sp = pipe.spectrum;
  // drawn at the real width so text stays readable; on a phone, row names go above each row
  const W = Math.max(300, Math.round(host.clientWidth || 760)), compact = W < 520, narrow = W < 700;
  const left = compact ? 10 : narrow ? 150 : 196, right = compact ? 10 : narrow ? 76 : 96, plotW = W - left - right;
  const fMax = 15, x = (f) => left + (f / fMax) * plotW;
  const top = 26, specH = compact ? 100 : 120, rowH = compact ? 46 : 34;
  const rowLabel = (yc, name, sub) => (compact
    ? `<text x="${left}" y="${yc - 14}" class="fm-label">${name} <tspan class="fm-sub">${sub}</tspan></text>`
    : `<text x="${left - 12}" y="${yc - 1}" class="fm-label" text-anchor="end">${name}</text><text x="${left - 12}" y="${yc + 14}" class="fm-sub" text-anchor="end">${sub}</text>`);
  const showBand = source === 'band';
  const rows = [...ALGORITHMS.map((a) => ({ a })), ...(showBand ? [{ band: true }] : [])];
  const y0 = top + specH + 22;
  const H = y0 + rows.length * rowH + 40;
  const kMax = Math.floor(fMax / sp.df);
  let maxS = 0;
  for (let k = 1; k <= kMax; k++) maxS = Math.max(maxS, sp.share[k]);
  maxS = maxS || 1;
  const ys = (v) => top + specH - (v / maxS) * (specH - 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="fmap" role="img" aria-label="Frequency content of the latest window and what each detector decided">`;
  for (let f = 0; f <= fMax; f++) {
    svg += `<line x1="${x(f)}" x2="${x(f)}" y1="${top}" y2="${H - 34}" class="fm-grid"/>`;
    if (compact ? f % 3 === 0 : !narrow || f % 2 === 0 || f === 15) svg += `<text x="${x(f)}" y="${H - 18}" class="fm-tick" text-anchor="middle">${f}</text>`;
  }
  svg += `<text x="${left + plotW / 2}" y="${H - 2}" class="fm-axis" text-anchor="middle">frequency (Hz = beats per second)</text>`;
  // real Parkinson's tremor: middle half of frequencies (PADS)
  if (pads) {
    for (const v of [pads.q1, pads.q3]) svg += `<line x1="${x(v)}" x2="${x(v)}" y1="${top}" y2="${y0 + rows.length * rowH - 6}" class="fm-guide"/>`;
    svg += `<text x="${x((pads.q1 + pads.q3) / 2)}" y="${top - 8}" class="fm-sub" text-anchor="middle">real Parkinson's tremor</text>`;
  }
  // spectrum (share of 1-15 Hz rotation power per 0.39 Hz bin)
  let d = '';
  for (let k = 1; k <= kMax; k++) d += `${k === 1 ? 'M' : 'L'}${x(k * sp.df).toFixed(1)},${ys(sp.share[k]).toFixed(1)}`;
  svg += `<path d="${d}L${x(kMax * sp.df).toFixed(1)},${ys(0)}L${x(sp.df).toFixed(1)},${ys(0)}Z" class="vs-spec-fill"/><path d="${d}" class="vs-spec"/>`;
  svg += `<line x1="${left}" x2="${left + plotW}" y1="${ys(0)}" y2="${ys(0)}" class="fm-base"/>`;
  if (!compact) {
    svg += `<text x="${left - 12}" y="${top + 16}" class="fm-label" text-anchor="end">Wrist rotation</text>`;
    svg += `<text x="${left - 12}" y="${top + 32}" class="fm-sub" text-anchor="end">by frequency, this window</text>`;
  }
  if (compact) svg += `<text x="${W - 4}" y="${top - 8}" class="fm-sub" text-anchor="end">strongest <tspan class="fm-label">${w.r.dom_freq_hz.toFixed(1)} Hz</tspan></text>`;
  else {
    svg += `<text x="${left + plotW + 10}" y="${top + 16}" class="fm-val">${w.r.dom_freq_hz.toFixed(1)} Hz</text>`;
    svg += `<text x="${left + plotW + 10}" y="${top + 32}" class="fm-sub">strongest</text>`;
  }
  // verdict word: right column, or (phone) at the end of the row's name line
  const verdict = (yc, yes, word) => `<text x="${compact ? W - 4 : left + plotW + 10}" y="${compact ? yc - 14 : yc + 5}" class="${yes ? 'vs-yes' : 'vs-no'}"${compact ? ' text-anchor="end"' : ''}>${word}</text>`;
  rows.forEach((row, i) => {
    const yc = compact ? y0 + i * rowH + 30 : y0 + i * rowH + rowH / 2 - 4;
    if (row.band) {
      const b = w.band;
      svg += rowLabel(yc, 'Band chip (ours)', 'the band\'s own answer');
      if (b?.candidate) svg += `<circle cx="${x(b.freqHz)}" cy="${yc}" r="6" class="${b.tremor ? 'vs-chip' : 'vs-chip open'}"><title>Band chip: ${b.tremor ? 'tremor' : 'beat found, checking'} at ${b.freqHz.toFixed(2)} Hz</title></circle>`;
      svg += verdict(yc, b?.tremor, !b ? '…' : b.tremor ? 'TREMOR' : 'no');
      return;
    }
    const a = row.a, dd = w.d[a.id], [lo, hi] = a.band;
    svg += rowLabel(yc, esc(a.short), `listens ${lo}–${hi} Hz`);
    if (a.gate) svg += `<rect x="${x(a.gate[0])}" y="${yc - 7}" width="${x(a.gate[1]) - x(a.gate[0])}" height="14" rx="3" class="fm-gate"><title>Skips the window if the arm moves in ${a.gate[0]}–${a.gate[1]} Hz</title></rect>`;
    svg += `<rect x="${x(lo)}" y="${yc - 9}" width="${x(hi) - x(lo)}" height="18" rx="4" style="fill:var(${a.color});opacity:.2"/>`;
    svg += `<rect x="${x(lo)}" y="${yc - 9}" width="${x(hi) - x(lo)}" height="18" rx="4" fill="none" style="stroke:var(${a.color})" stroke-width="1.5"/>`;
    if (dd.peak) {
      const cls = dd.flag ? '' : dd.cand ? 'open' : 'off';
      svg += `<circle cx="${x(dd.peak)}" cy="${yc}" r="6" class="vs-mark ${cls}" style="--c:var(${a.color})"><title>${esc(a.short)}: peak at ${dd.peak.toFixed(2)} Hz — ${dd.flag ? 'tremor' : esc(dd.why)}</title></circle>`;
    }
    svg += verdict(yc, dd.flag, dd.flag ? 'TREMOR' : dd.cand ? 'checking' : 'no');
  });
  svg += '</svg>';
  host.innerHTML = svg;

  // the same verdicts in words, with the reason for every "no"
  const card = (name, sw, verdict, yes, reason) => `<div class="vs-card${yes ? ' yes' : ''}"><div class="vs-card-name">${sw}${name}</div><div class="vs-card-verdict">${verdict}</div><div class="vs-card-why">${reason}</div></div>`;
  let html = ALGORITHMS.map((a) => {
    const dd = w.d[a.id];
    return card(esc(a.short), swatch(a), dd.flag ? `Tremor · ${dd.freq.toFixed(2)} Hz` : dd.cand ? 'Checking…' : 'No tremor', dd.flag, dd.flag ? 'steady beat in its band, two windows in a row' : esc(dd.why));
  }).join('');
  if (showBand) {
    const b = w.band;
    html += card('Band chip (ours)', '<span class="algo-sw vs-chip-sw" aria-hidden="true"></span>', !b ? 'Waiting…' : b.tremor ? `Tremor · ${b.freqHz.toFixed(2)} Hz` : b.candidate ? 'Checking…' : 'No tremor', b?.tremor,
      !b ? 'the band sends its verdict right after the window' : !w.cmp ? 'not comparable: samples of this window were lost' : w.cmp.same ? '✓ identical to “Ours” on this page' : '✗ differs from this page — see the table');
  }
  $('#vsVerdicts').innerHTML = html;
  $('#vsNowNote').textContent = `window ${w.n} · ${w.t.toFixed(0)} s into the session${w.label ? ` · you said: ${LABEL_NAME[w.label].toLowerCase()}` : ''}`;
}

// Rolling last-minute view: the raw input, what the wearer said, and every detector's verdicts.
function drawLanes(host) {
  if (!pipe || !pipe.windows.length) { host.innerHTML = ''; return; }
  // real width; on a phone each lane's name sits above it instead of in a left column
  const W = Math.max(300, Math.round(host.clientWidth || 760)), compact = W < 520;
  const left = compact ? 44 : 150, right = compact ? 8 : 16, plotW = W - left - right;
  const tNow = pipe.abs / FS, t0 = tNow - WINDOW_S;
  const x = (t) => left + ((t - t0) / WINDOW_S) * plotW;
  const traceH = 56, labH = 22, laneH = 52, gap = 14, titleH = compact ? 18 : 0;
  const top = 8 + titleH;
  const showBand = source === 'band';
  const lanes = [...ALGORITHMS.map((a) => ({ a })), ...(showBand ? [{ band: true }] : [])];
  const yLanes = top + traceH + gap + titleH + labH + gap;
  const H = yLanes + lanes.length * (laneH + gap + titleH) + 18;
  const title = (y0, name, sub, nameY = 20) => (compact
    ? `<text x="${left}" y="${y0 - 6}" class="ln-name">${name}${sub ? ` <tspan class="ln-sub">${sub}</tspan>` : ''}</text>`
    : `<text x="12" y="${y0 + nameY}" class="ln-name">${name}</text>${sub ? `<text x="12" y="${y0 + 37}" class="ln-sub">${sub}</text>` : ''}`);
  const wins = pipe.windows.filter((w) => w.t - 1.28 >= t0);
  const tc = (w) => w.t - 1.28;  // window centre
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="lanes" role="img" aria-label="Last minute: wrist rotation, your labels and each detector's verdicts">`;
  // 1) raw input: |gyro| envelope per pixel column
  const keep = pipe.keep, a1 = pipe.abs, a0 = Math.max(0, a1 - keep);
  const cols = Math.max(1, Math.round(plotW)), env = new Float64Array(cols).fill(NaN);
  for (let a = a0; a < a1; a++) {
    const v = pipe.trace[a % keep];
    if (!(v >= 0)) continue;
    const c = Math.min(cols - 1, Math.max(0, Math.floor(((a / FS - t0) / WINDOW_S) * cols)));
    if (!(env[c] >= v)) env[c] = v;
  }
  let vmax = 0;
  for (const v of env) if (v > vmax) vmax = v;
  const nice = [0.5, 1, 2, 5, 10, 20, 50].find((n) => n >= vmax) ?? Math.ceil(vmax);
  const yt = (v) => top + traceH - (v / nice) * traceH;
  let path = '', pen = false;
  env.forEach((v, c) => {
    if (!(v >= 0)) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${(left + c + 0.5).toFixed(1)},${yt(v).toFixed(1)}`;
    pen = true;
  });
  svg += `<line x1="${left}" x2="${W - right}" y1="${yt(0)}" y2="${yt(0)}" class="ln-base"/><line x1="${left}" x2="${W - right}" y1="${yt(nice)}" y2="${yt(nice)}" class="ln-grid"/>`;
  svg += `<text x="${left - 6}" y="${yt(nice) + 4}" class="ln-tick" text-anchor="end">${nice}${compact ? '' : ' rad/s'}</text>`;
  svg += title(top, 'Wrist rotation', compact ? 'rad/s, raw input to all four' : 'raw input, all four');
  if (path) svg += `<path d="${path}" class="vs-trace"/>`;
  // 2) what the wearer said
  const yl = top + traceH + gap + titleH;
  svg += title(yl, 'You said', '', 15);
  const log = pipe.labelLog;
  log.forEach((L, i) => {
    if (!L.label) return;
    const ta = Math.max(t0, L.from / FS), tb = Math.min(tNow, i + 1 < log.length ? log[i + 1].from / FS : tNow);
    if (tb <= ta) return;
    const xa = x(ta), xb = x(tb);
    svg += `<rect x="${xa + 1}" y="${yl}" width="${Math.max(1, xb - xa - 2)}" height="${labH}" rx="4" class="vs-lab ${L.label}"/>`;
    if (xb - xa > 64) svg += `<text x="${xa + 8}" y="${yl + 15}" class="vs-lab-text">${LABEL_SHORT[L.label]}</text>`;
  });
  // 3) one lane per detector (+ the band chip): dots where it said tremor, at the frequency it reported
  lanes.forEach((ln, li) => {
    const y0 = yLanes + li * (laneH + gap + titleH) + titleH;
    const y = (f) => y0 + laneH - (f / 10) * laneH;
    svg += `<rect x="${left}" y="${y(6)}" width="${plotW}" height="${y(4) - y(6)}" class="ln-band"/>`;
    for (const f of [0, 5, 10]) {
      svg += `<line x1="${left}" x2="${W - right}" y1="${y(f)}" y2="${y(f)}" class="${f ? 'ln-grid' : 'ln-base'}"/>`;
      if (f) svg += `<text x="${left - 6}" y="${y(f) + 4}" class="ln-tick" text-anchor="end">${f} Hz</text>`;
    }
    if (ln.band) {
      const n = wins.filter((w) => w.band?.tremor).length;
      svg += title(y0, 'Band chip (ours)', `${n} of ${wins.filter((w) => w.band).length} windows`);
      wins.forEach((w) => {
        if (w.band?.tremor) svg += `<circle cx="${x(tc(w)).toFixed(1)}" cy="${y(w.band.freqHz).toFixed(1)}" r="4" class="vs-chip"/>`;
        if (w.cmp && !w.cmp.same) svg += `<text x="${x(tc(w)).toFixed(1)}" y="${y0 + 10}" class="vs-diff" text-anchor="middle">✗</text>`;
      });
      return;
    }
    const a = ln.a, judged = wins.filter((w) => w.d), n = judged.filter((w) => w.d[a.id].flag).length;
    svg += title(y0, esc(a.short), `${n} of ${judged.length} windows`);
    if (!compact) svg += `<circle cx="13" cy="${y0 + 48}" r="4" style="fill:var(${a.color})"/>`;
    judged.forEach((w) => { if (w.d[a.id].flag) svg += `<circle cx="${x(tc(w)).toFixed(1)}" cy="${y(w.d[a.id].freq).toFixed(1)}" r="4" class="ln-dot" style="fill:var(${a.color})"/>`; });
  });
  const yb = yLanes + lanes.length * (laneH + gap + titleH);
  for (let s = 0; s <= WINDOW_S; s += compact ? 20 : 10) svg += `<text x="${x(t0 + s)}" y="${yb + 6}" class="ln-tick" text-anchor="middle">${s === WINDOW_S ? 'now' : `−${WINDOW_S - s} s`}</text>`;
  svg += `<line x1="0" x2="0" y1="${top}" y2="${yb - gap}" class="ln-cross" visibility="hidden"/></svg><div class="chart-tip vs-tip" hidden></div>`;
  host.innerHTML = svg;

  const el = host.querySelector('svg'), cross = el.querySelector('.ln-cross'), tip = host.querySelector('.chart-tip');
  el.onpointermove = (e) => {
    const r = el.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * W;
    if (vx < left || !wins.length) { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
    let w = wins[0], bd = Infinity;
    for (const c of wins) { const dd = Math.abs(x(tc(c)) - vx); if (dd < bd) { bd = dd; w = c; } }
    cross.setAttribute('x1', x(tc(w))); cross.setAttribute('x2', x(tc(w))); cross.setAttribute('visibility', 'visible');
    const said = w.label ? LABEL_NAME[w.label].toLowerCase() : w.label === undefined ? 'changed during this window' : 'not labelled';
    tip.innerHTML = `<b>window ${w.n}</b> · ${Math.round(tNow - w.t)} s ago · you said: ${said}` +
      (w.d ? ALGORITHMS.map((a) => `<br>${swatch(a)}${esc(a.short)}: ${w.d[a.id].flag ? `<b>tremor ${w.d[a.id].freq.toFixed(2)} Hz</b>` : esc(w.d[a.id].why)}`).join('') : '<br>samples lost: not judged on this page') +
      (w.band ? `<br><span class="algo-sw vs-chip-sw"></span>Band chip: ${w.band.tremor ? `<b>tremor ${w.band.freqHz.toFixed(2)} Hz</b>` : 'no tremor'}${w.cmp ? (w.cmp.same ? ' · ✓ same as this page' : ' · ✗ differs') : ''}` : '');
    tip.hidden = false;
    const px = (x(tc(w)) / W) * r.width + 12;
    tip.style.left = `${Math.max(4, Math.min(px, r.width - tip.offsetWidth - 4))}px`;
    tip.style.top = '8px';
  };
  el.onpointerleave = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
}

function renderScore() {
  const sc = pipe?.score;
  const n = (label) => (sc ? sc[label].ours.n : 0);
  const block = (title, sub, label) => {
    if (!sc || !n(label)) return `<div class="cmp-block"><div class="cmp-title">${title}</div><div class="cmp-sub">${sub}</div><p class="muted small">No windows labelled “${LABEL_NAME[label].toLowerCase()}” yet.</p></div>`;
    return `<div class="cmp-block"><div class="cmp-title">${title}</div><div class="cmp-sub">${sub} · ${n(label)} windows</div>
      ${ALGORITHMS.map((a) => {
        const s = sc[label][a.id], v = s.n ? (100 * s.flagged) / s.n : 0;
        return `<div class="cmp-row"><span class="cmp-name">${swatch(a)}${esc(a.short)}</span>
          <span class="cmp-track"><span class="cmp-bar" style="width:${Math.max(0.5, v)}%;background:var(${a.color})"></span></span>
          <span class="cmp-val">${s.flagged}/${s.n} · ${pct(s.flagged, s.n)}</span></div>`;
      }).join('')}</div>`;
  };
  let balanced = '';
  const nT = n('tremor'), nN = n('still') + n('movement');
  if (sc && nT >= 5 && nN >= 5) {
    balanced = `<div class="cmp-block"><div class="cmp-title">Balanced accuracy</div><div class="cmp-sub">average of tremor caught and non-tremor left alone · higher is better</div>
      ${ALGORITHMS.map((a) => {
        const sens = sc.tremor[a.id].flagged / nT, spec = 1 - (sc.still[a.id].flagged + sc.movement[a.id].flagged) / nN;
        const v = 50 * (sens + spec);
        return `<div class="cmp-row"><span class="cmp-name">${swatch(a)}${esc(a.short)}</span>
          <span class="cmp-track"><span class="cmp-bar" style="width:${Math.max(0.5, v)}%;background:var(${a.color})"></span></span>
          <span class="cmp-val">${v.toFixed(0)}%</span></div>`;
      }).join('')}</div>`;
  }
  $('#vsScore').innerHTML = [
    block('Tremor caught', 'windows labelled “imitating tremor” that each flagged · higher is better', 'tremor'),
    block('False alarms while still', 'windows labelled “holding still” flagged · lower is better', 'still'),
    block('False alarms while moving', 'brushing, stirring, waving… flagged · lower is better', 'movement'),
    balanced,
  ].join('');
  const mixed = pipe ? pipe.windows.filter((w) => w.label === undefined).length : 0;
  $('#vsScoreNote').textContent = mixed ? `${mixed} windows spanning a label change are left out` : 'every detector scored on the same windows';
}

function renderTable() {
  const host = $('#vsTable');
  if (!host.closest('details')?.open) return;  // only build it when someone looks
  const rows = (pipe?.windows ?? []).slice(-120).reverse();
  const cell = (dd) => (dd.flag ? `${dd.freq.toFixed(2)} Hz` : '–');
  host.innerHTML = rows.length ? `<div class="table-scroll cmp-scroll vs-table"><table class="data"><tr><th>Window</th><th>You said</th>${ALGORITHMS.map((a) => `<th>${swatch(a)}${esc(a.short)}</th>`).join('')}${source === 'band' ? '<th>Band chip</th><th>Same?</th>' : ''}</tr>
    ${rows.map((w) => `<tr><td>${w.n} <small class="muted">${w.t.toFixed(0)} s</small></td><td>${w.label ? LABEL_SHORT[w.label] : w.label === undefined ? 'changed' : ''}</td>
      ${ALGORITHMS.map((a) => `<td>${w.d ? cell(w.d[a.id]) : 'lost'}</td>`).join('')}
      ${source === 'band' ? `<td>${w.band ? (w.band.tremor ? `${w.band.freqHz.toFixed(2)} Hz` : '–') : '…'}</td><td>${w.cmp ? (w.cmp.same ? '✓' : '<strong>✗</strong>') : '—'}</td>` : ''}</tr>`).join('')}
    </table></div><p class="muted small">Newest first, last 120 windows. “–” = no tremor. Download the window results for all of them.</p>` : '<p class="empty">No windows yet.</p>';
}

function renderAll() {
  if (!opts) return;
  renderControls();
  renderTrust();
  drawNow($('#vsNow'), latestJudged());
  drawLanes($('#vsLanes'));
  renderScore();
  renderTable();
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------- entry points
export function initVersus(o) {
  opts = o;
  $('#vsLabels').innerHTML = [{ id: 'none', name: 'Not labelled' }, ...LABELS].map((l) =>
    `<button type="button" class="btn vs-seg" data-label="${l.id}" aria-pressed="${l.id === 'none'}">${esc(l.name)}${l.hint ? `<small>${esc(l.hint)}</small>` : ''}</button>`).join('');
  $('#vsLabels').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-label]');
    if (!b || b.disabled) return;
    setLabelButtons(b.dataset.label, false);
    pipe?.setLabel(b.dataset.label === 'none' ? null : b.dataset.label);
  });
  $('#vsStart').addEventListener('click', () => (running && source === 'band' ? (stopAll(), renderAll()) : startBand()));
  $('#vsSim').addEventListener('click', () => (running && source === 'sim' ? (stopAll(), renderAll()) : startSim()));
  $('#vsCsv').addEventListener('click', () => pipe?.stats.samples && download(`tremorband-live-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}-samples.csv`, pipe.samplesCsv()));
  $('#vsWinCsv').addEventListener('click', () => pipe?.windows.length && download(`tremorband-live-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}-windows.csv`, pipe.windowsCsv()));
  $('#vsTableToggle').addEventListener('toggle', renderTable);
  fetch('data/pads_summary.json').then((r) => r.json()).then((S) => { pads = S.observed.tdRest; scheduleDraw(); }).catch(() => {});
  setInterval(() => { if (running && opts.isVisible()) renderTrust(); }, 1000);
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(scheduleDraw, 200); });
  wired = true;
}

// Called for every new band connection object.
export function attachVersus(b) {
  band = b;
  b.addEventListener('raw', (e) => { if (running && source === 'band' && band === b) pipe.ingest(e.detail); });
  b.addEventListener('live', (e) => { if (running && source === 'band' && band === b) pipe.bandResult(e.detail); });
  b.addEventListener('state', () => { if (wired && opts.isVisible()) renderControls(); });
}

export function renderVersus() { if (wired) renderAll(); }
