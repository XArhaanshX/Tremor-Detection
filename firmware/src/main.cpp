// Tremor-monitoring wristband firmware.
//   sample (100 Hz FIFO) -> analyse every 1 s -> live BLE notify
//   -> 30 s epoch record -> flash queue -> batched sync with ACK
#include <Arduino.h>
#include <Preferences.h>

#include "ble_service.h"
#include "config.h"
#include "dsp/pronsup.h"
#include "dsp/tremor.h"
#include "imu.h"
#include "protocol.h"
#include "storage.h"

#ifdef SIMULATE_IMU
static SimImu imu;
static constexpr bool kSim = true;
#else
static Mpu6050 imu;
static constexpr bool kSim = false;
#endif

static constexpr float kGyroToRads = (float)M_PI / 180.0f / GYRO_LSB_PER_DPS;
static constexpr float kAccelToG = 1.0f / ACCEL_LSB_PER_G;

// ---------------------------------------------------------------- state
static Preferences prefs;
static RecordStore store;
static dsp::TremorDetector detector;
static dsp::WindowAggregator epoch;
static dsp::WindowAggregator testAgg;

static bool imuOk = false;
static uint16_t bootCount = 0;
static uint16_t leverMm = LEVER_MM_DEFAULT;
static bool timeSynced = false;

// sliding window (ring buffer) of physical-unit samples
static float ringG[3][WINDOW_N], ringA[3][WINDOW_N];
static int ringHead = 0, ringFilled = 0, sinceHop = 0, satCountdown = 0;
static bool gapPending = false;
static float winG[3][WINDOW_N], winA[3][WINDOW_N];  // linearised copy for analysis
static uint32_t windowCount = 0;

// epoch bookkeeping
static uint32_t epochStartMs = 0;
static bool buttonInEpoch = false, testInEpoch = false;

// battery
static uint8_t batteryPct = 255;
static uint16_t batteryMv = 0;

// sync state machine
static bool syncing = false, awaitingAck = false, doneSent = false;
static EpochRecord batch[SYNC_BATCH];
static int batchLen = 0, batchIdx = 0;
static uint32_t lastSendMs = 0, ackDeadlineMs = 0;

// active test
static uint8_t testType = 0;
static uint32_t testStartMs = 0, testDurMs = 0, lastProgressMs = 0;
static float psG[3][PRONSUP_MAX_S * SAMPLE_HZ];
static int psN = 0;
static bool psSat = false;

static uint32_t lastStatusMs = 0;

// ---------------------------------------------------------------- helpers
static uint32_t uptimeS() { return millis() / 1000; }

template <typename T>
static T clampTo(float v) {
  float lo = 0, hi = (float)((T)~(T)0);
  return (T)(v < lo ? lo : (v > hi ? hi : lroundf(v)));
}

static void led(bool on) {
  if (PIN_LED >= 0) digitalWrite(PIN_LED, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW);
}

static void readBattery() {
  if (PIN_BATT_ADC < 0) return;
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(PIN_BATT_ADC);
  batteryMv = (uint16_t)(mv / 8 * BATT_DIVIDER);
  // LiPo discharge curve (resting voltage -> %), linear between points
  static const uint16_t v[] = {3300, 3500, 3600, 3700, 3800, 3900, 4000, 4100, 4200};
  static const uint8_t p[] = {0, 5, 15, 30, 50, 65, 80, 90, 100};
  if (batteryMv < 2500) {  // divider not fitted / floating pin
    batteryPct = 255;
    return;
  }
  batteryPct = batteryMv <= v[0] ? 0 : 100;
  for (int i = 1; i < 9; i++)
    if (batteryMv < v[i]) {
      batteryPct = p[i - 1] + (p[i] - p[i - 1]) * (batteryMv - v[i - 1]) / (v[i] - v[i - 1]);
      break;
    }
}

