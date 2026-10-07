// Emits test vectors (hex of the firmware's packed structs) for check_protocol.mjs.
#include <stdio.h>
#include <string.h>

#include "../firmware/include/protocol.h"

template <typename T>
static void emit(const char* kind, const T& s, const char* expect) {
  const unsigned char* b = (const unsigned char*)&s;
  printf("{\"kind\":\"%s\",\"hex\":\"", kind);
  for (size_t i = 0; i < sizeof s; i++) printf("%02x", b[i]);
  printf("\",\"expect\":%s}\n", expect);
}

int main() {
  LivePacket l{123456, 3, LIVE_TREMOR | LIVE_CANDIDATE | LIVE_SIM, 512, 4567, 8901, 731, 1234, 489, 77, 0};
  emit("live", l, "{\"win\":123456,\"severity\":3,\"tremor\":true,\"candidate\":true,\"sim\":true,\"highFreq\":false,"
                  "\"freqHz\":5.12,\"ampCm\":45.67,\"omega\":8.901,\"ratio\":0.731,\"activityMg\":1234,\"domHz\":4.89,\"battery\":77}");
  EpochRecord r{4242, 1760000000u, 17, 4, 125, 66, 30, 49, 200, 2345, REC_TIME_VALID | REC_BUTTON, 120};
  emit("record", r, "{\"kind\":\"record\",\"seq\":4242,\"t\":1760000000,\"timeValid\":true,\"boot\":17,\"sevMax\":4,"
                    "\"sevMean\":2.5,\"tremorPct\":66,\"nWindows\":30,\"freqHz\":4.9,\"activityMg\":800,\"ampCm\":23.45,\"ampMaxCm\":12}");
  SyncMarker m{MARK_BATCH_END, 99999};
  emit("record", m, "{\"kind\":\"marker\",\"marker\":176,\"value\":99999}");
  StatusPacket s{PROTO_VERSION, 1, ST_TIME_SYNCED | ST_IMU_OK | ST_STORAGE_OK, 255, 0, 9, 0xDEADBEEF, 501, 480};
  emit("status", s, "{\"proto\":1,\"fw\":1,\"timeSynced\":true,\"imuOk\":true,\"storageOk\":true,\"sim\":false,"
                    "\"battery\":null,\"batteryMv\":null,\"boot\":9,\"storeId\":3735928559,\"nextSeq\":501,\"ackedSeq\":480,\"pending\":20}");
  TestTremorResult t{TEST_REST_TREMOR, TEST_STATE_DONE, 28, 93, 110, 3, 51, 0, 1520, 2210, 3456, 812};
  emit("test", t, "{\"type\":1,\"state\":2,\"nWindows\":28,\"tremorPct\":93,\"sevMean\":2.2,\"sevMax\":3,\"freqHz\":5.1,"
                  "\"ampMeanCm\":15.2,\"ampMaxCm\":22.1,\"omegaMean\":3.456,\"ratioMean\":0.812}");
  TestPronSupResult p{TEST_PRONSUP, TEST_STATE_DONE, 24, 1, 152, 1234, 456, 25, -7, 9, 1, 100};
  emit("test", p, "{\"type\":3,\"state\":2,\"movements\":24,\"hesitations\":1,\"rateHz\":1.52,\"excursionDeg\":123.4,"
                  "\"speedDps\":456,\"ampDecrementPct\":25,\"speedDecrementPct\":-7,\"rhythmCvPct\":9,\"saturated\":true,\"tooFew\":false,\"durationS\":10}");
  TestProgress g{TEST_PRONSUP, TEST_STATE_RUNNING, 45, 100};
  emit("test", g, "{\"type\":3,\"state\":1,\"elapsedS\":4.5,\"totalS\":10}");
  return 0;
}
