# Product Requirements Document — TremorBand

**Product:** TremorBand — all-day Parkinson's tremor monitoring wristband + offline dashboard
**Status:** Working research/education prototype (hardware design, firmware, dashboard and host tests exist)
**Disclaimer:** Not a medical device. Scores are estimates to discuss with a neurologist; they must not be used on their own to change medication.

---

## 1. Summary

TremorBand is an ESP32-S3 + IMU wristband that watches a Parkinson's patient's hand all day, detects **rest tremor on the device itself** using an FFT (no cloud), converts it into a **0–4 severity score** on the MDS-UPDRS tremor-amplitude scale, and streams it live over Bluetooth Low Energy to an **offline-capable web dashboard**. If Bluetooth drops, the band stores data in flash and syncs it later with acknowledgements, so nothing is lost. The dashboard also runs short **active tests** (finger tapping, hand turning, rest/postural tremor), so passive monitoring and active testing live in one platform, and produces a printable **report for the neurologist**.

## 2. Problem and opportunity

- Parkinson's symptoms fluctuate through the day with medication cycles ("on/off", wearing-off). A clinic visit shows a few minutes of that picture.
- Patients rely on memory and paper diaries, which are inaccurate and burdensome for people with motor and cognitive impairment.
- Neurologists need objective data: how much tremor, when, how long a dose works, whether it returns before the next dose.
- Existing wearables are expensive, closed, cloud-dependent, or not designed around tremor.

**Opportunity:** a low-cost (~$20–25 in parts), open, private, offline system that gives continuous objective tremor data plus a clinician-ready report.

## 3. Goals and non-goals

### Goals
1. Detect Parkinsonian rest tremor (4–6 Hz) continuously, on-device, with low false positives from normal movement.
2. Report severity on a clinically familiar scale (MDS-UPDRS 3.17 amplitude bins, 0–4).
3. Lose no data: store ~11 days offline on the band and sync with ACKs.
4. Keep all data private: no accounts, no cloud, no telemetry. Data lives on the band and in the user's own browser.
5. Be usable by patients with tremor, stiffness and slowness (see §9, UX requirements).
6. Combine passive monitoring and active tests; give medication-response insight (time to effect, wearing-off).
7. Be buildable by a beginner from off-the-shelf parts and runnable with no hardware (demo mode).

### Non-goals
- Diagnosis, treatment recommendations or medication changes.
- Detecting non-tremor symptoms (bradykinesia, gait freezing, dyskinesia) passively. Only hand turning and finger tapping are measured, and only as active tests.
- Cloud sync, multi-user accounts, clinician portals (possible future work).
- Regulatory clearance (FDA/CE). Clinical validation has not been done.

## 4. Users and stakeholders

| User | Needs |
|---|---|
| **Patient** (primary) | Wear it and forget it; glance at how they are doing; log medicine; do short tests. Large, calm, forgiving UI. |
| **Caregiver / builder** | Build and flash the band, install the app, set hand size and wrist, check battery and sync. |
| **Neurologist** | Objective, summarised data: % time with tremor, average/worst severity, dose response, trends; printable PDF and CSV. |
| **Researcher / student** | Open hardware, readable code, documented algorithm and protocol, host-testable DSP. |

## 5. System overview

```
WRISTBAND (XIAO ESP32-S3 + MPU-6050)
  MPU-6050 -I2C 400 kHz-> FIFO (100 Hz accel+gyro) -> 256-sample sliding window
     every 1 s: detrend -> Hann -> FFT x3 axes -> summed power spectrum
     -> "strong, narrow, steady, consistent 4-6 Hz beat?"
     -> amplitude (cm) -> severity 0-4
     -> LIVE notify (1/s)         -> 30 s epoch record -> LittleFS queue (~11 days)
  BLE GATT (NimBLE)
        |  Web Bluetooth - no internet, no cloud
DASHBOARD (offline PWA in Chrome/Edge)
  Live - Day - Tests - Report - Settings   | IndexedDB storage | ACKs records to the band
```

All tremor analysis happens on the band. The dashboard displays, stores, runs the on-screen tapping test, and builds reports.

## 6. Hardware

### 6.1 Bill of materials (≈ $20–25)

