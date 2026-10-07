// Local database (IndexedDB) — everything stays on this phone/laptop.
//   epochs: 30-s records from the band, key [storeId, seq]
//   doses:  medication log (from the app or the band's button)
//   tests:  active-test results

const DB_NAME = 'tremorband';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const e = db.createObjectStore('epochs', { keyPath: ['storeId', 'seq'] });
      e.createIndex('t', 't');
      db.createObjectStore('doses', { keyPath: 'id' }).createIndex('t', 't');
      db.createObjectStore('tests', { keyPath: 'id', autoIncrement: true }).createIndex('t', 't');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const result = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function putAll(storeName, items) {
  const db = await open();
  const tx = db.transaction(storeName, 'readwrite');
  const os = tx.objectStore(storeName);
  for (const it of items) os.put(it);
  await done(tx);
}

async function range(storeName, from, to) {
  const db = await open();
  const idx = db.transaction(storeName).objectStore(storeName).index('t');
  return result(idx.getAll(IDBKeyRange.bound(from, to)));
}

async function count(storeName) {
  const db = await open();
  return result(db.transaction(storeName).objectStore(storeName).count());
}

// Records from the band. t is converted to ms; records whose time couldn't be
// recovered (band rebooted and never met a phone) are kept with t = -1.
export async function saveEpochs(storeId, records) {
  const rows = records.map((r) => ({
    storeId, seq: r.seq, boot: r.boot,
    t: r.timeValid ? r.t * 1000 : -1, uptimeS: r.timeValid ? null : r.t,
    sevMax: r.sevMax, sevMean: r.sevMean, tremorPct: r.tremorPct, nWindows: r.nWindows,
    freqHz: r.freqHz, activityMg: r.activityMg, ampCm: r.ampCm, ampMaxCm: r.ampMaxCm, flags: r.flags,
  }));
  await putAll('epochs', rows);
  // the band's button = "I took my medication"
  const doses = records.filter((r) => r.flags & 2 && r.timeValid)
    .map((r) => ({ id: `band-${storeId}-${r.seq}`, t: r.t * 1000, source: 'band' }));
  if (doses.length) await putAll('doses', doses);
}

export const epochsBetween = (from, to) => range('epochs', from, to);
export const epochCount = () => count('epochs');
export async function unplacedCount() {
  const db = await open();
  return result(db.transaction('epochs').objectStore('epochs').index('t').count(IDBKeyRange.only(-1)));
}

export async function addDose(t = Date.now(), source = 'app') {
  const d = { id: `${source}-${t}`, t, source };
  await putAll('doses', [d]);
  return d;
}
export const dosesBetween = (from, to) => range('doses', from, to);
export async function deleteDose(id) {
  const db = await open();
  const tx = db.transaction('doses', 'readwrite');
  tx.objectStore('doses').delete(id);
  await done(tx);
}

export async function addTest(test) {
  const db = await open();
  const tx = db.transaction('tests', 'readwrite');
  const id = await result(tx.objectStore('tests').add(test));
  await done(tx);
  return { ...test, id };
}
export const testsBetween = (from, to) => range('tests', from, to);

export async function firstEpochTime() {
  const db = await open();
  const idx = db.transaction('epochs').objectStore('epochs').index('t');
  const cur = await result(idx.openCursor(IDBKeyRange.lowerBound(0)));
  return cur ? cur.value.t : null;
}

export async function clearAll() {
  const db = await open();
  const tx = db.transaction(['epochs', 'doses', 'tests'], 'readwrite');
  for (const s of ['epochs', 'doses', 'tests']) tx.objectStore(s).clear();
  await done(tx);
}

// ---- settings (small, per device) ----
const DEFAULTS = { leverCm: 10, wrist: 'right', demo: false, theme: 'auto' };
export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tb-settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem('tb-settings', JSON.stringify(s)); } catch { /* private mode */ }
}
