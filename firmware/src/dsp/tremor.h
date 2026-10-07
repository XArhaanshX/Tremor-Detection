// Tremor detector: one 2.56 s window of IMU data in, one decision out.
// Portable C++ (no Arduino) so it can be unit-tested on a PC.
// Algorithm write-up: docs/ALGORITHM.md
#pragma once
#include <stdint.h>

#include "fft.h"

namespace dsp {

struct TremorConfig {
  float fs = 100.0f;             // sample rate, Hz
  int n = 256;                   // window length (power of 2)
  float band_lo_hz = 4.0f;       // Parkinsonian rest-tremor band
  float band_hi_hz = 6.0f;
  float search_lo_hz = 1.0f;     // "all hand motion" range for the narrowness ratio
  float search_hi_hz = 15.0f;
  float hf_lo_hz = 6.5f;         // higher-frequency oscillations (essential/physiological)
  float hf_hi_hz = 12.0f;
  float min_ratio = 0.40f;       // peak lobe must hold >= 40% of search-range power
  float min_omega_amp = 0.10f;   // rad/s; ~0.6 mm p-p at 5 Hz, far above gyro noise
  float consist_df_hz = 1.0f;    // previous window's peak must be within this
  float min_steadiness = 0.5f;   // beat amplitude 1st half vs 2nd half of the window
  float lever_m = 0.10f;         // wrist-to-hand lever arm for displacement
  int lobe_bins = 2;             // Hann main lobe half-width in bins
};

struct WindowResult {
  bool candidate = false;   // strong + narrow 4-6 Hz peak in this window
  bool confirmed = false;   // candidate AND previous window agreed (consistent)
  bool high_freq = false;   // strong + narrow peak in 6.5-12 Hz instead
  bool saturated = false;
  bool gap = false;
  float freq_hz = 0;        // interpolated tremor-band peak frequency
  float dom_freq_hz = 0;    // dominant frequency in the search range
  float omega_amp = 0;      // tremor angular-velocity amplitude, rad/s
  float ratio = 0;          // spectral concentration 0..1
  float steadiness = 0;     // min/max of the beat amplitude in the two window halves
  float amp_cm = 0;         // estimated peak-to-peak hand displacement, cm
  float activity_mg = 0;    // accel-magnitude RMS, milli-g
  uint8_t severity = 0;     // 0..4
};

// MDS-UPDRS 3.17 rest-tremor amplitude bins: <1 cm, 1-3 cm, 3-10 cm, >=10 cm.
uint8_t severityFromAmplitudeCm(float amp_cm);

class TremorDetector {
 public:
  explicit TremorDetector(const TremorConfig& cfg = TremorConfig());

  // gyro: 3 arrays in rad/s, accel: 3 arrays in g. Each cfg.n long, oldest first.
  WindowResult analyze(const float* const gyro[3], const float* const accel[3],
                       bool saturated, bool gap);

  void reset();  // forget consistency history
  void setLeverMeters(float m) { cfg_.lever_m = m; }
  const TremorConfig& config() const { return cfg_; }
  const float* spectrum() const { return psd_; }  // last summed power spectrum (n/2+1)

 private:
  int binOf(float hz) const;
  float interpPeak(int k) const;
  // Strongest local peak inside [lo_hz, hi_hz]; returns bin or -1.
  int bandPeak(float lo_hz, float hi_hz) const;
  float lobePower(int k) const;
  // Amplitude of the f-Hz component in samples [from, from+len), all axes.
  float toneAmplitude(const float* const gyro[3], int from, int len, float f) const;

  TremorConfig cfg_;
  FFT fft_;
  float df_;
  float win_[FFT::kMaxN];
  float win_power_;  // sum of w^2
  float re_[FFT::kMaxN];
  float im_[FFT::kMaxN];
  float psd_[FFT::kMaxN / 2 + 1];
  bool prev_candidate_ = false;
  float prev_freq_ = 0;
};

// Rolls per-window results into a summary (used for 30 s epochs and tremor tests).
class WindowAggregator {
 public:
  void reset() { *this = WindowAggregator(); }
  void add(const WindowResult& r);

  int windows() const { return n_; }
  int tremorWindows() const { return n_tremor_; }
  float tremorPct() const { return n_ ? 100.0f * n_tremor_ / n_ : 0; }
  float severityMean() const { return n_ ? sev_sum_ / n_ : 0; }
  uint8_t severityMax() const { return sev_max_; }
  float freqMean() const { return n_tremor_ ? freq_sum_ / n_tremor_ : 0; }
  float ampMeanCm() const { return n_tremor_ ? amp_sum_ / n_tremor_ : 0; }
  float ampMaxCm() const { return amp_max_; }
  float omegaMean() const { return n_tremor_ ? omega_sum_ / n_tremor_ : 0; }
  float ratioMean() const { return n_ ? ratio_sum_ / n_ : 0; }
  float activityMean() const { return n_ ? activity_sum_ / n_ : 0; }
  bool anyHighFreq() const { return high_freq_; }
  bool anyGap() const { return gap_; }

 private:
  int n_ = 0, n_tremor_ = 0;
  uint8_t sev_max_ = 0;
  float sev_sum_ = 0, freq_sum_ = 0, amp_sum_ = 0, amp_max_ = 0;
  float omega_sum_ = 0, ratio_sum_ = 0, activity_sum_ = 0;
  bool high_freq_ = false, gap_ = false;
};

}  // namespace dsp