| # | Part | Role |
|---|---|---|
| 1 | Seeed Studio XIAO ESP32-S3 (not "Sense") | 21 × 17.8 mm, dual-core 240 MHz with hardware FPU, BLE 5, built-in LiPo charger, USB-C, 8 MB flash |
| 2 | MPU-6050 breakout (GY-521) | 3-axis gyro + 3-axis accel, 1 KB FIFO, on-chip low-pass filter, ±2000 dps, I²C |
| 3 | 3.7 V LiPo 400–500 mAh with protection circuit, ≤ 35 × 30 × 6 mm | ~12 h runtime |
| 4 | Mini SPDT slide switch | Power on/off (must be ON to charge) |
| 5 | 2 × 100 kΩ + 100 nF (optional) | Battery-voltage sensing |
| 6 | 3D-printed case (~45 × 38 × 14 mm) + 20 mm watch strap/Velcro | IMU must be held rigidly to the wrist |
| 7 | 30 AWG silicone wire, heat-shrink, foam tape | Assembly |

Alternative: classic ESP32 dev board for bench prototyping (`esp32dev` env). **Do not use ESP32-C3** (no FPU).

### 6.2 Wiring

| XIAO ESP32-S3 | Connects to | Constant (`firmware/include/config.h`) |
|---|---|---|
| 3V3 | GY-521 VCC | |
| GND | GY-521 GND, LiPo −, divider bottom | |
| D4 / GPIO5 | GY-521 SDA | `PIN_I2C_SDA` |
| D5 / GPIO6 | GY-521 SCL | `PIN_I2C_SCL` |
| D0 / GPIO1 | Battery divider midpoint (optional) | `PIN_BATT_ADC` (-1 = not fitted) |
| BAT+/BAT− pads | LiPo through the switch | |
| GPIO21 | Onboard LED (status) | `PIN_LED` |
| GPIO0 | Onboard BOOT button = "I took my medicine" | `PIN_BUTTON` |

Bench `esp32dev`: SDA 21, SCL 22, LED 2, button 0. MPU-6050 address 0x68 (AD0 low), INT unused (firmware polls the FIFO).

### 6.3 Mechanical and wearing

- GY-521 screwed or hard-glued to the case floor, not foam: a wobbly sensor has its own resonance that can mimic tremor.
- Stack: case floor → GY-521 → foam → battery → XIAO, USB-C facing a case opening, BOOT button under a flexible window.
- Worn on the back of the wrist of the more affected arm. **Orientation does not matter**: the maths sums all three gyro axes.

### 6.4 Power budget

| Consumer | Current |
|---|---|
| ESP32-S3 at 80 MHz, BLE connected | ~30–40 mA |
| MPU-6050 gyro + accel | ~3.9 mA |
| **Total** | **~35–45 mA → ≈ 12 h on 500 mAh** |

Charging from USB-C at ~100 mA (≈ 5 h). Future: ESP-IDF automatic light sleep could roughly double runtime.

### 6.5 Hardware-driven design decisions

| Decision | Reason |
|---|---|
| 100 Hz sampling, 42 Hz DLPF | SMPLRT_DIV=9; Nyquist 50 Hz ≫ 6 Hz; DLPF prevents aliasing |
| Gyro ±2000 dps | 10 cm tremor at 5 Hz ≈ 900 dps; fast hand turning 600–1000 dps would clip at ±250 |
| Accel ±8 g | Severe tremor reaches several g |
| FIFO drain every ~20 ms | FIFO holds 85 samples (0.85 s); BLE/flash pauses never lose data |
| I²C reads chunked to 120 B | Arduino-ESP32 Wire buffer is 128 B |
| Float FFT on device | S3 has a single-precision FPU |
| 20-byte BLE packets | Fits default ATT MTU 23 on every phone/browser |
| LittleFS ≤ 0.7 MB | Default 8 MB partition gives ~1.5 MB data partition |
| Records stamped boot+uptime | No battery-backed RTC |
| CPU at 80 MHz | 3 × 256-point FFT/s takes < 2 ms; saves power |

## 7. Firmware

**Stack:** C++ on Arduino-ESP32 via PlatformIO (`espressif32@^6.9.0`), NimBLE-Arduino `^1.4.3`, LittleFS. Environments: `xiao_esp32s3` (real sensor), `xiao_esp32s3_sim` (simulated patient, no sensor), `esp32dev`, `esp32dev_sim`.

