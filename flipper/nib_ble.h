#pragma once
// BLE peripheral side of the N.I.B. bridge.
//
// Goal: advertise the fixed N.I.B. GATT service so the phone's Web Bluetooth
// app can discover the Flipper by service UUID, then receive opcode packets the
// phone writes to the RX characteristic and hand them to nib_hid.
//
//   service  6e7d0001-b3f2-4c11-9a5d-0f1a2b3c4d5e
//   rx       6e7d0002-b3f2-4c11-9a5d-0f1a2b3c4d5e   phone writes here (WRITE)
//   status   6e7d0003-b3f2-4c11-9a5d-0f1a2b3c4d5e   NOTIFY
//
// FEASIBILITY (confirmed from the firmware app API, see README.md):
//   - A custom 128-bit GATT service from an EXTERNAL FAP is supported. The
//     needed symbols are all exported (status "+") in targets/f7/api_symbols.csv:
//       ble_gatt_service_add, ble_gatt_characteristic_init/update/delete,
//       furi_hal_bt_start_app, furi_hal_bt_change_app,
//       headers furi_ble/gatt.h and furi_ble/profile_interface.h.
//   - The firmware's own Serial profile (lib/ble_profile, exported, status "+")
//     is exactly this shape - a custom 128-bit service with a write RX and a
//     notify TX. COPY IT as the reference implementation. That profile is how
//     the Flipper mobile app already discovers a Flipper by a custom UUID, which
//     is the same discovery path Web Bluetooth uses.
//
// The only real unknowns to prototype on hardware (see README.md "Risks"):
//   1. Advertising the 128-bit service UUID in the ADV/scan-response payload so
//      navigator.bluetooth.requestDevice({filters:[{services:[UUID]}]}) matches.
//   2. Running BLE peripheral + USB HID concurrently.

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

typedef void (*NibRxCallback)(const uint8_t* data, size_t len, void* context);

// Start advertising the N.I.B. service. rx_cb is called for every packet the
// phone writes to the RX characteristic. Returns false if the stack refused.
// pin: require PIN pairing (code shown on the Flipper) and bond the phone.
bool nib_ble_start(NibRxCallback rx_cb, void* context, bool pin, const char* name);

// Turn discoverability (advertising) on or off while the profile stays up.
void nib_ble_set_discoverable(bool on);

// Drop the current central connection, if any.
void nib_ble_disconnect(void);

// Stop advertising and tear the profile down.
void nib_ble_stop(void);

// Publish the status JSON: stored for reads, and notified if subscribed.
bool nib_ble_set_status(const char* json);

// True while a central (the phone) is connected.
bool nib_ble_is_connected(void);

// Wipe bonded devices (protocol OP_FORGET / holding the button on the ESP32).
void nib_ble_forget_bonds(void);
