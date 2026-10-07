// Hand-turning (pronation-supination) test, MDS-UPDRS 3.6 style.
// The patient turns the palm up/down as fast and as fully as possible.
// The wrist gyroscope measures this rotation directly.
#pragma once

namespace dsp {

struct PronSupResult {
  int movements = 0;            // complete half-turns
  int hesitations = 0;          // half-turns lasting > 2x the median
  float rate_hz = 0;            // full turn cycles per second
  float excursion_deg = 0;      // mean rotation per half-turn
  float speed_dps = 0;          // mean peak angular speed per half-turn
  float amp_decrement_pct = 0;  // (first third - last third) / first third
  float speed_decrement_pct = 0;
  float rhythm_cv_pct = 0;      // variability of half-turn durations
  float duration_s = 0;
  bool saturated = false;
  bool too_few = false;         // < 4 half-turns detected
};

// gx/gy/gz: angular velocity in rad/s, n samples at fs Hz. The rotation axis is
// found automatically (principal axis), so the band's orientation doesn't matter.
PronSupResult analyzePronSup(const float* gx, const float* gy, const float* gz, int n,
                             float fs, bool saturated);

}  // namespace dsp
