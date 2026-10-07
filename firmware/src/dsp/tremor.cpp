#include "tremor.h"

#include <math.h>

namespace dsp {

uint8_t severityFromAmplitudeCm(float amp_cm) {
  if (amp_cm < 1.0f) return 1;
  if (amp_cm < 3.0f) return 2;
  if (amp_cm < 10.0f) return 3;
  return 4;
}

TremorDetector::TremorDetector(const TremorConfig& cfg)
    : cfg_(cfg), fft_(cfg.n), df_(cfg.fs / cfg.n) {
  win_power_ = 0;
  for (int i = 0; i < cfg_.n; i++) {
    win_[i] = 0.5f - 0.5f * cosf(2.0f * (float)M_PI * i / (cfg_.n - 1));  // Hann
    win_power_ += win_[i] * win_[i];
  }
}

void TremorDetector::reset() {
  prev_candidate_ = false;
  prev_freq_ = 0;
}

int TremorDetector::binOf(float hz) const { return (int)lroundf(hz / df_); }

// Gaussian (log-parabolic) interpolation: accurate for Hann-windowed peaks.
float TremorDetector::interpPeak(int k) const {
  const int half = cfg_.n / 2;
  if (k <= 0 || k >= half) return k * df_;
  const float eps = 1e-20f;
  float a = logf(psd_[k - 1] + eps), b = logf(psd_[k] + eps), c = logf(psd_[k + 1] + eps);
  float den = a - 2.0f * b + c;
  float delta = (den < 0) ? 0.5f * (a - c) / den : 0.0f;
  if (delta > 0.5f) delta = 0.5f;
  if (delta < -0.5f) delta = -0.5f;
  return (k + delta) * df_;
}

int TremorDetector::bandPeak(float lo_hz, float hi_hz) const {
  // bins whose centre lies within half a bin of the band edges
  int k0 = (int)ceilf(lo_hz / df_ - 0.5f);
  int k1 = (int)floorf(hi_hz / df_ + 0.5f);
  if (k0 < 1) k0 = 1;
  if (k1 > cfg_.n / 2 - 1) k1 = cfg_.n / 2 - 1;
  int best = -1;
  for (int k = k0; k <= k1; k++)
    if (best < 0 || psd_[k] > psd_[best]) best = k;
  if (best < 0) return -1;
  // must be a genuine peak, not the shoulder of something just outside the band
  if (psd_[best] < psd_[best - 1] || psd_[best] < psd_[best + 1]) return -1;
  return best;
}

float TremorDetector::lobePower(int k) const {
  float p = 0;
  for (int j = k - cfg_.lobe_bins; j <= k + cfg_.lobe_bins; j++)
    if (j >= 1 && j < cfg_.n / 2) p += psd_[j];
  return p;
}

float TremorDetector::toneAmplitude(const float* const gyro[3], int from, int len,
                                    float f) const {
  const float w = 2.0f * (float)M_PI * f / cfg_.fs;
  float power = 0;
  for (int ax = 0; ax < 3; ax++) {
    float mean = 0;
    for (int i = from; i < from + len; i++) mean += gyro[ax][i];
    mean /= len;
    float re = 0, im = 0;
    for (int i = from; i < from + len; i++) {
      float x = gyro[ax][i] - mean;
      re += x * cosf(w * i);
      im += x * sinf(w * i);
    }
    power += re * re + im * im;
  }
  return 2.0f * sqrtf(power) / len;
}

static void detrendWindow(const float* x, int n, const float* w, float* out) {
  // least-squares line fit, then subtract it and apply the window
  float sx = 0, sxy = 0;
  const float tm = 0.5f * (n - 1);
  float stt = 0;
  for (int i = 0; i < n; i++) {
    float t = i - tm;
    sx += x[i];
    sxy += t * x[i];
    stt += t * t;
  }
  float mean = sx / n, slope = sxy / stt;
  for (int i = 0; i < n; i++) out[i] = (x[i] - mean - slope * (i - tm)) * w[i];
}

WindowResult TremorDetector::analyze(const float* const gyro[3], const float* const accel[3],
                                     bool saturated, bool gap) {
  const int n = cfg_.n, half = n / 2;
  WindowResult r;
  r.saturated = saturated;
  r.gap = gap;

  // 1. Summed power spectrum of the three gyro axes (orientation independent).
  for (int k = 0; k <= half; k++) psd_[k] = 0;
  for (int ax = 0; ax < 3; ax++) {
    detrendWindow(gyro[ax], n, win_, re_);
    for (int i = 0; i < n; i++) im_[i] = 0;
    fft_.forward(re_, im_);
    for (int k = 0; k <= half; k++) psd_[k] += re_[k] * re_[k] + im_[k] * im_[k];
  }

  // 2. Movement intensity from the accelerometer magnitude.
  float msum = 0, msq = 0;
  for (int i = 0; i < n; i++) {
    float m = sqrtf(accel[0][i] * accel[0][i] + accel[1][i] * accel[1][i] +
                    accel[2][i] * accel[2][i]);
    msum += m;
    msq += m * m;
  }
  float var = msq / n - (msum / n) * (msum / n);
  r.activity_mg = 1000.0f * sqrtf(var > 0 ? var : 0);

  // 3. Total power of all hand motion in the search range.
  int s0 = binOf(cfg_.search_lo_hz), s1 = binOf(cfg_.search_hi_hz);
  if (s0 < 1) s0 = 1;
  if (s1 > half - 1) s1 = half - 1;
  float total = 0;
  int dom = s0;
  for (int k = s0; k <= s1; k++) {
    total += psd_[k];
    if (psd_[k] > psd_[dom]) dom = k;
  }
  r.dom_freq_hz = interpPeak(dom);
  if (total <= 0) {
    reset();
    return r;
  }

  // Mean-square of the band-limited angular velocity, from Parseval:
  // ms = 2 * sum|X_k|^2 / (N * sum w^2)   (one-sided spectrum)
  const float scale = 2.0f / (n * win_power_);

  // 4. Parkinsonian band: strong + narrow + steady?
  int kb = bandPeak(cfg_.band_lo_hz, cfg_.band_hi_hz);
  if (kb > 0) {
    float lobe = lobePower(kb);
    r.ratio = lobe / total;
    r.omega_amp = sqrtf(2.0f * scale * lobe);
    r.freq_hz = interpPeak(kb);
    // steady: the beat must run through the whole window, not be a short burst
    float a1 = toneAmplitude(gyro, 0, n / 2, r.freq_hz);
    float a2 = toneAmplitude(gyro, n / 2, n / 2, r.freq_hz);
    float hi = a1 > a2 ? a1 : a2;
    r.steadiness = hi > 0 ? (a1 < a2 ? a1 : a2) / hi : 0;
    r.candidate = !gap && r.ratio >= cfg_.min_ratio && r.omega_amp >= cfg_.min_omega_amp &&
                  r.steadiness >= cfg_.min_steadiness;
  }

  // 5. Higher-frequency oscillation (reported, never counted as PD tremor).
  int kh = bandPeak(cfg_.hf_lo_hz, cfg_.hf_hi_hz);
  if (kh > 0 && !r.candidate) {
    float lobe = lobePower(kh);
    r.high_freq = lobe / total >= cfg_.min_ratio &&
                  sqrtf(2.0f * scale * lobe) >= cfg_.min_omega_amp;
  }

  // 6. Consistency: the previous window must have seen the same beat.
  r.confirmed = r.candidate && prev_candidate_ &&
                fabsf(r.freq_hz - prev_freq_) <= cfg_.consist_df_hz;
  prev_candidate_ = r.candidate;
  prev_freq_ = r.freq_hz;
  if (gap) reset();

  // 7. Amplitude -> severity. Angular amplitude theta = omega / (2 pi f);
  //    hand moves +-theta*L, so peak-to-peak displacement = 2 * theta * L.
  if (r.candidate && r.freq_hz > 0) {
    float theta = r.omega_amp / (2.0f * (float)M_PI * r.freq_hz);
    r.amp_cm = 2.0f * theta * cfg_.lever_m * 100.0f;
  }
  r.severity = r.confirmed ? severityFromAmplitudeCm(r.amp_cm) : 0;
  return r;
}

void WindowAggregator::add(const WindowResult& r) {
  n_++;
  sev_sum_ += r.severity;
  if (r.severity > sev_max_) sev_max_ = r.severity;
  ratio_sum_ += r.ratio;
  activity_sum_ += r.activity_mg;
  if (r.confirmed) {
    n_tremor_++;
    freq_sum_ += r.freq_hz;
    amp_sum_ += r.amp_cm;
    omega_sum_ += r.omega_amp;
    if (r.amp_cm > amp_max_) amp_max_ = r.amp_cm;
  }
  if (r.high_freq) high_freq_ = true;
  if (r.gap) gap_ = true;
}

}  // namespace dsp
