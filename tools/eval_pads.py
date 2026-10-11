#!/usr/bin/env python3
"""Evaluate the wristband detector on the PADS dataset (PhysioNet, CC BY-NC-SA 4.0).

PADS: 469 people (Parkinson's, other movement disorders, healthy controls), Apple Watch
on each wrist, 100 Hz accelerometer (g) + gyroscope (rad/s), 11 scripted tasks.
Only subject-level diagnosis labels exist, so we evaluate:

  * healthy controls  -> every tremor detection is a FALSE POSITIVE (window level),
                         broken down by task so voluntary-movement tasks stand out;
  * Parkinson's       -> detection prevalence during the two rest tasks (rest tremor),
                         and subject-level "any rest tremor detected";
  * the effective-lever-arm distribution of beats in PD-at-rest vs HC-moving windows.

Three decision rules are compared on IDENTICAL per-window metrics produced by the
firmware's own DSP code (tools/dsp_cli.cpp), so the only difference is the rule:
  spectral       strong + narrow + steady + consistent 4-6 Hz beat (gyro-only, ELENA-style)
  spectral+gate  spectral, but windows with voluntary movement (0.5-3 Hz) are discarded
                 (the usual fix, e.g. the 2025 open-source gyroscope detector)
  ours           spectral + kinematic attribution (effective lever arm + axis linearity)

Usage: eval_pads.py --pads DIR --cli PATH/TO/dsp_cli [--out docs/results/pads]
"""
import argparse, json, os, subprocess, sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

TASKS = ["Relaxed", "RelaxedTask", "LiftHold", "StretchHold", "HoldWeight", "PointFinger",
         "DrinkGlas", "CrossArms", "TouchIndex", "TouchNose", "Entrainment"]
REST = {"Relaxed", "RelaxedTask"}
POSTURAL = {"LiftHold", "StretchHold", "HoldWeight"}
KINETIC = {"PointFinger", "DrinkGlas", "CrossArms", "TouchIndex", "TouchNose", "Entrainment"}
GATE_LOWBAND = 0.4  # rad/s RMS in 0.5-3 Hz; above this the gate baseline discards the window


def group_of(condition: str) -> str:
    c = condition.lower()
    if c.startswith("healthy"):
        return "HC"
    if "parkinson" in c and "atypical" not in c and "secondary" not in c:
        return "PD"
    return "DD"  # differential diagnoses: essential tremor, atypical/secondary parkinsonism, MS


def subtype_of(p):
    """PADS disease_comment gives the clinical PD subtype (German IPS = idiopathic PD)."""
    c = (p.get("disease_comment") or "").lower()
    if group_of(p.get("condition", "")) != "PD":
        return ""
    if "tremordominant" in c or "tremor-dominant" in c or "tremor dominant" in c:
        return "tremor-dominant"
    if "mixed" in c:
        return "mixed"
    if "akinetic" in c or "hypokinetic" in c or "rigid" in c:
        return "akinetic-rigid"
    return "unspecified"


def run_cli(cli, path, hop):
    with open(path, "rb") as f:
        out = subprocess.run([cli, "--cols", "t,ax,ay,az,gx,gy,gz", "--hop", str(hop)],
                             stdin=f, capture_output=True, check=True).stdout
    from io import BytesIO
    return pd.read_csv(BytesIO(out))


