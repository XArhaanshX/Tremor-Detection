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

#include "../firmware/src/dsp/tremor.h"

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
  printf("t,freq,dom,ratio,omega,steady,lever,axis,lowband,accel_amp,activity,amp_cm,candidate,confirmed,arm_driven,severity,highfreq\n");
  const int N = cfg.n;
  for (size_t start = 0; start + N <= g[0].size(); start += hop) {
    const float* gp[3] = {&g[0][start], &g[1][start], &g[2][start]};
    const float* ap[3] = {&a[0][start], &a[1][start], &a[2][start]};
    dsp::WindowResult r = det.analyze(gp, ap, false, false);
    printf("%.2f,%.3f,%.3f,%.4f,%.4f,%.3f,%.4f,%.3f,%.4f,%.4f,%.1f,%.3f,%d,%d,%d,%d,%d\n",
           (start + N) / fs, r.freq_hz, r.dom_freq_hz, r.ratio, r.omega_amp, r.steadiness,
           r.lever_eff_m, r.axis_linearity, r.lowband_omega, r.accel_amp, r.activity_mg, r.amp_cm,
           r.candidate, r.confirmed, r.arm_driven, r.severity, r.high_freq);
  }
  return 0;
}
