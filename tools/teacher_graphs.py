#!/usr/bin/env python3
"""Graphs that explain the signal processing, from one recording:

  1. raw accelerometer      - messy: gravity, arm movement, tremor all mixed
  2. band-passed 3.5-7.5 Hz - only the tremor band survives: a clean oscillation when
                              there is tremor, almost flat when there isn't
  3. STFT spectrogram       - time x frequency; tremor = a bright band near 5 Hz
  4. lever-arm check        - for every 4-6 Hz beat: is it made at the wrist (tremor) or
                              by the whole arm (brushing, stirring)? Computed by the SAME
                              C++ code that runs on the band (tools/dsp_cli).

  uv run --with numpy --with scipy --with matplotlib python tools/teacher_graphs.py --simulate
  uv run --with numpy --with scipy --with matplotlib python tools/teacher_graphs.py data/recordings/<file>.csv

Input CSV: t,ax,ay,az,gx,gy,gz (accel in g, gyro in rad/s, 100 Hz) - what the raw logger
firmware and tools/record.py / tools/experiment.py save. Output: a PNG next to the input
(or docs/figures/teacher_graphs_simulated.png for --simulate).
"""
import argparse, os, subprocess, sys
from io import StringIO

import numpy as np
from scipy import signal

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
FS = 100.0
G = 9.80665

# calm palette from the dashboard
INK, INK2, MUTED, GRID = "#22303a", "#4a5963", "#65747e", "#dde3e6"
BLUE, ORANGE, GREEN, SAND = "#3f7592", "#b8794b", "#5f9a82", "#cfae5a"


# ---------------------------------------------------------------- simulated session
def rotation(t, f, theta_amp, axis, lever_m, phase=0.0):
    """Rigid rotation about `axis` with the sensor `lever_m` from it: gyro + accel (g)."""
    n = np.asarray(axis, float) / np.linalg.norm(axis)
    tdir = np.array([n[1], -n[0], 0.0]); tdir /= np.linalg.norm(tdir)
    w = 2 * np.pi * f
    th = theta_amp * np.sin(w * t + phase)
    om = theta_amp * w * np.cos(w * t + phase)
    al = -theta_amp * w * w * np.sin(w * t + phase)
    gyro = np.outer(om, n)
    acc = np.outer(lever_m * al / G, tdir) + np.outer(th, tdir)  # tangential + gravity tilt
    return gyro, acc


def simulate(seed=3):
    """90 s: rest, wrist tremor, tooth-brushing, reaching for a cup, tremor while moving."""
    rng = np.random.default_rng(seed)
    t = np.arange(0, 90, 1 / FS)
    gyro = np.zeros((len(t), 3)); acc = np.zeros((len(t), 3)); acc[:, 2] = 1.0
    axis = (0.8, -0.5, 0.3)
    segs = [(0, 15, "rest"), (15, 35, "Parkinsonian rest tremor (5 Hz, wrist)"),
            (35, 55, "brushing teeth (4.3 Hz, whole forearm)"), (55, 70, "reaching for a cup"),
            (70, 90, "tremor while slowly moving the arm")]

    def span(a, b):
        return (t >= a) & (t < b)

    # tremor: hand rotating about the wrist, sensor ~3 cm from that axis, ~2.5 cm p-p at 10 cm
    for a, b in [(15, 35), (70, 90)]:
        m = span(a, b)
        env = np.clip(np.minimum(t[m] - a, b - t[m]) / 1.5, 0, 1)  # soft on/off
        f = 5.0 + 0.2 * np.sin(2 * np.pi * 0.05 * t[m])
        ph = 2 * np.pi * np.cumsum(f) / FS
        theta = 0.125 * env
        om = theta * 2 * np.pi * f * np.cos(ph)
        al = -theta * (2 * np.pi * f) ** 2 * np.sin(ph)
        n = np.asarray(axis) / np.linalg.norm(axis)
        tdir = np.array([n[1], -n[0], 0]); tdir /= np.linalg.norm(tdir)
        gyro[m] += np.outer(om, n)
        acc[m] += np.outer(0.03 * al / G + theta * np.sin(ph), tdir)
    # brushing: forearm swinging about the elbow, sensor ~28 cm from the axis
    m = span(35, 55)
    g, a_ = rotation(t[m], 4.3, 0.06, axis, 0.28)
    env = np.clip(np.minimum(t[m] - 35, 55 - t[m]) / 1.0, 0, 1)[:, None]
    gyro[m] += g * env; acc[m] += a_ * env
    # reaching: slow, large, non-rhythmic arm movement (0.3-1 Hz)
    for a, b in [(55, 70), (70, 90)]:
        m = span(a, b)
        slow = np.sin(np.pi * (t[m] - a) / (b - a)) ** 2
        gyro[m] += np.outer(1.2 * np.sin(2 * np.pi * 0.6 * t[m]) * slow, (0.2, 0.9, 0.3))
        acc[m] += np.outer(0.25 * np.sin(2 * np.pi * 0.6 * t[m] + 0.5) * slow, (0.9, 0.2, 0.1))
    # sensor imperfections: bias + noise
    gyro += 0.03 + rng.normal(0, 0.006, gyro.shape)
    acc += rng.normal(0, 0.004, acc.shape)
    return t, acc, gyro, segs


