# Tremor Detection Wristband

An ESP32 + IMU wristband that watches a Parkinson's patient's hand **all day**, detects
rest tremor **on the band itself** with an FFT (no cloud), turns it into a 0–4 severity
score, and streams it live over Bluetooth to an offline web dashboard. If Bluetooth
drops, the band keeps the data in flash and syncs it later. The dashboard also runs
short active tests (finger tapping, hand turning, rest/postural tremor) so passive
monitoring and active testing live in one platform.

- [Software architecture & plan](docs/ARCHITECTURE.md)
- [Hardware build guide](docs/HARDWARE.md)

> Research/education prototype — not a medical device.
