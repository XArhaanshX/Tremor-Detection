#include "storage.h"

#include <Arduino.h>
#include <LittleFS.h>

#include <algorithm>

#include "config.h"

namespace {
constexpr uint32_t kMagic = 0x54524D31;  // "TRM1"
constexpr const char* kDir = "/q";
constexpr const char* kMetaPath = "/meta.bin";
constexpr const char* kBootsPath = "/boots.bin";
constexpr size_t kMaxBoots = 32;
constexpr size_t kRec = sizeof(EpochRecord);

String segPath(uint32_t first) {
  char buf[24];
  snprintf(buf, sizeof buf, "%s/%08lx.bin", kDir, (unsigned long)first);
  return String(buf);
}
}  // namespace

bool RecordStore::begin(uint16_t boot) {
  boot_ = boot;
  if (!LittleFS.begin(true)) {  // formats the partition on first use
    Serial.println("[store] LittleFS mount failed");
    return false;
  }
  if (!LittleFS.exists(kDir)) LittleFS.mkdir(kDir);

  Meta m{};
  File f = LittleFS.exists(kMetaPath) ? LittleFS.open(kMetaPath, "r") : File();
  if (f && f.read((uint8_t*)&m, sizeof m) == sizeof m && m.magic == kMagic) {
    store_id_ = m.store_id;
    acked_ = m.acked;
  } else {
    store_id_ = esp_random();
    acked_ = 0;
  }
  if (f) f.close();

  segments_.clear();
  File dir = LittleFS.open(kDir);
  for (File e = dir.openNextFile(); e; e = dir.openNextFile()) {
    String name = e.name();
    int slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.substring(slash + 1);
    if (name.endsWith(".bin")) segments_.push_back(strtoul(name.c_str(), nullptr, 16));
    e.close();
  }
  std::sort(segments_.begin(), segments_.end());

  next_seq_ = acked_ + 1;
  last_count_ = 0;
  if (!segments_.empty()) {
    File last = LittleFS.open(segPath(segments_.back()), "r");
    last_count_ = last ? last.size() / kRec : 0;
    if (last) last.close();
    next_seq_ = std::max(next_seq_, segments_.back() + last_count_);
  }
  saveMeta();
  loadBoots();
  ok_ = true;
  Serial.printf("[store] id=%08lx segments=%u next=%lu acked=%lu\n", (unsigned long)store_id_,
                (unsigned)segments_.size(), (unsigned long)next_seq_, (unsigned long)acked_);
  return true;
}

void RecordStore::saveMeta() {
  Meta m{kMagic, store_id_, acked_};
  File f = LittleFS.open(kMetaPath, "w");
  if (f) {
    f.write((const uint8_t*)&m, sizeof m);
    f.close();
  }
}

bool RecordStore::append(EpochRecord& rec) {
  if (!ok_) return false;
  if (segments_.empty() || last_count_ >= QUEUE_SEG_RECORDS) {
    segments_.push_back(next_seq_);
    last_count_ = 0;
    while (segments_.size() > QUEUE_MAX_SEGS) dropOldestSegment();
  }
  rec.seq = next_seq_;
  File f = LittleFS.open(segPath(segments_.back()), "a");
  if (!f) return false;
  bool okw = f.write((const uint8_t*)&rec, kRec) == kRec;
  f.close();
  if (!okw) return false;
  next_seq_++;
  last_count_++;
  return true;
}

void RecordStore::dropOldestSegment() {
  // Out of space after ~11 days offline: oldest data goes first.
  uint32_t first = segments_.front();
  LittleFS.remove(segPath(first));
  segments_.erase(segments_.begin());
  uint32_t end = segments_.empty() ? next_seq_ - 1 : segments_.front() - 1;
  if (acked_ < end) {
    acked_ = end;
    saveMeta();
  }
  Serial.printf("[store] queue full, dropped segment %lu\n", (unsigned long)first);
}

int RecordStore::read(uint32_t from, EpochRecord* out, int max) {
  if (!ok_ || segments_.empty() || from >= next_seq_) return 0;
  if (from < segments_.front()) from = segments_.front();
  // segment containing `from`
  size_t i = std::upper_bound(segments_.begin(), segments_.end(), from) - segments_.begin() - 1;
  uint32_t first = segments_[i];
  uint32_t seg_end = (i + 1 < segments_.size()) ? segments_[i + 1] : next_seq_;
  int n = std::min<uint32_t>(max, seg_end - from);
  File f = LittleFS.open(segPath(first), "r");
  if (!f) return 0;
  f.seek((from - first) * kRec);
  int got = f.read((uint8_t*)out, n * kRec) / kRec;
  f.close();
  return got;
}

void RecordStore::ack(uint32_t seq) {
  if (seq >= next_seq_) seq = next_seq_ - 1;
  if (seq <= acked_) return;
  acked_ = seq;
  saveMeta();
  // delete segments whose every record is acked (never the one still being filled)
  while (segments_.size() > 1 && segments_[1] - 1 <= acked_) {
    LittleFS.remove(segPath(segments_.front()));
    segments_.erase(segments_.begin());
  }
  if (segments_.size() == 1 && last_count_ >= QUEUE_SEG_RECORDS && next_seq_ - 1 <= acked_) {
    LittleFS.remove(segPath(segments_.front()));
    segments_.clear();
  }
}

void RecordStore::eraseAll() {
  for (uint32_t s : segments_) LittleFS.remove(segPath(s));
  segments_.clear();
  last_count_ = 0;
  store_id_ = esp_random();
  acked_ = 0;
  next_seq_ = 1;
  saveMeta();
  Serial.printf("[store] erased, new id=%08lx\n", (unsigned long)store_id_);
}

void RecordStore::loadBoots() {
  boots_.clear();
  if (!LittleFS.exists(kBootsPath)) return;  // clock never set yet
  File f = LittleFS.open(kBootsPath, "r");
  if (!f) return;
  BootTime b;
  while (f.read((uint8_t*)&b, sizeof b) == sizeof b) boots_.push_back(b);
  f.close();
}

void RecordStore::saveBoots() {
  while (boots_.size() > kMaxBoots) boots_.erase(boots_.begin());
  File f = LittleFS.open(kBootsPath, "w");
  if (!f) return;
  for (auto& b : boots_) f.write((const uint8_t*)&b, sizeof b);
  f.close();
}

void RecordStore::setTimeOffset(uint32_t offset) {
  for (auto& b : boots_)
    if (b.boot == boot_) {
      int32_t diff = (int32_t)(offset - b.offset);
      if (diff > -3 && diff < 3) return;  // unchanged, spare the flash
      b.offset = offset;
      saveBoots();
      return;
    }
  boots_.push_back({boot_, offset});
  saveBoots();
}

bool RecordStore::toUnix(uint16_t boot, uint32_t uptime_s, uint32_t* unix_s) const {
  for (auto& b : boots_)
    if (b.boot == boot) {
      *unix_s = b.offset + uptime_s;
      return true;
    }
  return false;
}
