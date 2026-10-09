// Wiring diagnostic: tells you whether the sensor is powered, connected, and
// whether SDA/SCL are swapped.   pio run -e i2c_scan -t upload && pio device monitor
#include <Arduino.h>
#include <Wire.h>

static void probe(int sda, int scl) {
  // GY-521 has pull-up resistors: a powered, connected sensor holds both lines HIGH.
  pinMode(sda, INPUT);
  pinMode(scl, INPUT);
  delay(5);
  Serial.printf("  line levels: GPIO%d=%d  GPIO%d=%d  (1 = sensor pull-up seen)\n", sda,
                digitalRead(sda), scl, digitalRead(scl));
  Wire.begin(sda, scl, 100000);
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device at 0x%02X%s\n", a, (a == 0x68 || a == 0x69) ? "  <-- MPU-6050!" : "");
      found++;
    }
  }
  if (!found) Serial.println("  no devices");
  Wire.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);
}

void loop() {
  Serial.println("\n[scan] SDA=GPIO21 SCL=GPIO22 (correct wiring):");
  probe(21, 22);
  Serial.println("[scan] SDA=GPIO22 SCL=GPIO21 (if wires are swapped):");
  probe(22, 21);
  delay(2000);
}
