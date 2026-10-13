# PADS evaluation

Subjects: DD = 114, HC = 79, PD = 276
Windows: 100280 (2.56 s, 1 s hop) from 10310 recordings, both wrists.

## Healthy controls: windows flagged as tremor (all are false positives)

| Task | type | windows | bandpower | spectral | gated | ours |
|---|---|---:|---:|---:|---:|---:|
| Relaxed | rest | 2686 | 0.00% | 0.00% | 0.00% | 0.00% |
| RelaxedTask | rest | 2686 | 0.67% | 0.15% | 0.48% | 0.15% |
| LiftHold | postural | 1106 | 0.09% | 0.00% | 0.09% | 0.00% |
| StretchHold | postural | 1106 | 0.00% | 0.00% | 0.00% | 0.00% |
| HoldWeight | postural | 1106 | 0.00% | 0.00% | 0.09% | 0.00% |
| PointFinger | kinetic | 1106 | 0.09% | 0.00% | 0.09% | 0.00% |
| DrinkGlas | kinetic | 1106 | 1.54% | 0.09% | 0.36% | 0.09% |
| CrossArms | kinetic | 1106 | 0.18% | 0.00% | 0.09% | 0.00% |
| TouchIndex | kinetic | 1106 | 0.18% | 0.00% | 0.00% | 0.00% |
| TouchNose | kinetic | 1106 | 0.00% | 0.00% | 0.00% | 0.00% |
| Entrainment | kinetic | 2686 | 4.24% | 0.71% | 2.38% | 0.56% |
| **all** | | 16906 | **0.92%** | **0.14%** | **0.50%** | **0.12%** |

## Parkinson's: windows flagged during the two REST tasks

| | windows | bandpower | spectral | gated | ours |
|---|---:|---:|---:|---:|---:|
| PD at rest | 18768 | 10.15% | 6.40% | 9.08% | 5.89% |
| HC at rest | 5372 | 0.34% | 0.07% | 0.24% | 0.07% |

Not every Parkinson's patient has rest tremor (roughly 70% do), and PADS has no per-task tremor labels, so the PD row is a prevalence, not a sensitivity. What matters is that *ours* keeps the PD detections the spectral rule makes while cutting the healthy-control false positives.

## Subject level: any rest-task window flagged

| group | subjects | bandpower | spectral | gated | ours |
|---|---:|---:|---:|---:|---:|
| PD | 276 | 27.2% | 19.6% | 27.2% | 19.6% |
| DD | 114 | 38.6% | 22.8% | 37.7% | 22.8% |
| HC | 79 | 5.1% | 1.3% | 6.3% | 1.3% |

## Parkinson's clinical subtype (from the neurologist's diagnosis comment) vs rest-task detections

Tremor-dominant patients should be detected far more often than akinetic-rigid ones; a detector that cannot tell them apart is reacting to something other than tremor.

| PD subtype | subjects | rest windows | bandpower (windows) | spectral (windows) | gated (windows) | ours (windows) | bandpower (subjects) | spectral (subjects) | gated (subjects) | ours (subjects) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| tremor-dominant | 52 | 3536 | 26.50% | 18.13% | 23.36% | 16.01% | 57.7% | 50.0% | 53.8% | 50.0% |
| mixed | 80 | 5440 | 8.82% | 4.80% | 7.96% | 4.43% | 26.2% | 16.2% | 27.5% | 16.2% |
| akinetic-rigid | 114 | 7752 | 1.83% | 1.16% | 1.78% | 1.16% | 11.4% | 6.1% | 10.5% | 6.1% |
| unspecified | 30 | 2040 | 16.96% | 10.25% | 15.10% | 10.25% | 36.7% | 26.7% | 43.3% | 26.7% |

## Effective lever arm of detected beats

| windows with a strong, narrow, steady 4-6 Hz beat | n | lever median (cm) | 10th-90th pct | axis linearity median |
|---|---:|---:|---:|---:|
| PD at rest | 1426 | 6.0 | 3.9-13.1 | 0.96 |
| PD postural | 463 | 5.4 | 3.4-8.9 | 0.96 |
| PD kinetic tasks | 913 | 6.8 | 3.9-12.6 | 0.92 |
| DD (ET etc.) at rest | 517 | 5.9 | 3.7-9.7 | 0.94 |
| DD postural | 508 | 4.9 | 2.9-10.1 | 0.96 |
| HC at rest | 18 | 5.1 | 4.4-8.2 | 0.95 |
| HC postural | 3 | 3.5 | 3.5-7.7 | 0.98 |
| HC kinetic tasks | 83 | 8.1 | 4.1-17.6 | 0.93 |

## Parkinson's: kinetic/postural tasks (ambiguous: tremor and voluntary movement mix)

| Task | windows | bandpower | spectral | gated | ours |
|---|---:|---:|---:|---:|---:|
| Relaxed | 9384 | 8.06% | 4.54% | 6.95% | 4.23% |
| RelaxedTask | 9384 | 12.24% | 8.26% | 11.22% | 7.56% |
| LiftHold | 3864 | 6.42% | 1.48% | 4.14% | 1.48% |
| StretchHold | 3864 | 7.04% | 2.48% | 5.49% | 2.48% |
| HoldWeight | 3864 | 8.72% | 3.05% | 6.55% | 3.03% |
| PointFinger | 3864 | 0.98% | 0.23% | 0.26% | 0.23% |
| DrinkGlas | 3857 | 9.02% | 1.24% | 4.64% | 1.22% |
| CrossArms | 3857 | 4.87% | 1.22% | 2.80% | 1.19% |
| TouchIndex | 3864 | 1.60% | 0.18% | 0.39% | 0.18% |
| TouchNose | 3864 | 0.44% | 0.13% | 0.08% | 0.13% |
| Entrainment | 9367 | 11.36% | 4.01% | 8.24% | 3.79% |

## Lever-arm threshold sweep (spectral rule + lever gate only)

| max lever (cm) | HC windows flagged | PD rest windows flagged | HC kinetic flagged |
|---:|---:|---:|---:|
| 4 | 0.00% | 0.55% | 0.00% |
| 6 | 0.05% | 2.90% | 0.06% |
| 8 | 0.07% | 4.43% | 0.10% |
| 10 | 0.09% | 5.00% | 0.13% |
| 12 | 0.10% | 5.17% | 0.16% |
| 15 | 0.12% | 5.58% | 0.19% |
| 18 | 0.12% | 5.81% | 0.19% |
| 20 | 0.12% | 5.89% | 0.19% |
| 25 | 0.13% | 6.00% | 0.22% |
| 30 | 0.14% | 6.03% | 0.24% |
| none | 0.14% | 6.07% | 0.24% |
