// Cross-checks dashboard/js/protocol.js against the firmware's C structs.
// Usage: node tools/check_protocol.mjs   (compiles tools/protocol_vectors.cpp with g++)
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../dashboard/js/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(mkdtempSync(join(tmpdir(), 'proto-')), 'vectors');
execFileSync('g++', ['-std=c++17', '-o', exe, join(here, 'protocol_vectors.cpp')]);
const lines = execFileSync(exe).toString().trim().split('\n');

const decoders = { live: P.decodeLive, record: P.decodeRecordsPacket, status: P.decodeStatus, test: P.decodeTest };
let fail = 0;
for (const line of lines) {
  const { kind, hex, expect } = JSON.parse(line);
  const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const got = decoders[kind](new DataView(bytes.buffer));
  for (const [k, want] of Object.entries(expect)) {
    const ok = typeof want === 'number' ? Math.abs(got[k] - want) < 1e-9 : got[k] === want;
    if (!ok) { fail++; console.log(`FAIL ${kind}.${k}: got ${got[k]}, want ${want}`); }
  }
}
// encoders: byte layouts must match what main.cpp parses
const eq = (buf, arr, name) => {
  const a = [...new Uint8Array(buf)];
  if (a.join() !== arr.join()) { fail++; console.log(`FAIL ${name}: ${a} != ${arr}`); }
};
eq(P.cmdSetTime(0x01020304), [1, 4, 3, 2, 1], 'cmdSetTime');
eq(P.cmdAck(258), [3, 2, 1, 0, 0], 'cmdAck');
eq(P.cmdTestStart(3, 10), [0x10, 3, 10, 0], 'cmdTestStart');
eq(P.cmdSetLever(120), [0x20, 120, 0], 'cmdSetLever');
eq(P.cmdErase(), [0x7f, 0xa5, 0x5a], 'cmdErase');
console.log(fail ? `${fail} protocol mismatches` : `protocol OK: ${lines.length} packet types + 5 commands match firmware`);
process.exit(fail ? 1 : 0);
