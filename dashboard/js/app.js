import { BandConnection } from './ble.js';
import { SimBand } from './sim.js';
import * as db from './store.js';
import { Chart, fmtClock, fmtDate, timeTicks } from './chart.js';
import { TESTS, TestRunner, byId, headline, detailRows } from './tests.js';
import * as R from './report.js';
import { learnModel, predict, backtest, SLOTS } from './wearoff.js';
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
  model: null,          // personal wearing-off model (wearoff.js)
  lastDose: null,       // most recent dose {t, source}
  alertShown: null,     // key of the alert currently on screen (for notifications)
  sentToBand: null,     // last model/dose sent to the band
};

// ---------------------------------------------------------------- helpers
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function confirmModal(title, body, okLabel, safe = false) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.querySelector('.modal-box').innerHTML = `<h2>${title}</h2><p>${body}</p>
      <div class="modal-actions"><button class="btn ${safe ? '' : 'primary'}" data-r="0">Cancel</button><button class="btn ${safe ? 'primary' : 'danger'}" data-r="1">${okLabel}</button></div>`;
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
  refreshModelSoon();
}

function attach(band) {
  band.addEventListener('state', (e) => onState(e.detail));
  band.addEventListener('live', (e) => onLive(e.detail));
  band.addEventListener('status', (e) => {
    app.status = e.detail;
    renderConn();
    renderAlert();
    if (app.view === 'settings') renderSettings();
  });
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
  if (state === 'connected') { app.sentToBand = null; pushModelToBand(); }
  renderConn();
  renderHero();
  renderAlert();
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
let lastChartDraw = 0;
const CHART_REFRESH_MS = 5000;

function onLive(p) {
  const t = Date.now();
  app.lastLive = { ...p, t };
  app.live.push(app.lastLive);
  while (app.live.length && app.live[0].t < t - LIVE_SPAN_MS) app.live.shift();
  if (app.view === 'live') {
    renderHero();
    if (t - lastChartDraw > CHART_REFRESH_MS) { lastChartDraw = t; renderLiveCharts(); }  // slow redraw: no constant scrolling
  }
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
    : p.armRhythm ? 'Rhythmic arm movement (like brushing or stirring) — it comes from the elbow or shoulder, not the wrist, so it isn\'t counted.'
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
  ampChart.opts.yMax = Math.max(ampChart.opts.yMax, Math.ceil(maxAmp / 2) * 2);  // only ever grows: no rescaling jumps
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
  await refreshModel();  // picks the new dose up, sends its timing + the dose to the band
  toast(`Dose logged at ${fmtClock(t)}`);
  refreshViews();
}

// ---------------------------------------------------------------- medicine & wearing-off
const MODEL_DAYS = 22;

async function refreshModel() {
  const now = Date.now();
  const from = now - MODEL_DAYS * R.DAY_MS;
  const [epochs, doses] = await Promise.all([db.epochsBetween(from, now + 1), db.dosesBetween(from, now + 1)]);
  app.model = learnModel(epochs, doses, { now });
  app.lastDose = doses.filter((d) => d.t <= now).sort((a, b) => a.t - b.t).at(-1) ?? null;
  pushModelToBand();
  renderMedicine();
  renderAlert();
  renderCheckin();
}
const refreshModelSoon = debounce(refreshModel, 1500);

// The band runs the warning itself (works when the phone is away): give it the
// timing for the latest dose's time of day, and the dose itself.
function pushModelToBand() {
  const band = app.band;
  if (!band || app.state !== 'connected' || !band.setWearOff) return;
  const d = app.lastDose;
  const p = d ? predict(app.model, d.t) : null;
  const o = app.model?.ok ? app.model.overall : null;
  const warn = p?.warnAfterMin ?? o?.warnAfterMin ?? 0, typ = p?.typicalMin ?? o?.typicalMin ?? 0;
  const key = `${warn}/${typ}/${d?.t ?? 0}`;
  if (key === app.sentToBand) return;
  app.sentToBand = key;
  band.setWearOff(warn, typ);
  if (d && Date.now() - d.t < 8 * 3600e3) band.noteDose(d.t);
}

const recentDose = () => (app.lastDose && Date.now() - app.lastDose.t < 6 * 3600e3 ? app.lastDose : null);

function renderMedicine() {
  const d = app.lastDose, m = app.model, now = Date.now();
  const wrap = $('#doseTrackWrap');
  const n = m?.overall?.n ?? 0;
  $('#medNote').textContent = m?.ok ? `learned from ${n} doses` : '';
  if (!d) {
    $('#medLine1').textContent = 'No medicine logged yet. Press “I took my medicine” each time you take it.';
    $('#medLine2').textContent = 'After about 4 doses with the band on, the app learns when your medicine usually wears off.';
    wrap.hidden = true;
    return;
  }
  const mins = (now - d.t) / 60e3;
  if (mins >= 6 * 60) {
    $('#medLine1').textContent = `Last dose: ${fmtDate(d.t)} at ${fmtClock(d.t)} — no dose in the last 6 hours.`;
    wrap.hidden = true;
  } else {
    $('#medLine1').textContent = `Last dose at ${fmtClock(d.t)}, ${R.fmtDuration(mins)} ago${d.source === 'band' ? ' (band button)' : ''}.`;
  }
  const p = predict(m, d.t);
  if (!p) {
    $('#medLine2').textContent = `Learning when your medicine wears off: ${n} of 4 doses with enough recordings so far.`;
    wrap.hidden = true;
    return;
  }
  const e = m.slots[p.slot] ?? m.overall;
  const when = p.slotSpecific ? `${/^[aeiou]/.test(p.slot) ? 'an' : 'a'} ${p.slot} dose` : 'a dose';
  $('#medLine2').textContent = !e.medianReached
    ? `Most of your doses last until the next one (at least ${R.fmtDuration(p.typicalMin)}). You'll get a reminder ${R.fmtDuration(p.warnAfterMin)} after a dose, when some doses have started to wear off.`
    : mins < 6 * 60
      ? `Tremor usually comes back about ${R.fmtDuration(p.typicalMin)} after ${when} — around ${fmtClock(p.returnAt)}. ${now < p.warnAt ? `Reminder at ${fmtClock(p.warnAt)}${app.state === 'connected' ? ' (the band will blink too)' : ''}.` : `The reminder time was ${fmtClock(p.warnAt)}.`}`
      : `Tremor usually comes back about ${R.fmtDuration(p.typicalMin)} after ${when}.`;
  if (mins >= 6 * 60) { wrap.hidden = true; return; }
  // dose cycle bar: starting to work -> working -> may wear off -> usually worn off; marker = now
  const span = Math.max(p.typicalMin + 45, mins + 10);
  const pct = (v) => `${(100 * Math.min(v, span)) / span}%`;
  const segs = [['kick', 0, p.kickInMin], ['on', p.kickInMin, p.warnAfterMin], ['warn', p.warnAfterMin, p.typicalMin], ['after', p.typicalMin, span]];
  $('#doseTrack').innerHTML = segs.map(([c, a, b]) => `<span class="${c}" style="width:${pct(Math.max(0, b - a))}"></span>`).join('');
  $('#doseNow').style.left = pct(mins);
  $('#doseScale').innerHTML = `<span style="left:0">${fmtClock(d.t)}</span><span style="left:${pct(p.typicalMin)}">${fmtClock(p.returnAt)}</span><span style="left:100%">${fmtClock(d.t + span * 60e3)}</span>`;
  wrap.hidden = false;
}

// Alert: the band is the source of truth while connected (it also catches tremor coming
// back EARLY); otherwise the app warns from the learned timing alone.
function currentAlert() {
  const now = Date.now();
  if (app.state === 'connected' && app.status) {
    return app.status.alert ? { kind: app.status.alertEarly ? 'early' : 'time', source: 'band' } : null;
  }
  const d = recentDose();
  const p = d && predict(app.model, d.t);
  if (p && now >= p.warnAt && now < p.returnAt + 3600e3 && app.settings.dismissedDose !== d.t) return { kind: 'time', source: 'app' };
  return null;
}

function renderAlert() {
  const a = currentAlert();
  const banner = $('#alertBanner');
  if (!a) { banner.hidden = true; app.alertShown = null; return; }
  const d = app.lastDose;
  const p = d && predict(app.model, d.t);
  const ago = d ? R.fmtDuration((Date.now() - d.t) / 60e3) : '';
  let title, text;
  if (a.kind === 'early') {
    title = 'Tremor is coming back';
    const early = p && Date.now() < p.returnAt;
    text = d ? `The band has picked up steady tremor ${ago} after your ${fmtClock(d.t)} dose${early ? ' — earlier than usual' : ''}. Check your medication plan.`
      : 'The band has picked up steady tremor again. Check your medication plan.';
  } else {
    title = 'Your medicine usually starts wearing off about now';
    text = d && p ? `Last dose ${fmtClock(d.t)} (${ago} ago). Tremor usually comes back around ${fmtClock(p.returnAt)}. Check your medication plan.`
      : 'Going by your usual pattern, tremor tends to come back soon. Check your medication plan.';
  }
  $('#alertTitle').textContent = title;
  $('#alertText').textContent = text;
  banner.hidden = false;
  const key = `${a.kind}-${d?.t ?? 0}`;
  if (app.alertShown !== key) {
    app.alertShown = key;
    if (app.settings.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('TremorBand', { body: `${title}. ${text}`, icon: 'icons/icon.svg', tag: 'wearoff' }); } catch { /* ignore */ }
    }
  }
}

