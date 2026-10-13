// Runs the firmware's tremor detector over a CSV recording so the exact same code
// that runs on the wristband can be evaluated on datasets and on our own logs.
//
//   dsp_cli [--cols gx,gy,gz,ax,ay,az | --cols t,ax,ay,az,gx,gy,gz] [--fs 100]
//           [--hop 100] [--lever 0.10] [--max-lever 0.12] [--min-axis 0] [--skip-header]
//           < input.csv > windows.csv
//
// Input: one sample per line, comma separated, gyro in rad/s, accel in g.
// Output: one line per analysis window with every intermediate metric, so other
// decision rules (baselines) can be evaluated on the same numbers.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include <math.h>

#include "../firmware/src/dsp/tremor.h"

// Extra spectral features for the comparison detectors (computed from the SAME summed gyro
// spectrum the firmware uses). Mirrored exactly in dashboard/js/dsp.js.
struct Extra {
  float bp_ratio = 0, bp_omega = 0, bp_freq = 0;      // 3.5-7.5 Hz band power (classic threshold)
  float p37_freq = 0, p37_ratio = 0, p37_omega = 0;   // strongest local peak in 3-7 Hz (Timmermans-style)
  float dom_ratio = 0, dom_omega = 0;                 // lobe share and amplitude of the dominant 1-15 Hz peak
};

static float interpPeak(const float* psd, int k, int half, float df) {
  if (k <= 0 || k >= half) return k * df;
  const float eps = 1e-20f;
  float a = logf(psd[k - 1] + eps), b = logf(psd[k] + eps), c = logf(psd[k + 1] + eps);
  float den = a - 2.0f * b + c;
  float d = (den < 0) ? 0.5f * (a - c) / den : 0.0f;
  if (d > 0.5f) d = 0.5f;
  if (d < -0.5f) d = -0.5f;
  return (k + d) * df;
}

static Extra extraFeatures(const dsp::TremorDetector& det) {
  const dsp::TremorConfig& c = det.config();
  const float* psd = det.spectrum();
  const int n = c.n, half = n / 2;
  const float df = c.fs / n;
  float wp = 0;
  for (int i = 0; i < n; i++) { float w = 0.5f - 0.5f * cosf(2.0f * (float)M_PI * i / (n - 1)); wp += w * w; }
  const float scale = 2.0f / (n * wp);
  auto bin = [&](float hz) { return (int)lroundf(hz / df); };
  int s0 = bin(c.search_lo_hz), s1 = bin(c.search_hi_hz);
  if (s0 < 1) s0 = 1;
  if (s1 > half - 1) s1 = half - 1;
  float total = 0;
  int dom = s0;
  for (int k = s0; k <= s1; k++) { total += psd[k]; if (psd[k] > psd[dom]) dom = k; }
  Extra e;
  if (total <= 0) return e;
  auto lobe = [&](int k) { float p = 0; for (int j = k - c.lobe_bins; j <= k + c.lobe_bins; j++) if (j >= 1 && j < half) p += psd[j]; return p; };
  auto range = [&](float lo, float hi, int* k0, int* k1) {
    *k0 = (int)ceilf(lo / df - 0.5f); *k1 = (int)floorf(hi / df + 0.5f);
    if (*k0 < 1) *k0 = 1;
    if (*k1 > half - 1) *k1 = half - 1;
  };
  int k0, k1;
  range(3.5f, 7.5f, &k0, &k1);
  float bp = 0; int best = k0;
  for (int k = k0; k <= k1; k++) { bp += psd[k]; if (psd[k] > psd[best]) best = k; }
  e.bp_ratio = bp / total;
  e.bp_omega = sqrtf(2.0f * scale * bp);
  e.bp_freq = interpPeak(psd, best, half, df);
  range(3.0f, 7.0f, &k0, &k1);
  best = -1;
  for (int k = k0; k <= k1; k++) if (best < 0 || psd[k] > psd[best]) best = k;
  if (best > 0 && psd[best] >= psd[best - 1] && psd[best] >= psd[best + 1]) {
    float l = lobe(best);
    e.p37_freq = interpPeak(psd, best, half, df);
    e.p37_ratio = l / total;
    e.p37_omega = sqrtf(2.0f * scale * l);
  }
  e.dom_ratio = lobe(dom) / total;
  e.dom_omega = sqrtf(2.0f * scale * lobe(dom));
  return e;
}

