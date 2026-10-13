// BLE wire protocol shared by the wristband and the dashboard.
// Mirror: dashboard/js/protocol.js   Spec: docs/PROTOCOL.md
//
// Every packet is <= 20 bytes so it fits the default BLE ATT MTU (23) on any
// phone or browser without MTU negotiation. All integers are little-endian.
#pragma once
#include <stdint.h>

#define PROTO_VERSION 2

#define UUID_SERVICE "d2e60001-ed8b-45e3-b151-051e61e017ff"
#define UUID_LIVE    "d2e60002-ed8b-45e3-b151-051e61e017ff"  // notify: LivePacket, 1/s
#define UUID_RECORDS "d2e60003-ed8b-45e3-b151-051e61e017ff"  // notify: EpochRecord or SyncMarker
#define UUID_CONTROL "d2e60004-ed8b-45e3-b151-051e61e017ff"  // write: commands below
#define UUID_STATUS  "d2e60005-ed8b-45e3-b151-051e61e017ff"  // read/notify: StatusPacket
#define UUID_TEST    "d2e60006-ed8b-45e3-b151-051e61e017ff"  // notify: TestPacket
#define UUID_RAW     "d2e60007-ed8b-45e3-b151-051e61e017ff"  // notify: raw samples, only while CMD_RAW_STREAM is on

// ---- Control commands (app -> band) ----
enum : uint8_t {
  CMD_SET_TIME   = 0x01,  // [cmd, u32 unix_seconds]
  CMD_SYNC       = 0x02,  // [cmd]  start streaming un-acked records
  CMD_ACK        = 0x03,  // [cmd, u32 seq]  app has every record with seq <= value
  CMD_TEST_START = 0x10,  // [cmd, u8 test_type, u16 duration_s]
  CMD_TEST_ABORT = 0x11,  // [cmd]
  CMD_SET_LEVER  = 0x20,  // [cmd, u16 lever_mm]  wrist-to-hand lever for amplitude
  CMD_DOSE       = 0x21,  // [cmd, u32 unix_seconds]  a dose logged in the app
  CMD_SET_WEAROFF = 0x22, // [cmd, u16 warn_after_min, u16 typical_min]  learned in the app; 0 = unknown
  CMD_ALERT_DISMISS = 0x23, // [cmd]  patient acknowledged the wearing-off warning
  CMD_RAW_STREAM = 0x24,  // [cmd, u8 on]  stream the exact samples the band analyses (live comparison)
  CMD_ERASE      = 0x7F,  // [cmd, 0xA5, 0x5A]  wipe stored records
};

enum : uint8_t {
  TEST_REST_TREMOR     = 1,
  TEST_POSTURAL_TREMOR = 2,
  TEST_PRONSUP         = 3,  // hand turning (pronation-supination)
};

enum : uint8_t {
  TEST_STATE_RUNNING = 1,
  TEST_STATE_DONE    = 2,
  TEST_STATE_ABORTED = 3,
  TEST_STATE_ERROR   = 4,
};

// ---- Flags ----
// LivePacket.flags
enum : uint8_t {
  LIVE_TREMOR       = 1 << 0,  // confirmed tremor (strong + narrow + consistent)
  LIVE_CANDIDATE    = 1 << 1,  // this window alone passes strong + narrow
  LIVE_HIGHFREQ     = 1 << 2,  // strong narrow oscillation at 6.5-12 Hz (not PD rest tremor)
  LIVE_SATURATED    = 1 << 3,  // gyro hit full scale in this window
  LIVE_GAP          = 1 << 4,  // samples were lost in this window (FIFO overflow)
  LIVE_TEST_RUNNING = 1 << 5,
  LIVE_SIM          = 1 << 6,  // data comes from the simulated IMU
  LIVE_ARM_RHYTHM   = 1 << 7,  // strong 4-6 Hz beat, but driven by the arm (lever > gate): not tremor
};

// EpochRecord.flags
enum : uint8_t {
  REC_TIME_VALID = 1 << 0,  // t is unix seconds (else seconds since boot)
  REC_BUTTON     = 1 << 1,  // patient pressed the band's button (medication taken)
  REC_HIGHFREQ   = 1 << 2,
  REC_GAP        = 1 << 3,
  REC_SIM        = 1 << 4,
  REC_TEST       = 1 << 5,  // an active test ran during this epoch
  REC_ALERT      = 1 << 6,  // a wearing-off warning started during this epoch
};

// StatusPacket.flags
enum : uint8_t {
  ST_TIME_SYNCED = 1 << 0,
  ST_IMU_OK      = 1 << 1,
  ST_STORAGE_OK  = 1 << 2,
  ST_SIM         = 1 << 3,
  ST_TEST        = 1 << 4,
  ST_SYNCING     = 1 << 5,
  ST_ALERT       = 1 << 6,  // wearing-off warning active
  ST_ALERT_EARLY = 1 << 7,  // ...because tremor is already back (else: usual wear-off time reached)
};

// Records characteristic markers (5 bytes, distinguished from records by length)
enum : uint8_t {
  MARK_BATCH_END = 0xB0,  // [0xB0, u32 last_seq_sent]  -> app should ACK
  MARK_SYNC_DONE = 0xD0,  // [0xD0, u32 acked_seq]      -> nothing more pending
};

