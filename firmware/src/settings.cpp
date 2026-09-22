#include <Preferences.h>
#include <esp_random.h>

#include "config.h"
#include "screensaver.h"
#include "settings.h"

Settings gSettings;

static Preferences prefs;
static const char* kNamespace = "nib";

// The project was called BlueHID, and its NVS namespaces were "bluehid" and
// "bluehid_ss". Copy anything found there across once, so a reflashed dongle
// keeps its name, passkey and screensaver, then delete the old copies. The
// bonds live in NimBLE's own namespace and never moved.
static void migrateFromBlueHid() {
  Preferences from, to;
  if (!from.begin("bluehid", true)) return;
  if (from.isKey("pk")) {
    to.begin(kNamespace, false);
    if (!to.isKey("pk")) {
      to.putUInt("pk", from.getUInt("pk", NIB_PASSKEY));
      if (from.isKey("show")) to.putBool("show", from.getBool("show", true));
      if (from.isKey("name")) to.putString("name", from.getString("name", NIB_DEVICE_NAME));
      for (const char* k : { "mode", "usb", "hid", "pair" })
        if (from.isKey(k)) to.putUChar(k, from.getUChar(k, 0));
    }
    to.end();
  }
  from.end();

  if (from.begin("bluehid_ss", true)) {
    to.begin("nib_ss", false);
    if (!to.isKey("on") && from.isKey("on")) {
      to.putBool("on", from.getBool("on", true));
      if (from.isKey("sel3")) to.putUChar("sel3", from.getUChar("sel3", 0));
      if (from.isKey("idle")) to.putUShort("idle", from.getUShort("idle", 60));
      for (const char* k : { "cs.hdr", "cs.px" }) {
        const size_t n = from.getBytesLength(k);
        if (!n) continue;
        uint8_t* buf = (uint8_t*)malloc(n);
        if (buf && from.getBytes(k, buf, n) == n) to.putBytes(k, buf, n);
        free(buf);
      }
    }
    to.end();
    from.end();
  }

  if (from.begin("bluehid", false)) { from.clear(); from.end(); }
  if (from.begin("bluehid_ss", false)) { from.clear(); from.end(); }
}

uint32_t randomPasskey() {
  // BLE passkeys are six decimal digits, so 000000 to 999999.
  return esp_random() % 1000000u;
}

void settingsLoad(bool hasDisplay, bool hasButton) {
  migrateFromBlueHid();
  prefs.begin(kNamespace, true);
  gSettings.passkey     = prefs.getUInt("pk", NIB_PASSKEY);
  gSettings.showPasskey = prefs.getBool("show", NIB_DEFAULT_SHOW_PASSKEY);
  gSettings.mode        = (PasskeyMode)prefs.getUChar("mode", NIB_DEFAULT_PASSKEY_MODE);
  gSettings.name        = prefs.getString("name", NIB_DEVICE_NAME);
  gSettings.usb         = (UsbMode)prefs.getUChar("usb", NIB_DEFAULT_USB_MODE);
  gSettings.hid         = (HidIdentity)prefs.getUChar("hid", NIB_DEFAULT_HID_IDENTITY);
  gSettings.pair        = (PairMode)prefs.getUChar("pair", NIB_DEFAULT_PAIR_MODE);
  prefs.end();

#ifdef NIB_USB_MODE_FORCED
  // A build can pin this, so a dongle handed to someone else cannot be talked
  // back open from the app.
  gSettings.usb = (UsbMode)NIB_USB_MODE_FORCED;
#endif

  if (gSettings.name.isEmpty()) gSettings.name = NIB_DEVICE_NAME;

  if (!hasDisplay) gSettings.mode = PasskeyMode::Fixed;

#ifndef NIB_USB_MODE_FORCED
  // Without a BOOT button the 1200 baud jump is the only way to reflash, so
  // the console cannot be turned off or made read-only.
  if (!hasButton) gSettings.usb = UsbMode::Full;
#else
  (void)hasButton;
#endif

  if (gSettings.mode == PasskeyMode::RandomEachBoot) {
    gSettings.passkey = randomPasskey();
    // Deliberately not saved: a fresh one every boot is the whole point, and
    // writing to flash on each power-up would wear it out for nothing.
  }
}

void settingsSave() {
  prefs.begin(kNamespace, false);
  prefs.putUInt("pk", gSettings.passkey);
  prefs.putBool("show", gSettings.showPasskey);
  prefs.putUChar("mode", (uint8_t)gSettings.mode);
  prefs.putString("name", gSettings.name);
  prefs.putUChar("usb", (uint8_t)gSettings.usb);
  prefs.putUChar("hid", (uint8_t)gSettings.hid);
  prefs.putUChar("pair", (uint8_t)gSettings.pair);
  prefs.end();
}

void settingsResetToDefaults() {
  gSettings.passkey     = NIB_PASSKEY;
  gSettings.showPasskey = NIB_DEFAULT_SHOW_PASSKEY;
  gSettings.mode        = (PasskeyMode)NIB_DEFAULT_PASSKEY_MODE;
  gSettings.name        = NIB_DEVICE_NAME;
  gSettings.usb         = (UsbMode)NIB_DEFAULT_USB_MODE;
  gSettings.hid         = (HidIdentity)NIB_DEFAULT_HID_IDENTITY;
  gSettings.pair        = (PairMode)NIB_DEFAULT_PAIR_MODE;
  settingsSave();

  // The screensaver keeps its own NVS namespace, so a reset has to reach into
  // it. These are the same defaults screensaverBegin() falls back to, and each
  // setter only writes when the value actually changed. Clearing the custom
  // animation is the point of "factory": an imported one is user content, and
  // the button hold is the only way to get rid of it without the app.
  screensaverSetEnabled(NIB_DEFAULT_SAVER_ON);
  screensaverSelect(NIB_DEFAULT_SAVER);
  screensaverSetIdleSeconds(NIB_DEFAULT_SAVER_IDLE);
  screensaverSetWordmark(NIB_DEVICE_NAME);
  screensaverCustomClear();
}