int main(int argc, char** argv) {
  std::string cols = "t,ax,ay,az,gx,gy,gz";
  float fs = 100, lever = 0.10f;
  int hop = 100;
  bool skipHeader = false;
  dsp::TremorConfig cfg;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--cols") cols = next();
    else if (a == "--fs") fs = atof(next());
    else if (a == "--hop") hop = atoi(next());
    else if (a == "--lever") lever = atof(next());
    else if (a == "--max-lever") cfg.max_lever_eff_m = atof(next());
    else if (a == "--min-axis") cfg.min_axis_linearity = atof(next());
    else if (a == "--min-ratio") cfg.min_ratio = atof(next());
    else if (a == "--skip-header") skipHeader = true;
    else { fprintf(stderr, "unknown arg %s\n", argv[i]); return 2; }
  }
  cfg.fs = fs;
  cfg.lever_m = lever;

  // column map
  std::vector<std::string> names;
  for (size_t p = 0, q; p <= cols.size(); p = q + 1) {
    q = cols.find(',', p);
    if (q == std::string::npos) q = cols.size();
    names.push_back(cols.substr(p, q - p));
  }
  int idx[6] = {-1, -1, -1, -1, -1, -1};  // gx gy gz ax ay az
  const char* want[6] = {"gx", "gy", "gz", "ax", "ay", "az"};
  for (size_t c = 0; c < names.size(); c++)
    for (int w = 0; w < 6; w++)
      if (names[c] == want[w]) idx[w] = (int)c;
  for (int w = 0; w < 6; w++)
    if (idx[w] < 0) { fprintf(stderr, "--cols must name %s\n", want[w]); return 2; }

  std::vector<float> g[3], a[3];
  char line[1024];
  bool first = true;
  while (fgets(line, sizeof line, stdin)) {
    if (first && skipHeader) { first = false; continue; }
    first = false;
    float v[32];
    int n = 0;
    for (char* tok = strtok(line, ",; \t\r\n"); tok && n < 32; tok = strtok(nullptr, ",; \t\r\n")) v[n++] = atof(tok);
    if (n < (int)names.size()) continue;
    for (int w = 0; w < 3; w++) g[w].push_back(v[idx[w]]);
    for (int w = 0; w < 3; w++) a[w].push_back(v[idx[3 + w]]);
  }

  dsp::TremorDetector det(cfg);
  printf("t,freq,dom,ratio,omega,steady,lever,axis,lowband,accel_amp,activity,amp_cm,candidate,confirmed,arm_driven,severity,highfreq,"
         "bp_ratio,bp_omega,bp_freq,p37_freq,p37_ratio,p37_omega,dom_ratio,dom_omega\n");
  const int N = cfg.n;
  for (size_t start = 0; start + N <= g[0].size(); start += hop) {
    const float* gp[3] = {&g[0][start], &g[1][start], &g[2][start]};
    const float* ap[3] = {&a[0][start], &a[1][start], &a[2][start]};
    dsp::WindowResult r = det.analyze(gp, ap, false, false);
    Extra e = extraFeatures(det);
    printf("%.2f,%.3f,%.3f,%.4f,%.4f,%.3f,%.4f,%.3f,%.4f,%.4f,%.1f,%.3f,%d,%d,%d,%d,%d,%.4f,%.4f,%.3f,%.3f,%.4f,%.4f,%.4f,%.4f\n",
           (start + N) / fs, r.freq_hz, r.dom_freq_hz, r.ratio, r.omega_amp, r.steadiness,
           r.lever_eff_m, r.axis_linearity, r.lowband_omega, r.accel_amp, r.activity_mg, r.amp_cm,
           r.candidate, r.confirmed, r.arm_driven, r.severity, r.high_freq,
           e.bp_ratio, e.bp_omega, e.bp_freq, e.p37_freq, e.p37_ratio, e.p37_omega, e.dom_ratio, e.dom_omega);
  }
  return 0;
}