static void sendStatus() {
  StatusPacket s{};
  s.proto = PROTO_VERSION;
  s.fw = FW_VERSION;
  s.flags = (timeSynced ? ST_TIME_SYNCED : 0) | (imuOk ? ST_IMU_OK : 0) |
            (store.ok() ? ST_STORAGE_OK : 0) | (kSim ? ST_SIM : 0) | (testType ? ST_TEST : 0) |
            (syncing ? ST_SYNCING : 0);
  s.battery_pct = batteryPct;
  s.battery_mv = batteryMv;
  s.boot = bootCount;
  s.store_id = store.storeId();
  s.next_seq = store.nextSeq();
  s.acked_seq = store.ackedSeq();
  ble::sendStatus(s);
  lastStatusMs = millis();
}

// ---------------------------------------------------------------- active tests
static void finishTest(uint8_t state) {
  if (!testType) return;
  if (state == TEST_STATE_DONE && testType == TEST_PRONSUP) {
    dsp::PronSupResult r = dsp::analyzePronSup(psG[0], psG[1], psG[2], psN, SAMPLE_HZ, psSat);
    TestPronSupResult p{};
    p.type = testType;
    p.state = state;
    p.movements = clampTo<uint8_t>(r.movements);
    p.hesitations = clampTo<uint8_t>(r.hesitations);
    p.rate_cHz = clampTo<uint16_t>(r.rate_hz * 100);
    p.excursion_ddeg = clampTo<uint16_t>(r.excursion_deg * 10);
    p.speed_dps = clampTo<uint16_t>(r.speed_dps);
    p.amp_decrement_pct = (int8_t)constrain(lroundf(r.amp_decrement_pct), -127, 127);
    p.speed_decrement_pct = (int8_t)constrain(lroundf(r.speed_decrement_pct), -127, 127);
    p.rhythm_cv_pct = clampTo<uint8_t>(r.rhythm_cv_pct);
    p.flags = (r.saturated ? 1 : 0) | (r.too_few ? 2 : 0);
    p.duration_ds = clampTo<uint16_t>(r.duration_s * 10);
    ble::sendTest(&p, sizeof p);
    Serial.printf("[test] hand turning: %d moves, %.2f Hz, %.0f deg, %.0f dps, decrement %.0f%%\n",
                  r.movements, r.rate_hz, r.excursion_deg, r.speed_dps, r.amp_decrement_pct);
  } else if (state == TEST_STATE_DONE) {
    TestTremorResult p{};
    p.type = testType;
    p.state = state;
    p.n_windows = clampTo<uint8_t>(testAgg.windows());
    p.tremor_pct = clampTo<uint8_t>(testAgg.tremorPct());
    p.sev_mean_x50 = clampTo<uint8_t>(testAgg.severityMean() * 50);
    p.sev_max = testAgg.severityMax();
    p.freq_dHz = clampTo<uint8_t>(testAgg.freqMean() * 10);
    p.amp_mean_mmx10 = clampTo<uint16_t>(testAgg.ampMeanCm() * 100);
    p.amp_max_mmx10 = clampTo<uint16_t>(testAgg.ampMaxCm() * 100);
    p.omega_mean_mrads = clampTo<uint16_t>(testAgg.omegaMean() * 1000);
    p.ratio_mean_pm = clampTo<uint16_t>(testAgg.ratioMean() * 1000);
    ble::sendTest(&p, sizeof p);
    Serial.printf("[test] tremor test %d: %.0f%% tremor, sev max %d\n", testType,
                  testAgg.tremorPct(), testAgg.severityMax());
  } else {
    uint8_t p[2] = {testType, state};
    ble::sendTest(p, sizeof p);
  }
  testType = 0;
  sendStatus();
}

static void startTest(uint8_t type, uint16_t seconds) {
  if (type < TEST_REST_TREMOR || type > TEST_PRONSUP || seconds == 0) {
    uint8_t p[2] = {type, TEST_STATE_ERROR};
    ble::sendTest(p, sizeof p);
    return;
  }
  uint16_t maxS = type == TEST_PRONSUP ? PRONSUP_MAX_S : TEST_MAX_SECONDS;
  if (seconds > maxS) seconds = maxS;
  testType = type;
  testStartMs = lastProgressMs = millis();
  testDurMs = seconds * 1000u;
  testAgg.reset();
  psN = 0;
  psSat = false;
  testInEpoch = true;
  Serial.printf("[test] start type %d for %u s\n", type, seconds);
  sendStatus();
}