def load_csv(path):
    d = np.genfromtxt(path, delimiter=",", names=True)
    t = d["t"] - d["t"][0]
    acc = np.column_stack([d["ax"], d["ay"], d["az"]])
    gyro = np.column_stack([d["gx"], d["gy"], d["gz"]])
    return t, acc, gyro, []


# ---------------------------------------------------------------- firmware detector
def run_firmware(t, acc, gyro):
    """Window results from the band's own C++ detector (built on demand)."""
    try:
        from experiment import build_cli, CLI
        build_cli()
    except Exception as e:  # noqa
        print("could not build tools/dsp_cli (needs g++):", e)
        return None
    csv = "t,ax,ay,az,gx,gy,gz\n" + "\n".join(
        f"{a:.3f},{b[0]:.5f},{b[1]:.5f},{b[2]:.5f},{c[0]:.5f},{c[1]:.5f},{c[2]:.5f}" for a, b, c in zip(t, acc, gyro))
    out = subprocess.run([CLI, "--cols", "t,ax,ay,az,gx,gy,gz", "--skip-header"], input=csv.encode(),
                         capture_output=True, check=True).stdout.decode()
    return np.genfromtxt(StringIO(out), delimiter=",", names=True)


# ---------------------------------------------------------------- figure
def style(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color("#b5c0c6")
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.yaxis.grid(True, color=GRID, linewidth=0.7)
    ax.set_axisbelow(True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?")
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()
    if not args.csv and not args.simulate:
        ap.error("give a CSV recording or --simulate")

    t, acc, gyro, segs = simulate() if args.simulate else load_csv(args.csv)
    out = args.out or (os.path.join(ROOT, "docs", "figures", "teacher_graphs_simulated.png") if args.simulate
                       else os.path.splitext(args.csv)[0] + "_graphs.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    amag = np.linalg.norm(acc, axis=1)
    # 4th-order Butterworth band-pass 3.5-7.5 Hz, run forwards and backwards (no phase lag)
    b, a = signal.butter(4, [3.5, 7.5], btype="bandpass", fs=FS)
    gbp = signal.filtfilt(b, a, gyro, axis=0)
    gbp_total = np.sqrt((gbp ** 2).sum(axis=1)) * np.sign(gbp @ np.array([0.8, -0.5, 0.3]))
    # STFT: 2 s windows, 50 % overlap (power summed over the three gyro axes)
    f, tt, Z = signal.stft(gyro - gyro.mean(axis=0), fs=FS, nperseg=200, noverlap=100, axis=0)
    P = (np.abs(Z) ** 2).sum(axis=1)  # (freq, time)
    W = run_firmware(t, acc, gyro)

    fig, axs = plt.subplots(4, 1, figsize=(11, 10.5), dpi=140, sharex=True,
                            gridspec_kw={"height_ratios": [1, 1, 1.25, 1.1]})
    plt.rcParams["font.family"] = "sans-serif"
    for ax in axs:
        style(ax)
        for a0, b0, label in segs:
            if "tremor" in label and "rest" in label or label.startswith("tremor"):
                ax.axvspan(a0, b0, color=BLUE, alpha=0.06, lw=0)
            elif "brushing" in label:
                ax.axvspan(a0, b0, color=ORANGE, alpha=0.07, lw=0)
    for a0, b0, label in segs:
        axs[0].text((a0 + b0) / 2, 1.0, label, transform=axs[0].get_xaxis_transform(), ha="center", va="bottom",
                    fontsize=7.5, color=INK2, wrap=True)

    axs[0].plot(t, amag, color=BLUE, lw=0.8)
    axs[0].set_ylabel("accel |a| (g)", color=MUTED, fontsize=8.5)
    axs[0].set_title("1  Raw accelerometer: gravity, arm movement and tremor all mixed together"
                     + ("   (SIMULATED session)" if args.simulate else ""), loc="left", fontsize=9.5, color=INK, pad=22)

    axs[1].plot(t, gbp_total, color=BLUE, lw=0.8)
    axs[1].set_ylabel("rad/s", color=MUTED, fontsize=8.5)
    axs[1].set_title("2  Gyroscope band-passed 3.5–7.5 Hz: only the tremor band survives (brushing too — see 4)",
                     loc="left", fontsize=9.5, color=INK)

    keep = f <= 15
    im = axs[2].pcolormesh(tt, f[keep], 10 * np.log10(P[keep] + 1e-6), shading="gouraud", cmap="Blues",
                           vmin=np.percentile(10 * np.log10(P[keep] + 1e-6), 30))
    axs[2].axhspan(4, 6, color=SAND, alpha=0.18, lw=0)
    axs[2].set_ylabel("frequency (Hz)", color=MUTED, fontsize=8.5)
    axs[2].set_title("3  Spectrogram (STFT, 2 s windows, 50 % overlap): a bright band at 4–6 Hz = rhythmic beat",
                     loc="left", fontsize=9.5, color=INK)
    axs[2].yaxis.grid(False)
    cax = axs[2].inset_axes([0.985, 0.08, 0.012, 0.84])  # inside the panel: keeps all x-axes aligned
    cb = fig.colorbar(im, cax=cax)
    cb.set_label("power (dB)", color=MUTED, fontsize=8)
    cb.ax.tick_params(labelsize=7, colors=MUTED)

    ax = axs[3]
    if W is not None and len(W):
        beat = (W["freq"] > 0) & (W["ratio"] >= 0.4) & (W["omega"] >= 0.1) & (W["steady"] >= 0.5)
        tw = W["t"] - 1.28  # centre of each 2.56 s window
        lever = np.where(beat, W["lever"] * 100, np.nan)
        conf = W["confirmed"].astype(bool)
        arm = W["arm_driven"].astype(bool)
        ax.axhline(15, color=INK, lw=1, ls="--")
        ax.text(t[-1], 15.8, "15 cm: wrist vs arm", ha="right", fontsize=7.5, color=INK)
        ax.scatter(tw[conf], lever[conf], s=16, color=GREEN, label="counted as tremor (beat made at the wrist)", zorder=3)
        ax.scatter(tw[arm], lever[arm], s=16, color=ORANGE, label="rejected: rhythm made by the whole arm", zorder=3)
        other = beat & ~conf & ~arm
        ax.scatter(tw[other], lever[other], s=10, color=MUTED, label="beat, waiting for confirmation", zorder=2)
        ax.set_ylim(0, max(40, np.nanmax(lever) * 1.1 if np.isfinite(np.nanmax(lever)) else 40))
        ax.legend(frameon=False, fontsize=7.5, loc="upper left")
        detected = conf.mean() * 100
        print(f"windows: {len(W)}, counted as tremor: {conf.sum()}, rejected as arm rhythm: {arm.sum()}")
    else:
        ax.text(0.5, 0.5, "lever-arm panel needs g++ to build tools/dsp_cli", transform=ax.transAxes, ha="center",
                color=MUTED)
    ax.set_ylabel("effective lever arm (cm)", color=MUTED, fontsize=8.5)
    ax.set_xlabel("time (s)", color=MUTED, fontsize=8.5)
    ax.set_title("4  Our check: where is the rotation axis? accel ÷ (gyro × 2πf), by the band's own C++ code",
                 loc="left", fontsize=9.5, color=INK)

    fig.tight_layout()
    fig.savefig(out)
    print("wrote", os.path.relpath(out, ROOT))


if __name__ == "__main__":
    main()
