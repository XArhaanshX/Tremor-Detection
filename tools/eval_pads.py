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

Four decision rules are compared on IDENTICAL per-window features produced by the
firmware's own DSP code (tools/dsp_cli.cpp), so the only difference is the rule. They
mirror ALGORITHMS in dashboard/js/dsp.js:
  bandpower  >= 50 % of 1-15 Hz power in 3.5-7.5 Hz, amplitude >= 0.10 rad/s (classic baseline)
  spectral   strong + narrow + steady 4-6 Hz peak, gyro only (ELENA-style)
  gated      strong + narrow 3-7 Hz peak, windows with 0.5-3 Hz arm movement discarded
             (after Timmermans et al. 2025)
  ours       spectral + effective lever arm <= 15 cm (ELA)
Each needs two windows in a row at the same frequency.

Writes docs/results/pads/REPORT.md and dashboard/data/pads_summary.json (the dashboard's
Algorithms tab). Usage: eval_pads.py --pads DIR --cli PATH/TO/dsp_cli [--out docs/results/pads]
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


ALGOS = {  # id -> (candidate rule, reported-frequency column); keep in sync with dashboard/js/dsp.js
    "bandpower": (lambda d: (d.bp_ratio >= 0.5) & (d.bp_omega >= 0.10), "bp_freq"),
    "spectral": (lambda d: (d.freq > 0) & (d.ratio >= 0.40) & (d.omega >= 0.10) & (d.steady >= 0.5), "freq"),
    "gated": (lambda d: (d.p37_freq > 0) & (d.p37_ratio >= 0.40) & (d.p37_omega >= 0.10) & (d.lowband < GATE_LOWBAND), "p37_freq"),
    "ours": (None, "freq"),
}
NAMES = {"bandpower": "Band-power threshold", "spectral": "Spectral peak, gyro only",
         "gated": "Movement-gated (after Timmermans 2025)", "ours": "Ours: lever-arm check (ELA)"}
BANDS = {"bandpower": (3.5, 7.5), "spectral": (4, 6), "gated": (3, 7), "ours": (4, 6)}


def consistent(df, flag, freq="freq"):
    """Firmware-style consistency: this window AND the previous one pass, same frequency."""
    f = df[flag].to_numpy()
    fr = df[freq].to_numpy()
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
    ap.add_argument("--summary", default="dashboard/data/pads_summary.json")
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
        df["beat"] = ALGOS["spectral"][0](df)
        for aid, (rule, fcol) in ALGOS.items():
            if rule is None:
                df[aid] = df["confirmed"].astype(bool)
            else:
                df[f"{aid}_cand"] = rule(df)
                df[aid] = consistent(df, f"{aid}_cand", fcol)
            df[f"{aid}_f"] = np.where(df[aid], df[fcol], np.nan)
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

    rules = list(ALGOS)
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
    write_summary(W, files, patients, args.summary)


def write_summary(W, files, patients, path):
    """Compact numbers for the dashboard's Algorithms tab (dashboard/data/pads_summary.json)."""
    bins = np.round(np.arange(2.0, 9.01, 0.25), 2)
    hist = lambda v: np.histogram(v[(v >= bins[0]) & (v < bins[-1])], bins=bins)[0].tolist()
    q = lambda v: {"n": int(len(v)), "median": round(float(np.median(v)), 2) if len(v) else None,
                   "q1": round(float(np.percentile(v, 25)), 2) if len(v) else None,
                   "q3": round(float(np.percentile(v, 75)), 2) if len(v) else None}
    rest = W.task.isin(REST)
    pd_ = W.group == "PD"
    hc = W.group == "HC"
    td = pd_ & (W.subtype == "tremor-dominant")
    ar = pd_ & (W.subtype == "akinetic-rigid")
    # Algorithm-independent "what frequency is Parkinsonian tremor here": strong, narrow dominant
    # oscillations in tremor-dominant patients at rest (same strength rules, any frequency 2-9 Hz).
    strong = (W.dom_ratio >= 0.4) & (W.dom_omega >= 0.10) & (W.dom >= 2) & (W.dom < 9)
    td_beats = W.dom[td & rest & strong].to_numpy()
    hc_beats = W.dom[hc & W.task.isin(KINETIC) & strong].to_numpy()
    pct = lambda m: round(100 * float(m.mean()), 3) if m.size else None
    subj = lambda sel, a: round(100 * float(W[sel & rest].groupby("subject")[a].any().mean()), 1)
    out = {
        "dataset": {
            "name": "PADS - Parkinson's Disease Smartwatch dataset (PhysioNet)", "url": "https://physionet.org/content/parkinsons-disease-smartwatch/1.0.0/",
            "license": "CC BY-NC-SA 4.0", "recordings": len(files), "windows": int(len(W)),
            "subjects": {g: int(n) for g, n in W.groupby("group")["subject"].nunique().items()},
            "pdSubtypeSubjects": {k: int(v) for k, v in W[pd_].groupby("subtype")["subject"].nunique().items()},
        },
        "bins": bins.tolist(),
        "observed": {"tdRest": {**q(td_beats), "hist": hist(td_beats)}, "hcMoving": {**q(hc_beats), "hist": hist(hc_beats)}},
        "algorithms": {},
    }
    for a in ALGOS:
        f = W[f"{a}_f"]
        lo, hi = BANDS[a]
        tdf = f[td & rest].dropna().to_numpy()
        out["algorithms"][a] = {
            "name": NAMES[a], "band": [lo, hi],
            "hcAllPct": pct(W[a][hc]), "hcRestPct": pct(W[a][hc & rest]),
            "hcPosturalPct": pct(W[a][hc & W.task.isin(POSTURAL)]), "hcKineticPct": pct(W[a][hc & W.task.isin(KINETIC)]),
            "pdRestPct": pct(W[a][pd_ & rest]), "tdRestPct": pct(W[a][td & rest]), "arRestPct": pct(W[a][ar & rest]),
            "mixedRestPct": pct(W[a][pd_ & (W.subtype == "mixed") & rest]), "ddRestPct": pct(W[a][(W.group == "DD") & rest]),
            "tdSubjectsPct": subj(td, a), "arSubjectsPct": subj(ar, a), "hcSubjectsPct": subj(hc, a),
            "coveragePct": round(100 * float(((td_beats >= lo) & (td_beats <= hi)).mean()), 1) if len(td_beats) else None,
            "freqTdRest": {**q(tdf), "hist": hist(tdf)},
        }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print("wrote", path)


if __name__ == "__main__":
    main()
