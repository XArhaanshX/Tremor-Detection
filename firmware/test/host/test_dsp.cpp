// Host-side tests for the portable DSP code. Run: make -C firmware/test/host
// Signals are synthesised at the same rate/range the MPU-6050 is configured for,
// including quantisation to the +-2000 dps LSB, gyro bias and sensor noise.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include <random>
#include <vector>

#include "../../include/config.h"
#include "../../src/dsp/fft.h"
#include "../../src/dsp/pronsup.h"
#include "../../src/dsp/tremor.h"

using namespace dsp;

static int g_fail = 0, g_pass = 0;
#define CHECK(cond, ...)                                       \
  do {                                                         \
    if (cond) {                                                \
      g_pass++;                                                \
    } else {                                                   \
      g_fail++;                                                \
      printf("  FAIL %s:%d  %s  -- ", __FILE__, __LINE__, #cond); \
      printf(__VA_ARGS__);                                     \
      printf("\n");                                            \
    }                                                          \
  } while (0)

static const float FS = SAMPLE_HZ;
static const float TWO_PI = 2.0f * (float)M_PI;
static std::mt19937 rng(1234);

// ---------------------------------------------------------------- signal model
struct Signal {
  std::vector<float> g[3], a[3];
  explicit Signal(int n) {
    for (int i = 0; i < 3; i++) g[i].assign(n, 0), a[i].assign(n, 0);
  }
  int size() const { return (int)g[0].size(); }
};

// Rotational tremor about an arbitrary axis with peak-to-peak hand displacement pp_cm.
static void addTremor(Signal& s, float f, float pp_cm, const float axis[3], float lever_m = 0.10f,
                      int from = 0, int to = -1) {
  if (to < 0) to = s.size();
  float theta = (pp_cm / 100.0f) / (2.0f * lever_m);  // angular amplitude, rad
  float w = theta * TWO_PI * f;                       // angular-velocity amplitude
  float norm = sqrtf(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  float phase = std::uniform_real_distribution<float>(0, TWO_PI)(rng);
  for (int i = from; i < to; i++) {
    float v = w * sinf(TWO_PI * f * i / FS + phase);
    for (int k = 0; k < 3; k++) s.g[k][i] += v * axis[k] / norm;
    // gravity re-projection seen by the accelerometer
    s.a[0][i] += sinf(theta * sinf(TWO_PI * f * i / FS + phase));
  }
}

// Slow voluntary movement: a few low-frequency components + smooth random drift.
static void addVoluntary(Signal& s, float strength_rads) {
  std::normal_distribution<float> nd(0, 1);
  float f[3] = {0.4f, 0.9f, 1.7f};
  for (int k = 0; k < 3; k++) {
    float ph = nd(rng), drift = 0;
    for (int i = 0; i < s.size(); i++) {
      drift = 0.98f * drift + 0.02f * nd(rng) * strength_rads;
      float v = 0;
      for (int j = 0; j < 3; j++) v += strength_rads / (j + 1) * sinf(TWO_PI * f[j] * i / FS + ph + j);
      s.g[k][i] += v + drift;
      s.a[k][i] += 0.05f * v;
    }
  }
}

// Broadband "fidgeting" wobble at random, inconsistent rates.
static void addWobble(Signal& s, float rms_rads) {
  std::normal_distribution<float> nd(0, rms_rads);
  for (int k = 0; k < 3; k++) {
    float y = 0;
    for (int i = 0; i < s.size(); i++) {
      y = 0.7f * y + nd(rng);  // pink-ish noise, energy across 1-15 Hz
      s.g[k][i] += y;
    }
  }
}

// MPU-6050 imperfections: bias, white noise, quantisation, gravity on z.
static bool finishSensor(Signal& s) {
  std::normal_distribution<float> gn(0, 0.005f * sqrtf(FS / 2) * (float)M_PI / 180.0f);
  std::normal_distribution<float> an(0, 0.0004f * sqrtf(FS / 2));
  const float lsb = (float)M_PI / 180.0f / GYRO_LSB_PER_DPS;
  bool sat = false;
  float bias[3] = {0.05f, -0.03f, 0.02f};  // rad/s (~3 dps), typical zero-rate offset
  for (int k = 0; k < 3; k++)
    for (int i = 0; i < s.size(); i++) {
      float raw = (s.g[k][i] + bias[k] + gn(rng)) / lsb;
      if (raw > 32767) raw = 32767, sat = true;
      if (raw < -32768) raw = -32768, sat = true;
      s.g[k][i] = roundf(raw) * lsb;
      s.a[k][i] += (k == 2 ? 1.0f : 0.0f) + an(rng);
    }
  return sat;
}

// Run the detector over a signal with the firmware's window/hop.
static std::vector<WindowResult> runDetector(Signal& s, bool sat, float lever_m = 0.10f) {
  TremorConfig cfg;
  cfg.lever_m = lever_m;
  static TremorDetector det(cfg);
  det = TremorDetector(cfg);
  std::vector<WindowResult> out;
  for (int start = 0; start + WINDOW_N <= s.size(); start += HOP_N) {
    const float* g[3] = {&s.g[0][start], &s.g[1][start], &s.g[2][start]};
    const float* a[3] = {&s.a[0][start], &s.a[1][start], &s.a[2][start]};
    out.push_back(det.analyze(g, a, sat, false));
  }
  return out;
}

static WindowAggregator summarize(const std::vector<WindowResult>& rs, int skip = 2) {
  WindowAggregator agg;
  for (size_t i = skip; i < rs.size(); i++) agg.add(rs[i]);
  return agg;
}

static const float AXIS_DIAG[3] = {0.8f, -0.5f, 0.3f};

// ---------------------------------------------------------------- tests
static void testFFT() {
  printf("FFT matches a direct DFT\n");
  const int n = 256;
  FFT fft(n);
  std::vector<float> re(n), im(n, 0), x(n);
  std::normal_distribution<float> nd(0, 1);
  for (int i = 0; i < n; i++) x[i] = re[i] = nd(rng);
  fft.forward(re.data(), im.data());
  double maxerr = 0;
  for (int k = 0; k < n; k++) {
    double r = 0, m = 0;
    for (int i = 0; i < n; i++) {
      r += x[i] * cos(-2 * M_PI * k * i / n);
      m += x[i] * sin(-2 * M_PI * k * i / n);
    }
    maxerr = fmax(maxerr, fabs(r - re[k]) + fabs(m - im[k]));
  }
  CHECK(maxerr < 1e-3, "max error %g", maxerr);
}

static void testSeverityBins() {
  printf("UPDRS amplitude bins\n");
  CHECK(severityFromAmplitudeCm(0.5f) == 1, "0.5cm");
  CHECK(severityFromAmplitudeCm(1.0f) == 2, "1cm");
  CHECK(severityFromAmplitudeCm(2.9f) == 2, "2.9cm");
  CHECK(severityFromAmplitudeCm(3.0f) == 3, "3cm");
  CHECK(severityFromAmplitudeCm(9.9f) == 3, "9.9cm");
  CHECK(severityFromAmplitudeCm(10.0f) == 4, "10cm");
}

static void testTremorSweep() {
  printf("Pure rotational tremor: frequency, amplitude, severity\n");
  struct Case { float f, pp_cm; int sev; } cases[] = {
      {5.0f, 0.5f, 1}, {4.2f, 2.0f, 2}, {5.0f, 2.0f, 2}, {5.8f, 2.0f, 2},
      {4.6f, 5.0f, 3}, {5.3f, 12.0f, 4}, {4.0f, 1.5f, 2}, {6.0f, 6.0f, 3},
  };
  for (auto& c : cases) {
    Signal s(20 * SAMPLE_HZ);
    addTremor(s, c.f, c.pp_cm, AXIS_DIAG);
    bool sat = finishSensor(s);
    auto rs = runDetector(s, sat);
    auto agg = summarize(rs);
    printf("    f=%.1f pp=%.1fcm -> tremor %.0f%%, f=%.2f, amp=%.2fcm, sev max %d mean %.2f, ratio %.2f\n",
           c.f, c.pp_cm, agg.tremorPct(), agg.freqMean(), agg.ampMeanCm(), agg.severityMax(),
           agg.severityMean(), agg.ratioMean());
    CHECK(agg.tremorPct() >= 99, "detected %.0f%%", agg.tremorPct());
    CHECK(fabsf(agg.freqMean() - c.f) < 0.15f, "freq %.2f vs %.2f", agg.freqMean(), c.f);
    CHECK(fabsf(agg.ampMeanCm() - c.pp_cm) / c.pp_cm < 0.15f, "amp %.2f vs %.2f", agg.ampMeanCm(), c.pp_cm);
    CHECK(agg.severityMax() == c.sev, "sev %d vs %d", agg.severityMax(), c.sev);
    CHECK(!sat, "gyro saturated at %.1f cm", c.pp_cm);
  }
}

static void testOrientationInvariance() {
  printf("Same tremor, different strap orientation -> same amplitude\n");
  const float axes[4][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}, {0.6f, 0.6f, 0.5f}};
  float amps[4];
  for (int i = 0; i < 4; i++) {
    Signal s(15 * SAMPLE_HZ);
    addTremor(s, 5.0f, 3.5f, axes[i]);
    auto agg = summarize(runDetector(s, finishSensor(s)));
    amps[i] = agg.ampMeanCm();
  }
  for (int i = 1; i < 4; i++) CHECK(fabsf(amps[i] - amps[0]) < 0.2f, "%.2f vs %.2f", amps[i], amps[0]);
}

static void testNoFalseAlarms() {
  printf("No tremor: still hand, voluntary movement, random wobble, out-of-band beats\n");
  {
    Signal s(60 * SAMPLE_HZ);
    auto agg = summarize(runDetector(s, finishSensor(s)));
    printf("    still: tremor %.0f%%, activity %.1f mg\n", agg.tremorPct(), agg.activityMean());
    CHECK(agg.tremorPct() == 0, "still hand flagged %.0f%%", agg.tremorPct());
  }
  {
    Signal s(60 * SAMPLE_HZ);
    addVoluntary(s, 2.0f);
    auto agg = summarize(runDetector(s, finishSensor(s)));
    printf("    voluntary (cup, wave): tremor %.0f%%, ratio %.2f\n", agg.tremorPct(), agg.ratioMean());
    CHECK(agg.tremorPct() == 0, "voluntary flagged %.0f%%", agg.tremorPct());
  }
  {
    Signal s(60 * SAMPLE_HZ);
    addWobble(s, 0.4f);
    auto agg = summarize(runDetector(s, finishSensor(s)));
    printf("    random wobble: tremor %.0f%%, ratio %.2f\n", agg.tremorPct(), agg.ratioMean());
    CHECK(agg.tremorPct() < 3, "wobble flagged %.0f%%", agg.tremorPct());
  }
  {
    Signal s(30 * SAMPLE_HZ);
    addTremor(s, 2.5f, 4.0f, AXIS_DIAG);  // voluntary hand shaking / other tremor types
    auto agg = summarize(runDetector(s, finishSensor(s)));
    printf("    2.5 Hz shaking: tremor %.0f%%\n", agg.tremorPct());
    CHECK(agg.tremorPct() == 0, "2.5 Hz flagged %.0f%%", agg.tremorPct());
  }
  {
    Signal s(30 * SAMPLE_HZ);
    addTremor(s, 9.0f, 1.0f, AXIS_DIAG);  // essential / enhanced physiological tremor
    auto rs = runDetector(s, finishSensor(s));
    auto agg = summarize(rs);
    printf("    9 Hz oscillation: tremor %.0f%%, high-freq flag %d\n", agg.tremorPct(), agg.anyHighFreq());
    CHECK(agg.tremorPct() == 0, "9 Hz flagged %.0f%%", agg.tremorPct());
    CHECK(agg.anyHighFreq(), "9 Hz not reported as high-frequency oscillation");
  }
}

static void testTremorWithMovement() {
  printf("Tremor riding on top of other motion\n");
  {
    Signal s(30 * SAMPLE_HZ);
    addTremor(s, 5.0f, 2.0f, AXIS_DIAG);
    addWobble(s, 0.05f);
    auto agg = summarize(runDetector(s, finishSensor(s)));
    printf("    tremor + light fidgeting: tremor %.0f%%, sev mean %.2f\n", agg.tremorPct(), agg.severityMean());
    CHECK(agg.tremorPct() > 90, "missed tremor with light fidget %.0f%%", agg.tremorPct());
  }
  {
    Signal s(30 * SAMPLE_HZ);
    addTremor(s, 5.0f, 3.0f, AXIS_DIAG);
    addVoluntary(s, 0.3f);
    auto agg = summarize(runDetector(s, finishSensor(s)));
    printf("    tremor + slow arm movement: tremor %.0f%%\n", agg.tremorPct());
    CHECK(agg.tremorPct() > 80, "missed tremor during slow movement %.0f%%", agg.tremorPct());
  }
}

static void testNaturalTremor() {
  printf("Real tremor wanders: amplitude +-40%%, frequency 4.6-5.4 Hz\n");
  Signal s(60 * SAMPLE_HZ);
  float norm = sqrtf(0.8f * 0.8f + 0.5f * 0.5f + 0.3f * 0.3f), phase = 0;
  for (int i = 0; i < s.size(); i++) {
    float t = i / FS;
    float f = 5.0f + 0.4f * sinf(TWO_PI * 0.05f * t);
    float pp = 2.0f * (1.0f + 0.4f * sinf(TWO_PI * 0.2f * t));
    phase += TWO_PI * f / FS;
    float w = (pp / 100.0f) / 0.2f * TWO_PI * f * sinf(phase);
    for (int k = 0; k < 3; k++) s.g[k][i] += w * AXIS_DIAG[k] / norm;
  }
  addWobble(s, 0.03f);
  auto agg = summarize(runDetector(s, finishSensor(s)));
  printf("    tremor %.0f%%, f=%.2f, amp=%.2fcm, sev mean %.2f\n", agg.tremorPct(), agg.freqMean(),
         agg.ampMeanCm(), agg.severityMean());
  CHECK(agg.tremorPct() > 90, "natural tremor detected only %.0f%%", agg.tremorPct());
  CHECK(fabsf(agg.ampMeanCm() - 2.0f) < 0.4f, "amp %.2f", agg.ampMeanCm());
}

static void testConsistency() {
  printf("A single burst is not a tremor (consistency)\n");
  Signal s(20 * SAMPLE_HZ);
  addTremor(s, 5.0f, 3.0f, AXIS_DIAG, 0.10f, 5 * SAMPLE_HZ, 5 * SAMPLE_HZ + 120);  // 1.2 s burst
  auto rs = runDetector(s, finishSensor(s));
  int confirmed = 0;
  for (auto& r : rs) confirmed += r.confirmed;
  printf("    1.2 s burst -> %d confirmed windows\n", confirmed);
  CHECK(confirmed == 0, "burst confirmed in %d windows", confirmed);

  Signal s2(30 * SAMPLE_HZ);
  addTremor(s2, 5.0f, 3.0f, AXIS_DIAG, 0.10f, 10 * SAMPLE_HZ, 30 * SAMPLE_HZ);
  auto rs2 = runDetector(s2, finishSensor(s2));
  int first = -1;
  for (size_t i = 0; i < rs2.size(); i++)
    if (rs2[i].confirmed) { first = (int)i; break; }
  float latency = first < 0 ? 99 : (first * HOP_N + WINDOW_N) / FS - 10.0f;
  printf("    tremor onset at 10 s -> confirmed after %.1f s\n", latency);
  CHECK(first >= 0 && latency < 4.0f, "latency %.1f s", latency);
}

static void testLever() {
  printf("Lever arm scales the displacement estimate\n");
  Signal s(15 * SAMPLE_HZ);
  addTremor(s, 5.0f, 2.0f, AXIS_DIAG, 0.10f);
  bool sat = finishSensor(s);
  float a10 = summarize(runDetector(s, sat, 0.10f)).ampMeanCm();
  float a15 = summarize(runDetector(s, sat, 0.15f)).ampMeanCm();
  CHECK(fabsf(a15 / a10 - 1.5f) < 0.02f, "ratio %.3f", a15 / a10);
}

static void testPronSup() {
  printf("Hand-turning test\n");
  const int n = 10 * SAMPLE_HZ;
  std::vector<float> g[3];
  for (auto& v : g) v.assign(n, 0);
  const float f = 1.5f;                   // turns per second
  const float theta0 = 60.0f / 57.2958f;  // +-60 deg -> 120 deg per half-turn
  const float axis[3] = {0.2f, 0.95f, 0.25f};
  std::normal_distribution<float> nd(0, 0.03f);
  for (int i = 0; i < n; i++) {
    float t = i / FS;
    float amp = theta0 * (1.0f - 0.04f * t);  // gets smaller over time (decrement)
    float w = amp * TWO_PI * f * cosf(TWO_PI * f * t);
    for (int k = 0; k < 3; k++) g[k][i] = w * axis[k] + 0.04f + nd(rng);
  }
  auto r = analyzePronSup(g[0].data(), g[1].data(), g[2].data(), n, FS, false);
  printf("    moves %d, rate %.2f Hz, excursion %.1f deg, speed %.0f dps, amp decrement %.1f%%, cv %.1f%%, hes %d\n",
         r.movements, r.rate_hz, r.excursion_deg, r.speed_dps, r.amp_decrement_pct, r.rhythm_cv_pct, r.hesitations);
  CHECK(r.movements >= 27 && r.movements <= 30, "moves %d", r.movements);
  CHECK(fabsf(r.rate_hz - f) < 0.1f, "rate %.2f", r.rate_hz);
  CHECK(r.excursion_deg > 90 && r.excursion_deg < 120, "excursion %.1f", r.excursion_deg);
  CHECK(r.amp_decrement_pct > 15 && r.amp_decrement_pct < 35, "decrement %.1f", r.amp_decrement_pct);
  CHECK(r.rhythm_cv_pct < 10, "cv %.1f", r.rhythm_cv_pct);
  CHECK(r.hesitations == 0, "hesitations %d", r.hesitations);
  CHECK(!r.too_few, "too few");

  std::vector<float> z(n, 0.01f);
  auto still = analyzePronSup(z.data(), z.data(), z.data(), n, FS, false);
  CHECK(still.too_few, "still hand gave %d movements", still.movements);
}

int main() {
  testFFT();
  testSeverityBins();
  testTremorSweep();
  testOrientationInvariance();
  testNoFalseAlarms();
  testTremorWithMovement();
  testNaturalTremor();
  testConsistency();
  testLever();
  testPronSup();
  printf("\n%d passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
