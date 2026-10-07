#include "pronsup.h"

#include <math.h>
#include <stdlib.h>

namespace dsp {

namespace {

constexpr int kMaxMoves = 128;
constexpr float kRadToDeg = 57.2957795f;

int cmpFloat(const void* a, const void* b) {
  float x = *(const float*)a, y = *(const float*)b;
  return (x > y) - (x < y);
}

// Dominant eigenvector of a symmetric 3x3 matrix by power iteration.
void principalAxis(const float c[3][3], float v[3]) {
  v[0] = v[1] = v[2] = 0.57735f;
  for (int it = 0; it < 40; it++) {
    float w[3];
    for (int i = 0; i < 3; i++) w[i] = c[i][0] * v[0] + c[i][1] * v[1] + c[i][2] * v[2];
    float norm = sqrtf(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
    if (norm < 1e-12f) return;
    for (int i = 0; i < 3; i++) v[i] = w[i] / norm;
  }
}

// (mean of first third - mean of last third) / mean of first third, in %.
float decrementPct(const float* x, int n) {
  int t = n / 3;
  if (t < 1) return 0;
  float a = 0, b = 0;
  for (int i = 0; i < t; i++) {
    a += x[i];
    b += x[n - t + i];
  }
  return a > 0 ? 100.0f * (a - b) / a : 0;
}

}  // namespace

PronSupResult analyzePronSup(const float* gx, const float* gy, const float* gz, int n,
                             float fs, bool saturated) {
  PronSupResult r;
  r.saturated = saturated;
  r.duration_s = n / fs;
  if (n < 10) {
    r.too_few = true;
    return r;
  }
  const float* g[3] = {gx, gy, gz};

  // 1. Remove gyro bias (mean) and find the main rotation axis.
  float mean[3] = {0, 0, 0};
  for (int a = 0; a < 3; a++) {
    for (int i = 0; i < n; i++) mean[a] += g[a][i];
    mean[a] /= n;
  }
  float c[3][3] = {{0}};
  for (int i = 0; i < n; i++)
    for (int a = 0; a < 3; a++)
      for (int b = 0; b < 3; b++) c[a][b] += (g[a][i] - mean[a]) * (g[b][i] - mean[b]);
  float v[3];
  principalAxis(c, v);

  // 2. Project onto that axis; hysteresis threshold relative to the peak speed.
  float peak = 0;
  for (int i = 0; i < n; i++) {
    float s = (g[0][i] - mean[0]) * v[0] + (g[1][i] - mean[1]) * v[1] + (g[2][i] - mean[2]) * v[2];
    if (fabsf(s) > peak) peak = fabsf(s);
  }
  float h = 0.15f * peak;
  if (h < 0.5f) h = 0.5f;  // rad/s: ignore tiny wobbles / tremor at rest

  // 3. Segment into half-turns. A new half-turn starts at the zero crossing
  //    preceding each crossing of the opposite threshold.
  int starts[kMaxMoves + 1];
  int nstarts = 0;
  int state = 0;
  float prev = 0;
  int last_zero = 0;
  for (int i = 0; i < n; i++) {
    float s = (g[0][i] - mean[0]) * v[0] + (g[1][i] - mean[1]) * v[1] + (g[2][i] - mean[2]) * v[2];
    if (i > 0 && ((prev <= 0 && s > 0) || (prev >= 0 && s < 0))) last_zero = i;
    int ns = s > h ? 1 : (s < -h ? -1 : state);
    if (ns != state) {
      if (nstarts <= kMaxMoves) starts[nstarts++] = last_zero;
      state = ns;
    }
    prev = s;
  }

  int moves = nstarts - 1;  // the last one is cut off by the end of the test
  if (moves > kMaxMoves) moves = kMaxMoves;
  if (moves < 4) {
    r.movements = moves > 0 ? moves : 0;
    r.too_few = true;
    return r;
  }

  // 4. Per half-turn: rotation angle, peak speed, duration.
  float exc[kMaxMoves], spd[kMaxMoves], dur[kMaxMoves];
  for (int m = 0; m < moves; m++) {
    float integral = 0, pk = 0;
    for (int i = starts[m]; i < starts[m + 1]; i++) {
      float s = (g[0][i] - mean[0]) * v[0] + (g[1][i] - mean[1]) * v[1] + (g[2][i] - mean[2]) * v[2];
      integral += s;
      if (fabsf(s) > pk) pk = fabsf(s);
    }
    exc[m] = fabsf(integral / fs) * kRadToDeg;
    spd[m] = pk * kRadToDeg;
    dur[m] = (starts[m + 1] - starts[m]) / fs;
  }

  float esum = 0, ssum = 0, dsum = 0, dsq = 0;
  for (int m = 0; m < moves; m++) {
    esum += exc[m];
    ssum += spd[m];
    dsum += dur[m];
    dsq += dur[m] * dur[m];
  }
  r.movements = moves;
  r.excursion_deg = esum / moves;
  r.speed_dps = ssum / moves;
  float dmean = dsum / moves;
  float dvar = dsq / moves - dmean * dmean;
  r.rhythm_cv_pct = dmean > 0 ? 100.0f * sqrtf(dvar > 0 ? dvar : 0) / dmean : 0;
  r.rate_hz = dsum > 0 ? 0.5f * moves / dsum : 0;
  r.amp_decrement_pct = decrementPct(exc, moves);
  r.speed_decrement_pct = decrementPct(spd, moves);

  float sorted[kMaxMoves];
  for (int m = 0; m < moves; m++) sorted[m] = dur[m];
  qsort(sorted, moves, sizeof(float), cmpFloat);
  float median = sorted[moves / 2];
  for (int m = 0; m < moves; m++)
    if (dur[m] > 2.0f * median) r.hesitations++;
  return r;
}

}  // namespace dsp
