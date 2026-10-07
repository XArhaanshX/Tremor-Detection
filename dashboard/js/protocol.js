// BLE wire protocol — mirror of firmware/include/protocol.h. Little-endian, <= 20 B.

export const UUID = {
  service: 'd2e60001-ed8b-45e3-b151-051e61e017ff',
  live:    'd2e60002-ed8b-45e3-b151-051e61e017ff',
  records: 'd2e60003-ed8b-45e3-b151-051e61e017ff',
  control: 'd2e60004-ed8b-45e3-b151-051e61e017ff',
  status:  'd2e60005-ed8b-45e3-b151-051e61e017ff',
  test:    'd2e60006-ed8b-45e3-b151-051e61e017ff',
};

export const CMD = { SET_TIME: 0x01, SYNC: 0x02, ACK: 0x03, TEST_START: 0x10, TEST_ABORT: 0x11, SET_LEVER: 0x20, ERASE: 0x7f };
export const TEST = { REST: 1, POSTURAL: 2, PRONSUP: 3 };
export const TEST_STATE = { RUNNING: 1, DONE: 2, ABORTED: 3, ERROR: 4 };
export const MARK = { BATCH_END: 0xb0, SYNC_DONE: 0xd0 };

export const LIVE = { TREMOR: 1, CANDIDATE: 2, HIGHFREQ: 4, SATURATED: 8, GAP: 16, TEST: 32, SIM: 64 };
export const REC = { TIME_VALID: 1, BUTTON: 2, HIGHFREQ: 4, GAP: 8, SIM: 16, TEST: 32 };
export const ST = { TIME_SYNCED: 1, IMU_OK: 2, STORAGE_OK: 4, SIM: 8, TEST: 16, SYNCING: 32 };

export const SEVERITY_LABELS = ['Normal', 'Slight', 'Mild', 'Moderate', 'Severe'];

const dv = (buf) => (buf instanceof DataView ? buf : new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength));
const pct = (b) => (b === 255 ? null : b);

export function decodeLive(buf) {
  const v = dv(buf);
  const flags = v.getUint8(5);
  return {
    win: v.getUint32(0, true),
    severity: v.getUint8(4),
    flags,
    tremor: !!(flags & LIVE.TREMOR),
    candidate: !!(flags & LIVE.CANDIDATE),
    highFreq: !!(flags & LIVE.HIGHFREQ),
    saturated: !!(flags & LIVE.SATURATED),
    sim: !!(flags & LIVE.SIM),
    freqHz: v.getUint16(6, true) / 100,
    ampCm: v.getUint16(8, true) / 100,
    omega: v.getUint16(10, true) / 1000,
    ratio: v.getUint16(12, true) / 1000,
    activityMg: v.getUint16(14, true),
    domHz: v.getUint16(16, true) / 100,
    battery: pct(v.getUint8(18)),
  };
}

// Returns {kind:'record', ...} for 20-byte records, {kind:'marker', ...} for 5-byte markers.
export function decodeRecordsPacket(buf) {
  const v = dv(buf);
  if (v.byteLength === 5) return { kind: 'marker', marker: v.getUint8(0), value: v.getUint32(1, true) };
  const flags = v.getUint8(18);
  return {
    kind: 'record',
    seq: v.getUint32(0, true),
    t: v.getUint32(4, true),
    timeValid: !!(flags & REC.TIME_VALID),
    boot: v.getUint16(8, true),
    sevMax: v.getUint8(10),
    sevMean: v.getUint8(11) / 50,
    tremorPct: v.getUint8(12),
    nWindows: v.getUint8(13),
    freqHz: v.getUint8(14) / 10,
    activityMg: v.getUint8(15) * 4,
    ampCm: v.getUint16(16, true) / 100,
    flags,
    ampMaxCm: v.getUint8(19) / 10,
  };
}

export function decodeStatus(buf) {
  const v = dv(buf);
  const flags = v.getUint8(2);
  return {
    proto: v.getUint8(0),
    fw: v.getUint8(1),
    flags,
    timeSynced: !!(flags & ST.TIME_SYNCED),
    imuOk: !!(flags & ST.IMU_OK),
    storageOk: !!(flags & ST.STORAGE_OK),
    sim: !!(flags & ST.SIM),
    testRunning: !!(flags & ST.TEST),
    syncing: !!(flags & ST.SYNCING),
    battery: pct(v.getUint8(3)),
    batteryMv: v.getUint16(4, true) || null,
    boot: v.getUint16(6, true),
    storeId: v.getUint32(8, true),
    nextSeq: v.getUint32(12, true),
    ackedSeq: v.getUint32(16, true),
    pending: Math.max(0, v.getUint32(12, true) - 1 - v.getUint32(16, true)),
  };
}

export function decodeTest(buf) {
  const v = dv(buf);
  const type = v.getUint8(0), state = v.getUint8(1);
  const out = { type, state };
  if (state === TEST_STATE.RUNNING && v.byteLength >= 6) {
    out.elapsedS = v.getUint16(2, true) / 10;
    out.totalS = v.getUint16(4, true) / 10;
  } else if (state === TEST_STATE.DONE && type === TEST.PRONSUP && v.byteLength >= 16) {
    const f = v.getUint8(13);
    Object.assign(out, {
      movements: v.getUint8(2),
      hesitations: v.getUint8(3),
      rateHz: v.getUint16(4, true) / 100,
      excursionDeg: v.getUint16(6, true) / 10,
      speedDps: v.getUint16(8, true),
      ampDecrementPct: v.getInt8(10),
      speedDecrementPct: v.getInt8(11),
      rhythmCvPct: v.getUint8(12),
      saturated: !!(f & 1),
      tooFew: !!(f & 2),
      durationS: v.getUint16(14, true) / 10,
    });
  } else if (state === TEST_STATE.DONE && v.byteLength >= 16) {
    Object.assign(out, {
      nWindows: v.getUint8(2),
      tremorPct: v.getUint8(3),
      sevMean: v.getUint8(4) / 50,
      sevMax: v.getUint8(5),
      freqHz: v.getUint8(6) / 10,
      ampMeanCm: v.getUint16(8, true) / 100,
      ampMaxCm: v.getUint16(10, true) / 100,
      omegaMean: v.getUint16(12, true) / 1000,
      ratioMean: v.getUint16(14, true) / 1000,
    });
  }
  return out;
}

// ---- command encoders ----
const bytes = (n) => new DataView(new ArrayBuffer(n));
export function cmdSetTime(unixS) { const v = bytes(5); v.setUint8(0, CMD.SET_TIME); v.setUint32(1, unixS >>> 0, true); return v.buffer; }
export function cmdSync() { return new Uint8Array([CMD.SYNC]).buffer; }
export function cmdAck(seq) { const v = bytes(5); v.setUint8(0, CMD.ACK); v.setUint32(1, seq >>> 0, true); return v.buffer; }
export function cmdTestStart(type, seconds) { const v = bytes(4); v.setUint8(0, CMD.TEST_START); v.setUint8(1, type); v.setUint16(2, seconds, true); return v.buffer; }
export function cmdTestAbort() { return new Uint8Array([CMD.TEST_ABORT]).buffer; }
export function cmdSetLever(mm) { const v = bytes(3); v.setUint8(0, CMD.SET_LEVER); v.setUint16(1, mm, true); return v.buffer; }
export function cmdErase() { return new Uint8Array([CMD.ERASE, 0xa5, 0x5a]).buffer; }
