#pragma once
#include <Arduino.h>

// Settings the phone can change over BLE, kept in NVS so they survive reboots.
//
// The screensaver's three settings - on, which one, and the idle timeout - are
// deliberately NOT in this struct. screensaver.cpp owns them in its own NVS
// namespace and writes each one the moment it changes, because the phone's
// settings screen wants a live preview and APPLY here costs a reboot. Two copies
// of the same value is how they drift, so there is only the one. What this file
// does own is the factory reset: settingsResetToDefaults() clears them too.

enum class PasskeyMode : uint8_t {
  Fixed          = 0,   // one passkey until you change it
  RandomEachBoot = 1,   // new passkey on every power-up
  RandomOnUnpair = 2,   // new passkey whenever bonds are wiped
};

// What the attached computer is allowed to see and do over USB.
enum class UsbMode : uint8_t {
  Full       = 0,  // serial console, and the host may trigger firmware updates
  ConsoleRO  = 1,  // serial console, but the 1200 baud bootloader jump is refused
  Off        = 2,  // no serial device at all: the host sees a keyboard and mouse
};

// How the dongle introduces itself over USB. Some software filters devices by
// name, and a keyboard called "N.I.B." can trip policy that a plain one does not.
enum class HidIdentity : uint8_t {
  Named   = 0,   // manufacturer "nib", product is the device name
  Generic = 1,   // manufacturer "Generic", product "USB Keyboard"
};

enum class PairMode : uint8_t {
  Always = 0,   // any phone that knows the passkey can pair, any time
  Window = 1,   // new phones only while a pairing window is open: after a
                // 10 s button hold, or when a paired phone opens one; phones
                // already paired always reconnect
};

struct Settings {
  uint32_t    passkey;      // six digits
  bool        showPasskey;  // keep it on the idle screen
  PasskeyMode mode;
  String      name;         // BLE advertised name
  UsbMode     usb;
  HidIdentity hid;
  PairMode    pair;
};

// Restores compiled-in defaults, screensaver and any imported animation
// included. The 30 second button hold calls this, which is the way back in if a
// setting locks you out of the app.
void settingsResetToDefaults();

extern Settings gSettings;

// `hasDisplay` false pins the passkey to Fixed: a random passkey that nothing
// can display is a locked door with no key.
// Clamps what this board cannot recover from: random passkeys without a
// screen, and a USB mode that blocks reflashing without a BOOT button.
void     settingsLoad(bool hasDisplay, bool hasButton);
void     settingsSave();
uint32_t randomPasskey();
