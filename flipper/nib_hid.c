#include "nib_hid.h"

#include <furi_hal_usb.h>
#include <furi_hal_usb_hid.h>

// Our protocol's modifier bitmask (protocol.h) uses the SAME bit order as the
// USB HID modifier byte: bit0 LCtrl .. bit7 RGui. furi_hal_hid_kb_press wants
// the modifier flags in the HIGH byte of its uint16_t, so we just shift.
static inline uint16_t nib_key(uint8_t mods, uint8_t usage) {
    return ((uint16_t)mods << 8) | usage;
}

void* nib_hid_begin(void) {
    // Save whatever USB config is active (normally the CDC/serial console) so we
    // can restore it on exit, then claim the port as HID. Same call BadUSB uses.
    FuriHalUsbInterface* prev = furi_hal_usb_get_config();
    furi_hal_usb_unlock();
    furi_hal_usb_set_config(&usb_hid, NULL);
    return prev;
}

void nib_hid_end(void* previous_usb_config) {
    nib_hid_release_all();
    furi_hal_usb_unlock();
    furi_hal_usb_set_config((FuriHalUsbInterface*)previous_usb_config, NULL);
}

void nib_hid_tap(uint8_t mods, uint8_t usage) {
    uint16_t k = nib_key(mods, usage);
    furi_hal_hid_kb_press(k);
    furi_hal_hid_kb_release(k);
}

void nib_hid_key_down(uint8_t mods, uint8_t usage) {
    furi_hal_hid_kb_press(nib_key(mods, usage));
}

void nib_hid_key_up(uint8_t mods, uint8_t usage) {
    furi_hal_hid_kb_release(nib_key(mods, usage));
}

void nib_hid_release_all(void) {
    furi_hal_hid_kb_release_all();
    furi_hal_hid_mouse_release(HID_MOUSE_BTN_LEFT);
    furi_hal_hid_mouse_release(HID_MOUSE_BTN_RIGHT);
    furi_hal_hid_mouse_release(HID_MOUSE_BTN_WHEEL);
    furi_hal_hid_consumer_key_release_all();
}

void nib_hid_move(int8_t dx, int8_t dy, int8_t wheel) {
    if(dx || dy) furi_hal_hid_mouse_move(dx, dy);
    if(wheel) furi_hal_hid_mouse_scroll(wheel);
}

void nib_hid_button(uint8_t button, uint8_t action) {
    // protocol button 1=L 2=R 4=M already matches HID_MOUSE_BTN_* masks.
    switch(action) {
    case 0: // up
        furi_hal_hid_mouse_release(button);
        break;
    case 1: // down
        furi_hal_hid_mouse_press(button);
        break;
    case 2: // click
    default:
        furi_hal_hid_mouse_press(button);
        furi_hal_hid_mouse_release(button);
        break;
    }
}

void nib_hid_consumer(uint16_t usage) {
    // The stock descriptor carries consumer control as report id 3.
    furi_hal_hid_consumer_key_press(usage);
    furi_hal_hid_consumer_key_release(usage);
}

bool nib_hid_is_connected(void) {
    return furi_hal_hid_is_connected();
}
