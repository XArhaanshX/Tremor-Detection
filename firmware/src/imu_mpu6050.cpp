#include <Arduino.h>
#include <Wire.h>

#include "config.h"
#include "imu.h"

namespace {
constexpr uint8_t ADDR = 0x68;  // AD0 low (GY-521 default)
constexpr uint8_t REG_SMPLRT_DIV = 0x19;
constexpr uint8_t REG_CONFIG = 0x1A;
constexpr uint8_t REG_GYRO_CONFIG = 0x1B;
constexpr uint8_t REG_ACCEL_CONFIG = 0x1C;
constexpr uint8_t REG_FIFO_EN = 0x23;
constexpr uint8_t REG_INT_ENABLE = 0x38;
constexpr uint8_t REG_INT_STATUS = 0x3A;
constexpr uint8_t REG_USER_CTRL = 0x6A;
constexpr uint8_t REG_PWR_MGMT_1 = 0x6B;
constexpr uint8_t REG_FIFO_COUNTH = 0x72;
constexpr uint8_t REG_FIFO_R_W = 0x74;
constexpr uint8_t REG_WHO_AM_I = 0x75;

constexpr uint8_t FIFO_ACCEL_GYRO = 0x78;  // XG | YG | ZG | ACCEL -> 12 bytes/sample
constexpr uint8_t USER_FIFO_EN = 0x40;
constexpr uint8_t USER_FIFO_RESET = 0x04;
constexpr uint8_t INT_FIFO_OFLOW = 0x10;
constexpr int BYTES_PER_SAMPLE = 12;
constexpr int CHUNK_SAMPLES = 10;  // 120 B per read: Arduino-ESP32 Wire buffer is 128 B
}  // namespace

void Mpu6050::writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool Mpu6050::readBytes(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

uint8_t Mpu6050::readReg(uint8_t reg) {
  uint8_t v = 0;
  readBytes(reg, &v, 1);
  return v;
}

void Mpu6050::resetFifo() {
  writeReg(REG_FIFO_EN, 0);
  writeReg(REG_USER_CTRL, 0);
  writeReg(REG_USER_CTRL, USER_FIFO_RESET);
  writeReg(REG_USER_CTRL, USER_FIFO_EN);
  writeReg(REG_FIFO_EN, FIFO_ACCEL_GYRO);
  readReg(REG_INT_STATUS);  // clear a stale overflow flag
}

bool Mpu6050::begin(int sda, int scl, uint32_t hz) {
  Wire.begin(sda, scl, hz);
  who_ = readReg(REG_WHO_AM_I);
  if (who_ != 0x68) {
    // 0x70/0x72/0x98 are MPU-6500/9250-family clones sold as "MPU-6050";
    // the registers used here are compatible.
    if (who_ != 0x70 && who_ != 0x72 && who_ != 0x98) return false;
    Serial.printf("[imu] WARNING: WHO_AM_I=0x%02X (clone), continuing\n", who_);
  }
  writeReg(REG_PWR_MGMT_1, 0x80);  // device reset
  delay(100);
  writeReg(REG_PWR_MGMT_1, 0x01);  // wake, clock = PLL on gyro X (more stable than 8 MHz RC)
  delay(10);
  writeReg(REG_SMPLRT_DIV, MPU_SMPLRT_DIV);
  writeReg(REG_CONFIG, MPU_DLPF_CFG);
  writeReg(REG_GYRO_CONFIG, MPU_GYRO_FS_SEL << 3);
  writeReg(REG_ACCEL_CONFIG, MPU_ACCEL_FS_SEL << 3);
  writeReg(REG_INT_ENABLE, INT_FIFO_OFLOW);  // only latches the status bit; INT pin unused
  resetFifo();
  return true;
}

int Mpu6050::read(ImuSample* out, int max, bool* overflow) {
  *overflow = false;
  if (readReg(REG_INT_STATUS) & INT_FIFO_OFLOW) {
    resetFifo();
    *overflow = true;
    return 0;
  }
  uint8_t c[2];
  if (!readBytes(REG_FIFO_COUNTH, c, 2)) return 0;
  int count = (c[0] << 8) | c[1];
  if (count % BYTES_PER_SAMPLE) {  // misaligned (partial write / glitch): resync
    resetFifo();
    *overflow = true;
    return 0;
  }
  int n = count / BYTES_PER_SAMPLE;
  if (n > max) n = max;
  int got = 0;
  uint8_t buf[CHUNK_SAMPLES * BYTES_PER_SAMPLE];
  while (got < n) {
    int k = n - got < CHUNK_SAMPLES ? n - got : CHUNK_SAMPLES;
    if (!readBytes(REG_FIFO_R_W, buf, k * BYTES_PER_SAMPLE)) break;
    for (int i = 0; i < k; i++) {
      const uint8_t* b = buf + i * BYTES_PER_SAMPLE;  // big-endian, register order
      ImuSample& s = out[got + i];
      s.ax = (int16_t)((b[0] << 8) | b[1]);
      s.ay = (int16_t)((b[2] << 8) | b[3]);
      s.az = (int16_t)((b[4] << 8) | b[5]);
      s.gx = (int16_t)((b[6] << 8) | b[7]);
      s.gy = (int16_t)((b[8] << 8) | b[9]);
      s.gz = (int16_t)((b[10] << 8) | b[11]);
    }
    got += k;
  }
  return got;
}
