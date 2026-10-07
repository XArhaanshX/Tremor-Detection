# Software Architecture & Plan

This is the plan the code in this repo implements. Every design decision below
is tied back to a hardware constraint (see [HARDWARE.md](HARDWARE.md)) — if you
change the hardware, re-check the table at the bottom.

## 1. The system in one picture

```
 ┌──────────────────────── WRISTBAND (XIAO ESP32-S3 + MPU-6050) ────────────────────────┐
 │                                                                                       │
 │  MPU-6050 ──I²C 400kHz──▶ FIFO (100 Hz, accel+gyro) ──▶ 256-sample sliding window      │
 │                                                          │ every 1 s (hop = 100)      │
 │                                                          ▼                            │
 │                                   detrend → Hann → FFT ×3 axes → power spectrum       │
 │                                                          │                            │
 │                       "strong, narrow, consistent 4–6 Hz beat?"  (tremor.cpp)         │
 │                                                          │                            │
 │                          amplitude (cm) ──▶ severity 0–4 (UPDRS amplitude bins)       │
 │                                │                         │                            │
 │                 LIVE notify (1/s)              30-s epoch summary                     │
 │                                │                         │                            │
 │                                │              LittleFS queue (survives power loss,    │
 │                                │              ~11 days of offline storage)            │
 │                                ▼                         ▼                            │
 │                       ────────────── BLE GATT (NimBLE) ──────────────                 │
 └───────────────────────────────────────────┬───────────────────────────────────────────┘
                                             │ Web Bluetooth (no internet, no cloud)
 ┌───────────────────────────────────────────▼───────────────────────────────────────────┐
 │  DASHBOARD (offline-capable web app / PWA, runs in Chrome/Edge on laptop or Android)  │
 │   Live view · Day timeline · Dose log · Active tests · Report / CSV export            │
 │   IndexedDB on the phone/laptop stores everything; ACKs records back to the band      │
 └───────────────────────────────────────────────────────────────────────────────────────┘
```

All tremor analysis happens **on the wristband**. The dashboard only displays,
stores and runs the phone-based tapping test.

## 2. Repository layout

| Path | What it is |
|---|---|
| `firmware/` | PlatformIO project for the wristband (Arduino-ESP32 + NimBLE) |
| `firmware/src/dsp/` | Portable C++ signal processing (FFT, tremor detector, hand-turning test). No Arduino code, so it is unit-tested on a PC. |
| `firmware/test/host/` | PC test harness: synthetic tremor / movement / noise signals → checks the detector |
| `dashboard/` | The web app (plain HTML/JS modules, no build step, works offline) |
| `tools/` | Cross-checks between firmware and dashboard (packet format) |
| `docs/` | Plan, hardware build guide, BLE protocol, algorithm, user flow |

## 3. Firmware modules

| Module | Responsibility |
|---|---|
| `imu_mpu6050` | Register-level driver: 100 Hz, DLPF 42 Hz, ±2000 dps, ±8 g, FIFO burst reads, overflow recovery |
| `sim_imu` | Synthetic IMU (build flag `SIMULATE_IMU`) so the BLE/dashboard path can be tested with a bare ESP32 |
| `dsp/fft` | Radix-2 float FFT (uses the ESP32 hardware FPU) |
| `dsp/tremor` | Per-window analysis: spectrum → tremor decision → amplitude → severity |
| `dsp/aggregate` | Rolls window results into 30-s epochs and into tremor-test results |
| `dsp/pronsup` | Hand-turning (pronation–supination) test analysis: speed, amplitude, decrement, rhythm |
| `storage` | Append-only segmented queue on LittleFS with sequence numbers + ACK pointer; boot/time table |
| `ble_service` | GATT server: Live, Records, Control, Status, Test characteristics |
| `main` | Scheduler: sample → analyse every 1 s → epoch every 30 s → store → sync |

## 4. Detection algorithm (summary — full detail in [ALGORITHM.md](ALGORITHM.md))

1. 256 samples (2.56 s) of gyroscope data per axis, new analysis every 1 s.
2. Remove the mean and linear trend (kills gyro bias and slow arm drift), apply a Hann window.
3. FFT each axis and **add the three power spectra** — this makes the result
   independent of how the band is strapped on (and avoids the frequency-doubling
   you get from taking the magnitude of an oscillating rotation).
4. Tremor *candidate* if, inside 4–6 Hz:
   - **narrow/strong:** the peak's main lobe holds ≥ 40 % of all power in 1–15 Hz, and is a true local peak;
   - **big enough:** tremor angular-velocity amplitude ≥ 0.10 rad/s (well above sensor noise).