static void serviceTest() {
  if (!testType) return;
  uint32_t el = millis() - testStartMs;
  if (el >= testDurMs) {
    finishTest(TEST_STATE_DONE);
    return;
  }
  if (millis() - lastProgressMs >= 1000) {
    lastProgressMs = millis();
    TestProgress p{testType, TEST_STATE_RUNNING, (uint16_t)(el / 100), (uint16_t)(testDurMs / 100)};
    ble::sendTest(&p, sizeof p);
  }
}

// ---------------------------------------------------------------- analysis
static void analyzeWindow() {
  for (int i = 0; i < WINDOW_N; i++) {
    int j = (ringHead + i) % WINDOW_N;  // oldest first
    for (int k = 0; k < 3; k++) {
      winG[k][i] = ringG[k][j];
      winA[k][i] = ringA[k][j];
    }
  }
  const float* g[3] = {winG[0], winG[1], winG[2]};
  const float* a[3] = {winA[0], winA[1], winA[2]};
  dsp::WindowResult r = detector.analyze(g, a, satCountdown > 0, gapPending);
  gapPending = false;
  windowCount++;
  epoch.add(r);
  if (testType == TEST_REST_TREMOR || testType == TEST_POSTURAL_TREMOR) testAgg.add(r);

  LivePacket p{};
  p.win = windowCount;
  p.severity = r.severity;
  p.flags = (r.confirmed ? LIVE_TREMOR : 0) | (r.candidate ? LIVE_CANDIDATE : 0) |
            (r.high_freq ? LIVE_HIGHFREQ : 0) | (r.saturated ? LIVE_SATURATED : 0) |
            (r.gap ? LIVE_GAP : 0) | (testType ? LIVE_TEST_RUNNING : 0) | (kSim ? LIVE_SIM : 0);
  p.freq_cHz = r.candidate ? clampTo<uint16_t>(r.freq_hz * 100) : 0;
  p.amp_mmx10 = r.candidate ? clampTo<uint16_t>(r.amp_cm * 100) : 0;
  p.omega_mrads = clampTo<uint16_t>(r.omega_amp * 1000);
  p.ratio_pm = clampTo<uint16_t>(r.ratio * 1000);
  p.activity_mg = clampTo<uint16_t>(r.activity_mg);
  p.dom_cHz = clampTo<uint16_t>(r.dom_freq_hz * 100);
  p.battery_pct = batteryPct;
  ble::sendLive(p);

  if (r.confirmed)
    Serial.printf("[tremor] sev %d  %.2f Hz  %.1f cm  ratio %.2f\n", r.severity, r.freq_hz,
                  r.amp_cm, r.ratio);
}

static void pushSample(const ImuSample& s) {
  float g[3] = {s.gx * kGyroToRads, s.gy * kGyroToRads, s.gz * kGyroToRads};
  float a[3] = {s.ax * kAccelToG, s.ay * kAccelToG, s.az * kAccelToG};
  for (int k = 0; k < 3; k++) {
    ringG[k][ringHead] = g[k];
    ringA[k][ringHead] = a[k];
  }
  ringHead = (ringHead + 1) % WINDOW_N;
  if (ringFilled < WINDOW_N) ringFilled++;
  sinceHop++;

  if (abs(s.gx) > GYRO_SAT_RAW || abs(s.gy) > GYRO_SAT_RAW || abs(s.gz) > GYRO_SAT_RAW) {
    satCountdown = WINDOW_N;
    if (testType == TEST_PRONSUP) psSat = true;
  } else if (satCountdown > 0) {
    satCountdown--;
  }

  if (testType == TEST_PRONSUP && psN < PRONSUP_MAX_S * SAMPLE_HZ) {
    for (int k = 0; k < 3; k++) psG[k][psN] = g[k];
    psN++;
  }

  if (ringFilled == WINDOW_N && sinceHop >= HOP_N) {
    sinceHop = 0;
    analyzeWindow();
  }
}