def consistent(df, flag):
    """Firmware-style consistency: this window AND the previous one pass, same frequency."""
    f = df[flag].to_numpy()
    fr = df["freq"].to_numpy()
    out = np.zeros(len(df), bool)
    for i in range(1, len(df)):
        out[i] = f[i] and f[i - 1] and abs(fr[i] - fr[i - 1]) <= 1.0
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pads", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--out", default="docs/results/pads")
    ap.add_argument("--hop", type=int, default=100)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    patients = {}
    for fn in os.listdir(os.path.join(args.pads, "patients")):
        with open(os.path.join(args.pads, "patients", fn)) as f:
            p = json.load(f)
        p["subtype"] = subtype_of(p)
        patients[p["id"]] = p
    print(f"{len(patients)} subjects; conditions:", pd.Series([p["condition"] for p in patients.values()]).value_counts().to_dict())
    print("PD subtypes:", pd.Series([p["subtype"] for p in patients.values() if group_of(p["condition"]) == "PD"]).value_counts().to_dict())

    ts_dir = os.path.join(args.pads, "movement", "timeseries")
    files = sorted(f for f in os.listdir(ts_dir) if f.endswith(".txt") and os.path.getsize(os.path.join(ts_dir, f)) > 1000)
    print(f"{len(files)} recordings")

    def work(fn):
        sid, task, wrist = fn[:-4].split("_", 2)
        try:
            df = run_cli(args.cli, os.path.join(ts_dir, fn), args.hop)
        except Exception as e:  # noqa
            print("skip", fn, e, file=sys.stderr)
            return None
        beat = (df["freq"] > 0) & (df["ratio"] >= 0.40) & (df["omega"] >= 0.10) & (df["steady"] >= 0.5)
        df["beat"] = beat
        df["spectral"] = consistent(df, "beat")
        df["gated_beat"] = beat & (df["lowband"] < GATE_LOWBAND)
        df["spectral_gate"] = consistent(df, "gated_beat")
        df["ours"] = df["confirmed"].astype(bool)
        df["subject"] = sid
        df["task"] = task
        df["wrist"] = wrist
        p = patients.get(sid, {})
        df["condition"] = p.get("condition", "?")
        df["group"] = group_of(p.get("condition", "?"))
        df["subtype"] = p.get("subtype", "")
        df["dominant_side"] = (wrist.replace("Wrist", "").lower() == p.get("handedness", "?"))
        return df.iloc[1:]  # first window has no predecessor for consistency

    with ThreadPoolExecutor(max_workers=os.cpu_count()) as ex:
        parts = [d for d in ex.map(work, files) if d is not None]
    W = pd.concat(parts, ignore_index=True)
    W.to_csv(os.path.join(args.out, "windows.csv"), index=False)
    print(f"{len(W)} analysis windows")

    rules = ["spectral", "spectral_gate", "ours"]
    lines = []
    P = lines.append
    P("# PADS evaluation\n")
    P(f"Subjects: " + ", ".join(f"{g} = {n}" for g, n in W.groupby('group')['subject'].nunique().items()))
    P(f"Windows: {len(W)} (2.56 s, 1 s hop) from {len(files)} recordings, both wrists.\n")

    # 1. False positives in healthy controls, per task
    P("## Healthy controls: windows flagged as tremor (all are false positives)\n")
    P("| Task | type | windows | " + " | ".join(rules) + " |")
    P("|---|---|---:|" + "---:|" * len(rules))
    hc = W[W.group == "HC"]
    for t in TASKS:
        sub = hc[hc.task == t]
        if not len(sub):
            continue
        kind = "rest" if t in REST else "postural" if t in POSTURAL else "kinetic"
        P(f"| {t} | {kind} | {len(sub)} | " + " | ".join(f"{100*sub[r].mean():.2f}%" for r in rules) + " |")
    P(f"| **all** | | {len(hc)} | " + " | ".join(f"**{100*hc[r].mean():.2f}%**" for r in rules) + " |")
    P("")

    # 2. PD detections at rest, per rule (sensitivity proxy)
    P("## Parkinson's: windows flagged during the two REST tasks\n")
    pd_rest = W[(W.group == "PD") & W.task.isin(REST)]
    hc_rest = hc[hc.task.isin(REST)]
    P("| | windows | " + " | ".join(rules) + " |")
    P("|---|---:|" + "---:|" * len(rules))
    P(f"| PD at rest | {len(pd_rest)} | " + " | ".join(f"{100*pd_rest[r].mean():.2f}%" for r in rules) + " |")
    P(f"| HC at rest | {len(hc_rest)} | " + " | ".join(f"{100*hc_rest[r].mean():.2f}%" for r in rules) + " |")
    P("")
    P("Not every Parkinson's patient has rest tremor (roughly 70% do), and PADS has no per-task tremor "
      "labels, so the PD row is a prevalence, not a sensitivity. What matters is that *ours* keeps the PD "
      "detections the spectral rule makes while cutting the healthy-control false positives.\n")

    # 3. Subject level
    P("## Subject level: any rest-task window flagged\n")
    P("| group | subjects | " + " | ".join(rules) + " |")
    P("|---|---:|" + "---:|" * len(rules))
    for g in ["PD", "DD", "HC"]:
        sub = W[(W.group == g) & W.task.isin(REST)]
        n = sub.subject.nunique()
        P(f"| {g} | {n} | " + " | ".join(f"{100*sub.groupby('subject')[r].any().mean():.1f}%" for r in rules) + " |")
    P("")

    # 3b. Clinical subtype check: tremor-dominant PD should light up far more than akinetic-rigid PD
    P("## Parkinson's clinical subtype (from the neurologist's diagnosis comment) vs rest-task detections\n")
    P("Tremor-dominant patients should be detected far more often than akinetic-rigid ones; a detector that "
      "cannot tell them apart is reacting to something other than tremor.\n")
    P("| PD subtype | subjects | rest windows | " + " | ".join(f"{r} (windows)" for r in rules) + " | " + " | ".join(f"{r} (subjects)" for r in rules) + " |")
    P("|---|---:|---:|" + "---:|" * (2 * len(rules)))
    for st in ["tremor-dominant", "mixed", "akinetic-rigid", "unspecified"]:
        sub = W[(W.group == "PD") & (W.subtype == st) & W.task.isin(REST)]
        if not len(sub):
            continue
        P(f"| {st} | {sub.subject.nunique()} | {len(sub)} | " + " | ".join(f"{100*sub[r].mean():.2f}%" for r in rules) + " | " +
          " | ".join(f"{100*sub.groupby('subject')[r].any().mean():.1f}%" for r in rules) + " |")
    P("")

    # 4. What the kinematic attribution sees
    P("## Effective lever arm of detected beats\n")
    beats = W[W.beat]
    P("| windows with a strong, narrow, steady 4-6 Hz beat | n | lever median (cm) | 10th-90th pct | axis linearity median |")
    P("|---|---:|---:|---:|---:|")
    for name, sel in [("PD at rest", beats[(beats.group == "PD") & beats.task.isin(REST)]),
                      ("PD postural", beats[(beats.group == "PD") & beats.task.isin(POSTURAL)]),
                      ("PD kinetic tasks", beats[(beats.group == "PD") & beats.task.isin(KINETIC)]),
                      ("DD (ET etc.) at rest", beats[(beats.group == "DD") & beats.task.isin(REST)]),
                      ("DD postural", beats[(beats.group == "DD") & beats.task.isin(POSTURAL)]),
                      ("HC at rest", beats[(beats.group == "HC") & beats.task.isin(REST)]),
                      ("HC postural", beats[(beats.group == "HC") & beats.task.isin(POSTURAL)]),
                      ("HC kinetic tasks", beats[(beats.group == "HC") & beats.task.isin(KINETIC)])]:
        if not len(sel):
            P(f"| {name} | 0 | | | |")
            continue
        lv = sel.lever * 100
        P(f"| {name} | {len(sel)} | {lv.median():.1f} | {lv.quantile(.1):.1f}-{lv.quantile(.9):.1f} | {sel.axis.median():.2f} |")
    P("")

    # 5. Kinetic-task breakdown for PD (what ours removes)
    P("## Parkinson's: kinetic/postural tasks (ambiguous: tremor and voluntary movement mix)\n")
    P("| Task | windows | " + " | ".join(rules) + " |")
    P("|---|---:|" + "---:|" * len(rules))
    pdw = W[W.group == "PD"]
    for t in TASKS:
        sub = pdw[pdw.task == t]
        if len(sub):
            P(f"| {t} | {len(sub)} | " + " | ".join(f"{100*sub[r].mean():.2f}%" for r in rules) + " |")
    P("")

    # 6. Threshold sweep for the lever gate
    P("## Lever-arm threshold sweep (spectral rule + lever gate only)\n")
    P("| max lever (cm) | HC windows flagged | PD rest windows flagged | HC kinetic flagged |")
    P("|---:|---:|---:|---:|")
    for thr in [4, 6, 8, 10, 12, 15, 18, 20, 25, 30, 1000]:
        W["_g"] = W.beat & (W.lever * 100 <= thr)
        flag = pd.Series(False, index=W.index)
        for (_, _, _), grp in W.groupby(["subject", "task", "wrist"], sort=False):
            flag.loc[grp.index] = consistent(grp.assign(_g=grp["_g"]), "_g")
        hcf = flag[W.group == "HC"].mean()
        pdf_ = flag[(W.group == "PD") & W.task.isin(REST)].mean()
        hck = flag[(W.group == "HC") & W.task.isin(KINETIC)].mean()
        P(f"| {thr if thr < 1000 else 'none'} | {100*hcf:.2f}% | {100*pdf_:.2f}% | {100*hck:.2f}% |")
    W.drop(columns="_g", inplace=True)

    report = "\n".join(lines)
    with open(os.path.join(args.out, "REPORT.md"), "w") as f:
        f.write(report + "\n")
    print(report)


if __name__ == "__main__":
    main()
