// IMU sources: the real MPU-6050 and a simulator with the same interface.
#pragma once
#include <stdint.h>

struct ImuSample {
  int16_t ax, ay, az;  // raw, ACCEL_LSB_PER_G per g
  int16_t gx, gy, gz;  // raw, GYRO_LSB_PER_DPS per deg/s
};

// MPU-6050 (and MPU-6500-family clones) over I2C. Each new 100 Hz sample is read
// straight from the data registers as one self-contained 14-byte burst, so a bad I2C
// transfer (loose jumper wire, clone sensor, radio noise) costs one 10 ms sample, which
// is interpolated, instead of corrupting a FIFO stream and throwing a whole window away.
class Mpu6050 {
 public:
  bool begin(int sda, int scl, uint32_t hz);
  // Returns the new sample(s) since the last call (with any short gap interpolated).
  // overflow=true if data was missing for too long to fill (window must restart).
  int read(ImuSample* out, int max, bool* overflow);
  uint8_t whoAmI() const { return who_; }
  uint32_t samples() const { return samples_; }   // read from the sensor
  uint32_t filled() const { return filled_; }     // interpolated after a lost read
  uint32_t errors() const { return errors_; }     // failed I2C transfers

 private:
  void writeReg(uint8_t reg, uint8_t val);
  uint8_t readReg(uint8_t reg);
  bool readBytes(uint8_t reg, uint8_t* buf, uint8_t len);
  uint8_t who_ = 0;
  ImuSample last_{};
  uint32_t lastUs_ = 0;
  bool haveLast_ = false;
  uint32_t samples_ = 0, filled_ = 0, errors_ = 0;
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
  uint32_t samples() const { return n_; }
  uint32_t filled() const { return 0; }
  uint32_t errors() const { return 0; }

 private:
  uint32_t last_us_ = 0;
  uint32_t n_ = 0;
  float phase_ = 0, pp_cm_ = 0;
  uint32_t rng_ = 12345;
  float noise();
};
