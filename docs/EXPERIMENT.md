# Testing the lever-arm algorithm with the parts we already have

**Needed:** the ESP32 board, the GY-521 sensor, the jumper wires, the USB cable, this laptop.
**From around the house:** tape (any kind), a dry toothbrush, a cup + spoon, a cloth, a closed bottle.
Nothing to buy. Takes about 20 minutes.

The experiment answers one question: *do everyday rhythmic movements (brushing, stirring,
scrubbing, shaking) fool a normal tremor detector, and does the lever-arm check stop that
without missing tremor?* Every recording is scored by three detectors on the same data:

| detector | what it is |
|---|---|
| spectral (gyro-only) | the standard approach (ELENA-style): strong, narrow, steady 4–6 Hz beat |
| movement gate | the 2025 open-source fix: ignore any window with arm movement |
| **ours** | spectral + effective lever arm (is the beat made at the wrist or by the arm?) |

## 1. Get the sensor working (the one blocker)

The board must log `MPU-6050 ... OK`. If it still says `NOT FOUND`, check with the USB unplugged:

- **3V3 → VCC, GND → GND, P21 → SDA, P22 → SCL.** SDA/SCL are the 3rd and 4th sensor pins, not XDA/XCL.
- The small LED on the sensor lights up when USB is plugged in. If it doesn't, the 3V3 or GND wire is wrong or loose.
- Each sensor pin is in its own breadboard row, and each wire is in the same row as its sensor pin.

## 2. Make the sensor wearable (no breadboard)

The sensor has to sit **on the wrist where a watch goes**, so it moves with the wrist:

1. Take the sensor out of the breadboard.
2. Make 4 longer wires by joining two male-to-female wires end to end (male end into the
   other wire's female end). Each long wire now has a socket at both ends.
3. Connect them exactly as before: 3V3 → VCC, GND → GND, P21 → SDA, P22 → SCL.
4. Wrap a bit of tape around each join and over the sockets on the ESP32 so nothing pops off.
5. **Tape the sensor flat and tight on the back of your wrist**, where a watch face would be.
   It must not wobble. A loose sensor wiggles by itself and ruins the test.
6. Tape the ESP32 to your forearm or upper arm, or just keep it on the table, with the USB
   cable to the laptop. Keep the laptop close; the cable is your leash.

## 3. Flash the recorder

```bash
cd "/home/arhaansh/Projects/tremor detection/firmware"
pio run -e esp32dev_rawlog -t upload
```

## 4. Run the guided experiment

```bash
cd "/home/arhaansh/Projects/tremor detection"
uv run --with pyserial --with pandas --with numpy python tools/experiment.py
```

It checks the sensor, then walks you through 11 activities, 40 s each. For each one it
shows the instructions, counts down, records, and immediately prints the three detectors'
results. Press `r` to redo one, `s` to skip one.

| # | activity | should count as tremor? |
|---|---|---|
| 1 | hand still at rest | no |
| 2 | **imitated tremor**: small fast hand shiver (~5/s), forearm resting | **yes** |
| 3 | brushing teeth (dry toothbrush) | no |
| 4 | stirring a cup | no |
| 5 | scrubbing the table with a dry cloth | no |
| 6 | shaking a closed bottle | no |
| 7 | rubbing hands as if washing (no water) | no |
| 8 | typing | no |
| 9 | waving | no |
| 10 | drinking from a cup | no |
| 11 | **imitated tremor while slowly moving the arm** (hard case) | **yes** |

**Keep water away from the electronics.** Every "washing" activity is mimed dry.

At the end it writes `data/recordings/session_<time>/REPORT.md` with the full table and a
summary. Commit that folder: it is the evidence.

## 5. What a good result looks like

- Rows 3–6: the gyro-only detector fires a lot, **ours stays near 0 %**, and the beat lever
  reads well above 15 cm. These are the false alarms we remove.
- Row 2: all three detect it. Ours keeps detecting it because the lever is small.
- Row 11: the movement gate throws many of these windows away; ours should keep more.
- Rows 1, 7–10: usually nobody fires (no strong 4–6 Hz beat).

If an activity fools ours too (its lever reads under 15 cm), that's a real finding. Note
it, then re-score with a stricter setting without re-recording:

```bash
uv run --with pandas --with numpy python tools/experiment.py --score-only data/recordings/session_<time>
```

(`tools/dsp_cli` also takes `--max-lever` and `--min-axis` to sweep the gate thresholds.)

## 6. Live demo afterwards

Flash the normal band firmware (`pio run -e esp32dev -t upload`), connect the dashboard,
and brush or stir: the Live tab says *"Rhythmic arm movement (like brushing or stirring) —
it comes from the elbow or shoulder, not the wrist, so it isn't counted."* Then do the
imitated tremor and watch the score come up.

## Honest limits

- The tremor is imitated by a healthy person. It has the same **kinematics** as rest tremor
  (an oscillation generated at the wrist), which is exactly what the lever arm measures. It
  says nothing about involuntary vs voluntary, so this is not clinical validation.
- One person, one session. Run it on 3–4 teammates for a stronger result.
- Real-patient evidence comes from the PADS analysis ([RESEARCH.md](RESEARCH.md)).