// Raw stream packet (UUID_RAW), sized to the negotiated MTU:
//   u16 first_index   index of the first sample (low 16 bits of a running sample counter)
//   u8  count         samples in this packet (1..RAW_MAX_PER_PACKET)
//   u8  flags         bit0 = gap: the band restarted its analysis window before this packet
//   count x { i16 ax, ay, az, gx, gy, gz }  raw sensor units (ACCEL_LSB_PER_G, GYRO_LSB_PER_DPS)
#define RAW_HEADER_BYTES 4
#define RAW_SAMPLE_BYTES 12
#define RAW_MAX_PER_PACKET 8

#pragma pack(push, 1)

struct LivePacket {          // 20 bytes, one per analysis window (1 s)
  uint32_t win;              // window counter since boot (gap detection)
  uint8_t  severity;         // 0-4
  uint8_t  flags;            // LIVE_*
  uint16_t freq_cHz;         // tremor-band peak frequency x100 (0 if none)
  uint16_t amp_mmx10;        // estimated peak-to-peak hand displacement, 0.1 mm
  uint16_t omega_mrads;      // tremor angular-velocity amplitude, mrad/s
  uint16_t ratio_pm;         // spectral concentration of the peak, per mille
  uint16_t activity_mg;      // overall movement intensity, milli-g RMS
  uint16_t dom_cHz;          // dominant frequency 1-15 Hz x100
  uint8_t  battery_pct;      // 255 = unknown
  uint8_t  reserved;
};

struct EpochRecord {         // 20 bytes, one per 30 s, stored in flash
  uint32_t seq;              // 1, 2, 3 ... never reused within a store_id
  uint32_t t;                // epoch END: unix s if REC_TIME_VALID else uptime s
  uint16_t boot;             // boot counter
  uint8_t  sev_max;          // 0-4
  uint8_t  sev_mean_x50;     // mean severity x50 (0-200)
  uint8_t  tremor_pct;       // % of windows with confirmed tremor
  uint8_t  n_windows;
  uint8_t  freq_dHz;         // mean tremor frequency x10 (0 if no tremor)
  uint8_t  activity_4mg;     // mean activity in 4 mg units
  uint16_t amp_mmx10;        // mean p-p amplitude while tremor, 0.1 mm
  uint8_t  flags;            // REC_*
  uint8_t  amp_max_mm;       // max p-p amplitude in epoch, mm (capped 255)
};

struct SyncMarker {          // 5 bytes
  uint8_t  kind;             // MARK_*
  uint32_t value;
};

struct StatusPacket {        // 20 bytes
  uint8_t  proto;            // PROTO_VERSION
  uint8_t  fw;               // firmware version
  uint8_t  flags;            // ST_*
  uint8_t  battery_pct;      // 255 = unknown
  uint16_t battery_mv;       // 0 = unknown
  uint16_t boot;
  uint32_t store_id;         // random id of this flash store (changes after erase)
  uint32_t next_seq;         // seq the next record will get
  uint32_t acked_seq;        // highest seq acknowledged by the app
};

struct TestProgress {        // TestPacket while running
  uint8_t  type;
  uint8_t  state;            // TEST_STATE_RUNNING
  uint16_t elapsed_ds;       // tenths of a second
  uint16_t total_ds;
};

struct TestTremorResult {    // TestPacket when a rest/postural test is done
  uint8_t  type;
  uint8_t  state;            // TEST_STATE_DONE
  uint8_t  n_windows;
  uint8_t  tremor_pct;
  uint8_t  sev_mean_x50;
  uint8_t  sev_max;
  uint8_t  freq_dHz;
  uint8_t  reserved;
  uint16_t amp_mean_mmx10;
  uint16_t amp_max_mmx10;
  uint16_t omega_mean_mrads;
  uint16_t ratio_mean_pm;
};

struct TestPronSupResult {   // TestPacket when the hand-turning test is done
  uint8_t  type;
  uint8_t  state;            // TEST_STATE_DONE
  uint8_t  movements;        // half-turns (each pronation or supination)
  uint8_t  hesitations;      // pauses > 2x the median movement time
  uint16_t rate_cHz;         // full turn cycles per second x100
  uint16_t excursion_ddeg;   // mean rotation per half-turn, 0.1 deg
  uint16_t speed_dps;        // mean peak angular speed, deg/s
  int8_t   amp_decrement_pct;   // last third vs first third (+ = getting smaller)
  int8_t   speed_decrement_pct;
  uint8_t  rhythm_cv_pct;    // coefficient of variation of half-turn durations
  uint8_t  flags;            // bit0 saturated, bit1 too few movements
  uint16_t duration_ds;
};

#pragma pack(pop)

static_assert(sizeof(LivePacket) == 20, "LivePacket must be 20 bytes");
static_assert(sizeof(EpochRecord) == 20, "EpochRecord must be 20 bytes");
static_assert(sizeof(SyncMarker) == 5, "SyncMarker must be 5 bytes");
static_assert(sizeof(StatusPacket) == 20, "StatusPacket must be 20 bytes");
static_assert(sizeof(TestProgress) == 6, "TestProgress must be 6 bytes");
static_assert(sizeof(TestTremorResult) == 16, "TestTremorResult must be 16 bytes");
static_assert(sizeof(TestPronSupResult) == 16, "TestPronSupResult must be 16 bytes");