function dismissAlert() {
  if (app.state === 'connected') app.band?.dismissAlert?.();
  if (app.lastDose) { app.settings.dismissedDose = app.lastDose.t; db.saveSettings(app.settings); }
  $('#alertBanner').hidden = true;
}

// Check-ins: short tests timed around each dose ("is it working?" ~1 h after, and just
// before it usually wears off), so test scores can be read against the dose cycle.
function currentCheckin() {
  const d = recentDose();
  if (!d) return null;
  const now = Date.now(), m = (now - d.t) / 60e3;
  const done = app.settings.checkins?.[d.t] ?? [];
  const p = predict(app.model, d.t);
  if (m >= 60 && m < 90 && !done.includes('on')) {
    return { kind: 'on', title: 'Quick check: is your medicine working?', text: 'About an hour after a dose is a good time for a short test. It takes 10–30 seconds.' };
  }
  if (p && now >= p.warnAt - 10 * 60e3 && now < p.warnAt + 30 * 60e3 && !done.includes('wearing')) {
    return { kind: 'wearing', title: 'Quick check before your medicine wears off', text: `Your dose usually wears off around ${fmtClock(p.returnAt)}. A short test now shows how you're doing.` };
  }
  return null;
}

function markCheckin(kind) {
  const d = app.lastDose;
  if (!d) return;
  const c = app.settings.checkins ?? {};
  for (const k of Object.keys(c)) if (+k < Date.now() - 2 * R.DAY_MS) delete c[k];  // keep it small
  c[d.t] = [...new Set([...(c[d.t] ?? []), kind])];
  app.settings.checkins = c;
  db.saveSettings(app.settings);
}

