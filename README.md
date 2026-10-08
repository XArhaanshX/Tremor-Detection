# Tremor Detection Wristband

An ESP32 + IMU wristband that watches a Parkinson's patient's hand **all day**, detects
rest tremor **on the band itself** with an FFT (no cloud), turns it into a 0–4 severity
score on the UPDRS amplitude scale, and streams it live over Bluetooth to an offline web
dashboard. If Bluetooth drops, the band keeps the data in flash and syncs it later with
acknowledgements, so nothing is lost. The dashboard also runs short active tests (finger
tapping, hand turning, rest/postural tremor) so passive monitoring and active testing
live in one platform.

> Research/education prototype — not a medical device.

## Docs
- [User flow](docs/USER_FLOW.md) — what the patient does, start to finish
- [First-time build guide](docs/BEGINNER_BUILD.md) — never done hardware? start here
- [Hardware build guide](docs/HARDWARE.md) — parts, wiring, power & storage budget
- [Software architecture](docs/ARCHITECTURE.md) — modules and the hardware-compliance checklist
- [Algorithm](docs/ALGORITHM.md) — how tremor is told apart from normal movement
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
make -C firmware/test/host        # 71 DSP checks on synthetic tremor/movement/noise
node tools/check_protocol.mjs     # firmware structs <-> dashboard decoder
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
