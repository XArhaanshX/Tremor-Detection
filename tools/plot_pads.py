#!/usr/bin/env python3
"""Figures from eval_pads.py output (windows.csv): lever-arm distributions and
false-positive bars. Usage: plot_pads.py docs/results/pads"""
import os, sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

BLUE, ORANGE, AQUA, YELLOW = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"
INK, MUTED, GRID = "#0b0b0b", "#898781", "#e1e0d9"
REST = {"Relaxed", "RelaxedTask"}
KINETIC = {"PointFinger", "DrinkGlas", "CrossArms", "TouchIndex", "TouchNose", "Entrainment"}


def style(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color("#c3c2b7")
    ax.tick_params(colors=MUTED, labelsize=9)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "docs/results/pads"
    W = pd.read_csv(os.path.join(out, "windows.csv"))
    beats = W[W.beat]
    plt.rcParams["font.family"] = "sans-serif"

    # Figure 1: where does the rotation axis sit? (effective lever arm)
    fig, ax = plt.subplots(figsize=(7.5, 3.6), dpi=150)
    bins = np.linspace(0, 40, 41)
    groups = [
        ("Parkinson's, at rest (tremor)", beats[(beats.group == "PD") & beats.task.isin(REST)].lever * 100, BLUE),
        ("Healthy, moving tasks (voluntary)", beats[(beats.group == "HC") & beats.task.isin(KINETIC)].lever * 100, ORANGE),
        ("Parkinson's, moving tasks", beats[(beats.group == "PD") & beats.task.isin(KINETIC)].lever * 100, AQUA),
    ]
    for label, v, c in groups:
        if len(v):
            ax.hist(v.clip(0, 40), bins=bins, density=True, histtype="step", linewidth=2, color=c,
                    label=f"{label}  (n={len(v)}, median {v.median():.1f} cm)")
    ax.axvline(12, color=INK, linewidth=1, linestyle="--")
    ax.text(12.4, ax.get_ylim()[1] * 0.95, "12 cm gate", fontsize=8, color=INK, va="top")
    ax.set_xlabel("effective lever arm of the 4–6 Hz beat (cm)", color=MUTED)
    ax.set_ylabel("density", color=MUTED)
    ax.set_title("Where is the oscillation coming from? Wrist-generated beats sit near the sensor", fontsize=10, color=INK, loc="left")
    ax.legend(frameon=False, fontsize=8)
    style(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "lever_distribution.png"))

    # Figure 2: healthy-control false positives per task group, per rule
    fig, ax = plt.subplots(figsize=(7.5, 3.2), dpi=150)
    hc = W[W.group == "HC"]
    cats = [("rest", hc[hc.task.isin(REST)]), ("postural", hc[~hc.task.isin(REST | KINETIC)]), ("moving", hc[hc.task.isin(KINETIC)])]
    rules = [("spectral (gyro-only)", "spectral", BLUE), ("spectral + movement gate", "spectral_gate", YELLOW), ("ours (lever arm)", "ours", AQUA)]
    x = np.arange(len(cats))
    w = 0.26
    for i, (label, col, c) in enumerate(rules):
        vals = [100 * d[col].mean() for _, d in cats]
        bars = ax.bar(x + (i - 1) * w, vals, w - 0.03, color=c, label=label)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.05, f"{v:.2f}%", ha="center", fontsize=7, color=INK)
    ax.set_xticks(x, [f"{n}\n({len(d)} windows)" for n, d in cats])
    ax.set_ylabel("windows wrongly flagged as tremor", color=MUTED)
    ax.set_title("Healthy controls: false positives by task type", fontsize=10, color=INK, loc="left")
    ax.legend(frameon=False, fontsize=8)
    style(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "false_positives.png"))
    print("wrote", os.path.join(out, "lever_distribution.png"), "and false_positives.png")


if __name__ == "__main__":
    main()
