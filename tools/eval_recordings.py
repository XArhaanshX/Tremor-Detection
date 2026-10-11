#!/usr/bin/env python3
"""Score our own band recordings (from tools/record.py) with the three decision rules.

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

GATE_LOWBAND = 0.4


def consistent(flag, freq):
    out = np.zeros(len(flag), bool)
    for i in range(1, len(flag)):
        out[i] = flag[i] and flag[i - 1] and abs(freq[i] - freq[i - 1]) <= 1.0
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--hop", type=int, default=100)
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()
    print(f"{'recording':40s} {'windows':>7s} {'spectral':>9s} {'spec+gate':>9s} {'ours':>7s} {'lever cm':>9s} {'axis':>5s}")
    for path in args.files:
        with open(path, "rb") as f:
            out = subprocess.run([args.cli, "--cols", "t,ax,ay,az,gx,gy,gz", "--hop", str(args.hop), "--skip-header"],
                                 stdin=f, capture_output=True, check=True).stdout
        d = pd.read_csv(BytesIO(out))
        beat = ((d.freq > 0) & (d.ratio >= 0.4) & (d.omega >= 0.1) & (d.steady >= 0.5)).to_numpy()
        spectral = consistent(beat, d.freq.to_numpy())
        gate = consistent(beat & (d.lowband < GATE_LOWBAND).to_numpy(), d.freq.to_numpy())
        ours = d.confirmed.astype(bool).to_numpy()
        beats = d[beat]
        lever = f"{100*beats.lever.median():.1f}" if len(beats) else "-"
        axis = f"{beats.axis.median():.2f}" if len(beats) else "-"
        print(f"{os.path.basename(path)[:40]:40s} {len(d):7d} {100*spectral.mean():8.1f}% {100*gate.mean():8.1f}% {100*ours.mean():6.1f}% {lever:>9s} {axis:>5s}")


if __name__ == "__main__":
    main()
