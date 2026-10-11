#!/usr/bin/env python3
"""Guided experiment: does the lever-arm check stop everyday rhythmic movements from
being counted as tremor, while still catching tremor?

Needs only: the ESP32 + MPU-6050 flashed with the raw logger, a USB cable to this laptop,
some tape, and household objects (dry toothbrush, cup + spoon, cloth, bottle).

  cd firmware && pio run -e esp32dev_rawlog -t upload && cd ..
  uv run --with pyserial --with pandas --with numpy python tools/experiment.py

It walks you through each activity, records it, scores it immediately with the exact
firmware detector, and writes a report to data/recordings/session_<time>/REPORT.md.
Re-score an old session:   ... python tools/experiment.py --score-only data/recordings/session_...
"""
import argparse, glob, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_recordings import score_file  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "build", "dsp_cli")
CLI_SRC = [os.path.join(ROOT, p) for p in ("tools/dsp_cli.cpp", "firmware/src/dsp/fft.cpp", "firmware/src/dsp/tremor.cpp",
                                           "firmware/src/dsp/tremor.h", "firmware/src/dsp/fft.h")]

# (label, should it count as tremor?, what to do)
PROTOCOL = [
    ("rest_still", False,
     "Forearm resting on the table or your lap, hand relaxed and completely still."),
    ("fake_tremor_rest", True,
     "Forearm resting on the table/lap, palm down. Make a small, fast shiver with your HAND at the "
     "wrist (tiny back-and-forth twists, about 5 per second, like a nervous shake). Keep the "
     "forearm still - only the hand moves."),
    ("brushing_teeth", False,
     "Brush your teeth with a DRY toothbrush (keep water away from the electronics), normal strokes."),
    ("stirring", False,
     "Stir a cup or bowl briskly with a spoon, like mixing sugar into tea."),
    ("scrubbing", False,
     "Scrub the table with a dry cloth or sponge, quick back-and-forth strokes."),
    ("shaking_bottle", False,
     "Shake a closed bottle up and down quickly."),
    ("rubbing_hands", False,
     "Rub your hands together as if washing them (no water)."),
    ("typing", False,
     "Type on the laptop keyboard normally."),
    ("waving", False,
     "Wave hello, over and over."),
    ("drinking", False,
     "Pick up a cup, take a sip, put it down. Repeat until time is up."),
    ("fake_tremor_moving", True,
     "HARD CASE: keep doing the small fast hand shiver while slowly raising and lowering your "
     "forearm. (Existing detectors throw these windows away.)"),
]


def build_cli():
    if os.path.exists(CLI) and all(os.path.getmtime(CLI) >= os.path.getmtime(s) for s in CLI_SRC):
        return
    os.makedirs(os.path.dirname(CLI), exist_ok=True)
    print("Building the detector (same C++ code as the wristband)...")
    subprocess.run(["g++", "-std=gnu++17", "-O2", "-I" + os.path.join(ROOT, "firmware/include"), "-o", CLI] +
                   [s for s in CLI_SRC if s.endswith(".cpp")], check=True)


def find_port():
    ports = sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*") + glob.glob("/dev/cu.usbserial*") +
                   glob.glob("/dev/cu.SLAB*"))
    return ports[0] if ports else None


def open_serial(port, baud):
    import serial
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, baud, 0.5
    s.dtr = s.rts = False  # don't hold the board in reset
    try:
        s.open()
    except serial.SerialException as e:
        if "Permission denied" in str(e):
            sys.exit(f"No permission for {port}. Log out and back in (you're in the 'uucp' group), "
                     "or run this in a terminal after `newgrp uucp`.")
        raise
    return s


def parse(line):
    parts = line.split(",")
    if len(parts) != 7:
        return None
    try:
        return [float(p) for p in parts]
    except ValueError:
        return None


