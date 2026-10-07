// BLE GATT server (NimBLE). Callbacks run on the NimBLE host task, so incoming
// commands are queued and handled by the main loop -- no shared-state races.
#pragma once
#include <stdint.h>
#include <stddef.h>

#include "protocol.h"

struct Command {
  uint8_t len;
  uint8_t data[19];
};

namespace ble {

void begin(const char* name);
bool connected();
bool popCommand(Command* cmd);

void sendLive(const LivePacket& p);
void sendStatus(const StatusPacket& p);  // also updates the readable value
void sendTest(const void* data, size_t len);
void sendRecord(const EpochRecord& r);
void sendMarker(uint8_t kind, uint32_t value);

}  // namespace ble
