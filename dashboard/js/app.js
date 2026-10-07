import { BandConnection } from './ble.js';
import { SimBand } from './sim.js';
import * as db from './store.js';
import { Chart, fmtClock, fmtDate, timeTicks } from './chart.js';
import { TESTS, TestRunner, byId, headline, detailRows } from './tests.js';
import * as R from './report.js';
import { SEVERITY_LABELS } from './protocol.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sevVar = (s) => ['--good', '--warning', '--warning', '--serious', '--critical'][s] || '--text-muted';
const sevChip = (s) => `<span class="sev-chip" style="--c: var(${sevVar(s)})">${s} ${SEVERITY_LABELS[s]}</span>`;
const LIVE_SPAN_MS = 180000;

const app = {
  band: null,
  mode: null,           // 'ble' | 'demo'
  settings: db.getSettings(),
  live: [],             // recent live packets {t, ...}
  lastLive: null,
  status: null,
  lastSync: null,
  syncing: null,
  view: 'live',
  dayOffset: 0,
};

// ---------------------------------------------------------------- helpers
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function confirmModal(title, body, okLabel) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.querySelector('.modal-box').innerHTML = `<h2>${title}</h2><p>${body}</p>
      <div class="modal-actions"><button class="btn" data-r="0">Cancel</button><button class="btn primary" data-r="1">${okLabel}</button></div>`;
    m.hidden = false;
    m.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { m.hidden = true; resolve(b.dataset.r === '1'); }));
  });
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const refreshViews = debounce(() => renderView(app.view), 400);

// ---------------------------------------------------------------- band connection
async function saveBatch(storeId, records) {
  await db.saveEpochs(storeId, records);
  refreshViews();
}

function attach(band) {
  band.addEventListener('state', (e) => onState(e.detail));
  band.addEventListener('live', (e) => onLive(e.detail));
  band.addEventListener('status', (e) => { app.status = e.detail; renderConn(); if (app.view === 'settings') renderSettings(); });
  band.addEventListener('sync', (e) => {
    app.syncing = e.detail.done ? null : e.detail;
    if (e.detail.done) app.lastSync = Date.now();
    renderConn();
  });
}

async function connect(mode) {
  if (app.band) app.band.disconnect();
  const leverMm = Math.round(app.settings.leverCm * 10);
  app.mode = mode;
  app.band = mode === 'demo' ? new SimBand({ saveBatch, leverMm }) : new BandConnection({ saveBatch, leverMm });
  attach(app.band);
  app.settings.demo = mode === 'demo';
  db.saveSettings(app.settings);
  try {
    await app.band.connect();
  } catch (err) {
    if (err.name !== 'NotFoundError') toast(`Couldn't connect: ${err.message}`);  // NotFoundError = picker cancelled
    app.band = null;
    app.mode = null;
    onState({ state: 'disconnected' });
  }
}

function disconnect() {
  app.band?.disconnect();
  app.band = null;
  app.mode = null;
  app.settings.demo = false;
  db.saveSettings(app.settings);
  onState({ state: 'disconnected' });
}

function onState({ state }) {
  app.state = state;
  if (state !== 'connected') app.lastLive = null;
  renderConn();
  renderHero();
}

function renderConn() {
  const pill = $('#connPill');
  const state = app.state || 'disconnected';
  pill.dataset.state = state;
  const name = app.mode === 'demo' ? 'Demo band' : 'Band';
  $('#connText').textContent = {
    connected: `${name} connected`, connecting: 'Connecting…', reconnecting: 'Out of range — reconnecting',
    disconnected: 'Not connected',
  }[state];
  let sub = '';
  if (state === 'connected') {
    const bat = app.status?.battery != null ? `🔋 ${app.status.battery}%` : '';
    const sync = app.syncing ? `Syncing… ${app.syncing.received} records received`
      : app.lastSync ? `Synced ${fmtClock(app.lastSync)}` : 'Syncing…';
    sub = [sync, bat].filter(Boolean).join(' · ');
  } else if (state === 'reconnecting') {
    sub = 'The band keeps recording — data syncs when it\'s back in range';
  }
  $('#syncText').textContent = sub;
  const btn = $('#connectBtn');
  btn.textContent = app.band ? (app.mode === 'demo' ? 'Exit demo' : 'Disconnect') : 'Connect band';
  $('#onboarding').hidden = !!app.band;
}

