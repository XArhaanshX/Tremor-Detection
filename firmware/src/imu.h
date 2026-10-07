// IMU sources: the real MPU-6050 and a simulator with the same interface.
#pragma once
#include <stdint.h>

struct ImuSample {
  int16_t ax, ay, az;  // raw, ACCEL_LSB_PER_G per g
  int16_t gx, gy, gz;  // raw, GYRO_LSB_PER_DPS per deg/s
};

// MPU-6050 over I2C, read through its hardware FIFO so the main loop can be
// late by up to 0.85 s (BLE, flash writes) without losing a single sample.
class Mpu6050 {
 public:
  bool begin(int sda, int scl, uint32_t hz);
  // Drains up to max samples. overflow=true if samples were lost (FIFO reset).
  int read(ImuSample* out, int max, bool* overflow);
  uint8_t whoAmI() const { return who_; }

 private:
  void writeReg(uint8_t reg, uint8_t val);
  uint8_t readReg(uint8_t reg);
  bool readBytes(uint8_t reg, uint8_t* buf, uint8_t len);
  void resetFifo();
  uint8_t who_ = 0;
};

// Synthetic patient for bench testing without a sensor (build flag SIMULATE_IMU).
// An 8-minute cycle: medication ON (no tremor) -> wearing off (tremor grows to
// ~6 cm) -> next dose (tremor stops), with bouts of voluntary movement mixed in.
class SimImu {
 public:
  bool begin(int, int, uint32_t);
  int read(ImuSample* out, int max, bool* overflow);
  uint8_t whoAmI() const { return 0; }
  float currentTremorCm() const { return pp_cm_; }

 private:
  uint32_t last_us_ = 0;
  uint32_t n_ = 0;
  float phase_ = 0, pp_cm_ = 0;
  uint32_t rng_ = 12345;
  float noise();
};
