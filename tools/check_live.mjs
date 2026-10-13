// Checks the live comparison pipeline (dashboard/js/livepipe.js) end to end against the
// firmware's C++ detector: a simulated session is quantised to raw sensor counts, packetised
// exactly like firmware/src/main.cpp streams it (8 samples per packet, flushed at every window
// boundary, a "restart" mark on the first packet, 16-bit sample counter that wraps), and the
// band's verdict for each window comes from tools/dsp_cli (the firmware's own tremor.cpp).
// The page's windows must line up with the band's one for one and agree on every decision.
//   node tools/check_live.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LivePipeline, GYRO_TO_RADS, ACCEL_TO_G } from '../dashboard/js/livepipe.js';
import { SCENARIOS, buildScenario, parseRecording } from '../dashboard/js/bench.js';
import { analyzeRecording, decide, ALGORITHMS } from '../dashboard/js/dsp.js';
import { LIVE } from '../dashboard/js/protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'build', 'dsp_cli');
const srcs = ['tools/dsp_cli.cpp', 'firmware/src/dsp/fft.cpp', 'firmware/src/dsp/tremor.cpp'].map((p) => join(root, p));
if (!existsSync(cli) || srcs.some((s) => statSync(s).mtimeMs > statSync(cli).mtimeMs)) {
  execFileSync('mkdir', ['-p', join(root, 'build')]);
  execFileSync('g++', ['-std=gnu++17', '-O2', `-I${join(root, 'firmware/include')}`, '-o', cli, ...srcs]);
}

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// ---- a session: still -> mild tremor -> brushing (arm rhythm) -> moderate tremor -> walking
const plan = [['still', 20, 'still'], ['mild', 30, 'tremor'], ['brushing', 30, 'movement'], ['moderate', 25, 'tremor'], ['walking', 20, 'movement']];
const raw = [], labels = [];
const GLSB = Math.PI / 180 / 16.4;
const clip = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
plan.forEach(([id, sec, label], k) => {
  const s = buildScenario(SCENARIOS.find((x) => x.id === id), 10 + k, sec);
  for (let i = 0; i < s.n; i++) {
    raw.push([clip(s.ax[i] * 4096), clip(s.ay[i] * 4096), clip(s.az[i] * 4096), clip(s.gx[i] / GLSB), clip(s.gy[i] / GLSB), clip(s.gz[i] / GLSB)]);
    labels.push(label);
  }
});

// ---- the band's verdicts: the firmware's C++ on the same float32 numbers the band computes
const f32 = Math.fround;
const csv = raw.map((v) => [0, ...[0, 1, 2].map((j) => f32(v[j] * ACCEL_TO_G)), ...[3, 4, 5].map((j) => f32(v[j] * GYRO_TO_RADS))]
  .map((x) => x.toPrecision(9)).join(',')).join('\n');
const out = execFileSync(cli, ['--skip-header'], { input: 't,ax,ay,az,gx,gy,gz\n' + csv, maxBuffer: 1 << 26 }).toString().trim().split('\n');
const head = out.shift().split(',');
const C = out.map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], +v])));
const livePacket = (c, i) => {
  const gap = i === 0;  // the band's first window after a restart
  const flags = (c.confirmed ? LIVE.TREMOR : 0) | (c.candidate ? LIVE.CANDIDATE : 0) | (c.highfreq ? LIVE.HIGHFREQ : 0) |
    (c.arm_driven ? LIVE.ARM_RHYTHM : 0) | (gap ? LIVE.GAP : 0);
  return { flags, tremor: !!c.confirmed, candidate: !!c.candidate, highFreq: !!c.highfreq, armRhythm: !!c.arm_driven,
    freqHz: c.candidate ? Math.floor(c.freq * 100) / 100 : 0, ratio: Math.floor(c.ratio * 1000) / 1000,
    omega: Math.floor(c.omega * 1000) / 1000, severity: c.severity, win: i + 1 };
};