static void serviceImu() {
  static ImuSample buf[64];
  bool overflow = false;
  int n = imu.read(buf, 64, &overflow);
  if (overflow) {
    // samples were lost: restart the window so no analysis spans the gap
    ringFilled = 0;
    sinceHop = 0;
    gapPending = true;
    detector.reset();
    Serial.println("[imu] FIFO overflow, window restarted");
  }
  for (int i = 0; i < n; i++) pushSample(buf[i]);
}

// ---------------------------------------------------------------- epochs
static void closeEpoch() {
  epochStartMs += EPOCH_SECONDS * 1000u;
  if (epoch.windows() == 0) return;
  EpochRecord rec{};
  rec.t = uptimeS();
  rec.boot = bootCount;
  rec.sev_max = epoch.severityMax();
  rec.sev_mean_x50 = clampTo<uint8_t>(epoch.severityMean() * 50);
  rec.tremor_pct = clampTo<uint8_t>(epoch.tremorPct());
  rec.n_windows = clampTo<uint8_t>(epoch.windows());
  rec.freq_dHz = clampTo<uint8_t>(epoch.freqMean() * 10);
  rec.activity_4mg = clampTo<uint8_t>(epoch.activityMean() / 4);
  rec.amp_mmx10 = clampTo<uint16_t>(epoch.ampMeanCm() * 100);
  rec.amp_max_mm = clampTo<uint8_t>(epoch.ampMaxCm() * 10);
  rec.flags = (buttonInEpoch ? REC_BUTTON : 0) | (epoch.anyHighFreq() ? REC_HIGHFREQ : 0) |
              (epoch.anyGap() ? REC_GAP : 0) | (kSim ? REC_SIM : 0) | (testInEpoch ? REC_TEST : 0);
  store.append(rec);
  Serial.printf("[epoch] #%lu tremor %u%% sev max %u mean %.2f amp %.1f cm (pending %lu)\n",
                (unsigned long)rec.seq, rec.tremor_pct, rec.sev_max, rec.sev_mean_x50 / 50.0f,
                rec.amp_mmx10 / 100.0f, (unsigned long)store.pending());
  epoch.reset();
  buttonInEpoch = testInEpoch = false;
  doneSent = false;  // there is something new to sync
  readBattery();
  sendStatus();
}

// ---------------------------------------------------------------- sync
static void serviceSync() {
  if (!syncing || !ble::connected()) return;
  uint32_t now = millis();

  if (batchIdx < batchLen) {  // pace notifications inside a batch
    if (now - lastSendMs < SYNC_PACE_MS) return;
    EpochRecord r = batch[batchIdx++];
    uint32_t unix;
    if (!(r.flags & REC_TIME_VALID) && store.toUnix(r.boot, r.t, &unix)) {
      r.t = unix;
      r.flags |= REC_TIME_VALID;
    }
    ble::sendRecord(r);
    lastSendMs = now;
    if (batchIdx == batchLen) {
      ble::sendMarker(MARK_BATCH_END, batch[batchLen - 1].seq);
      awaitingAck = true;
      ackDeadlineMs = now + 5000;
    }
    return;
  }

  if (awaitingAck) {
    if ((int32_t)(now - ackDeadlineMs) > 0) awaitingAck = false;  // resend from acked+1
    return;
  }

  batchLen = store.read(store.ackedSeq() + 1, batch, SYNC_BATCH);
  batchIdx = 0;
  if (batchLen == 0 && !doneSent) {
    ble::sendMarker(MARK_SYNC_DONE, store.ackedSeq());
    doneSent = true;
  }
}