// ---------------------------------------------------------------- live view
let sevChart, ampChart;

function onLive(p) {
  const t = Date.now();
  app.lastLive = { ...p, t };
  app.live.push(app.lastLive);
  while (app.live.length && app.live[0].t < t - LIVE_SPAN_MS) app.live.shift();
  if (app.view === 'live') { renderHero(); renderLiveCharts(); }
}

function renderHero() {
  const p = app.lastLive;
  const hero = $('#hero');
  if (!p || Date.now() - p.t > 6000) {
    hero.dataset.sev = 'none';
    $('#heroNum').textContent = '–';
    $('#heroWord').textContent = app.state === 'connected' ? 'Starting…' : app.state === 'reconnecting' ? 'Band out of range' : 'Waiting for band';
    $('#heroDesc').textContent = app.state === 'connected' ? 'The first reading takes about 3 seconds.'
      : app.state === 'reconnecting' ? 'The band is still recording and will send everything when it reconnects.'
      : 'Severity 0–4 on the same scale neurologists use (UPDRS).';
    for (const id of ['#tFreq', '#tAmp', '#tRatio', '#tAct']) $(id).textContent = '–';
    hero.querySelectorAll('.scale span').forEach((s) => s.classList.remove('on'));
    return;
  }
  hero.dataset.sev = p.severity;
  $('#heroNum').textContent = p.severity;
  $('#heroWord').textContent = p.tremor ? SEVERITY_LABELS[p.severity] : 'No tremor';
  $('#heroDesc').textContent =
    p.tremor ? `Steady ${p.freqHz.toFixed(1)} Hz shake, about ${p.ampCm.toFixed(1)} cm.`
    : p.candidate ? 'Possible tremor — checking that the beat is steady…'
    : p.highFreq ? 'A faster shake (6.5–12 Hz) — not the Parkinson\'s rest-tremor pattern.'
    : p.activityMg > 60 ? 'Hand is moving — normal movement isn\'t counted as tremor.'
    : 'Hand is steady.';
  hero.querySelectorAll('.scale span').forEach((s) => s.classList.toggle('on', +s.dataset.s === p.severity));
  $('#tFreq').textContent = p.candidate ? `${p.freqHz.toFixed(1)} Hz` : '—';
  $('#tAmp').textContent = p.candidate ? `${p.ampCm.toFixed(1)} cm` : '—';
  $('#tRatio').textContent = `${Math.round(p.ratio * 100)}%`;
  $('#tAct').textContent = p.activityMg > 60 ? 'Moving' : p.activityMg > 20 ? 'A little' : 'Still';
}

function renderLiveCharts() {
  const now = Date.now();
  const base = { xMin: now - LIVE_SPAN_MS, xMax: now };
  const pts = app.live.map((p) => ({ x: p.t, y: p.severity, p }));
  sevChart.set({
    ...base,
    series: [{ type: 'step', color: '--series-1', points: pts, maxGap: 5000 }],
    tooltip: ({ x, p }) => `<b>${fmtClock(x)}</b><br>Severity ${p.severity} · ${SEVERITY_LABELS[p.severity]}${p.tremor ? `<br>${p.freqHz.toFixed(1)} Hz, ${p.ampCm.toFixed(1)} cm` : ''}`,
    ariaLabel: `Severity over the last 3 minutes, now ${app.lastLive?.severity ?? 'unknown'}`,
  });
  const maxAmp = Math.max(2, ...app.live.map((p) => p.ampCm));
  ampChart.opts.yMax = Math.ceil(maxAmp);
  ampChart.opts.yTicks = niceTicks(ampChart.opts.yMax);
  ampChart.set({
    ...base,
    series: [{ type: 'line', color: '--series-1', points: app.live.map((p) => ({ x: p.t, y: p.tremor ? p.ampCm : 0, p })), maxGap: 5000 }],
    tooltip: ({ x, p }) => `<b>${fmtClock(x)}</b><br>${p.tremor ? `${p.ampCm.toFixed(1)} cm` : 'no tremor'}`,
    ariaLabel: 'Estimated tremor size over the last 3 minutes',
  });
}

