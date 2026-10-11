// Raw IMU logger for collecting our own test recordings.
//   pio run -e esp32dev_rawlog -t upload
//   python3 tools/record.py --label brushing --seconds 60
// Prints "t,ax,ay,az,gx,gy,gz" (accel in g, gyro in rad/s) at 100 Hz over serial,
// using the same MPU-6050 configuration as the band firmware.
#include <Arduino.h>

#include "config.h"
#include "imu.h"

static Mpu6050 imu;
static bool ok = false;
static uint32_t n = 0;

void setup() {
  Serial.begin(921600);
  delay(200);
  ok = imu.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
  Serial.println(ok ? "# MPU-6050 OK" : "# MPU-6050 NOT FOUND");
  Serial.println("t,ax,ay,az,gx,gy,gz");
}

void loop() {
  if (!ok) {
    delay(1000);
    ok = imu.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
    return;
  }
  static ImuSample buf[32];
  bool overflow;
  int k = imu.read(buf, 32, &overflow);
  if (overflow) Serial.println("# overflow");
  const float g2rad = (float)M_PI / 180.0f / GYRO_LSB_PER_DPS;
  for (int i = 0; i < k; i++, n++) {
    const ImuSample& s = buf[i];
    Serial.printf("%.2f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f\n", n / (float)SAMPLE_HZ, s.ax / ACCEL_LSB_PER_G,
                  s.ay / ACCEL_LSB_PER_G, s.az / ACCEL_LSB_PER_G, s.gx * g2rad, s.gy * g2rad, s.gz * g2rad);
  }
  delay(5);
}