| Module (`firmware/src/`) | Responsibility |
|---|---|
| `imu_mpu6050.cpp` / `imu.h` | Register-level driver: 100 Hz, DLPF 42 Hz, ±2000 dps, ±8 g, FIFO burst reads, overflow recovery |
| `imu_sim.cpp` | Synthetic IMU (`SIMULATE_IMU`): tremor that comes and goes like medication wearing off |
| `dsp/fft.cpp` | Radix-2 float FFT |
| `dsp/tremor.cpp` | Per-window analysis: spectrum → tremor decision → amplitude → severity |
| `dsp/pronsup.cpp` | Hand-turning (pronation–supination) analysis |
| `storage.cpp` | Append-only segmented queue on LittleFS with sequence numbers, ACK pointer, boot/time table |
| `ble_service.cpp` | GATT server: Live, Records, Control, Status, Test characteristics |
| `main.cpp` | Scheduler: sample → analyse each 1 s → epoch each 30 s → store → sync |
| `include/config.h` | Every tunable (pins, sensor registers, window sizes, storage limits) |
| `include/protocol.h` | Packet structs, source of truth for the BLE protocol |

### 7.1 Detection algorithm (`docs/ALGORITHM.md`)

Input: last 256 gyro samples (2.56 s at 100 Hz, 0.39 Hz resolution), new result every 1 s.

1. Detrend (mean + linear trend) and Hann window each gyro axis.
2. FFT each axis; **sum the three power spectra** (orientation-independent, avoids frequency doubling).
3. Find the strongest local peak in 4–6 Hz; refine by Gaussian interpolation.
4. A **candidate** requires all four:
   - **Narrow:** main lobe (±2 bins) ≥ 40 % of power in 1–15 Hz
   - **Strong:** amplitude ≥ 0.10 rad/s (~0.6 mm)
   - **In band:** true local maximum inside 4–6 Hz
   - **Steady:** beat amplitude ratio first/second half of the window ≥ 0.5
5. **Confirmed** only if the previous window was also a candidate within ±1 Hz (onset latency ≈ 3.5 s).
6. Amplitude by Parseval: ω = √(2·ms); θ = ω/(2πf); hand displacement peak-to-peak ≈ 2·θ·L, with L = wrist-to-palm lever (default 10 cm, set in app).
7. Severity (MDS-UPDRS 3.17 amplitude bins): none = 0, < 1 cm = 1, 1–3 cm = 2, 3–10 cm = 3, ≥ 10 cm = 4.
8. 6.5–12 Hz oscillations passing the same tests are flagged `HIGHFREQ` and never counted (essential/physiological tremor range).

### 7.2 Hand-turning test

Buffers up to 15 s of gyro data, finds the main rotation axis by power iteration on the 3×3 covariance (orientation-free), splits into half-turns with hysteresis (15 % of peak speed, ≥ 0.5 rad/s), and reports turns/s, rotation per turn, peak speed, amplitude and speed decrement (first vs last third), rhythm CV and hesitations (the things MDS-UPDRS 3.6 asks a clinician to judge by eye).

### 7.3 Data storage and "nothing is lost"

- Every 30 s the band writes one 20-byte epoch record to flash with a sequence number, phone or not.
- Queue: 128 segments × 256 records × 20 B ≈ 655 KB → **~11 days offline**. When full, oldest data is dropped first.
- Records are deleted only after the app ACKs them. `store_id` changes after erase or fresh flash so sequence numbers never collide.
- Records are stamped boot number + uptime; once a phone sets the clock during that boot, the band converts to real time (`REC_TIME_VALID`).

## 8. BLE protocol (`docs/PROTOCOL.md`)

All packets ≤ 20 bytes, little-endian. Service `d2e60001-ed8b-45e3-b151-051e61e017ff`, advertised as `TremorBand-XXXX`.

| Characteristic | Suffix | Props | Payload |
|---|---|---|---|
| Live | `…0002` | notify | `LivePacket` 20 B, 1/s |
| Records | `…0003` | notify | `EpochRecord` 20 B or `SyncMarker` 5 B |
| Control | `…0004` | write | commands |
| Status | `…0005` | read, notify | `StatusPacket` 20 B, every 5 s + on change |
| Test | `…0006` | notify | progress (6 B) / result (16 B) / aborted (2 B) |