function niceTicks(max) {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : 5;
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

// ---------------------------------------------------------------- doses
async function logDose(t = Date.now()) {
  await db.addDose(t, 'app');
  app.band?.noteDose?.(t);
  toast(`Dose logged at ${fmtClock(t)}`);
  refreshViews();
}

// ---------------------------------------------------------------- day view
let dayChart;

async function renderDay() {
  const today = R.startOfDay(Date.now());
  const day = today + app.dayOffset * R.DAY_MS;
  const end = day + R.DAY_MS;
  const isToday = app.dayOffset === 0;
  $('#dayTitle').textContent = isToday ? 'Today' : app.dayOffset === -1 ? 'Yesterday'
    : new Date(day).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  $('#dayNext').disabled = isToday;

  const [epochs, doses, tests] = await Promise.all([db.epochsBetween(day, end), db.dosesBetween(day, end), db.testsBetween(day, end)]);
  const sum = R.summarize(epochs);
  $('#dayTiles').innerHTML = [
    ['Time monitored', sum ? R.fmtDuration(sum.monitoredMin) : '—'],
    ['Time with tremor', sum ? `${sum.tremorPct.toFixed(0)}%` : '—'],
    ['Average severity', sum ? sum.meanSev.toFixed(1) : '—'],
    ['Worst', sum?.peakT ? `${sum.maxSev} at ${fmtClock(sum.peakT)}` : sum ? 'none' : '—'],
  ].map(([k, v]) => `<div class="tile"><div class="tile-label">${k}</div><div class="tile-val">${v}</div></div>`).join('');

  const bins = R.bin(epochs, day, 10 * 60e3);
  const first = bins.length ? bins[0].x : day + 7 * 3600e3;
  const xMin = Math.min(day + 7 * 3600e3, first - (first % 3600e3));
  const xMax = isToday ? Math.max(Date.now(), xMin + 6 * 3600e3) : end;
  if (!epochs.length) $('#dayChart').dataset.empty = 'No recordings for this day yet.';
  dayChart.set({
    xMin, xMax,
    series: [{ type: 'bars', color: '--series-1', barWidth: 10 * 60e3, points: bins }],
    markers: doses.map((d) => ({ x: d.t, label: '💊', color: '--text-2' })),
    tooltip: (b) => `<b>${fmtClock(b.x)}–${fmtClock(b.x + 600e3)}</b><br>Average severity ${b.y.toFixed(1)} · worst ${b.max}<br>Tremor ${b.tremorPct.toFixed(0)}% of the time${b.ampCm ? `<br>Size ≈ ${b.ampCm.toFixed(1)} cm` : ''}`,
    ariaLabel: `Tremor severity through ${$('#dayTitle').textContent}`,
  });
  $('#dayTable').innerHTML = bins.length ? `<div class="table-scroll"><table class="data"><tr><th>Time</th><th>Avg severity</th><th>Worst</th><th>% tremor</th><th>Size (cm)</th></tr>${
    bins.map((b) => `<tr><td>${fmtClock(b.x)}</td><td>${b.y.toFixed(2)}</td><td>${b.max}</td><td>${b.tremorPct.toFixed(0)}%</td><td>${b.ampCm ? b.ampCm.toFixed(1) : '—'}</td></tr>`).join('')
  }</table></div>` : '<p class="empty">No data.</p>';

  // doses + wear-off
  const wo = R.wearOff(await db.epochsBetween(day - 6 * 3600e3, end + 6 * 3600e3), doses);
  const woByDose = new Map(wo.map((w) => [w.dose, w]));
  $('#dayDoses').innerHTML = `${doses.length ? `<table class="data"><tr><th>Dose</th><th>Started working</th><th>Tremor came back</th><th></th></tr>${
    doses.sort((a, b) => a.t - b.t).map((d) => {
      const w = woByDose.get(d.t);
      const back = !w ? 'not enough data' : w.wearOffMin != null ? `after ${R.fmtDuration(w.wearOffMin)}` : w.untilNextMin ? 'not before next dose ✓' : '—';
      return `<tr><td>${fmtClock(d.t)} <span class="badge">${d.source === 'band' ? 'band button' : 'app'}</span></td>
        <td>${w?.onsetMin != null ? `after ${R.fmtDuration(w.onsetMin)}` : '—'}</td><td>${back}</td>
        <td>${d.source === 'app' ? `<button class="btn" data-del-dose="${esc(d.id)}" aria-label="Delete dose">✕</button>` : ''}</td></tr>`;
    }).join('')}</table>` : '<p class="empty">No doses logged this day. Tap “Took my dose” (or press the band\'s button) when taking medication.</p>'}
    <div class="row" style="margin-top:10px"><label class="small muted" for="missedDose">Forgot to log one?</label>
    <input type="time" id="missedDose" class="btn"> <button class="btn" id="addMissedDose">Add dose</button></div>`;
  $('#dayDoses').querySelectorAll('[data-del-dose]').forEach((b) => b.addEventListener('click', async () => {
    await db.deleteDose(b.dataset.delDose);
    renderDay();
  }));
  $('#addMissedDose').addEventListener('click', () => {
    const v = $('#missedDose').value;
    if (!v) return;
    const [h, m] = v.split(':').map(Number);
    logDose(day + (h * 60 + m) * 60e3);
  });

  $('#dayTests').innerHTML = tests.length ? testTable(tests) : '<p class="empty">No tests this day.</p>';
}

function testTable(tests) {
  return `<table class="data"><tr><th>Time</th><th>Test</th><th>Result</th><th>Passive reading</th></tr>${
    tests.sort((a, b) => b.t - a.t).map((t) => `<tr><td>${fmtDate(t.t)} ${fmtClock(t.t)}</td><td>${byId(t.kind)?.name ?? t.kind}</td>
      <td>${headline(t.kind, t.result).text}</td><td>${t.context?.severity != null ? sevChip(t.context.severity) : '—'}</td></tr>`).join('')
  }</table>`;
}

// ---------------------------------------------------------------- tests view
let trendChart, runner;

function renderTestCards() {
  $('#testCards').innerHTML = TESTS.map((t) => `<div class="card test-card">
    <div class="where">${t.where === 'band' ? 'Wristband' : 'On screen'} · ${t.seconds} s</div>
    <h3>${t.name}</h3><p>${t.blurb}</p>
    <button class="btn primary" data-test="${t.id}">Start</button></div>`).join('');
  $('#testCards').querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => runner.open(b.dataset.test)));
  $('#trendSelect').innerHTML = TESTS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  $('#trendSelect').addEventListener('change', renderTests);
}