// ---- stream it like main.cpp: streamRaw() + flushRaw() before every sendLive()
function stream(pipe, { firstIndex = 65000, drop = () => false, labelAt = null } = {}) {
  let idx = firstIndex, pkt = [], first = 0, gap = true, win = 0, sent = 0, dropped = 0;
  const flush = () => {
    if (!pkt.length) return;
    const p = { first, gap, samples: pkt };
    if (drop(sent++)) dropped += pkt.length; else pipe.ingest(p, 1000 + idx * 10);
    pkt = []; gap = false;
  };
  raw.forEach((v, i) => {
    if (labelAt && (i === 0 || labels[i] !== labels[i - 1])) pipe.setLabel(labelAt(labels[i]));
    if (!pkt.length) first = idx & 0xffff;
    pkt.push(v);
    idx++;
    if (pkt.length >= 8) flush();
    if (i >= 255 && (i - 255) % 100 === 0) {  // the band analyses a window ending at this sample
      flush();
      pipe.bandResult(livePacket(C[win], win));
      win++;
    }
  });
  flush();
  return { dropped, bandWindows: win };
}

// 1. clean stream: every window matched and identical
{
  const pipe = new LivePipeline();
  const { bandWindows } = stream(pipe, { labelAt: (l) => l });
  const s = pipe.stats;
  check(pipe.windows.length === C.length && bandWindows === C.length, `page analysed ${pipe.windows.length} windows, band ${C.length}`);
  check(s.compared === C.length && s.same === s.compared, `band and page agree on ${s.same} of ${s.compared} windows (tremor, candidate, arm rhythm, faster shake, gap)`);
  check(s.maxFreqDiff < 0.02 && s.maxRatioDiff < 0.003, `largest differences: ${s.maxFreqDiff.toFixed(4)} Hz, ratio ${s.maxRatioDiff.toFixed(4)}`);
  check(s.lost === 0 && s.samples === raw.length, `${s.samples} samples, ${s.lost} lost (16-bit counter wrapped mid-session)`);
  // same decisions as the offline path (Compare tab / eval tools) on the exported CSV
  const rec = parseRecording(pipe.samplesCsv());
  const off = decide(analyzeRecording(rec));
  const mism = ALGORITHMS.reduce((n, a) => n + pipe.windows.filter((w, i) => w.d[a.id].flag !== off[a.id].flags[i]).length, 0);
  check(rec.n === raw.length && mism === 0, `exported CSV re-analysed offline: ${rec.n} samples, ${mism} decision differences`);
  // labelled scoring: windows that span a label change are not scored
  const scored = Object.values(pipe.score).reduce((p, x) => p + x.ours.n, 0);
  const mixed = pipe.windows.filter((w) => w.label === undefined).length;
  check(scored + mixed === pipe.windows.length && mixed > 0 && mixed <= 3 * (plan.length - 1), `${scored} windows scored by label, ${mixed} spanning a change left out`);
  const sc = pipe.score;
  console.log('     flagged (still / tremor / movement):', ALGORITHMS.map((a) => `${a.id} ${sc.still[a.id].flagged}/${sc.still[a.id].n} ${sc.tremor[a.id].flagged}/${sc.tremor[a.id].n} ${sc.movement[a.id].flagged}/${sc.movement[a.id].n}`).join(' | '));
  check(sc.tremor.ours.flagged > 0.8 * sc.tremor.ours.n && sc.movement.ours.flagged === 0, 'ours: catches the tremor, ignores brushing and walking');
}

// 2. packets lost in transit: counted, the windows they touch are not judged by the page,
//    and every window the page does judge still matches the band
{
  const pipe = new LivePipeline();
  const lostPackets = new Set([300, 301, 700]);
  const { dropped } = stream(pipe, { drop: (k) => lostPackets.has(k), firstIndex: 100 });
  const s = pipe.stats;
  check(s.lost === dropped && dropped > 0, `${dropped} samples dropped, ${s.lost} counted as lost`);
  check(pipe.windows.length === C.length, `still one entry per band window (${pipe.windows.length})`);
  check(s.notCompared >= 3 && s.notCompared <= 8, `${s.notCompared} windows not compared (they contain lost samples)`);
  check(s.compared + s.notCompared === C.length && s.same === s.compared, `the other ${s.compared} still identical (${s.same})`);
}

// 3. joining mid-stream: nothing is analysed until the band marks a fresh window
{
  const pipe = new LivePipeline();
  pipe.ingest({ first: 5, gap: false, samples: raw.slice(0, 8) });
  pipe.bandResult(livePacket(C[0], 0));
  check(pipe.windows.length === 0 && !pipe.aligned, 'waits for the band\'s restart mark before analysing');
}

console.log(fails ? `${fails} check(s) FAILED` : 'all live-pipeline checks passed');
process.exit(fails ? 1 : 0);
