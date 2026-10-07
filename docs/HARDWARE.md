# Hardware Build Guide

## 1. Bill of materials

| # | Part | Why this part | Approx. cost |
|---|---|---|---|
| 1 | **Seeed Studio XIAO ESP32-S3** (not the "Sense" camera version — not needed) | 21 × 17.8 mm (fits on a wrist), dual-core 240 MHz with **hardware FPU** for the FFT, BLE 5, **built-in LiPo charger** + battery pads, USB-C, 8 MB flash for offline storage | ~$7.50 |
| 2 | **MPU-6050 breakout (GY-521)** | 3-axis gyroscope + 3-axis accelerometer, hardware 1 KB FIFO, on-chip low-pass filter, ±2000 dps range, I²C, onboard 3.3 V regulator and pull-ups | ~$2–4 |
| 3 | **3.7 V LiPo, 400–500 mAh, with protection circuit**, ≤ 35 × 30 × 6 mm (e.g. "503035" size) | ~12 h of continuous monitoring (see power budget). Protection PCB is mandatory for something worn on skin | ~$5 |
| 4 | Mini slide switch (SPDT, e.g. SS12D00) | Power on/off | <$1 |
| 5 | 2 × 100 kΩ resistors + 1 × 100 nF capacitor (optional) | Battery-voltage sensing (XIAO ESP32-S3 has no built-in battery divider) | <$1 |
| 6 | 3D-printed case (~45 × 38 × 14 mm) + 20 mm watch strap or Velcro strap | IMU must be **rigidly** held against the wrist | ~$3 |
| 7 | 30 AWG silicone wire, heat-shrink, double-sided foam tape / hot glue | Assembly | — |

**Alternative board:** any classic ESP32 dev board (ESP32-WROOM-32) works with the
same firmware (`pio run -e esp32dev`), but it is too big for a wristband and has no
battery charger — fine for a bench prototype only.
**Do not use an ESP32-C3**: it has no floating-point unit.

## 2. Wiring

```
   XIAO ESP32-S3                         GY-521 (MPU-6050)
  ┌──────────────┐                      ┌──────────────┐
  │ 3V3      ●───┼──────────────────────┼─● VCC         │
  │ GND      ●───┼──────────────────────┼─● GND         │
  │ D4/GPIO5 ●───┼───── SDA ────────────┼─● SDA         │
  │ D5/GPIO6 ●───┼───── SCL ────────────┼─● SCL         │
  │              │                      │  ● XDA  (nc)  │
  │              │                      │  ● XCL  (nc)  │
  │              │                      │  ● AD0  (nc → address 0x68, pulled low on board)
  │              │                      │  ● INT  (nc → firmware polls the FIFO)
  │              │                      └──────────────┘
  │ BAT+ pad ●───┼──── switch ──── LiPo +  (red)
  │ BAT- pad ●───┼────────────────  LiPo −  (black)
  │              │
  │ D0/GPIO1 ●───┼──┬── 100 kΩ ── BAT+ (after the switch)     (optional battery sense)
  │              │  ├── 100 kΩ ── GND
  │              │  └── 100 nF ── GND
  └──────────────┘
```

| XIAO ESP32-S3 pin | Connects to | Firmware constant (`firmware/include/config.h`) |
|---|---|---|
| 3V3 | GY-521 VCC | — |
| GND | GY-521 GND, LiPo −, divider bottom | — |
| D4 (GPIO5) | GY-521 SDA | `PIN_I2C_SDA` |
| D5 (GPIO6) | GY-521 SCL | `PIN_I2C_SCL` |
| D0 (GPIO1) | Battery divider midpoint (optional) | `PIN_BATT_ADC` (`-1` = not fitted) |
| BAT+/BAT− pads (underside) | LiPo through the switch | — |
| GPIO21 (onboard orange LED) | status LED | `PIN_LED` |
| GPIO0 (onboard BOOT button) | "I just took my medication" button | `PIN_BUTTON` |

For the `esp32dev` bench build: SDA = GPIO21, SCL = GPIO22, LED = GPIO2, button = GPIO0.

Electrical notes (checked against datasheets):
- GY-521 VCC goes through its own LDO; feeding 3.3 V gives ~3.28 V at the MPU-6050's
  ~4 mA draw — inside its 2.375–3.46 V range.
- GY-521 already has I²C pull-ups; don't add more.
- The divider draws 4.2 V / 200 kΩ ≈ 21 µA, negligible. The 100 nF cap gives the
  ESP32 ADC a low-impedance source to sample from.
- The XIAO charges the LiPo from USB-C at ~100 mA (≈5 h for 500 mAh). With the switch
  in series, **the switch must be ON to charge**.

## 3. Mechanical assembly

1. Solder the 4 wires between XIAO and GY-521 (keep them short — 3–4 cm).
2. Solder the battery leads to the XIAO's BAT pads via the switch. Check polarity twice.
3. **Mount the GY-521 rigidly** to the floor of the case (2× M2 screws or a hard glue
   layer, *not* foam). A wobbly sensor has its own resonance that can look like tremor.
4. Stack: case floor → GY-521 → foam tape → battery → XIAO on top, USB-C port facing a
   hole in the case wall. The BOOT button should sit under a small flexible window or
   a printed button plunger.
5. Strap: 20 mm slots on both sides for a watch strap or Velcro.

**How to wear it:** on the back of the wrist (watch position) of the *more affected*
arm, snug enough that the case can't slide. Orientation doesn't matter: the firmware
sums all three gyro axes and finds the main rotation axis by itself, so the patient
doesn't have to put it on the same way every day.

## 4. Power budget

| Consumer | Current |
|---|---|
| ESP32-S3 at 80 MHz, BLE connected (modem-sleep between events) | ~30–40 mA |
| MPU-6050, gyro + accel on | ~3.9 mA |
| LED (10 ms blinks) | ~0 average |
| **Total** | **~35–45 mA** |

500 mAh / ~40 mA ≈ **12 hours** → a full waking day; charge overnight.
Measure your actual draw with a USB power meter and adjust expectations.
(Future improvement: ESP-IDF automatic light sleep would roughly double this.)

## 5. Flash storage budget

- Data partition (LittleFS) on the default 8 MB partition table: ~1.5 MB.
- Queue capped at 128 segments × 256 records × 20 B = 655 KB.
- One record every 30 s → 2 880/day → **~11 days** without connecting to a phone.

## 6. Flashing the firmware

```bash
pip install platformio            # once
cd firmware
pio run -e xiao_esp32s3 -t upload # wristband
pio device monitor                # serial log at 115200 baud
```

No IMU yet? Flash the simulator build — it fakes a patient whose tremor comes and
goes like medication wearing off, so you can test the whole app with just the board:

```bash
pio run -e xiao_esp32s3_sim -t upload
```

## 7. Bring-up checklist

1. Serial log shows `MPU-6050 WHO_AM_I=0x68 OK` (some clones report 0x70/0x72/0x98 — those are accepted with a warning).
2. Place the band flat on a table: live view shows severity 0, activity < 20 mg.
3. Shake your wrist rhythmically ~5 times a second: severity jumps to 1–3 within ~2–3 s, frequency ≈ 5 Hz.
4. Wave slowly / pick up a cup: severity stays 0.
5. Walk away from the phone for > 1 min, come back: the dashboard syncs the missed epochs automatically.

## 8. Safety

This is a research/education prototype, **not a medical device**. Its scores are
estimates and must not be used to change medication without a neurologist.
Use a protected LiPo, don't charge it unattended, and stop wearing the band if
the case gets warm.