async function renderTests() {
  const tests = await db.testsBetween(Date.now() - 60 * R.DAY_MS, Date.now() + 1);
  const kind = $('#trendSelect').value;
  const pts = tests.filter((t) => t.kind === kind).sort((a, b) => a.t - b.t)
    .map((t) => ({ x: t.t, y: headline(kind, t.result).value, t }));
  const unit = pts[0] ? headline(kind, pts[0].t.result).unit : '';
  const maxY = kind === 'rest' || kind === 'postural' ? 4 : Math.max(1, Math.ceil(Math.max(...pts.map((p) => p.y), 0) * 1.2));
  trendChart.opts.yMax = maxY;
  trendChart.opts.yTicks = niceTicks(maxY);
  const xMin = pts.length ? Math.min(pts[0].x, Date.now() - 7 * R.DAY_MS) : Date.now() - 7 * R.DAY_MS;
  trendChart.set({
    xMin, xMax: Date.now(),
    series: [{ type: 'line', color: '--series-1', dots: true, points: pts }],
    tooltip: ({ x, t }) => `<b>${fmtDate(x)} ${fmtClock(x)}</b><br>${headline(kind, t.result).text}${t.context?.severity != null ? `<br>Passive severity then: ${t.context.severity}` : ''}`,
    ariaLabel: `${byId(kind).name} trend in ${unit}`,
  });
  $('#testHistory').innerHTML = tests.length ? testTable(tests.slice(-20)) : '<p class="empty">No tests yet. Pick one above to start.</p>';
}

