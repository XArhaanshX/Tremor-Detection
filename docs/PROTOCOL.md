# BLE Protocol

Source of truth: [`firmware/include/protocol.h`](../firmware/include/protocol.h).
Mirror: [`dashboard/js/protocol.js`](../dashboard/js/protocol.js).
`node tools/check_protocol.mjs` compiles the C structs and checks the JS decoder byte-for-byte.

All packets are **≤ 20 bytes** (fits the default ATT MTU of 23 on every phone/browser) and **little-endian**.

## GATT

Service `d2e60001-ed8b-45e3-b151-051e61e017ff`, advertised as `TremorBand-XXXX`.

| Characteristic | UUID suffix | Props | Payload |
|---|---|---|---|
| Live | `…0002` | notify | `LivePacket` (20 B), once per second |
| Records | `…0003` | notify | `EpochRecord` (20 B) or `SyncMarker` (5 B) |
| Control | `…0004` | write | commands below |
| Status | `…0005` | read, notify | `StatusPacket` (20 B), every 5 s + on change |
| Test | `…0006` | notify | progress (6 B) / result (16 B) / aborted (2 B) |

## Commands (Control)

| Byte 0 | Name | Args |
|---|---|---|
| `0x01` | SET_TIME | u32 unix seconds |
| `0x02` | SYNC | — start streaming un-ACKed records |
| `0x03` | ACK | u32 seq: app has stored every record ≤ seq |
| `0x10` | TEST_START | u8 type (1 rest, 2 postural, 3 hand turning), u16 seconds |
| `0x11` | TEST_ABORT | — |
| `0x20` | SET_LEVER | u16 mm (30–300), saved in NVS |
| `0x21` | DOSE | u32 unix seconds — a dose logged in the app (the band button logs its own) |
| `0x22` | SET_WEAROFF | u16 warn_after_min, u16 typical_min — learned in the app; 0 = unknown; saved in NVS |
| `0x23` | ALERT_DISMISS | — patient acknowledged the wearing-off warning |
| `0x7F` | ERASE | `0xA5 0x5A` |

## Sync sequence

```
app                                   band
 |-- SET_TIME(now) ------------------->|  remembers unix-uptime offset for this boot
 |-- SET_LEVER(mm) ------------------->|
 |-- read Status ---------------------->|  store_id, next_seq, acked_seq
 |-- SYNC ----------------------------->|
 |<------------- record seq=acked+1 ----|
 |<------------- ... (≤ 32 records) ----|  6 ms apart
 |<------------- BATCH_END(last) -------|
 |   (save to IndexedDB, then)          |
 |-- ACK(highest contiguous seq) ------>|  deletes fully-ACKed segments, sends next batch
 |            ...                       |
 |<------------- SYNC_DONE(acked) ------|  nothing pending
 |<------------- record (every 30 s) ---|  new epochs keep flowing while connected
```

- No ACK within 5 s → the band resends from `acked+1`. The app de-duplicates by `[store_id, seq]`.
- A gap in a batch (lost notification) → the app ACKs only up to the gap → resent.
- `store_id` changes after ERASE (or a fresh flash) so old and new sequence numbers never collide.
- Records are stored with *uptime*; the band converts to unix time at send if it knows that boot's offset (`REC_TIME_VALID`).

## Wearing-off warning (protocol v2)

- On connect, and whenever the app's model or the latest dose changes, the app sends
  `SET_WEAROFF` (timing for the latest dose's time of day) and `DOSE` (the latest dose).
- The band keeps the last dose (button press or `DOSE`, newest wins) and raises an alert:
  *time* (`warn_after_min` reached, up to 30 min past the usual wear-off) or *early*
  (tremor confirmed in ≥ 50 % of the last 10 min, ≥ 45 min after the dose).
- Alert state is in `StatusPacket.flags`: `ST_ALERT` (bit 6), `ST_ALERT_EARLY` (bit 7).
  The epoch in which an alert starts carries `REC_ALERT` (bit 6).
- An alert ends after 30 min, on `ALERT_DISMISS`, or on a new dose.

Packet field layouts are documented inline in `protocol.h`.