function renderCheckin() {
  const c = currentCheckin();
  const card = $('#checkinCard');
  if (!c) { card.hidden = true; return; }
  $('#checkinTitle').textContent = c.title;
  $('#checkinText').textContent = c.text;
  const bandOk = app.state === 'connected';
  $('#checkinActions').innerHTML = `<button class="btn" data-checkin="skip">Not now</button>
    <button class="btn primary" data-checkin="tapping">Finger tapping (10 s)</button>
    ${bandOk ? '<button class="btn primary" data-checkin="rest">Rest tremor check (30 s)</button>' : ''}`;
  card.querySelectorAll('[data-checkin]').forEach((b) => b.addEventListener('click', () => {
    markCheckin(c.kind);
    card.hidden = true;
    if (b.dataset.checkin !== 'skip') runner.open(b.dataset.checkin);
  }));
  card.hidden = false;
}

// minutes since the last dose and which check-in (if any) a test belongs to
function doseContext() {
  const d = app.lastDose;
  if (!d) return {};
  const m = Math.round((Date.now() - d.t) / 60e3);
  return { minSinceDose: m, doseT: d.t };
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
    [sum ? `Tremor-free (${(100 - sum.tremorPct).toFixed(0)}%)` : 'Tremor-free time', sum ? R.fmtDuration(sum.monitoredMin * (1 - sum.tremorPct / 100)) : '—'],
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
let patternChart, freeChart;

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

  const freeDays = [];
  for (let d = start; d < end; d += R.DAY_MS) {
    const s = R.summarize(epochs.filter((x) => x.t > d && x.t <= d + R.DAY_MS));
    if (s) freeDays.push({ x: d, y: (s.monitoredMin * (1 - s.tremorPct / 100)) / 60, monitoredH: s.monitoredMin / 60, pct: 100 - s.tremorPct });
  }
  const maxFree = Math.max(4, ...freeDays.map((f) => f.monitoredH));
  freeChart.opts.yMax = Math.ceil(maxFree / 4) * 4;
  freeChart.opts.yTicks = Array.from({ length: freeChart.opts.yMax / 4 + 1 }, (_, i) => i * 4);
  freeChart.set({
    xMin: start, xMax: end,
    series: [{ type: 'bars', color: '--series-1', barWidth: R.DAY_MS, points: freeDays }],
    tooltip: (f) => `<b>${fmtDate(f.x)}</b><br>${R.fmtDuration(f.y * 60)} tremor-free (${f.pct.toFixed(0)}%)<br>of ${R.fmtDuration(f.monitoredH * 60)} monitored`,
    ariaLabel: 'Hours without tremor per day',
  });

  $('#reportMeta').textContent = `${fmtDate(start)} – ${fmtDate(end - 1)} · generated ${new Date().toLocaleString()} · ${app.settings.wrist} wrist`;
  $('#reportTiles').innerHTML = [
    ['Hours monitored', sum ? (sum.monitoredMin / 60).toFixed(0) : '—'],
    ['Tremor-free per day', freeDays.length ? R.fmtDuration(freeDays.reduce((a, x) => a + x.y, 0) / freeDays.length * 60) : '—'],
    ['Average severity', sum ? sum.meanSev.toFixed(2) : '—'],
    ['Dose lasts (typical)', app.model?.ok ? `${app.model.overall.medianReached ? '' : '≥ '}${R.fmtDuration(app.model.overall.typicalMin)}` : offs.length ? R.fmtDuration(median(offs)) : '—'],
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
    </table>${learnedHtml(epochs, doses)}` : '<p class="empty">Log doses (app button or the band\'s button) to see how long each one lasts.</p>';

  const byKind = TESTS.map((t) => {
    const list = tests.filter((x) => x.kind === t.id).sort((a, b) => a.t - b.t);
    if (!list.length) return '';
    const vals = list.map((x) => headline(t.id, x.result).value);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return `<tr><td>${t.name}</td><td>${list.length}</td><td>${avg.toFixed(2)} ${headline(t.id, list[0].result).unit}</td><td>${headline(t.id, list.at(-1).result).text}</td></tr>`;
  }).join('');
  $('#reportTests').innerHTML = byKind ? `<table class="data"><tr><th>Test</th><th>Times done</th><th>Average</th><th>Latest</th></tr>${byKind}</table>${testsByDoseHtml(tests)}` : '<p class="empty">No active tests in this range.</p>';
}

// Learned wear-off timing per time of day, and how well the warning would have worked.
function learnedHtml(epochs, doses) {
  const m = app.model;
  if (!m?.ok) return `<p class="muted small" style="margin-top:12px">The personal wear-off model needs at least 4 doses with recordings (has ${m?.overall?.n ?? 0}).</p>`;
  const fmt = (e) => `${e.medianReached ? '' : '≥ '}${R.fmtDuration(e.typicalMin)}`;
  const rows = [['All doses', m.overall], ...SLOTS.filter((s) => m.slots[s.id]).map((s) => [s.label, m.slots[s.id]])]
    .map(([label, e]) => `<tr><td>${label}</td><td>${e.n}</td><td>${R.fmtDuration(e.kickInMin)}</td><td>${fmt(e)}</td><td>${e.earliestMin != null ? R.fmtDuration(e.earliestMin) : '—'}</td><td>${R.fmtDuration(e.warnAfterMin)}</td></tr>`).join('');
  const b = backtest(epochs, doses);
  const L = b.learned, F = b.fixedRule;
  const v = (x, unit = '') => (x == null ? '—' : `${x}${unit}`);
  const bt = L.returns ? `<h4>How well the warning would have worked</h4>
    <p class="muted small">Each past dose predicted using only the doses before it, then compared with what happened.</p>
    <table class="data"><tr><th></th><th>Learned for this patient</th><th>Fixed rule: every dose lasts ${R.fmtDuration(b.fixedRuleMin)}</th></tr>
      <tr><td>Typical error in when tremor returns</td><td>${v(L.maeMin, ' min')}</td><td>${v(F.maeMin, ' min')}</td></tr>
      <tr><td>Warned before tremor came back</td><td>${v(L.warnedPct, '%')} of ${L.returns}</td><td>${v(F.warnedPct, '%')} of ${F.returns}</td></tr>
      <tr><td>Warning came this much earlier (median)</td><td>${v(L.medianLeadMin, ' min')}</td><td>${v(F.medianLeadMin, ' min')}</td></tr>
      <tr><td>Warned when tremor didn't come back</td><td>${v(L.unneededPct, '%')}</td><td>${v(F.unneededPct, '%')}</td></tr>
    </table>` : '';
  return `<h4>Learned dose timing (last 21 days, Kaplan–Meier)</h4>
    <table class="data"><tr><th>Doses</th><th>n</th><th>Starts working</th><th>Usually wears off</th><th>Earliest (1 in 4)</th><th>Reminder after</th></tr>${rows}</table>${bt}`;
}

// Test results grouped by time since the dose: shows the dose cycle in active tests too.
function testsByDoseHtml(tests) {
  const buckets = [[0, 60, '0–1 h'], [60, 120, '1–2 h'], [120, 180, '2–3 h'], [180, 1e9, '3 h +']];
  const rows = TESTS.map((t) => {
    const list = tests.filter((x) => x.kind === t.id && x.context?.minSinceDose != null && x.context.minSinceDose < 6 * 60);
    if (list.length < 2) return '';
    const cells = buckets.map(([a, b]) => {
      const vals = list.filter((x) => x.context.minSinceDose >= a && x.context.minSinceDose < b).map((x) => headline(t.id, x.result).value);
      return `<td>${vals.length ? `${(vals.reduce((p, q) => p + q, 0) / vals.length).toFixed(1)} <small class="muted">(${vals.length})</small>` : '—'}</td>`;
    }).join('');
    return `<tr><td>${t.name} <small class="muted">${headline(t.id, list[0].result).unit}</small></td>${cells}</tr>`;
  }).join('');
  return rows ? `<h4>By time since the last dose</h4><table class="data"><tr><th>Test</th>${buckets.map((b) => `<th>${b[2]}</th>`).join('')}</tr>${rows}</table>` : '';
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
  const m = app.model;
  const notifyState = !('Notification' in window) ? 'not supported by this browser'
    : Notification.permission === 'granted' && app.settings.notify ? 'on' : Notification.permission === 'denied' ? 'blocked in browser settings' : 'off';
  $('#reminderInfo').innerHTML = [
    ...(m?.ok ? [
      row('Learned from', `${m.overall.n} doses (${m.overall.events} where tremor came back)`),
      row('Usually wears off after', `${m.overall.medianReached ? '' : 'at least '}${R.fmtDuration(m.overall.typicalMin)}`),
      row('Reminder after', R.fmtDuration(m.overall.warnAfterMin)),
      ...SLOTS.filter((s) => m.slots[s.id]).map((s) => row(s.label, `${R.fmtDuration(m.slots[s.id].typicalMin)}, reminder after ${R.fmtDuration(m.slots[s.id].warnAfterMin)}`)),
    ] : [row('Status', `Learning — ${m?.overall?.n ?? 0} of 4 doses with enough recordings`)]),
    row('Notifications on this device', notifyState),
  ].join('');
  $('#notifyBtn').hidden = notifyState === 'on' || notifyState.startsWith('not supported');
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
  freeChart = new Chart($('#freeChart'), { height: 200, yMin: 0, yMax: 16, yTicks: [0, 4, 8, 12, 16], yFormat: (h) => `${h} h`, xFormat: fmtDate, xTicks: (a, b, w) => timeTicks(a, b, w).filter((t) => new Date(t).getHours() === 0) });
  patternChart = new Chart($('#patternChart'), { height: 220, yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], xFormat: (h) => `${String(h).padStart(2, '0')}:00`, xTicks: () => [0, 3, 6, 9, 12, 15, 18, 21] });

  runner = new TestRunner($('#modal'), {
    getBand: () => app.band,
    getContext: () => ({
      ...(app.lastLive && Date.now() - app.lastLive.t < 10000 ? { severity: app.lastLive.severity, ampCm: app.lastLive.ampCm } : {}),
      ...doseContext(),
    }),
    onSaved: async (t) => { const saved = await db.addTest(t); refreshViews(); return saved; },
  });
  renderTestCards();

  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#connectBtn').addEventListener('click', () => (app.band ? disconnect() : connect('ble')));
  document.querySelector('[data-action=connect]').addEventListener('click', () => connect('ble'));
  document.querySelector('[data-action=demo]').addEventListener('click', () => connect('demo'));
  $('#doseBtn').addEventListener('click', async () => {
    if (await confirmModal('Log your medicine?', `Record that you took your medicine at ${fmtClock(Date.now())}.`, 'Yes, I took it', true)) logDose();
  });
  $('#alertOk').addEventListener('click', dismissAlert);
  $('#alertDose').addEventListener('click', async () => {
    if (await confirmModal('Log your medicine?', `Record that you took your medicine at ${fmtClock(Date.now())}.`, 'Yes, I took it', true)) { dismissAlert(); logDose(); }
  });
  $('#notifyBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('This browser can\'t show notifications.'); return; }
    const perm = await Notification.requestPermission();
    app.settings.notify = perm === 'granted';
    db.saveSettings(app.settings);
    toast(perm === 'granted' ? 'Notifications on' : 'Notifications not allowed — the in-app reminder still works');
    renderSettings();
  });
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
  setInterval(() => { renderMedicine(); renderAlert(); renderCheckin(); }, 30000);  // dose clock, reminders
  setInterval(refreshModel, 10 * 60e3);
  refreshModel();
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
