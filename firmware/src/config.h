#pragma once

// Everything here can be overridden from platformio.ini with -D, so a board
// with different wiring, or no screen at all, needs no edits to this file.

// ---- BLE identity -----------------------------------------------------------
// Custom 128-bit UUIDs. Web Bluetooth can only see a device by a service UUID
// it asks for, so these must match web/ble.js exactly.
#define NIB_SERVICE_UUID  "6e7d0001-b3f2-4c11-9a5d-0f1a2b3c4d5e"
#define NIB_RX_UUID       "6e7d0002-b3f2-4c11-9a5d-0f1a2b3c4d5e"  // phone -> dongle
#define NIB_STATUS_UUID   "6e7d0003-b3f2-4c11-9a5d-0f1a2b3c4d5e"  // dongle -> phone

#ifndef NIB_DEVICE_NAME
#define NIB_DEVICE_NAME   "N.I.B."
#endif

// ---- Security ---------------------------------------------------------------
// 1 = the phone must bond with a passkey before it can write anything.
// 0 = anything nearby can type into your Mac. Bench testing only.
#ifndef NIB_REQUIRE_PAIRING
#define NIB_REQUIRE_PAIRING  1
#endif

// First-boot passkey. After that the phone owns it, stored in NVS.
// On a board with no screen this is the only way in, so change it.
#ifndef NIB_PASSKEY
#define NIB_PASSKEY          424242
#endif

// ---- Setting defaults ---------------------------------------------------------
// What a fresh or factory-reset dongle starts with. Each is also a setting in
// the app; a flag only changes the starting point.
#ifndef NIB_DEFAULT_SHOW_PASSKEY
#define NIB_DEFAULT_SHOW_PASSKEY  1   // keep the passkey on the idle screen
#endif
#ifndef NIB_DEFAULT_PASSKEY_MODE
#define NIB_DEFAULT_PASSKEY_MODE  0   // 0 fixed, 1 new each boot, 2 new on unpair
#endif
#ifndef NIB_DEFAULT_USB_MODE
#define NIB_DEFAULT_USB_MODE      0   // 0 console, 1 console no reflash, 2 none
#endif
#ifndef NIB_DEFAULT_HID_IDENTITY
#define NIB_DEFAULT_HID_IDENTITY  0   // 0 device name, 1 "USB Keyboard"
#endif
#ifndef NIB_DEFAULT_PAIR_MODE
#define NIB_DEFAULT_PAIR_MODE     0   // 0 any time, 1 pairing window only
#endif
#ifndef NIB_DEFAULT_SAVER_ON
#define NIB_DEFAULT_SAVER_ON      1
#endif
#ifndef NIB_DEFAULT_SAVER
#define NIB_DEFAULT_SAVER         0   // catalogue index, 255 = shuffle
#endif
#ifndef NIB_DEFAULT_SAVER_IDLE
#define NIB_DEFAULT_SAVER_IDLE    60  // seconds, 0 = never
#endif

// ---- Host lockout -----------------------------------------------------------
// The computer the dongle is plugged into can normally put it into the ROM
// bootloader on its own: opening the USB serial port at 1200 baud asks the
// firmware to jump there, no button needed. That is how this project's own
// upload script works, and it is equally available to anything else running on
// that machine.
//
// The USB setting in the app controls this (settings.h, UsbMode), and a build
// can pin it with -DNIB_USB_MODE_FORCED=2 so the app cannot change it. Without a
// button it stays on, because it is then the only way to reflash.

// ---- Gamepad -----------------------------------------------------------------
// A USB gamepad interface next to the keyboard and mouse, for the app's
// joystick layout. 0 leaves it out of the USB descriptor entirely.
#ifndef NIB_GAMEPAD
#define NIB_GAMEPAD 1
#endif

// ---- Typing ----------------------------------------------------------------
#define NIB_KEY_PRESS_MS   8   // how long a key is held down
#define NIB_KEY_GAP_MS     8   // gap between consecutive keys

