#include "fft.h"

#include <math.h>

namespace dsp {

FFT::FFT(int n) : n_(n), log2n_(0) {
  while ((1 << log2n_) < n_) log2n_++;
  for (int k = 0; k < n_ / 2; k++) {
    double a = -2.0 * M_PI * k / n_;
    cos_[k] = (float)cos(a);
    sin_[k] = (float)sin(a);
  }
}

void FFT::forward(float* re, float* im) const {
  // bit-reversal permutation
  for (int i = 1, j = 0; i < n_; i++) {
    int bit = n_ >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // butterflies
  for (int len = 2; len <= n_; len <<= 1) {
    int half = len >> 1;
    int step = n_ / len;
    for (int i = 0; i < n_; i += len) {
      for (int k = 0; k < half; k++) {
        float wr = cos_[k * step], wi = sin_[k * step];
        int a = i + k, b = a + half;
        float xr = re[b] * wr - im[b] * wi;
        float xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
      }
    }
  }
}

}  // namespace dsp