Commands: `0x01 SET_TIME`, `0x02 SYNC`, `0x03 ACK`, `0x10 TEST_START` (1 rest, 2 postural, 3 hand turning), `0x11 TEST_ABORT`, `0x20 SET_LEVER` (30–300 mm, saved in NVS), `0x7F ERASE` (needs `0xA5 0x5A`).

**Sync:** app sets time and lever, reads status, sends SYNC; band streams ≤ 32 records 6 ms apart then BATCH_END; app saves to IndexedDB and sends ACK for the highest contiguous seq; band deletes ACKed segments and sends the next batch until SYNC_DONE. No ACK within 5 s → band resends from acked+1; app de-duplicates on `[store_id, seq]`; gaps are ACKed only up to the gap.

## 9. Dashboard (software)

**Stack:** plain HTML + CSS + ES modules, **no build step, no dependencies**, no CDN. Web Bluetooth, IndexedDB, Canvas 2D charts, Service Worker (offline shell cache) and Web App Manifest (installable PWA). Browsers: Chrome/Edge on Windows, macOS, Linux, Android, ChromeOS. iPhone: Bluefy browser (iOS Safari has no Web Bluetooth).

| File (`dashboard/`) | Responsibility |
|---|---|
| `index.html` | Single-page shell, five views |
| `css/style.css` | Design tokens, layout, light/dark themes |
| `js/app.js` | Views and wiring |
| `js/ble.js` | Web Bluetooth connection, notifications, sync/ACK state machine, auto-reconnect |
| `js/protocol.js` | UUIDs and packet decoders (mirror of `protocol.h`) |
| `js/sim.js` | Demo band with the same interface, a week of history and a live simulated patient |
| `js/store.js` | IndexedDB: records, doses, test results, settings |
| `js/chart.js` | Dependency-free canvas chart: bars/line/step, markers, hover tooltip |
| `js/tests.js` | Finger tapping (on screen) and band-based tests |
| `js/report.js` | Daily summaries, CSV export, printable report |
| `sw.js` | Offline caching (cache name bumped per release) |

### 9.1 Views and features

| View | Features |
|---|---|
| **Live** | Severity 0–4 with plain-word label, steady/moving explanation, shake rate (Hz), shake size (cm), beat strength, arm movement, 3-minute severity and size charts |
| **Day** | Time monitored, % time with tremor, average and worst severity, 10-minute bar chart with dose markers, "how each dose worked" (time to effect, time until tremor returns), tests of the day, ‹ › day navigation, "forgot to log a dose" |
| **Tests** | Finger tapping (10 s), hand turning (10 s), rest tremor (30 s), postural tremor (30 s); trend chart and history. Results are stored alongside the passive reading at that moment |
| **Report** | 7/14/30 days: hours monitored, % tremor, average severity, dose duration, typical-day curve, day-by-day table, medication response, test averages; **Print / save PDF** and CSV export (records, doses, tests) |
| **Settings** | Hand size (wrist-to-palm, 5–20 cm), wrist side, band info (battery, firmware, storage), data on device, delete app data, erase band memory |

Also: connection pill with sync progress, demo mode ("Try the demo"), dose logging from the app or the band button.

### 9.2 Active tests

| Test | Measured by | Duration | Metrics |
|---|---|---|---|
| Finger tapping | Screen, two alternating targets | 10 s | taps, taps/s, rhythm CV, fatigue (2nd vs 1st half), accuracy, longest pause |
| Hand turning | Wristband gyro | 10 s | turns/s, rotation per turn, peak speed, amplitude and speed decrement, rhythm, hesitations |
| Rest tremor | Wristband FFT pipeline | 30 s | % time with tremor, mean/max severity, Hz, cm |
| Postural tremor | Same, arms held out | 30 s | same |

### 9.3 UX requirements for patients with Parkinson's

These are product requirements, implemented in the current UI:

- **Calm, low-glare palette:** muted slate and soft blue-teal, off-white or soft charcoal (never pure white/black), muted severity colours with no alarm-red; light and dark follow the system setting.
- **No motion or jitter:** no animations, hover lifts or blur; fixed-size number slots so changing values never shift the layout; live charts refresh every 5 s instead of continuously scrolling; axis only grows.
- **Large targets for tremor and impaired fine motor control:** 18 px base text, controls ≥ 56 px, generous spacing, large tap targets in tests, wide thumb-reachable "I took my medicine" button at the bottom.
- **Prevent accidental actions:** dose logging asks for confirmation; destructive confirmations make Cancel the highlighted button and put the destructive button on the opposite side; destructive area is visually separated; toasts stay 6 s.
- **Fixed, predictable navigation:** top bar and tab bar fixed in place, centred tabs, no hidden gestures.
- **Plain language:** "the arm that shakes more", "Hand is steady", severity words alongside numbers; technical terms limited to hints.
- **One column, one thing at a time:** hero result first, supporting numbers second, charts last.
- **Accessibility basics:** visible focus rings, `aria` labels on charts/buttons, reduced reliance on hover (tooltips are supplemental), table alternative for charts.
- **Privacy by default:** data stays in the browser; no accounts.

## 10. Data model

| Entity | Fields (summary) | Where |
|---|---|---|
| Epoch record (20 B) | store_id/seq, time (unix or uptime + flag), severity stats, % tremor, mean Hz/cm, activity | Band flash, then IndexedDB |
| Live packet (20 B) | severity, tremor/candidate/high-freq flags, Hz, cm, ratio, activity | BLE only, last 3 minutes held in memory |
| Status packet | battery, firmware, store_id, next_seq, acked_seq | BLE |
| Dose | timestamp, source (app/band) | IndexedDB; band notified via `noteDose` |
| Test result | kind, time, metrics, passive reading | IndexedDB |
| Settings | lever cm, wrist side, demo flag | IndexedDB; lever also on band (NVS) |

## 11. Key user flows (`docs/USER_FLOW.md`)

1. **Setup (once):** build and flash band; open dashboard (GitHub Pages or `python -m http.server -d dashboard 8000`); optionally install as an app; set hand size and wrist.
2. **Morning:** switch on, strap on; LED blink every 2 s = recording. Press **Connect band** → pick `TremorBand-XXXX` (first time only). The app sets the clock, sends hand size and back-fills everything missed.
3. **All day:** passive FFT every second; Live tab shows result; walking out of range shows "Out of range — reconnecting" while the band keeps recording.
4. **Medication:** tap the app button (with confirmation) or press the band's button (3 LED blinks).
5. **Active tests:** a few times a day, e.g. before a dose and an hour after.
6. **Evening:** Day tab to review the day and each dose's effect.
7. **Before the appointment:** Report tab → print/save PDF or export CSV.
8. **Night:** charge over USB-C with the switch ON.

## 12. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| F1 | Sample IMU at 100 Hz with no loss during BLE/flash activity | Must |
| F2 | Run tremor analysis every 1 s on-device | Must |
| F3 | Detect 4–6 Hz rest tremor; reject voluntary movement, sub-4 Hz, > 6.5 Hz | Must |
| F4 | Output severity 0–4 and estimated amplitude (cm) | Must |
| F5 | Persist a 30 s record to flash with sequence number | Must |
| F6 | Sync with batch + ACK + resend; de-duplicate on the app | Must |
| F7 | Stream live data at 1 Hz to a connected app | Must |
| F8 | Work offline after first load; installable | Must |
| F9 | Log doses from app and from the band button | Must |
| F10 | Run finger-tapping, hand-turning, rest and postural tests | Should |
| F11 | Day view with dose-response analysis | Should |
| F12 | Printable report and CSV export | Should |
| F13 | Demo mode without hardware | Should |
| F14 | Orientation-independent measurement | Must |
| F15 | Erase band memory and delete app data with confirmation | Should |

## 13. Non-functional requirements

| Area | Target |
|---|---|
| Battery | ≥ 12 h continuous on 500 mAh |
| Offline storage | ≈ 11 days of 30 s epochs on the band |
| Latency | Tremor onset shown in ≈ 3.5 s; live updates 1/s |
| Privacy | No network calls, no accounts; data only on band and user's browser |
| Safety | Protected LiPo only; "not a medical device" shown; stop wearing if warm |
| Compatibility | Chrome/Edge desktop and Android; Bluefy on iOS |
| Footprint | Dashboard ≈ 100 KB, zero dependencies |
| Reliability | Power-loss-safe flash queue; auto-reconnect; resend on missing ACK |

## 14. Testing and quality