// ---------------------------------------------------------------- report view
let patternChart;

async function renderReport() {
  const days = +$('#rangeSelect').value;
  const end = R.startOfDay(Date.now()) + R.DAY_MS;
  const start = end - days * R.DAY_MS;
  const [epochs, doses, tests] = await Promise.all([db.epochsBetween(start, end), db.dosesBetween(start, end), db.testsBetween(start, end)]);
  const sum = R.summarize(epochs);
  const wo = R.wearOff(epochs, doses);
  const offs = wo.filter((w) => w.wearOffMin != null).map((w) => w.wearOffMin).sort((a, b) => a - b);
  const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
  const ons = wo.filter((w) => w.onsetMin != null).map((w) => w.onsetMin).sort((a, b) => a - b);

  $('#reportMeta').textContent = `${fmtDate(start)} – ${fmtDate(end - 1)} · generated ${new Date().toLocaleString()} · ${app.settings.wrist} wrist`;
  $('#reportTiles').innerHTML = [
    ['Hours monitored', sum ? (sum.monitoredMin / 60).toFixed(0) : '—'],
    ['Time with tremor', sum ? `${sum.tremorPct.toFixed(0)}%` : '—'],
    ['Average severity', sum ? sum.meanSev.toFixed(2) : '—'],
    ['Dose lasts (median)', offs.length ? R.fmtDuration(median(offs)) : '—'],
  ].map(([k, v]) => `<div class="tile"><div class="tile-label">${k}</div><div class="tile-val">${v}</div></div>`).join('');

  const pattern = R.hourlyPattern(epochs);
  patternChart.set({
    xMin: 0, xMax: 23,
    series: [{ type: 'line', color: '--series-1', dots: true, points: pattern.map((p) => ({ ...p, y: p.y })) }],
    tooltip: (p) => p.y == null ? `${p.x}:00 — no data` : `<b>${String(p.x).padStart(2, '0')}:00–${String(p.x + 1).padStart(2, '0')}:00</b><br>Average severity ${p.y.toFixed(2)}<br>Tremor ${p.tremorPct.toFixed(0)}% of the time<br>${p.hours.toFixed(1)} h of data`,
    ariaLabel: 'Average tremor severity by hour of day',
  });

  const rows = [];
  for (let d = end - R.DAY_MS; d >= start; d -= R.DAY_MS) {
    const e = epochs.filter((x) => x.t > d && x.t <= d + R.DAY_MS);
    const s = R.summarize(e);
    if (!s) continue;
    rows.push(`<tr><td>${new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td>
      <td>${R.fmtDuration(s.monitoredMin)}</td><td>${s.tremorPct.toFixed(0)}%</td><td>${s.meanSev.toFixed(2)}</td>
      <td>${s.peakT ? `${s.maxSev} at ${fmtClock(s.peakT)}` : '0'}</td>
      <td>${doses.filter((x) => x.t >= d && x.t < d + R.DAY_MS).length}</td>
      <td>${tests.filter((x) => x.t >= d && x.t < d + R.DAY_MS).length}</td></tr>`);
  }
  $('#reportDays').innerHTML = rows.length ? `<div class="table-scroll"><table class="data"><tr><th>Day</th><th>Monitored</th><th>% tremor</th><th>Avg severity</th><th>Worst</th><th>Doses</th><th>Tests</th></tr>${rows.join('')}</table></div>`
    : '<p class="empty">No recordings in this range.</p>';

  const returned = wo.filter((w) => w.wearOffMin != null && (w.untilNextMin == null || w.wearOffMin < w.untilNextMin)).length;
  $('#reportDoses').innerHTML = wo.length ? `<table class="kv">
      <tr><th>Doses with enough data</th><td>${wo.length}</td></tr>
      <tr><th>Typical time until it works</th><td>${R.fmtDuration(median(ons))}</td></tr>
      <tr><th>Typical time until tremor returns</th><td>${R.fmtDuration(median(offs))}</td></tr>
      <tr><th>Tremor came back <em>before</em> the next dose<small>possible "wearing-off"</small></th><td>${returned} of ${wo.length}</td></tr>
    </table>` : '<p class="empty">Log doses (app button or the band\'s button) to see how long each one lasts.</p>';

  const byKind = TESTS.map((t) => {
    const list = tests.filter((x) => x.kind === t.id).sort((a, b) => a.t - b.t);
    if (!list.length) return '';
    const vals = list.map((x) => headline(t.id, x.result).value);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return `<tr><td>${t.name}</td><td>${list.length}</td><td>${avg.toFixed(2)} ${headline(t.id, list[0].result).unit}</td><td>${headline(t.id, list.at(-1).result).text}</td></tr>`;
  }).join('');
  $('#reportTests').innerHTML = byKind ? `<table class="data"><tr><th>Test</th><th>Times done</th><th>Average</th><th>Latest</th></tr>${byKind}</table>` : '<p class="empty">No active tests in this range.</p>';
}

