#pragma once
// USB HID output side of the N.I.B. bridge.
//
// The Flipper is a real USB HID keyboard+mouse to the host it is plugged into,
// exactly as its BadUSB app is. We reuse the SAME exported firmware API BadUSB
// uses:
//
//   Variable  usb_hid                 FuriHalUsbInterface   (status +, exported)
//   Function  furi_hal_hid_kb_press   (uint16_t)            (status +)
//   Function  furi_hal_hid_kb_release (uint16_t)            (status +)
//   Function  furi_hal_hid_kb_release_all ()                (status +)
//   Function  furi_hal_hid_mouse_move / _press / _release / _scroll (status +)
//
// The uint16_t key passed to furi_hal_hid_kb_press is (HID_KEYBOARD_* usage in
// the low byte) OR-ed with modifier flags in the high byte (KEY_MOD_LEFT_CTRL
// etc., from furi_hal_usb_hid.h). Our wire protocol already hands us a raw
// usage-page-0x07 usage + a modifier bitmask, so the mapping is nearly 1:1.
//
// VERIFIED (API 88.2, flipperdevices dev): every symbol above is exported
// (status "+") in targets/f7/api_symbols.csv, furi_hal_usb_set_config takes a
// FuriHalUsbInterface* (cast the saved handle on restore), and the stock usb_hid
// descriptor carries keyboard(id1)+mouse(id2)+consumer(id3). The modifier bit
// order matches protocol.h byte-for-byte, so mods map with a plain <<8.

#include <stdint.h>
#include <stdbool.h>

// Claim the USB port as an HID device (call once at app start). Returns the
// previous USB config so it can be restored on exit.
void* nib_hid_begin(void);

// Restore the USB port to whatever it was (VCP/CLI) on app exit.
void nib_hid_end(void* previous_usb_config);

// Wire opcode handlers. mods is the protocol modifier bitmask (see protocol.h),
// usage is a raw HID usage-page-0x07 id.
void nib_hid_tap(uint8_t mods, uint8_t usage);   // press then release
void nib_hid_key_down(uint8_t mods, uint8_t usage);
void nib_hid_key_up(uint8_t mods, uint8_t usage);
void nib_hid_release_all(void);

void nib_hid_move(int8_t dx, int8_t dy, int8_t wheel);
void nib_hid_button(uint8_t button, uint8_t action); // 1=L 2=R 4=M; 0=up 1=down 2=click
void nib_hid_consumer(uint16_t usage); // one press of a consumer-control key (media)

// True when the USB HID device has enumerated on a host (a computer is attached).
bool nib_hid_is_connected(void);