def sanity_check(s):
    """Make sure the raw logger is running and the sensor is answering."""
    s.reset_input_buffer()
    end, rows, notes = time.time() + 2.0, [], []
    while time.time() < end:
        line = s.readline().decode("ascii", "ignore").strip()
        if line.startswith("#"):
            notes.append(line)
        elif (v := parse(line)):
            rows.append(v)
    if not rows:
        # restart the board to catch its boot message
        s.rts = True
        time.sleep(0.15)
        s.rts = False
        end = time.time() + 3.0
        while time.time() < end:
            line = s.readline().decode("ascii", "ignore").strip()
            if line.startswith("#"):
                notes.append(line)
            elif (v := parse(line)):
                rows.append(v)
    if any("NOT FOUND" in n for n in notes):
        sys.exit("The board can't see the MPU-6050. Check the 4 wires (3V3-VCC, GND-GND, P21-SDA, P22-SCL), "
                 "then run this again.")
    if not rows:
        sys.exit("No data from the board. Is the raw logger flashed?  cd firmware && pio run -e esp32dev_rawlog -t upload")
    a = [(r[1] ** 2 + r[2] ** 2 + r[3] ** 2) ** 0.5 for r in rows]
    mean_a = sum(a) / len(a)
    print(f"Sensor OK: {len(rows)} samples in ~2 s, gravity reads {mean_a:.2f} g")
    if not 0.8 < mean_a < 1.2:
        print("  (gravity should read ~1.00 g - check the sensor is the MPU-6050 and wired correctly)")


def record(s, path, seconds):
    s.reset_input_buffer()
    n, bad = 0, 0
    t_end = time.time() + seconds
    with open(path, "w") as f:
        f.write("t,ax,ay,az,gx,gy,gz\n")
        while time.time() < t_end:
            line = s.readline().decode("ascii", "ignore").strip()
            if line.startswith("# overflow"):
                bad += 1
                continue
            if parse(line):
                f.write(line + "\n")
                n += 1
                if n % 100 == 0:
                    left = max(0, t_end - time.time())
                    print(f"\r  recording... {left:4.0f} s left ", end="", flush=True)
    print(f"\r  saved {n / 100:.0f} s of data{f' ({bad} overflows)' if bad else ''}          ")
    return n


def verdict(should_be_tremor, r):
    if should_be_tremor:
        return "PASS" if r["ours"] >= 50 else "MISS"
    return "PASS" if r["ours"] <= 5 else "FALSE ALARM"


def describe(label, should, r):
    if not r.get("windows"):
        return f"  {label}: too short to score"
    lever = "-" if r["lever_cm"] != r["lever_cm"] else f"{r['lever_cm']:.1f} cm"
    return (f"  gyro-only detector: {r['spectral']:5.1f}% tremor | movement-gate: {r['spectral_gate']:5.1f}% | "
            f"OURS: {r['ours']:5.1f}%   (beat lever {lever})  -> {verdict(should, r)}")


