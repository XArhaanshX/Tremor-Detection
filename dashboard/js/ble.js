// Web Bluetooth link to the wristband.
// Events: state, live, status, sync, test   (CustomEvent, data in .detail)
import * as P from './protocol.js';

const RETRY_MS = [2000, 4000, 8000, 15000];

export class BandConnection extends EventTarget {
  // saveBatch(storeId, records) must resolve only once records are safely stored:
  // the band deletes them as soon as we ACK.
  constructor({ saveBatch, leverMm = 100 }) {
    super();
    this.saveBatch = saveBatch;
    this.leverMm = leverMm;
    this.device = null;
    this.chr = {};
    this.state = 'disconnected';
    this.status = null;
    this.userClosed = false;
    this.retry = 0;
    this.gattQueue = Promise.resolve();
    this.resetSync();
  }

  static supported() { return !!navigator.bluetooth; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state) { this.state = state; this.emit('state', { state, name: this.device?.name }); }
  resetSync() { this.batch = []; this.ackBase = 0; this.received = 0; }

  // Web Bluetooth allows one GATT operation at a time: serialise everything.
  gatt(fn) {
    const p = this.gattQueue.then(fn, fn);
    this.gattQueue = p.catch(() => {});
    return p;
  }

  write(buf) {
    const c = this.chr.control;
    if (!c) return Promise.resolve();
    return this.gatt(() => (c.writeValueWithResponse ? c.writeValueWithResponse(buf) : c.writeValue(buf)));
  }

  // Must be called from a user gesture (button click) the first time.
  async connect() {
    this.userClosed = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [P.UUID.service] }, { namePrefix: 'TremorBand' }],
      optionalServices: [P.UUID.service],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    await this.open();
  }

  // Reconnect to a band this browser was allowed to use before, without the picker.
  async reconnectKnown() {
    if (!navigator.bluetooth?.getDevices) return false;
    const devices = await navigator.bluetooth.getDevices();
    const dev = devices.find((d) => d.name?.startsWith('TremorBand'));
    if (!dev) return false;
    this.device = dev;
    this.userClosed = false;
    dev.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    this.setState('reconnecting');
    this.scheduleRetry(0);
    return true;
  }

  async open() {
    this.setState(this.retry ? 'reconnecting' : 'connecting');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(P.UUID.service);
    for (const k of ['live', 'records', 'control', 'status', 'test']) this.chr[k] = await svc.getCharacteristic(P.UUID[k]);
    this.gattQueue = Promise.resolve();
    this.resetSync();

    this.chr.live.addEventListener('characteristicvaluechanged', (e) => this.emit('live', P.decodeLive(e.target.value)));
    this.chr.status.addEventListener('characteristicvaluechanged', (e) => this.onStatus(P.decodeStatus(e.target.value)));
    this.chr.test.addEventListener('characteristicvaluechanged', (e) => this.emit('test', P.decodeTest(e.target.value)));
    this.chr.records.addEventListener('characteristicvaluechanged', (e) => this.onRecordsPacket(e.target.value));
    for (const k of ['status', 'live', 'test', 'records']) await this.gatt(() => this.chr[k].startNotifications());

    // handshake: clock -> lever arm -> status -> start syncing stored records
    await this.write(P.cmdSetTime(Math.floor(Date.now() / 1000)));
    await this.write(P.cmdSetLever(this.leverMm));
    this.onStatus(P.decodeStatus(await this.gatt(() => this.chr.status.readValue())));
    await this.write(P.cmdSync());
    this.retry = 0;
    this.setState('connected');
  }

  onStatus(s) {
    if (this.status && this.status.storeId !== s.storeId) this.resetSync();  // band was erased
    this.status = s;
    this.ackBase = Math.max(this.ackBase, s.ackedSeq);
    this.emit('status', s);
  }

  async onRecordsPacket(value) {
    const p = P.decodeRecordsPacket(value);
    if (p.kind === 'record') { this.batch.push(p); return; }
    if (p.marker === P.MARK.SYNC_DONE) {
      this.emit('sync', { done: true, received: this.received, pending: 0 });
      return;
    }
    if (p.marker !== P.MARK.BATCH_END) return;

    const records = this.batch;
    this.batch = [];
    const storeId = this.status?.storeId ?? 0;
    try {
      if (records.length) await this.saveBatch(storeId, records);
    } catch (err) {
      console.error('saving records failed — not acknowledging', err);
      return;  // band will resend after its ACK timeout
    }
    // ACK only the contiguous run: a gap means a notification was lost -> resend from there
    const seqs = new Set(records.map((r) => r.seq));
    let ack = this.ackBase;
    while (seqs.has(ack + 1)) ack++;
    this.received += records.length;
    this.ackBase = ack;
    const pending = this.status ? Math.max(0, this.status.nextSeq - 1 - ack) : 0;
    this.emit('sync', { done: false, received: this.received, pending });
    await this.write(P.cmdAck(ack));
  }

  onDisconnected() {
    this.chr = {};
    if (this.userClosed) { this.setState('disconnected'); return; }
    // Patient walked away from the phone: keep trying; the band buffers meanwhile.
    this.setState('reconnecting');
    this.scheduleRetry(RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)]);
  }

  scheduleRetry(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      if (this.userClosed) return;
      try {
        await this.open();
      } catch {
        this.retry++;
        this.scheduleRetry(RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)]);
      }
    }, ms);
  }

  disconnect() {
    this.userClosed = true;
    clearTimeout(this.retryTimer);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.setState('disconnected');
  }

  setLever(mm) { this.leverMm = mm; return this.write(P.cmdSetLever(mm)); }
  startTest(type, seconds) { return this.write(P.cmdTestStart(type, seconds)); }
  abortTest() { return this.write(P.cmdTestAbort()); }
  erase() { return this.write(P.cmdErase()); }
  noteDose() {}  // the real band learns about doses only via its button
}
