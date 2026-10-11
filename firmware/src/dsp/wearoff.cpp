#include "wearoff.h"

namespace dsp {

void WearOffMonitor::setModel(uint16_t warn_after_min, uint16_t typical_min) {
  warn_after_min_ = warn_after_min;
  typical_min_ = typical_min;
}

void WearOffMonitor::onDose(int64_t t_ms) {
  // Ignore an older dose arriving late (e.g. the app re-sending history).
  if (has_dose_ && t_ms <= dose_ms_) return;
  has_dose_ = true;
  dose_ms_ = t_ms;
  alerted_this_dose_ = false;
  active_ = AlertReason::None;  // taking the medicine answers the alert
}

void WearOffMonitor::onWindow(int64_t now_ms, bool tremor) {
  int64_t minute = now_ms / 60000;
  if (bucket_minute_ == INT64_MIN) bucket_minute_ = minute;
  // advance the ring, clearing minutes with no data
  while (bucket_minute_ < minute) {
    bucket_minute_++;
    head_ = (head_ + 1) % kMinutes;
    seen_[head_] = trem_[head_] = 0;
    if (minute - bucket_minute_ > kMinutes) bucket_minute_ = minute - kMinutes;  // long gap
  }
  seen_[head_]++;
  if (tremor) trem_[head_]++;
}

float WearOffMonitor::recentTremorFraction() const {
  int n = cfg_.early_window_min < kMinutes ? cfg_.early_window_min : kMinutes;
  uint32_t seen = 0, trem = 0;
  for (int i = 0; i < n; i++) {
    int k = (head_ - i + kMinutes) % kMinutes;
    seen += seen_[k];
    trem += trem_[k];
  }
  // need most of the window observed before judging (band worn, sensor working)
  if (seen < (uint32_t)(n * 60 * 0.6f)) return 0;
  return (float)trem / seen;
}

AlertReason WearOffMonitor::tick(int64_t now_ms) {
  if (active_ != AlertReason::None &&
      now_ms - active_since_ms_ >= (int64_t)cfg_.alert_duration_min * 60000)
    active_ = AlertReason::None;
  if (!has_dose_ || alerted_this_dose_) return AlertReason::None;

  int64_t since_min = (now_ms - dose_ms_) / 60000;
  AlertReason start = AlertReason::None;
  if (since_min >= cfg_.early_min_after_dose && recentTremorFraction() >= cfg_.early_fraction)
    start = AlertReason::Early;  // tremor is already back
  else if (warn_after_min_ > 0 && since_min >= warn_after_min_ && since_min < lateLimitMin())
    start = AlertReason::Time;   // about to wear off, going by this patient's history

  if (start != AlertReason::None) {
    alerted_this_dose_ = true;
    active_ = start;
    active_since_ms_ = now_ms;
  }
  return start;
}

}  // namespace dsp