5. **Consistent:** confirmed only if the previous window was also a candidate at a similar frequency (±1 Hz).
6. Amplitude: angular amplitude θ = ω / (2πf); hand displacement ≈ 2·θ·L (L = wrist-to-hand lever, default 10 cm, settable in the app).
7. Severity uses the MDS-UPDRS tremor-amplitude bins: none → 0, < 1 cm → 1, 1–3 cm → 2, 3–10 cm → 3, ≥ 10 cm → 4.

## 5. Data flow & “nothing is lost” guarantee

- Every 30 s the band writes one 20-byte **epoch record** to flash with a sequence number — whether or not a phone is connected.
- When the dashboard connects it sets the band's clock, then asks for records. The band sends them in batches of 32; the dashboard saves them to IndexedDB and replies **ACK n** ("I have everything up to n"). Only then does the band delete them.
- If the link drops mid-sync, un-ACKed records are simply sent again next time (the dashboard de-duplicates by sequence number).
- The ESP32 has no battery-backed clock, so records are stamped with *boot number + seconds since boot*. As soon as a phone sets the time during that boot, the band can convert all of that boot's records to real clock time.
- Capacity: 128 segments × 256 records × 20 B ≈ 655 KB → ~11 days with no phone at all. When full, the oldest data is dropped first.

## 6. Dashboard modules

| File | Responsibility |
|---|---|
| `js/protocol.js` | UUIDs, packet decoders/encoders (mirror of `firmware/include/protocol.h`) |
| `js/ble.js` | Web Bluetooth connection, notifications, sync/ACK state machine, auto-reconnect |
| `js/sim.js` | Demo band: same interface as `ble.js`, generates realistic days + live data |
| `js/store.js` | IndexedDB: records, doses, test results, settings |
| `js/chart.js` | Small canvas chart library (no CDN → works offline) |
| `js/tests.js` | Finger-tapping test (on screen) + band-based tests (rest tremor, postural tremor, hand turning) |
| `js/report.js` | Daily summaries, CSV export, printable report for the neurologist |
| `js/app.js` | Views and wiring |
| `sw.js` | Service worker — after the first load the app works with no internet |

## 7. Active tests (passive + active in one platform)

| Test | Where it's measured | Duration | Metrics |
|---|---|---|---|
| Finger tapping | Phone/laptop screen (two alternating targets) | 10 s | taps, taps/s, rhythm (CV of intervals), fatigue (2nd half vs 1st half), accuracy, longest pause |
| Hand turning (pronation–supination) | Wristband gyroscope | 10 s | turns/s, mean rotation angle, peak speed, amplitude & speed decrement, rhythm, hesitations |
| Rest tremor check | Wristband (same FFT pipeline) | 30 s | % time with tremor, mean/max severity, frequency, amplitude |
| Postural tremor check | Wristband (same FFT pipeline) | 30 s | same as above, arms held out |

Every test result is saved with the band's current passive tremor reading
alongside it, so you can see "what happened naturally" next to "how they did on the test".

## 8. Hardware-compliance checklist

| Decision | Hardware fact it depends on |
|---|---|
| 100 Hz sampling, 42 Hz DLPF | MPU-6050 SMPLRT_DIV=9 with DLPF on (1 kHz/10). Nyquist 50 Hz ≫ 6 Hz; DLPF prevents aliasing |
| Gyro ±2000 dps | 10 cm tremor at 5 Hz ≈ 900 dps; fast hand-turning ≈ 600–1000 dps. ±250 dps (default) would clip |
| Accel ±8 g | Wrist acceleration in severe tremor reaches several g |
| FIFO reads | MPU-6050 FIFO = 1024 B = 85 samples (0.85 s). Main loop drains it every ~20 ms, so BLE/flash pauses never lose samples |
| I²C reads chunked to 120 B | Arduino-ESP32 Wire buffer is 128 B |
| Float FFT on-device | ESP32 / ESP32-S3 have a single-precision FPU (ESP32-C3 does **not** — don't use it) |
| 20-byte packets | Default BLE ATT MTU 23 → 20-byte payload works with every phone/browser without MTU negotiation |
| LittleFS ≤ 0.7 MB | Default partition tables give a 1.375–1.5 MB data partition on 4 MB/8 MB boards |
| Records stamped with boot+uptime | ESP32 has no battery-backed RTC |
| Web Bluetooth | Chrome/Edge (Windows, macOS, Linux, Android, ChromeOS). iOS Safari has no Web Bluetooth → use the Bluefy browser on iPhone |
| CPU at 80 MHz | Enough for 3×256-pt FFT per second (< 2 ms) while cutting power for all-day battery |
| Orientation-independent maths | Patients won't strap it on identically every day |