// ---- BOOT button ------------------------------------------------------------
// Holding it wipes every bonded phone and drops the dongle back into pairing
// mode, which is the way out of "I paired the wrong phone".
#ifndef NIB_BTN_PIN
#define NIB_BTN_PIN        0       // BOOT is GPIO0 on every ESP32-S3; -1 for none
#endif
#ifndef NIB_BTN_ACTIVE_LOW
#define NIB_BTN_ACTIVE_LOW 1
#endif
#define NIB_HAS_BUTTON (NIB_BTN_PIN >= 0)
#define NIB_UNPAIR_HOLD_MS 15000   // hold this long to forget all phones
#define NIB_RESET_HOLD_MS  30000   // keep holding to restore every default
#ifndef NIB_PAIR_HOLD_MS
#define NIB_PAIR_HOLD_MS   10000   // hold this long, then let go: new phones may pair
#endif
#ifndef NIB_PAIR_WINDOW_MS
#define NIB_PAIR_WINDOW_MS 120000  // how long that pairing window stays open
#endif
// With no button there is no gesture to open a pairing window, so every
// plug-in opens one: replugging the dongle is the gesture. Zero turns it off.
#ifndef NIB_BOOT_PAIR_MS
#if NIB_HAS_BUTTON
#define NIB_BOOT_PAIR_MS   0
#else
#define NIB_BOOT_PAIR_MS   NIB_PAIR_WINDOW_MS
#endif
#endif

// ---- LCD --------------------------------------------------------------------
// Defaults are for the Pocket-Dongle-S3-0.96 (ST7735 GREENTAB 160x80: BGR,
// inverted, 26 pixel column offset), taken from the vendor's TFT_eSPI setup.
// Build with -DNIB_LCD_ENABLED=0 for a board with no screen.
#ifndef NIB_LCD_ENABLED
#define NIB_LCD_ENABLED  1
#endif

#ifndef NIB_LCD_SCLK
#define NIB_LCD_SCLK    10
#endif
#ifndef NIB_LCD_MOSI
#define NIB_LCD_MOSI    11
#endif
#ifndef NIB_LCD_CS
#define NIB_LCD_CS      12
#endif
#ifndef NIB_LCD_DC
#define NIB_LCD_DC      13
#endif
#ifndef NIB_LCD_RST
#define NIB_LCD_RST     14
#endif
#ifndef NIB_LCD_ROTATION
#define NIB_LCD_ROTATION 1   // 1 or 3 - flip this if the text reads upside down
#endif

// Backlight pin, or -1 when the board hardwires it on, as this one does.
#ifndef NIB_LCD_BL
#define NIB_LCD_BL      -1
#endif
#ifndef NIB_LCD_BL_ACTIVE_LOW
#define NIB_LCD_BL_ACTIVE_LOW 1
#endif

// Which controller drives the panel. 7735 covers the common 160x80 and 128x160
// modules; 7789 covers the 240x135, 172x320 and 240x240 ones.
#define NIB_ST7735  7735
#define NIB_ST7789  7789
#ifndef NIB_LCD_DRIVER
#define NIB_LCD_DRIVER  NIB_ST7735
#endif

// Panel geometry before rotation, and whether it ships colour-inverted.
#ifndef NIB_LCD_W
#define NIB_LCD_W       80
#endif
#ifndef NIB_LCD_H
#define NIB_LCD_H       160
#endif
// RAM offset of the visible window, in the panel's native (portrait) axes.
// Only used by the 80x160 ST7735 path. Wrong values show as a noisy strip
// along one or two edges.
#ifndef NIB_LCD_COLSTART
#define NIB_LCD_COLSTART 26
#endif
#ifndef NIB_LCD_ROWSTART
#define NIB_LCD_ROWSTART 1
#endif
#ifndef NIB_LCD_INVERT
#define NIB_LCD_INVERT  1
#endif