async function exportCsv(kind) {
  const days = +$('#rangeSelect').value;
  const end = Date.now() + 1, start = R.startOfDay(Date.now()) - (days - 1) * R.DAY_MS;
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'epochs') R.download(`tremor-records-${stamp}.csv`, R.epochsCsv(await db.epochsBetween(start, end)));
  if (kind === 'doses') R.download(`doses-${stamp}.csv`, R.dosesCsv(await db.dosesBetween(start, end)));
  if (kind === 'tests') R.download(`tests-${stamp}.csv`, R.testsCsv(await db.testsBetween(start, end)));
}

// ---------------------------------------------------------------- settings
async function renderSettings() {
  $('#leverInput').value = app.settings.leverCm;
  $('#leverVal').textContent = `${app.settings.leverCm} cm`;
  $('#wristSelect').value = app.settings.wrist;
  const s = app.status;
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  $('#deviceInfo').innerHTML = s ? [
    row('Mode', s.sim ? 'Simulated sensor' : 'Real sensor'),
    row('Motion sensor', s.imuOk ? 'OK' : '⚠ not found — check wiring'),
    row('Flash storage', s.storageOk ? 'OK' : '⚠ error'),
    row('Clock set', s.timeSynced ? 'Yes' : 'Not yet'),
    row('Battery', s.battery != null ? `${s.battery}%${s.batteryMv ? ` (${(s.batteryMv / 1000).toFixed(2)} V)` : ''}` : 'not measured'),
    row('Records waiting on band', s.pending),
    row('Firmware / protocol', `v${s.fw} / v${s.proto}`),
    row('Boot count', s.boot),
    row('Store ID', s.storeId.toString(16).padStart(8, '0')),
  ].join('') : row('Status', 'Not connected');
  const [n, unplaced, first] = await Promise.all([db.epochCount(), db.unplacedCount(), db.firstEpochTime()]);
  $('#dataInfo').innerHTML = [
    row('30-second records', n.toLocaleString()),
    row('≈ hours of monitoring', ((n * 30) / 3600).toFixed(1)),
    row('Since', first ? fmtDate(first) : '—'),
    ...(unplaced ? [row('Records without a clock time', unplaced)] : []),
  ].join('');
}

// ---------------------------------------------------------------- views
function renderView(v) {
  if (v === 'live') { renderHero(); renderLiveCharts(); }
  if (v === 'day') renderDay();
  if (v === 'tests') renderTests();
  if (v === 'report') renderReport();
  if (v === 'settings') renderSettings();
}

function show(v) {
  if (!document.getElementById(`view-${v}`)) v = 'live';
  app.view = v;
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== `view-${v}`));
  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === v));
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
  renderView(v);
}