- **Host DSP tests:** `make -C firmware/test/host` (71 checks) runs FFT, tremor detector and hand-turning code on a PC with synthetic tremor, movement and noise (with MPU-6050 bias, noise and quantisation). Verified: 4–6 Hz, 0.5–12 cm tremor detected 100 %, frequency ±0.02 Hz, amplitude within 1 %, correct UPDRS bin, identical across 4 strap orientations; still hand, slow voluntary movement, random wobble, 2.5 Hz and 9 Hz oscillations → 0 %; 1.2 s burst not confirmed.
- **Protocol cross-check:** `node tools/check_protocol.mjs` compiles the firmware C structs and checks the JS decoder byte-for-byte (needs a C++ compiler such as g++).
- **CI:** GitHub Actions workflows in `tools/github-workflows/` (CI, Pages deploy); copy to `.github/workflows/` to enable.
- **Bring-up checklist:** WHO_AM_I 0x68 OK; flat on a table → severity 0, activity < 20 mg; shake ~5 Hz → severity 1–3 within 2–3 s; slow waving → 0; walk away > 1 min and return → automatic back-fill.

## 15. Repository layout

```
firmware/   PlatformIO project (Arduino-ESP32 + NimBLE)
  src/dsp/  portable FFT, tremor detector, hand-turning analysis (host-tested)
  include/  config.h (tunables), protocol.h (packet source of truth)
  test/host PC test harness
dashboard/  offline PWA: Web Bluetooth, IndexedDB, canvas charts, tests, reports
tools/      protocol cross-check, CI/Pages workflows
docs/       user flow, beginner build, hardware, architecture, algorithm, protocol
```

## 16. Build and run

```bash
# Dashboard (demo, no hardware)
python -m http.server -d dashboard 8000        # http://localhost:8000

# Firmware
pip install platformio
pio run -d firmware -e xiao_esp32s3 -t upload       # real sensor
pio run -d firmware -e xiao_esp32s3_sim -t upload   # simulated patient
pio device monitor -b 115200

# Tests
make -C firmware/test/host
node tools/check_protocol.mjs
```

## 17. Risks and limitations

| Risk | Mitigation / note |
|---|---|
| Thresholds tuned on synthetic data | Re-tune with real patient recordings before relying on them |
| cm estimate assumes pure wrist rotation with lever L | Calibrate against clinician ratings; hand size is user-set |
| Action/re-emergent tremor during large voluntary movement may be missed | Narrowness test is deliberately conservative |
| Loose sensor mounting creates false resonance | Rigid mounting is part of the build guide |
| Band clock resets on power loss | Boot + uptime stamping; re-set clock on each connect |
| iOS lacks Web Bluetooth in Safari | Bluefy browser; possible native app later |
| Battery safety on skin | Protected LiPo, no unattended charging |
| Not clinically validated, no regulatory clearance | Positioned strictly as research/education |
| Passive detection limited to tremor | Bradykinesia captured only by active tests |

## 18. Roadmap / future work

1. Validate against clinician-rated MDS-UPDRS scores and real patient recordings; re-tune thresholds.
2. Battery life: automatic light sleep, adaptive duty cycling.
3. Passive bradykinesia, dyskinesia and gait/freezing indicators.
4. Medication reminders and symptom diary prompts.
5. Optional encrypted export / clinician sharing (user-initiated only).
6. Native mobile app or Capacitor wrapper for iOS.
7. Custom PCB and smaller enclosure; skin-safe materials.
8. Accessibility options in the dashboard: text-size control, high-contrast mode, simplified "caregiver view", voice prompts for tests.

## 19. Success metrics

- **Detection:** sensitivity/specificity versus clinician labels (target to be set after validation).
- **Data integrity:** 0 lost records across disconnect/reconnect tests.
- **Battery:** ≥ 12 h measured with a USB power meter.
- **Usability:** a patient can connect, log a dose and run a test without help; zero accidental dose logs in usability sessions.
- **Clinician value:** the printed report answers "how much, when, and does the dose last" at a glance.

## 20. Documentation index

- [User flow](docs/USER_FLOW.md)
- [First-time build guide](docs/BEGINNER_BUILD.md)
- [Hardware build guide](docs/HARDWARE.md)
- [Software architecture](docs/ARCHITECTURE.md)
- [Algorithm](docs/ALGORITHM.md)
- [BLE protocol](docs/PROTOCOL.md)