// ---------------------------------------------------------------- commands
static uint32_t u32At(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

static void handleCommand(const Command& c) {
  switch (c.data[0]) {
    case CMD_SET_TIME:
      if (c.len >= 5) {
        uint32_t unix = u32At(c.data + 1);
        store.setTimeOffset(unix - uptimeS());
        timeSynced = true;
        Serial.printf("[time] synced, unix=%lu\n", (unsigned long)unix);
      }
      break;
    case CMD_SYNC:
      syncing = true;
      awaitingAck = false;
      doneSent = false;
      batchLen = batchIdx = 0;
      break;
    case CMD_ACK:
      if (c.len >= 5) {
        store.ack(u32At(c.data + 1));
        awaitingAck = false;
        doneSent = false;
      }
      break;
    case CMD_TEST_START:
      if (c.len >= 4) startTest(c.data[1], c.data[2] | (c.data[3] << 8));
      break;
    case CMD_TEST_ABORT:
      finishTest(TEST_STATE_ABORTED);
      break;
    case CMD_SET_LEVER:
      if (c.len >= 3) {
        uint16_t mm = c.data[1] | (c.data[2] << 8);
        if (mm >= 30 && mm <= 300) {
          leverMm = mm;
          detector.setLeverMeters(mm / 1000.0f);
          if (prefs.getUShort("lever", 0) != mm) prefs.putUShort("lever", mm);
        }
      }
      break;
    case CMD_ERASE:
      if (c.len >= 3 && c.data[1] == 0xA5 && c.data[2] == 0x5A) {
        store.eraseAll();
        batchLen = batchIdx = 0;
        awaitingAck = false;
      }
      break;
    case 0xFF:  // internal: link dropped
      syncing = awaitingAck = false;
      batchLen = batchIdx = 0;
      if (testType) finishTest(TEST_STATE_ABORTED);
      return;
  }
  sendStatus();
}

// ---------------------------------------------------------------- button & LED
static void serviceButton() {
  static bool last = true;
  static uint32_t lastChangeMs = 0;
  bool level = digitalRead(PIN_BUTTON);
  if (level != last && millis() - lastChangeMs > 40) {
    lastChangeMs = millis();
    last = level;
    if (!level) {  // pressed: patient marks "took my medication"
      buttonInEpoch = true;
      Serial.println("[button] medication marked");
      for (int i = 0; i < 3; i++) {
        led(true);
        delay(60);
        led(false);
        delay(60);
      }
    }
  }
}

static void serviceLed() {
  // short blink: every 2 s while waiting for a phone, every 10 s when connected
  uint32_t period = ble::connected() ? 10000 : 2000;
  led(millis() % period < 15);
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  setCpuFrequencyMhz(80);  // plenty for 3 FFTs/s, saves battery; BLE needs >= 80 MHz
  if (PIN_LED >= 0) pinMode(PIN_LED, OUTPUT);
  led(false);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  prefs.begin("band", false);
  bootCount = prefs.getUShort("boot", 0) + 1;
  prefs.putUShort("boot", bootCount);
  leverMm = prefs.getUShort("lever", LEVER_MM_DEFAULT);
  detector.setLeverMeters(leverMm / 1000.0f);
  Serial.printf("\n[boot] tremor band fw %d, boot #%u, lever %u mm%s\n", FW_VERSION, bootCount,
                leverMm, kSim ? ", SIMULATED IMU" : "");

  store.begin(bootCount);

  imuOk = imu.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
  if (kSim) Serial.println("[imu] simulator running");
  else if (imuOk) Serial.printf("[imu] MPU-6050 WHO_AM_I=0x%02X OK\n", imu.whoAmI());
  else Serial.println("[imu] MPU-6050 NOT FOUND - check SDA/SCL/3V3 wiring");

  uint64_t mac = ESP.getEfuseMac();
  char name[20];
  snprintf(name, sizeof name, "TremorBand-%02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  ble::begin(name);

  readBattery();
  sendStatus();
  epochStartMs = millis();
}

void loop() {
  if (imuOk) serviceImu();
  else {
    static uint32_t lastRetry = 0;  // sensor unplugged? keep trying every 5 s
    if (millis() - lastRetry > 5000) {
      lastRetry = millis();
      imuOk = imu.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
      if (imuOk) Serial.println("[imu] sensor found");
    }
  }

  Command c;
  while (ble::popCommand(&c)) handleCommand(c);

  if (millis() - epochStartMs >= EPOCH_SECONDS * 1000u) closeEpoch();
  serviceTest();
  serviceSync();
  serviceButton();
  serviceLed();
  if (ble::connected() && millis() - lastStatusMs > 5000) sendStatus();
  delay(2);
}
