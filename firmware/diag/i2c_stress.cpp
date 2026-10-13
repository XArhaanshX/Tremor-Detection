// I2C reliability test for the IMU wiring: error rate per bus speed and read style.
//   pio run -e i2c_stress -t upload && pio device monitor
#include <Arduino.h>
#include <Wire.h>

#include "config.h"

static const uint8_t ADDR = 0x68;

static bool readRegs(uint8_t reg, uint8_t* buf, uint8_t len, bool repeatedStart) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(!repeatedStart) != 0) return false;
  if (Wire.requestFrom(ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

static void writeReg(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.write(v);
  Wire.endTransmission();
}

static void trial(uint32_t hz, bool rs) {
  Wire.end();
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, hz);
  writeReg(0x6B, 0x01);  // wake
  delay(20);
  uint8_t b[14];
  int ok = 0, fail = 0;
  float gmin = 1e9, gmax = -1e9;
  uint32_t end = millis() + 3000;
  while (millis() < end) {
    if (readRegs(0x3B, b, 14, rs)) {  // accel, temp, gyro: one burst
      ok++;
      float az = (int16_t)((b[4] << 8) | b[5]) / 16384.0f;  // default +-2 g after wake
      gmin = min(gmin, az); gmax = max(gmax, az);
    } else {
      fail++;
    }
    delay(2);
  }
  Serial.printf("[stress] %3u kHz %-15s ok %5d  fail %5d  (%.1f%%)  accel z %.2f..%.2f g\n", hz / 1000,
                rs ? "repeated-start" : "stop+start", ok, fail, 100.0f * fail / (ok + fail), gmin, gmax);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[stress] start");
}

void loop() {
  for (uint32_t hz : {400000u, 100000u}) {
    trial(hz, true);
    trial(hz, false);
  }
  Serial.println("[stress] round done");
  delay(500);
}
