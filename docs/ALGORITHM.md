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
5. **Wrist-generated, not arm-generated** (our contribution — see [RESEARCH.md](RESEARCH.md)):
   the accelerometer spectrum is computed in the same bins as the gyroscope spectrum and
   `lever_eff = accel_amp / (omega_amp · 2πf)` gives the distance from the sensor to the
   rotation axis. Rest tremor rotates the hand about the wrist/forearm, a few cm from a
   wrist-worn sensor; brushing, washing, stirring and scrubbing swing the forearm about the
   elbow/shoulder, 20–40 cm away. Beats with `lever_eff > 15 cm` are reported as *rhythmic arm
   movement* and not counted. A second cue, `axis_linearity` (principal-axis fraction of the
   beat's 3×3 cross-spectral matrix), is ≈ 1 for a single-joint oscillation and ≈ 0.5 for
   circular motion such as stirring; it is exported for evaluation and can gate too.
6. **Consistent**: *confirmed* only if the previous window was also a candidate within ±1 Hz. Onset latency ≈ 3.5 s.
7. **Amplitude** (Parseval): mean-square of the band-limited angular velocity
   `ms = 2·Σ|X_k|² / (N·Σw²)` over the lobe → `ω = √(2·ms)`.
   Angular amplitude `θ = ω / (2πf)`; hand displacement peak-to-peak `≈ 2·θ·L`, L = wrist-to-palm lever (default 10 cm, set in the app).
8. **Severity** — MDS-UPDRS 3.17 amplitude bins:

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
| Brushing (elbow 28 cm), washing (25 cm), scrubbing (shoulder 40 cm), shaking a bottle (22 cm), stirring (3 cm circle) | gyro-only spectral rule: 100 % false positives; ours: 0 % — effective lever reads 0.21–0.38 m |
| Rotation at a known lever 2–30 cm | lever estimate = true lever ± g/(2πf)² gravity term |
| Single-axis vs circular 5 Hz rotation | axis linearity 1.00 vs 0.50 |

## Real-patient evaluation
`tools/eval_pads.py` runs this exact C++ code over the PADS dataset (469 people, both
wrists, 11 tasks) and compares three decision rules on identical metrics. Results:
[results/pads/REPORT.md](results/pads/REPORT.md).

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

## Wearing-off prediction (`dashboard/js/wearoff.js` + `firmware/src/dsp/wearoff.cpp`)

**Learning (in the app, from the last 21 days).** For each dose, the 30-s records give:
- *starts working*: first time the 20-min rolling severity drops below 0.5 (≥ 10 min after the dose);
- *tremor returns*: first time it rises back to ≥ 1, at least 20 min after it started working
  (looked at for at most 6 h, and never past the next dose).

Doses where tremor had **not** returned by the next dose (or by the time the band was taken
off) are *censored*: "lasted at least this long". Ignoring them, or treating them as returns,
biases the estimate short. So the duration is estimated with the **Kaplan–Meier** estimator,
the standard method for time-to-event data with censoring (checked against the textbook
Freireich 6-MP example in `tools/test_wearoff.mjs`):

| Output | Definition |
|---|---|
| typical wear-off | KM median time to tremor returning (shown as "at least …" if most doses outlast the next one) |
| reminder after | KM 25th percentile (1 in 4 doses has worn off by then), ≥ 20 min before the typical return, ≥ 15 min after it usually starts working |
| per time of day | the same, separately for morning / midday / afternoon / evening doses once a slot has ≥ 4 doses |

Needs ≥ 4 doses with recordings, ≥ 2 of them with tremor returning.

**Warning (on the band, works with the phone away).** The app sends `warn_after_min` and
`typical_min` for the latest dose's time of day, plus app-logged doses. The band alerts:
- *time*: `warn_after_min` after the last dose (only until 30 min past the usual wear-off);
- *early*: tremor confirmed in ≥ 50 % of the last 10 min, ≥ 45 min after the dose — tremor is
  already back, whatever the history says. Needs ≥ 6 of those 10 min observed.

The alert = LED double-blink every 3 s (+ motor pulses if fitted) for up to 30 min, ended by
a new dose or dismiss. The app shows a banner, and a system notification if allowed.

**Honest evaluation (backtest).** Each past dose is predicted using only doses before it,
then compared with what happened — error in minutes, % of returns warned in advance, lead
time, warnings when tremor didn't return — next to a fixed "every dose lasts 3 h" rule.
Shown in the Report tab. Synthetic patient lasting 140 ± 15 min: learned error 8 min, warned
in advance 100 %, vs fixed rule 31 min / 12 %. When a patient's doses really do last ~3 h,
the fixed rule does as well (the demo patient is such a case) — learning pays off when a
patient differs from the default.

Limits: the "returns" threshold uses rest tremor only (tremor hidden by activity looks like
"still working"); dose size, meals and missed doses are not modelled; not validated on
patients.

## Check-ins
After each dose the app offers a short test ~1 h later ("is it working?") and just before the
predicted wear-off. Every test stores minutes since the last dose, and the Report groups
test scores by time since dose (0–1 h, 1–2 h, 2–3 h, 3 h+).
