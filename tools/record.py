#!/usr/bin/env python3
"""Record raw IMU data from the band (flashed with the *_rawlog firmware) to a CSV.

  python3 tools/record.py --label brushing_teeth --seconds 60 [--port /dev/ttyUSB0]

Files land in data/recordings/<label>_<timestamp>.csv with columns t,ax,ay,az,gx,gy,gz
(accel in g, gyro in rad/s, 100 Hz) -- the same layout as PADS, so tools/dsp_cli and
tools/eval_recordings.py work on both.

Suggested protocol (wear the sensor on the back of the wrist, strapped tight):
  rest_still        hand in lap, 60 s                      -> should be 0
  fake_tremor       wrist wag ~5/s, hand in lap, 60 s      -> tremor
  brushing_teeth    real brushing, 60 s                    -> should be 0
  washing_hands     60 s                                   -> should be 0
  stirring          stir a pot/cup, 60 s                   -> should be 0
  typing            60 s                                   -> should be 0
  walking           60 s, arm swinging naturally           -> should be 0
  drinking          pick up cup, drink, put down, x10      -> should be 0
  tremor_walking    wrist wag while walking slowly, 60 s   -> tremor (hard case)
"""
import argparse, os, sys, time

try:
    import serial
except ImportError:
    sys.exit("pip install pyserial")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--port", default="/dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--out", default="data/recordings")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"{args.label}_{time.strftime('%Y%m%d_%H%M%S')}.csv")

    s = serial.Serial()
    s.port, s.baudrate, s.timeout = args.port, args.baud, 1
    s.dtr = s.rts = False  # don't reset the board when opening
    s.open()
    s.reset_input_buffer()
    print(f"Recording '{args.label}' for {args.seconds:.0f} s -> {path}")
    for i in (3, 2, 1):
        print(f"  starting in {i}...")
        time.sleep(1)
    s.reset_input_buffer()
    n, overflow = 0, 0
    t_end = time.time() + args.seconds
    with open(path, "w") as f:
        f.write("t,ax,ay,az,gx,gy,gz\n")
        while time.time() < t_end:
            line = s.readline().decode("ascii", "ignore").strip()
            if not line or line.startswith("#") or line.startswith("t,"):
                overflow += line.startswith("# overflow")
                continue
            if line.count(",") == 6:
                f.write(line + "\n")
                n += 1
                if n % 500 == 0:
                    print(f"  {n/100:.0f} s", end="\r", flush=True)
    print(f"\nSaved {n} samples ({n/100:.1f} s){', ' + str(overflow) + ' overflows' if overflow else ''}")


if __name__ == "__main__":
    main()
