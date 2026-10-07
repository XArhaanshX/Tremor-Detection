// Every tunable lives here, next to the hardware fact that justifies it.
// See docs/HARDWARE.md and docs/ARCHITECTURE.md (section 8) before changing anything.
#pragma once

#define FW_VERSION 1

// ---------------------------------------------------------------- pins
#if defined(BOARD_XIAO_ESP32S3)
  #define PIN_I2C_SDA   5    // D4
  #define PIN_I2C_SCL   6    // D5
  #define PIN_BATT_ADC  1    // D0, 2x100k divider; set -1 if not fitted
  #define PIN_LED       21   // onboard orange user LED
  #define LED_ACTIVE_LOW 1
  #define PIN_BUTTON    0    // onboard BOOT button
#else  // generic ESP32-WROOM dev board (bench prototype)
  #define PIN_I2C_SDA   21
  #define PIN_I2C_SCL   22
  #define PIN_BATT_ADC  -1
  #define PIN_LED       2
  #define LED_ACTIVE_LOW 0
  #define PIN_BUTTON    0
#endif

#define BATT_DIVIDER  2.0f   // 100k/100k
#define I2C_HZ        400000 // MPU-6050 supports 400 kHz fast mode

// ---------------------------------------------------------------- sensor
// MPU-6050: sample rate = 1 kHz / (1 + SMPLRT_DIV) when the DLPF is enabled.
#define SAMPLE_HZ        100
#define MPU_SMPLRT_DIV   9      // 1000 / (1 + 9) = 100 Hz
#define MPU_DLPF_CFG     3      // accel 44 Hz / gyro 42 Hz bandwidth: anti-alias for 100 Hz
#define MPU_GYRO_FS_SEL  3      // +-2000 dps (severe tremor ~900 dps, fast hand turning ~1000 dps)
#define MPU_ACCEL_FS_SEL 2      // +-8 g
#define GYRO_LSB_PER_DPS 16.4f  // for FS_SEL=3
#define ACCEL_LSB_PER_G  4096.0f// for AFS_SEL=2
#define GYRO_SAT_RAW     32000  // |raw| above this = saturated

// ---------------------------------------------------------------- analysis
#define WINDOW_N        256     // 2.56 s at 100 Hz, 0.39 Hz frequency resolution
#define HOP_N           100     // new result every 1 s
#define EPOCH_SECONDS   30      // one stored record per 30 s
#define LEVER_MM_DEFAULT 100    // wrist-to-hand lever arm for displacement estimate

// ---------------------------------------------------------------- storage
#define QUEUE_SEG_RECORDS 256   // records per segment file (5 KB)
#define QUEUE_MAX_SEGS    128   // 655 KB cap -> ~11 days at 30 s epochs
#define SYNC_BATCH        32    // records per batch before waiting for ACK
#define SYNC_PACE_MS      6     // gap between notifications inside a batch

// ---------------------------------------------------------------- tests
#define TEST_MAX_SECONDS  60
#define PRONSUP_MAX_S     15    // raw gyro buffer for hand-turning test: 15 s x 100 Hz