def report(session, results):
    lines = ["# Lever-arm experiment", "", f"Session: `{os.path.basename(session)}`", "",
             "Each row is one recording, scored window-by-window (2.56 s windows, 1 s hop) by the exact "
             "firmware detector. 'spectral' = gyro-only strong+narrow+steady 4-6 Hz rule (ELENA-style); "
             "'movement gate' = spectral rule that discards windows with 0.5-3 Hz arm movement (2025 open-source "
             "detector style); 'ours' = spectral + effective-lever-arm attribution.", "",
             "| activity | should be tremor? | spectral | movement gate | **ours** | beat lever (cm) | axis linearity | beat freq (Hz) | verdict |",
             "|---|---|---:|---:|---:|---:|---:|---:|---|"]
    fa_removed = 0
    for label, should, r in results:
        if not r.get("windows"):
            continue
        f = lambda v, d=1: "-" if v != v else f"{v:.{d}f}"  # noqa: E731
        lines.append(f"| {label} | {'yes' if should else 'no'} | {r['spectral']:.1f}% | {r['spectral_gate']:.1f}% | "
                     f"**{r['ours']:.1f}%** | {f(r['lever_cm'])} | {f(r['axis'], 2)} | {f(r['freq_hz'])} | {verdict(should, r)} |")
        if not should and r["spectral"] > 5 and r["ours"] <= 5:
            fa_removed += 1
    non = [r for _, s, r in results if not s and r.get("windows")]
    yes = [r for _, s, r in results if s and r.get("windows")]
    lines += ["", "## Summary", ""]
    if non:
        lines.append(f"- Non-tremor activities: gyro-only detector flagged **{sum(r['spectral'] for r in non)/len(non):.1f}%** "
                     f"of windows on average, movement gate **{sum(r['spectral_gate'] for r in non)/len(non):.1f}%**, "
                     f"ours **{sum(r['ours'] for r in non)/len(non):.1f}%**.")
        lines.append(f"- Activities where the gyro-only detector raised false alarms and ours did not: **{fa_removed}**.")
    if yes:
        lines.append(f"- Imitated tremor: ours detected **{sum(r['ours'] for r in yes)/len(yes):.1f}%** of windows "
                     f"(gyro-only {sum(r['spectral'] for r in yes)/len(yes):.1f}%, movement gate "
                     f"{sum(r['spectral_gate'] for r in yes)/len(yes):.1f}%).")
    lines += ["", "Caveat: the tremor here is imitated by a healthy person. It has the same *kinematics* as rest "
              "tremor (a wrist-generated oscillation), which is what the lever arm measures, but this is not a "
              "clinical validation."]
    text = "\n".join(lines) + "\n"
    with open(os.path.join(session, "REPORT.md"), "w") as f:
        f.write(text)
    return text


def score_session(session):
    build_cli()
    results = []
    for label, should, _ in PROTOCOL:
        path = os.path.join(session, f"{label}.csv")
        if os.path.exists(path):
            results.append((label, should, score_file(CLI, path)))
    for path in sorted(glob.glob(os.path.join(session, "*.csv"))):  # extra recordings you added yourself
        label = os.path.basename(path)[:-4]
        if label not in {p[0] for p in PROTOCOL}:
            results.append((label, "tremor" in label, score_file(CLI, path)))
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=40)
    ap.add_argument("--port")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--score-only", metavar="SESSION_DIR")
    args = ap.parse_args()

    if args.score_only:
        print(report(args.score_only, score_session(args.score_only)))
        return

    build_cli()
    port = args.port or find_port()
    if not port:
        sys.exit("No board found. Plug the ESP32 into USB.")
    s = open_serial(port, args.baud)
    print(f"Board on {port}")
    sanity_check(s)

    session = os.path.join(ROOT, "data", "recordings", time.strftime("session_%Y%m%d_%H%M%S"))
    os.makedirs(session, exist_ok=True)
    print(f"\nSaving to {os.path.relpath(session, ROOT)}")
    print("Tape the sensor firmly where a watch sits (back of the wrist). It must not wobble.\n")

    results = []
    i = 0
    while i < len(PROTOCOL):
        label, should, how = PROTOCOL[i]
        print(f"[{i + 1}/{len(PROTOCOL)}] {label.replace('_', ' ').upper()}  ({args.seconds:.0f} s)")
        print(f"  {how}")
        ans = input("  Enter = start, s = skip, q = finish now: ").strip().lower()
        if ans == "q":
            break
        if ans == "s":
            i += 1
            continue
        for k in (3, 2, 1):
            print(f"\r  get ready... {k} ", end="", flush=True)
            time.sleep(1)
        print("\r  GO!               ")
        path = os.path.join(session, f"{label}.csv")
        record(s, path, args.seconds)
        r = score_file(CLI, path)
        print(describe(label, should, r))
        if input("  Enter = keep and continue, r = redo: ").strip().lower() == "r":
            continue
        results.append((label, should, r))
        i += 1
        print()

    s.close()
    print("\n" + report(session, score_session(session)))
    print(f"Report saved to {os.path.relpath(os.path.join(session, 'REPORT.md'), ROOT)}")


if __name__ == "__main__":
    main()
