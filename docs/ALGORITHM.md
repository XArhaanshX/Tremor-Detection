# Tremor Detection Algorithm

Runs on the wristband every second (`firmware/src/dsp/tremor.cpp`). Unit-tested on a PC
with synthetic signals that include MPU-6050 bias, noise and quantisation
(`make -C firmware/test/host` → 71 checks).

## Input
Last **256 samples (2.56 s)** at **100 Hz** of the gyroscope (rad/s, 3 axes) and accelerometer (g).
Frequency resolution 0.39 Hz. The MPU-6050's 42 Hz low-pass filter removes anything that could alias.

The gyroscope is the main signal: Parkinson's rest tremor is mostly a rotation of the
forearm/wrist (pill-rolling, pronation–supination), which a gyroscope measures directly
and gravity doesn't contaminate.

## Steps
1. **Detrend + window** each gyro axis: remove mean (gyro bias) and linear trend (slow arm drift), multiply by a Hann window.
2. **FFT** each axis, **sum the three power spectra**. Summing powers (not taking |ω| first) makes the result independent of how the band is worn, and avoids the frequency-doubling that `|sin|` would create.
3. **Find the beat**: strongest *local* peak among the bins covering 4–6 Hz; frequency refined by Gaussian interpolation.
4. **Four tests — all must pass** for a *candidate*:
   | Test | Rule | Why |
   |---|---|---|
   | Narrow | peak's main lobe (±2 bins) ≥ **40 %** of all power in 1–15 Hz | normal movement and wobble spread power over many frequencies |
   | Strong | tremor angular-velocity amplitude ≥ **0.10 rad/s** | ~0.6 mm hand movement; far above sensor noise (0.005 °/s/√Hz) |
   | In band | true local maximum inside 4–6 Hz | 2–3 Hz is voluntary shaking / other tremors; > 6.5 Hz is essential/physiological |
   | Steady | beat amplitude in 1st vs 2nd half of the window ≥ **0.5** ratio | a single jerk or 1-s burst is not "repeating over and over" |
5. **Consistent**: *confirmed* only if the previous window was also a candidate within ±1 Hz. Onset latency ≈ 3.5 s.
6. **Amplitude** (Parseval): mean-square of the band-limited angular velocity
   `ms = 2·Σ|X_k|² / (N·Σw²)` over the lobe → `ω = √(2·ms)`.
   Angular amplitude `θ = ω / (2πf)`; hand displacement peak-to-peak `≈ 2·θ·L`, L = wrist-to-palm lever (default 10 cm, set in the app).
7. **Severity** — MDS-UPDRS 3.17 amplitude bins:

   | Displacement | Score |
   |---|---|
   | no confirmed tremor | 0 Normal |
   | < 1 cm | 1 Slight |
   | 1 – 3 cm | 2 Mild |
   | 3 – 10 cm | 3 Moderate |
   | ≥ 10 cm | 4 Severe |

Oscillations that pass the same tests at **6.5–12 Hz** are flagged (`HIGHFREQ`) but never counted — that's the essential/physiological tremor range.

## Verified behaviour (host tests)
| Scenario | Result |
|---|---|
| 4.0–6.0 Hz tremor, 0.5–12 cm | 100 % detected, frequency ±0.02 Hz, amplitude within 1 %, correct UPDRS bin |
| Same tremor, 4 strap orientations | identical amplitude |
| Still hand / slow voluntary movement / random wobble | 0 % |
| 2.5 Hz shaking, 9 Hz oscillation | 0 % (9 Hz flagged as high-frequency) |
| Tremor + fidgeting / + slow arm movement | 100 % detected |
| Natural tremor (±40 % amplitude, 4.6–5.4 Hz drift) | 100 % detected, amplitude 2.01 vs 2.0 cm |
| 1.2 s burst | not confirmed |

## Limits (be honest in the presentation)
- The cm estimate assumes a pure rotation about the wrist with lever L; it should be calibrated against clinician ratings before any clinical use.
- Re-emergent/action tremor during big voluntary movements may be missed (the narrowness test is deliberately conservative).
- Thresholds were tuned on synthetic data; real patient recordings should be used to re-tune them.

## Hand-turning test (`pronsup.cpp`)
Buffers up to 15 s of gyro data, finds the main rotation axis by power iteration on the
3×3 covariance (orientation-free), splits the signal into half-turns with hysteresis
(15 % of peak speed, ≥ 0.5 rad/s), and reports turns/s, rotation per turn, peak speed,
amplitude & speed decrement (first third vs last third), rhythm CV and hesitations —
the things MDS-UPDRS 3.6 asks a clinician to judge by eye.
