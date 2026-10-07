// Offline record queue on LittleFS ("nothing is lost when Bluetooth drops").
//
// Records get increasing sequence numbers and are appended to segment files
// /q/<first-seq-hex>.bin (256 records each). The app ACKs the highest seq it has
// saved; fully-acked segments are deleted. LittleFS appends are cheap and
// power-loss safe; random writes are not, so nothing is ever rewritten in place.
#pragma once
#include <stdint.h>

#include <vector>

#include "protocol.h"

class RecordStore {
 public:
  bool begin(uint16_t boot);
  bool ok() const { return ok_; }

  bool append(EpochRecord& rec);  // assigns rec.seq
  // Reads up to max consecutive records starting at the first seq >= from.
  int read(uint32_t from, EpochRecord* out, int max);
  void ack(uint32_t seq);
  void eraseAll();

  uint32_t nextSeq() const { return next_seq_; }
  uint32_t ackedSeq() const { return acked_; }
  uint32_t storeId() const { return store_id_; }
  uint32_t pending() const { return next_seq_ - 1 - acked_; }

  // The ESP32 has no battery-backed clock: records carry boot number + uptime.
  // When the app sets the time we remember unix-uptime offset for that boot.
  void setTimeOffset(uint32_t offset);
  bool toUnix(uint16_t boot, uint32_t uptime_s, uint32_t* unix_s) const;

 private:
  struct Meta {
    uint32_t magic;
    uint32_t store_id;
    uint32_t acked;
  };
  struct BootTime {
    uint16_t boot;
    uint32_t offset;
  } __attribute__((packed));

  void saveMeta();
  void loadBoots();
  void saveBoots();
  void dropOldestSegment();

  bool ok_ = false;
  uint16_t boot_ = 0;
  uint32_t store_id_ = 0;
  uint32_t acked_ = 0;
  uint32_t next_seq_ = 1;
  uint32_t last_count_ = 0;          // records in the newest segment
  std::vector<uint32_t> segments_;   // first seq of each segment, ascending
  std::vector<BootTime> boots_;
};
