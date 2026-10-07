// Demo band: same interface and events as BandConnection, no hardware needed.
// Models a patient on 4 doses/day whose tremor returns ~2.5-4 h after each dose,
// removes the band at night, and does daily activities that mask tremor.
import { TEST, TEST_STATE } from './protocol.js';

const STORE_ID = 0x51a1d0e0;
const EPOCH_MS = 30000;
const OFF_AMP_CM = 5.5;
const DAY_MS = 86400000;

function rng(seed) {  // deterministic per seed (mulberry32)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sevFromCm = (cm) => (cm < 1 ? 1 : cm < 3 ? 2 : cm < 10 ? 3 : 4);
const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const awake = (t) => { const h = new Date(t).getHours(); return h >= 7 && h < 23; };

function loadState() {
  try { return JSON.parse(localStorage.getItem('tb-sim') || 'null'); } catch { return null; }
}
function saveState(s) { try { localStorage.setItem('tb-sim', JSON.stringify(s)); } catch { /* ignore */ } }

export class SimBand extends EventTarget {
  constructor({ saveBatch, leverMm = 100 }) {
    super();
    this.saveBatch = saveBatch;
    this.leverMm = leverMm;
    this.state = 'disconnected';
    this.status = null;
    this.timers = [];
    let s = loadState();
    if (!s) {
      s = { base: midnight(Date.now()) - 6 * DAY_MS, acked: 0, extraDoses: [] };
      saveState(s);
    }
    this.persist = s;
    this.win = 0;
    this.epochAgg = [];
  }

  static supported() { return true; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state) { this.state = state; this.emit('state', { state, name: 'TremorBand-DEMO' }); }

  // ---- patient model ----
  scheduledDoses(day) {  // 08:00, 12:00, 16:00, 20:00 +-20 min; some days miss the 16:00 dose
    const r = rng(Math.floor(day / DAY_MS));
    const out = [];
    for (const h of [8, 12, 16, 20]) {
      if (h === 16 && r() < 0.25) continue;
      out.push(day + h * 3600000 + Math.round((r() - 0.5) * 40) * 60000);
    }
    return out;
  }

  // Doses that count at time t: the scheduled ones from history (and from today
  // before the demo went live), plus whatever the user logs in the app.
  dosesUpTo(t) {
    const day = midnight(t);
    const live = this.persist.liveFrom || Infinity;
    const sched = [...this.scheduledDoses(day - DAY_MS), ...this.scheduledDoses(day)].filter((d) => d < live);
    return [...sched, ...this.persist.extraDoses].filter((d) => d <= t);
  }

  // Tremor amplitude (cm p-p) as the last dose kicks in and wears off.
  curve(minutes) {
    if (!isFinite(minutes) || minutes > 360 || minutes >= 240) return OFF_AMP_CM;
    if (minutes < 150) return 0.15;
    return 0.15 + (OFF_AMP_CM - 0.15) * (minutes - 150) / 90;
  }

  // Days differ: some are worse overall, on some the dose wears off sooner.
  dayTraits(t) {
    const r = rng(Math.floor(midnight(t) / DAY_MS) * 31 + 7);
    return { scale: 0.6 + 0.7 * r(), shiftMin: Math.round((r() - 0.5) * 70) };
  }

  ampAt(t) {
    const { scale, shiftMin } = this.dayTraits(t);
    const doses = this.dosesUpTo(t);
    const last = Math.max(-Infinity, ...doses);
    const m = (t - last) / 60000 + shiftMin;
    if (m - shiftMin >= 30 || !isFinite(m)) return scale * this.curve(m);
    const before = Math.max(-Infinity, ...doses.filter((d) => d < last));
    const startAmp = scale * this.curve((last - before) / 60000 + shiftMin);
    return 0.15 + (startAmp - 0.15) * (1 - (m - shiftMin) / 30);  // dose kicking in over 30 min
  }

  epochAt(seq) {
    const t = this.persist.base + seq * EPOCH_MS;
    if (!awake(t)) return null;  // band is charging overnight
    const r = rng(seq * 7919);
    const active = r() < 0.18;  // eating, walking, chores: voluntary movement masks rest tremor
    const amp = this.ampAt(t) * (0.75 + 0.5 * r());
    let pctT = amp < 0.3 ? 0 : Math.round(Math.min(100, 40 + amp * 14 + r() * 15));
    if (active) pctT = Math.round(pctT * 0.25);
    const sev = pctT ? sevFromCm(amp) : 0;
    const doses = this.dosesUpTo(t + EPOCH_MS).filter((d) => d > t && d <= t + EPOCH_MS);
    return {
      kind: 'record', seq, t: Math.floor(t / 1000) + 30, timeValid: true, boot: 1,
      sevMax: pctT ? Math.min(4, sevFromCm(amp * 1.25)) : 0,
      sevMean: (sev * pctT) / 100, tremorPct: pctT, nWindows: 30,
      freqHz: pctT ? Math.round((4.7 + r() * 0.6) * 10) / 10 : 0,
      activityMg: active ? 120 + Math.round(r() * 200) : 6 + Math.round(r() * 20),
      ampCm: pctT ? Math.round(amp * 100) / 100 : 0, ampMaxCm: pctT ? Math.round(amp * 12.5) / 10 : 0,
      flags: 1 | (doses.length ? 2 : 0) | 16,
    };
  }

  // ---- interface ----
  async connect() {
    this.setState('connecting');
    await new Promise((r) => setTimeout(r, 600));
    if (!this.persist.liveFrom) { this.persist.liveFrom = Date.now(); saveState(this.persist); }
    this.setState('connected');
    this.sendStatus();
    this.timers.push(setInterval(() => this.tickLive(), 1000));
    this.timers.push(setInterval(() => this.sendStatus(), 5000));
    await this.syncHistory();
  }

  async reconnectKnown() { return false; }

  async syncHistory() {
    const nowSeq = Math.floor((Date.now() - this.persist.base) / EPOCH_MS) - 1;
    let from = this.persist.acked + 1;
    let received = 0;
    while (from <= nowSeq && this.state === 'connected') {
      const to = Math.min(nowSeq, from + 499);
      const batch = [];
      for (let s = from; s <= to; s++) { const e = this.epochAt(s); if (e) batch.push(e); }
      if (batch.length) await this.saveBatch(STORE_ID, batch);
      received += batch.length;
      this.persist.acked = to;
      saveState(this.persist);
      from = to + 1;
      this.emit('sync', { done: false, received, pending: Math.max(0, nowSeq - to) });
      await new Promise((r) => setTimeout(r, 30));
    }
    this.lastEpochSeq = nowSeq;
    this.emit('sync', { done: true, received, pending: 0 });
  }

  tickLive() {
    const now = Date.now();
    this.win++;
    const r = Math.random;
    const voluntary = (now / 1000) % 60 < 7;
    const amp = this.ampAt(now) * (0.85 + 0.3 * r());
    const candidate = !voluntary && amp >= 0.3;
    this.streak = candidate ? (this.streak || 0) + 1 : 0;
    const tremor = this.streak >= 2;
    const freq = 4.9 + 0.25 * Math.sin(now / 20000) + (r() - 0.5) * 0.1;
    const live = {
      win: this.win, severity: tremor ? sevFromCm(amp) : 0, tremor, candidate, highFreq: false, saturated: false, sim: true,
      freqHz: candidate ? freq : 0, ampCm: candidate ? amp : 0,
      omega: candidate ? (amp / 100 / (2 * this.leverMm / 1000)) * 2 * Math.PI * freq : 0.01,
      ratio: candidate ? 0.6 + 0.3 * r() : 0.1 + 0.15 * r(),
      activityMg: voluntary ? 150 + 100 * r() : 5 + 10 * r(),
      domHz: voluntary ? 0.8 + r() * 0.4 : candidate ? freq : 1 + r() * 8,
      battery: this.battery(),
    };
    this.emit('live', live);
    this.epochAgg.push(live);
    if (this.test && (this.test.type === TEST.REST || this.test.type === TEST.POSTURAL)) this.test.windows.push(live);
    if (this.test) this.tickTest();

    const seq = Math.floor((now - this.persist.base) / EPOCH_MS) - 1;
    if (seq > this.lastEpochSeq) {  // a new 30-s epoch closed: send it like the band would
      this.lastEpochSeq = seq;
      const e = this.epochAt(seq);
      if (e && this.epochAgg.length) {
        const w = this.epochAgg;
        const tr = w.filter((x) => x.tremor);
        Object.assign(e, {
          tremorPct: Math.round((100 * tr.length) / w.length), nWindows: w.length,
          sevMean: w.reduce((a, x) => a + x.severity, 0) / w.length,
          sevMax: Math.max(0, ...w.map((x) => x.severity)),
          ampCm: tr.length ? tr.reduce((a, x) => a + x.ampCm, 0) / tr.length : 0,
          ampMaxCm: Math.max(0, ...tr.map((x) => x.ampCm)),
          freqHz: tr.length ? tr.reduce((a, x) => a + x.freqHz, 0) / tr.length : 0,
          activityMg: w.reduce((a, x) => a + x.activityMg, 0) / w.length,
          flags: (e.flags & ~2) | (this.pendingButton ? 2 : 0),
        });
        this.pendingButton = false;
        this.saveBatch(STORE_ID, [e]).then(() => { this.persist.acked = seq; saveState(this.persist); this.emit('sync', { done: true, received: 1, pending: 0 }); });
      }
      this.epochAgg = [];
    }
  }

  battery() { return Math.max(5, 92 - Math.floor((Date.now() - this.persist.liveFrom) / 600000)); }

  sendStatus() {
    this.status = {
      proto: 1, fw: 1, timeSynced: true, imuOk: true, storageOk: true, sim: true, testRunning: !!this.test, syncing: true,
      battery: this.battery(), batteryMv: 3950, boot: 1, storeId: STORE_ID,
      nextSeq: this.persist.acked + 1, ackedSeq: this.persist.acked, pending: 0,
    };
    this.emit('status', this.status);
  }

  startTest(type, seconds) {
    this.test = { type, seconds, start: Date.now(), windows: [] };
    this.sendStatus();
  }

  tickTest() {
    const t = this.test;
    const el = (Date.now() - t.start) / 1000;
    if (el < t.seconds) { this.emit('test', { type: t.type, state: TEST_STATE.RUNNING, elapsedS: el, totalS: t.seconds }); return; }
    this.test = null;
    const off = Math.min(1, this.ampAt(Date.now()) / OFF_AMP_CM);
    if (t.type === TEST.PRONSUP) {
      const rate = 1.9 - 0.8 * off + (Math.random() - 0.5) * 0.1;
      const exc = 150 - 55 * off + (Math.random() - 0.5) * 8;
      this.emit('test', {
        type: t.type, state: TEST_STATE.DONE, movements: Math.round(2 * rate * t.seconds) - 1,
        hesitations: off > 0.6 ? 1 + Math.round(Math.random()) : 0, rateHz: rate, excursionDeg: exc,
        speedDps: Math.round(Math.PI * rate * exc), ampDecrementPct: Math.round(4 + 26 * off),
        speedDecrementPct: Math.round(2 + 18 * off), rhythmCvPct: Math.round(6 + 12 * off),
        saturated: false, tooFew: false, durationS: t.seconds,
      });
    } else {
      const w = t.windows.map((x) => (t.type === TEST.POSTURAL ? { ...x, ampCm: x.ampCm * 0.6 } : x));
      const tr = w.filter((x) => x.tremor);
      const n = Math.max(1, w.length);
      this.emit('test', {
        type: t.type, state: TEST_STATE.DONE, nWindows: w.length, tremorPct: Math.round((100 * tr.length) / n),
        sevMean: tr.reduce((a, x) => a + sevFromCm(x.ampCm), 0) / n, sevMax: Math.max(0, ...tr.map((x) => sevFromCm(x.ampCm))),
        freqHz: tr.length ? tr.reduce((a, x) => a + x.freqHz, 0) / tr.length : 0,
        ampMeanCm: tr.length ? tr.reduce((a, x) => a + x.ampCm, 0) / tr.length : 0,
        ampMaxCm: Math.max(0, ...tr.map((x) => x.ampCm)), omegaMean: 0, ratioMean: w.reduce((a, x) => a + x.ratio, 0) / n,
      });
    }
    this.sendStatus();
  }

  abortTest() {
    if (!this.test) return;
    this.emit('test', { type: this.test.type, state: TEST_STATE.ABORTED });
    this.test = null;
  }

  noteDose(t) {  // app logged a dose: the simulated tremor responds to it
    this.persist.extraDoses.push(t);
    this.persist.extraDoses = this.persist.extraDoses.filter((d) => d > Date.now() - 2 * DAY_MS);
    saveState(this.persist);
  }

  pressButton() { this.pendingButton = true; this.noteDose(Date.now()); }
  async setLever(mm) { this.leverMm = mm; }
  async erase() { this.persist = { base: midnight(Date.now()) - 6 * DAY_MS, acked: 0, extraDoses: [], liveFrom: Date.now() }; saveState(this.persist); this.sendStatus(); }

  disconnect() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.setState('disconnected');
  }
}
