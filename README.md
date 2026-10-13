# Tremor Detection Wristband

An ESP32 + IMU wristband that watches a Parkinson's patient's hand **all day**, detects
rest tremor **on the band itself** with an FFT (no cloud), turns it into a 0–4 severity
score on the UPDRS amplitude scale, and streams it live over Bluetooth to an offline web
dashboard. If Bluetooth drops, the band keeps the data in flash and syncs it later with
acknowledgements, so nothing is lost.

- **Lever-arm check:** accelerometer ÷ gyroscope at the beat frequency tells tremor made at
  the wrist from rhythmic arm movements (brushing, stirring), which fool gyro-only detectors.
- **Wearing-off warning:** the app learns how long each dose lasts for this patient
  (Kaplan–Meier, per time of day) and the band warns before tremor usually returns, or as
  soon as it comes back early.
- **Eight short tests** (tapping, per-hand tapping, spiral, follow-the-dot, reaction time,
  hand turning, rest and postural tremor), prompted around each dose, next to the all-day data.

> Research/education prototype — not a medical device.

## Docs
- [User flow](docs/USER_FLOW.md) — what the patient does, start to finish
- [First-time build guide](docs/BEGINNER_BUILD.md) — never done hardware? start here
- [Hardware build guide](docs/HARDWARE.md) — parts, wiring, power & storage budget
- [Software architecture](docs/ARCHITECTURE.md) — modules and the hardware-compliance checklist
- [Algorithm](docs/ALGORITHM.md) — how tremor is told apart from normal movement; wearing-off model
- [Research note](docs/RESEARCH.md) — what already exists, the gap, PADS real-patient results
- [Experiment](docs/EXPERIMENT.md) — test the lever-arm check with our own band
- [PRD](PRD.md) — product requirements
- [BLE protocol](docs/PROTOCOL.md) — packets, sync & ACK

## Quick start
```bash
# Dashboard (try the demo — no hardware needed)
python3 -m http.server -d dashboard 8000      # open http://localhost:8000 in Chrome/Edge

# Firmware (Seeed XIAO ESP32-S3 + MPU-6050)
pip install platformio
pio run -d firmware -e xiao_esp32s3 -t upload         # real sensor
pio run -d firmware -e xiao_esp32s3_sim -t upload     # simulated patient, no sensor
pio device monitor -b 115200

# Tests
make -C firmware/test/host        # 104 DSP checks: tremor, lever arm, hand turning, wear-off monitor
node tools/check_protocol.mjs     # firmware structs <-> dashboard decoder
node tools/check_dsp_js.mjs       # dashboard's JS detector == firmware C++, window by window
node tools/test_wearoff.mjs       # 23 checks: Kaplan-Meier, censoring, slots, backtest
node tools/test_screen_tests.mjs  # 65 checks: spiral, reaction, tracking, per-hand tapping

# Research tools (Python: uv run --with numpy --with scipy --with pandas --with matplotlib python ...)
tools/eval_pads.py                # firmware detector on the PADS dataset (469 people)
tools/experiment.py               # guided recordings with our band, three detectors compared
tools/teacher_graphs.py --simulate  # raw / band-passed / spectrogram / lever-arm figure
```

GitHub Actions workflows (CI + Pages deploy for the dashboard) are in
`tools/github-workflows/` — copy them to `.github/workflows/` to enable.

## Layout
```
firmware/   PlatformIO project (Arduino-ESP32 + NimBLE)
  src/dsp/  portable FFT, tremor detector, hand-turning analysis (host-tested)
dashboard/  offline PWA: Web Bluetooth, IndexedDB, canvas charts, tests, reports
tools/      protocol cross-check, CI/Pages workflows
docs/       plan, hardware, algorithm, protocol, user flow
```
