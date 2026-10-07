#include <Arduino.h>
#include <math.h>

#include "config.h"
#include "imu.h"

namespace {
constexpr float kCycleS = 480.0f;  // one "medication cycle" in the simulation
constexpr float kLeverM = LEVER_MM_DEFAULT / 1000.0f;
constexpr float kAxis[3] = {0.80f, -0.50f, 0.33f};  // tremor rotation axis (unit-ish)
}  // namespace

bool SimImu::begin(int, int, uint32_t) {
  last_us_ = micros();
  return true;
}

float SimImu::noise() {  // cheap uniform [-1, 1)
  rng_ = rng_ * 1664525u + 1013904223u;
  return (rng_ >> 8) / 8388608.0f - 1.0f;
}

int SimImu::read(ImuSample* out, int max, bool* overflow) {
  *overflow = false;
  uint32_t now = micros();
  int due = (int)((now - last_us_) / (1000000 / SAMPLE_HZ));
  if (due > max) due = max;
  last_us_ += due * (1000000 / SAMPLE_HZ);

  const float dps_per_rad = 57.29578f;
  for (int i = 0; i < due; i++, n_++) {
    float t = n_ / (float)SAMPLE_HZ;
    float u = fmodf(t, kCycleS);
    // tremor amplitude follows the "medication" cycle
    if (u < 120) pp_cm_ = 0;                                    // dose working
    else if (u < 360) pp_cm_ = 0.4f + 5.6f * (u - 120) / 240;   // wearing off
    else if (u < 420) pp_cm_ = 6.0f;                            // OFF
    else pp_cm_ = 6.0f * (480 - u) / 60;                        // next dose kicks in
    float f = 4.8f + 0.3f * sinf(t * 0.05f);
    phase_ += 2 * (float)M_PI * f / SAMPLE_HZ;
    float theta = (pp_cm_ / 100.0f) / (2 * kLeverM);
    float w = theta * 2 * (float)M_PI * f * sinf(phase_);  // rad/s

    // 6 s of voluntary movement every 45 s
    float vol = fmodf(t, 45.0f) < 6 ? 1.5f * sinf(2 * (float)M_PI * 0.8f * t) : 0;

    float g[3], a[3];
    for (int k = 0; k < 3; k++) g[k] = (w + vol) * kAxis[k] + 0.02f * noise() + 0.03f;
    a[0] = sinf(theta * sinf(phase_)) + 0.1f * vol + 0.004f * noise();
    a[1] = 0.004f * noise();
    a[2] = 1.0f + 0.004f * noise();

    ImuSample& s = out[i];
    s.gx = (int16_t)constrain(lroundf(g[0] * dps_per_rad * GYRO_LSB_PER_DPS), -32768, 32767);
    s.gy = (int16_t)constrain(lroundf(g[1] * dps_per_rad * GYRO_LSB_PER_DPS), -32768, 32767);
    s.gz = (int16_t)constrain(lroundf(g[2] * dps_per_rad * GYRO_LSB_PER_DPS), -32768, 32767);
    s.ax = (int16_t)constrain(lroundf(a[0] * ACCEL_LSB_PER_G), -32768, 32767);
    s.ay = (int16_t)constrain(lroundf(a[1] * ACCEL_LSB_PER_G), -32768, 32767);
    s.az = (int16_t)constrain(lroundf(a[2] * ACCEL_LSB_PER_G), -32768, 32767);
  }
  return due;
}
