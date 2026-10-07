// In-place iterative radix-2 complex FFT (single precision).
// Portable C++: runs on the ESP32 FPU and on a PC for unit tests.
#pragma once

namespace dsp {

class FFT {
 public:
  // n must be a power of two and <= kMaxN.
  explicit FFT(int n);
  int size() const { return n_; }
  // re/im: length n, transformed in place (forward transform, no scaling).
  void forward(float* re, float* im) const;

  static constexpr int kMaxN = 1024;

 private:
  int n_;
  int log2n_;
  float cos_[kMaxN / 2];
  float sin_[kMaxN / 2];
};

}  // namespace dsp
