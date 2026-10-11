// Wearing-off warning, run on the band so it works even when no phone is nearby.
//
// The app learns, from weeks of doses and tremor records, how long a dose usually
// lasts for this patient (Kaplan-Meier over past doses, see dashboard/js/wearoff.js)
// and sends two numbers: warn_after_min (warn this long after a dose) and
// typical_min (the usual time until tremor returns). The band then:
//   * TIME alert : warns warn_after_min after the last dose (before tremor returns);
//   * EARLY alert: warns as soon as tremor is clearly back after the dose had taken
//                  effect, even if that is sooner than usual (works with no model too).
// Portable C++ (no Arduino): host-tested in firmware/test/host.
#pragma once
#include <stdint.h>

namespace dsp {

enum class AlertReason : uint8_t { None = 0, Time = 1, Early = 2 };

struct WearOffConfig {
  int early_min_after_dose = 45;   // dose must have had time to work first
  int early_window_min = 10;       // look at the last 10 minutes...
  float early_fraction = 0.5f;     // ...and alert if tremor was confirmed in >= half of it
  int alert_duration_min = 30;     // an alert stays active this long unless dismissed
};

class WearOffMonitor {
 public:
  explicit WearOffMonitor(const WearOffConfig& cfg = WearOffConfig()) : cfg_(cfg) {}

  // Learned timing from the app; 0 = not known yet (time alert disabled).
  void setModel(uint16_t warn_after_min, uint16_t typical_min);
  // A dose was taken at t_ms (band clock, may be negative = before boot).
  void onDose(int64_t t_ms);
  // One analysis window (1 s) finished at now_ms; tremor = confirmed tremor.
  void onWindow(int64_t now_ms, bool tremor);
  // Call regularly. Returns the reason if an alert STARTED on this call.
  AlertReason tick(int64_t now_ms);
  void dismiss() { active_ = AlertReason::None; }

  AlertReason active() const { return active_; }
  bool hasDose() const { return has_dose_; }
  int64_t lastDoseMs() const { return dose_ms_; }
  uint16_t warnAfterMin() const { return warn_after_min_; }
  uint16_t typicalMin() const { return typical_min_; }
  float recentTremorFraction() const;
  // A time-based warning is only useful until shortly after the usual wear-off time
  // (e.g. the band hears about a dose late, when the phone reconnects hours after).
  int lateLimitMin() const {
    int t = typical_min_ > warn_after_min_ ? typical_min_ : warn_after_min_;
    return t + 30 < 6 * 60 ? t + 30 : 6 * 60;
  }

 private:
  static constexpr int kMinutes = 30;  // ring of per-minute tremor counts
  WearOffConfig cfg_;
  uint16_t warn_after_min_ = 0, typical_min_ = 0;
  bool has_dose_ = false;
  int64_t dose_ms_ = 0;
  bool alerted_this_dose_ = false;
  AlertReason active_ = AlertReason::None;
  int64_t active_since_ms_ = 0;
  // per-minute buckets: windows seen and windows with tremor
  int64_t bucket_minute_ = INT64_MIN;
  uint16_t seen_[kMinutes] = {0}, trem_[kMinutes] = {0};
  int head_ = 0;
};

}  // namespace dsp
