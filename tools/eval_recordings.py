#!/usr/bin/env python3
"""Score our own band recordings (from tools/record.py or tools/experiment.py) with the
three decision rules.

  python3 tools/eval_recordings.py --cli build/dsp_cli data/recordings/*.csv

Prints, per recording: % of windows flagged by the gyro-only spectral rule, by the
spectral+movement-gate rule, and by ours, plus the median effective lever arm of the
beats it saw. Label the files by activity (brushing_teeth_..., fake_tremor_...) and the
expected answer is obvious: only *tremor* recordings should be flagged.
"""
import argparse, os, subprocess
from io import BytesIO

import numpy as np
import pandas as pd

GATE_LOWBAND = 0.4  # rad/s RMS in 0.5-3 Hz: above this the movement-gate baseline drops the window


def consistent(flag, freq):
    out = np.zeros(len(flag), bool)
    for i in range(1, len(flag)):
        out[i] = flag[i] and flag[i - 1] and abs(freq[i] - freq[i - 1]) <= 1.0
    return out


def score_file(cli, path, hop=100):
    """Run the firmware DSP over one recording and apply the three decision rules."""
    with open(path, "rb") as f:
        out = subprocess.run([cli, "--cols", "t,ax,ay,az,gx,gy,gz", "--hop", str(hop), "--skip-header"],
                             stdin=f, capture_output=True, check=True).stdout
    d = pd.read_csv(BytesIO(out))
    if not len(d):
        return {"windows": 0}
    beat = ((d.freq > 0) & (d.ratio >= 0.4) & (d.omega >= 0.1) & (d.steady >= 0.5)).to_numpy()
    freq = d.freq.to_numpy()
    beats = d[beat]
    return {
        "windows": len(d),
        "spectral": 100 * consistent(beat, freq).mean(),
        "spectral_gate": 100 * consistent(beat & (d.lowband < GATE_LOWBAND).to_numpy(), freq).mean(),
        "ours": 100 * d.confirmed.astype(bool).mean(),
        "arm_rhythm": 100 * d.arm_driven.astype(bool).mean(),
        "beat_pct": 100 * beat.mean(),
        "lever_cm": 100 * beats.lever.median() if len(beats) else float("nan"),
        "axis": beats.axis.median() if len(beats) else float("nan"),
        "freq_hz": beats.freq.median() if len(beats) else float("nan"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--hop", type=int, default=100)
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()
    print(f"{'recording':40s} {'windows':>7s} {'spectral':>9s} {'spec+gate':>9s} {'ours':>7s} {'lever cm':>9s} {'axis':>5s}")
    for path in args.files:
        r = score_file(args.cli, path, args.hop)
        if not r["windows"]:
            print(f"{os.path.basename(path)[:40]:40s}  (too short)")
            continue
        print(f"{os.path.basename(path)[:40]:40s} {r['windows']:7d} {r['spectral']:8.1f}% {r['spectral_gate']:8.1f}% "
              f"{r['ours']:6.1f}% {r['lever_cm']:9.1f} {r['axis']:5.2f}")


if __name__ == "__main__":
    main()
