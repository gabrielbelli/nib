#pragma once
// Wire format: phone writes packets to the RX characteristic.
// Byte 0 is the opcode, the rest is that opcode's payload.
//
//   0x10 TAP    [mods, usage] * n   tap each key in order (text, shortcuts)
//   0x11 DOWN   [mods, usage]       hold a key down
//   0x12 UP     [mods, usage]       release a key
//   0x13 RELEASE_ALL  -             panic: release every key and button
//   0x14 CONSUMER     [usageLo, usageHi]  one press of a consumer-control key
//   0x15 GAMEPAD      [lx ly rx ry lt rt, hat, buttons u32 LE]  whole gamepad state
//   0x20 MOVE   [dx, dy, wheel]     int8 each, relative mouse movement
//   0x21 BTN    [button, action]    button 1=L 2=R 4=M, action 0=up 1=down 2=click
//   0x30 SECRET [mods, usage] * n   same as TAP but never logged anywhere
//
// Settings, all of which persist in NVS. APPLY reboots, because the BLE name
// and the pairing passkey are only read when the stack starts.
//   0x40 SET_PASSKEY [u32 little endian]
//   0x41 SET_OPTIONS [showPasskey, passkeyMode, usbMode, hidIdentity]
//                    trailing bytes are optional; older senders may omit them
//   0x42 SET_NAME    [utf8, up to 20 bytes]
//   0x43 APPLY       -                save settings and restart
//   0x44 FORGET      -                wipe bonds (the button's 15 s hold, where there is one)
//
// Screensaver. The dongle's panel has no backlight GPIO, so this is about not
// parking a bright static layout on one set of pixels, not about saving power.
// See screensaver.h for the catalogue and the import payload layout.
//   0x45 STATUS_REQ       -             re-send the status notification
//   0x46 PAIR_OPEN        -             open a pairing window (paired phones only)
//   0x50 SS_SET           [enabled 0/1, index, idleSecondsLo, idleSecondsHi]
//                         index 0xFF is shuffle; the two idle bytes are optional
//   0x51 SS_PREVIEW       [index]       show it for a few seconds, no save
//   0x52 SS_IMPORT_BEGIN  [header bytes ...]        see screensaver.h
//   0x53 SS_IMPORT_DATA   [offLo, offHi, data ...]  chunks in order
//   0x54 SS_IMPORT_COMMIT [crc32 little endian]     over the whole payload
//   0x55 SS_IMPORT_ABORT  -
//   0x56 SS_CUSTOM_CLEAR  -             forget the imported animation
//   0x57 SS_CLOCK         [epoch u32 LE, tzOffsetMinutes i16 LE]
//                         the dongle has no RTC, so the phone tells it the time
//
// Modifier bitmask (byte `mods`):
//   bit0 LCtrl  bit1 LShift  bit2 LAlt  bit3 LGui(Cmd)
//   bit4 RCtrl  bit5 RShift  bit6 RAlt  bit7 RGui
//
// `usage` is a raw USB HID Usage ID from page 0x07, e.g. 0x04='a', 0x28=Enter.
// Layout translation (text -> mods+usage) happens in the web app, not here.

enum : uint8_t {
  OP_TAP         = 0x10,
  OP_DOWN        = 0x11,
  OP_UP          = 0x12,
  OP_RELEASE_ALL = 0x13,
  OP_CONSUMER    = 0x14,
  OP_GAMEPAD     = 0x15,
  OP_MOVE        = 0x20,
  OP_BTN         = 0x21,
  OP_SECRET      = 0x30,

  OP_SET_PASSKEY = 0x40,
  OP_SET_OPTIONS = 0x41,
  OP_SET_NAME    = 0x42,
  OP_APPLY       = 0x43,
  OP_FORGET      = 0x44,

  OP_STATUS_REQ       = 0x45,   // no payload: publish the status notification now
  OP_PAIR_OPEN        = 0x46,   // no payload: let a new phone pair for the next two minutes
  OP_SS_SET           = 0x50,
  OP_SS_PREVIEW       = 0x51,
  OP_SS_IMPORT_BEGIN  = 0x52,
  OP_SS_IMPORT_DATA   = 0x53,
  OP_SS_IMPORT_COMMIT = 0x54,
  OP_SS_IMPORT_ABORT  = 0x55,
  OP_SS_CUSTOM_CLEAR  = 0x56,
  OP_SS_CLOCK         = 0x57,
};