// ---------------------------------------------------------------- init
function init() {
  const sevOpts = { height: 200, yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], xFormat: fmtClock, xTicks: timeTicks };
  sevChart = new Chart($('#liveSevChart'), sevOpts);
  ampChart = new Chart($('#liveAmpChart'), { ...sevOpts, height: 160, yMax: 2, yTicks: [0, 1, 2] });
  dayChart = new Chart($('#dayChart'), { ...sevOpts, height: 240 });
  trendChart = new Chart($('#trendChart'), { height: 200, yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], xFormat: fmtDate, xTicks: (a, b, w) => timeTicks(a, b, w).filter((t) => new Date(t).getHours() === 0) });
  patternChart = new Chart($('#patternChart'), { height: 220, yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], xFormat: (h) => `${String(h).padStart(2, '0')}:00`, xTicks: () => [0, 3, 6, 9, 12, 15, 18, 21] });

  runner = new TestRunner($('#modal'), {
    getBand: () => app.band,
    getContext: () => (app.lastLive && Date.now() - app.lastLive.t < 10000 ? { severity: app.lastLive.severity, ampCm: app.lastLive.ampCm } : {}),
    onSaved: async (t) => { const saved = await db.addTest(t); refreshViews(); return saved; },
  });
  renderTestCards();

  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#connectBtn').addEventListener('click', () => (app.band ? disconnect() : connect('ble')));
  document.querySelector('[data-action=connect]').addEventListener('click', () => connect('ble'));
  document.querySelector('[data-action=demo]').addEventListener('click', () => connect('demo'));
  $('#doseBtn').addEventListener('click', () => logDose());
  $('#dayPrev').addEventListener('click', () => { app.dayOffset--; renderDay(); });
  $('#dayNext').addEventListener('click', () => { app.dayOffset = Math.min(0, app.dayOffset + 1); renderDay(); });
  $('#rangeSelect').addEventListener('change', renderReport);
  $('#printBtn').addEventListener('click', () => window.print());
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportCsv(b.dataset.export)));
  $('#leverInput').addEventListener('input', (e) => { $('#leverVal').textContent = `${e.target.value} cm`; });
  $('#leverInput').addEventListener('change', (e) => {
    app.settings.leverCm = +e.target.value;
    db.saveSettings(app.settings);
    app.band?.setLever(Math.round(app.settings.leverCm * 10));
    toast('Hand size saved');
  });
  $('#wristSelect').addEventListener('change', (e) => { app.settings.wrist = e.target.value; db.saveSettings(app.settings); });
  $('#clearAppBtn').addEventListener('click', async () => {
    if (await confirmModal('Delete all data?', 'This removes every recording, dose and test result stored in this browser. The band\'s own memory is not affected.', 'Delete')) {
      await db.clearAll();
      toast('All app data deleted');
      renderSettings();
    }
  });
  $('#eraseBandBtn').addEventListener('click', async () => {
    if (!app.band || app.state !== 'connected') { toast('Connect the band first'); return; }
    if (await confirmModal('Erase band memory?', 'Records on the band that haven\'t synced yet will be lost.', 'Erase')) {
      await app.band.erase();
      toast('Band memory erased');
    }
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') runner.close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) runner.close(); });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  if (!BandConnection.supported()) {
    $('#btSupport').innerHTML = window.isSecureContext
      ? 'This browser can\'t use Bluetooth. Use Chrome or Edge (Windows, Mac, Linux, Android) or the Bluefy browser on iPhone — or try the demo.'
      : 'Bluetooth needs a secure page: open this app via https:// or http://localhost.';
    document.querySelector('[data-action=connect]').disabled = true;
  }

  setInterval(() => { if (app.view === 'live') { renderHero(); if (!app.lastLive) renderLiveCharts(); } }, 2000);
  renderConn();
  show(location.hash.slice(1) || 'live');

  // pick up where we left off
  if (app.settings.demo) connect('demo');
  else if (BandConnection.supported()) {
    const band = new BandConnection({ saveBatch, leverMm: Math.round(app.settings.leverCm * 10) });
    attach(band);
    band.reconnectKnown().then((found) => { if (found) { app.band = band; app.mode = 'ble'; renderConn(); } }).catch(() => {});
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
