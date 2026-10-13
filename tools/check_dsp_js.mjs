// Checks the dashboard's JavaScript detector (dashboard/js/dsp.js) against the firmware's C++
// (via tools/dsp_cli) on every benchmark scenario, window by window: features must agree to
// float precision and every algorithm's decision must be identical.
//   node tools/check_dsp_js.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRecording, decide, ALGORITHMS } from '../dashboard/js/dsp.js';
import { SCENARIOS, buildScenario } from '../dashboard/js/bench.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'build', 'dsp_cli');
const srcs = ['tools/dsp_cli.cpp', 'firmware/src/dsp/fft.cpp', 'firmware/src/dsp/tremor.cpp'].map((p) => join(root, p));
if (!existsSync(cli) || srcs.some((s) => statSync(s).mtimeMs > statSync(cli).mtimeMs)) {
  execFileSync('mkdir', ['-p', join(root, 'build')]);
  execFileSync('g++', ['-std=gnu++17', '-O2', `-I${join(root, 'firmware/include')}`, '-o', cli, ...srcs]);
}
const tmp = mkdtempSync(join(tmpdir(), 'dspjs-'));

// C++ column -> JS field
const FIELDS = { freq: 'freq_hz', ratio: 'ratio', omega: 'omega_amp', steady: 'steadiness', lever: 'lever_eff_m', axis: 'axis_linearity',
  lowband: 'lowband_omega', bp_ratio: 'bp_ratio', bp_omega: 'bp_omega', bp_freq: 'bp_freq', p37_freq: 'p37_freq', p37_ratio: 'p37_ratio',
  p37_omega: 'p37_omega', dom_ratio: 'dom_ratio', dom_omega: 'dom_omega' };

let windows = 0, featMismatch = 0, decMismatch = 0, worst = 0;
for (const sc of SCENARIOS) {
  const s = buildScenario(sc, 3, 40);
  const csv = 't,ax,ay,az,gx,gy,gz\n' + Array.from({ length: s.n }, (_, i) =>
    [s.t[i], s.ax[i], s.ay[i], s.az[i], s.gx[i], s.gy[i], s.gz[i]].map((v) => v.toPrecision(9)).join(',')).join('\n');
  const f = join(tmp, `${sc.id}.csv`);
  writeFileSync(f, csv);
  const out = execFileSync(cli, ['--skip-header'], { input: csv }).toString().trim().split('\n');
  const head = out.shift().split(',');
  const C = out.map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], +v])));
  // re-read the exact numbers the C++ saw (CSV rounding) so both sides get identical input
  const rows = csv.split('\n').slice(1).map((l) => l.split(',').map(Number));
  const sig = { gx: rows.map((r) => r[4]), gy: rows.map((r) => r[5]), gz: rows.map((r) => r[6]), ax: rows.map((r) => r[1]), ay: rows.map((r) => r[2]), az: rows.map((r) => r[3]) };
  const J = analyzeRecording(sig);
  if (J.length !== C.length) { console.log(`FAIL ${sc.id}: ${J.length} JS windows vs ${C.length} C++`); decMismatch++; continue; }
  // decisions of all four algorithms from each side's features
  const cWin = C.map((c) => ({ ...Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [v, c[k]])), candidate: !!c.candidate, confirmed: !!c.confirmed }));
  const dJ = decide(J), dC = decide(cWin);
  for (let i = 0; i < C.length; i++) {
    windows++;
    for (const [k, v] of Object.entries(FIELDS)) {
      const a = C[i][k], b = J[i][v];
      const err = Math.abs(a - b) / Math.max(1e-3, Math.abs(a));
      // C++ prints 3-4 decimals and computes in float32: allow print rounding + float error
      if (Math.abs(a - b) > 6e-3 && err > 2e-3) { featMismatch++; if (featMismatch <= 5) console.log(`  ${sc.id} w${i} ${k}: C++ ${a} JS ${b}`); }
      if (Math.abs(a) > 0.05) worst = Math.max(worst, err);  // ignore values below print precision
    }
    for (const alg of ALGORITHMS) if (dJ[alg.id].flags[i] !== dC[alg.id].flags[i]) {
      decMismatch++;
      console.log(`  DECISION ${sc.id} w${i} ${alg.id}: C++ ${dC[alg.id].flags[i]} JS ${dJ[alg.id].flags[i]}`);
    }
  }
}
console.log(`${windows} windows over ${SCENARIOS.length} scenarios: ${featMismatch} feature mismatches, ${decMismatch} decision mismatches (worst relative feature difference ${worst.toExponential(1)})`);
process.exit(featMismatch || decMismatch ? 1 : 0);
