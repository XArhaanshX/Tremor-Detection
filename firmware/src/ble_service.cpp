#include "ble_service.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <freertos/queue.h>

namespace ble {
namespace {

NimBLECharacteristic* g_live = nullptr;
NimBLECharacteristic* g_records = nullptr;
NimBLECharacteristic* g_status = nullptr;
NimBLECharacteristic* g_test = nullptr;
QueueHandle_t g_cmds = nullptr;
volatile bool g_connected = false;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*) override {
    g_connected = true;
    Serial.println("[ble] connected");
  }
  void onDisconnect(NimBLEServer*) override {
    g_connected = false;
    Serial.println("[ble] disconnected (advertising again)");
    Command c{1, {0xFF}};  // internal: tell the main loop the link dropped
    xQueueSend(g_cmds, &c, 0);
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* chr) override {
    auto v = chr->getValue();
    Command c{};
    c.len = v.length() > sizeof c.data ? sizeof c.data : v.length();
    memcpy(c.data, reinterpret_cast<const uint8_t*>(v.data()), c.len);
    if (c.len) xQueueSend(g_cmds, &c, 0);
  }
};

void notify(NimBLECharacteristic* chr, const void* data, size_t len) {
  if (!g_connected || !chr) return;
  chr->setValue(reinterpret_cast<const uint8_t*>(data), len);
  chr->notify();
}

}  // namespace

void begin(const char* name) {
  g_cmds = xQueueCreate(16, sizeof(Command));
  NimBLEDevice::init(name);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(UUID_SERVICE);
  g_live = svc->createCharacteristic(UUID_LIVE, NIMBLE_PROPERTY::NOTIFY);
  g_records = svc->createCharacteristic(UUID_RECORDS, NIMBLE_PROPERTY::NOTIFY);
  g_status = svc->createCharacteristic(UUID_STATUS, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  g_test = svc->createCharacteristic(UUID_TEST, NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic* control =
      svc->createCharacteristic(UUID_CONTROL, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  control->setCallbacks(new ControlCallbacks());
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(UUID_SERVICE);  // lets the browser filter for our band
  adv->setScanResponse(true);         // device name goes in the scan response
  adv->start();
  Serial.printf("[ble] advertising as %s\n", name);
}

bool connected() { return g_connected; }

bool popCommand(Command* cmd) { return g_cmds && xQueueReceive(g_cmds, cmd, 0) == pdTRUE; }

void sendLive(const LivePacket& p) { notify(g_live, &p, sizeof p); }

void sendStatus(const StatusPacket& p) {
  if (!g_status) return;
  g_status->setValue(reinterpret_cast<const uint8_t*>(&p), sizeof p);
  if (g_connected) g_status->notify();
}

void sendTest(const void* data, size_t len) { notify(g_test, data, len); }

void sendRecord(const EpochRecord& r) { notify(g_records, &r, sizeof r); }

void sendMarker(uint8_t kind, uint32_t value) {
  SyncMarker m{kind, value};
  notify(g_records, &m, sizeof m);
}

}  // namespace ble
