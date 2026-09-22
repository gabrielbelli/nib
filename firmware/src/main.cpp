// N.I.B. - phone (Web Bluetooth) -> ESP32-S3 (BLE) -> computer (USB HID)
//
// The dongle presents itself to the host as an ordinary USB keyboard + mouse,
// and to the phone as a BLE peripheral with one write characteristic.
// Everything the phone writes is turned into HID reports. See protocol.h.
//
// Default board is the Pocket-Dongle-S3-0.96. Boards without a screen work
// too: build with -DNIB_LCD_ENABLED=0.

#include <Arduino.h>
#include <USB.h>
#include <USBHIDKeyboard.h>
#include <USBHIDMouse.h>
#include <USBHIDConsumerControl.h>
#include <USBHIDGamepad.h>
#include <NimBLEDevice.h>
#include <esp_system.h>
#include <stdarg.h>

#include "config.h"
#include "protocol.h"
#include "display.h"
#include "screensaver.h"
#include "settings.h"

USBHIDKeyboard Keyboard;
USBHIDMouse    Mouse;
// Media and remote keys: volume, play/pause, and the Home and Back that TV
// boxes (Android TV, Fire TV) answer to.
USBHIDConsumerControl Consumer;
#if NIB_GAMEPAD
// A generic HID gamepad: two sticks, two triggers, a hat and 32 buttons.
USBHIDGamepad Gamepad;
#endif

// The USB serial console is created by hand rather than by the Arduino core,
// so whether it exists at all is a runtime decision. A host that cannot see a
// serial port cannot ask the dongle to jump into its bootloader.
static USBCDC gCdc;
static Print* gLog = &Serial;   // UART0 until a USB console is opened

// ---- which kind of computer is this plugged into --------------------------
// Windows and Linux send the keyboard's lock-light state (a HID output report)
// within moments of enumerating a keyboard; macOS does not, until someone
// presses Caps Lock. So: a light report in the first few seconds after the
// host configures us means a PC, silence means a Mac. The same fingerprint the
// USB Rubber Ducky uses. The phone only uses it for labels and a default, and
// the user can always override it.
enum class Host : uint8_t { Unknown = 0, Mac = 1, Pc = 2 };
static volatile uint32_t gUsbUpAt  = 0;
static volatile bool     gLedEarly = false;
static volatile Host     gHost     = Host::Unknown;
static const uint32_t    HOST_WINDOW_MS = 4000;
// The host's lock lights (bit 0 Num, 1 Caps, 2 Scroll), as it last set them.
// The phone shows them, since it cannot see the far keyboard's LEDs.
static volatile uint8_t  gLeds = 0;
static volatile bool     gLedsNews = false;
static const char* hostName(Host h) { return h == Host::Mac ? "mac" : h == Host::Pc ? "pc" : ""; }

// ---- pairing window --------------------------------------------------------
// In PairMode::Window a new phone may only bond while a window is open. A
// dongle with no bonds at all is always open, so it can never lock itself.
static volatile uint32_t gPairUntil = 0;       // millis() when the window closes, 0 = shut
static int               gBondsAtConnect = 0;

static bool pairingOpen() {
  if (gSettings.pair == PairMode::Always) return true;
  if (NimBLEDevice::getNumBonds() == 0) return true;
  return gPairUntil && (int32_t)(gPairUntil - millis()) > 0;
}
static uint32_t pairSecondsLeft() {
  if (!gPairUntil || gSettings.pair == PairMode::Always) return 0;
  const int32_t left = (int32_t)(gPairUntil - millis());
  return left > 0 ? (uint32_t)(left + 999) / 1000 : 0;
}

// Arduino's Keyboard API takes these pseudo-keycodes for modifiers; index by
// the bit position used in the wire protocol.
static const uint8_t kModKeys[8] = {
  KEY_LEFT_CTRL,  KEY_LEFT_SHIFT,  KEY_LEFT_ALT,  KEY_LEFT_GUI,
  KEY_RIGHT_CTRL, KEY_RIGHT_SHIFT, KEY_RIGHT_ALT, KEY_RIGHT_GUI,
};

// BLE writes arrive on the NimBLE host task. Doing HID work with delays there
// stalls the stack, so packets are handed to a worker task instead.
struct Packet {
  uint16_t len;          // not uint8_t: 256 truncates to 0 and the packet vanishes
  uint8_t  data[256];
};
static QueueHandle_t gQueue;

static constexpr uint16_t NO_CONN = 0xffff;
static volatile uint16_t  gConnHandle = NO_CONN;
static NimBLECharacteristic* gStatusChar = nullptr;

// Result of the last screensaver import step, so the phone can tell a refused
// transfer from a slow one. 0 is SsImport::Ok. See screensaver.h for the codes.
static volatile uint8_t gLastImport = (uint8_t)SsImport::Ok;

// ------------------------------------------------------------------ status
// The phone reads this to populate its settings screen. Assembled by hand
// because it is the only JSON this firmware ever produces, and a library for
// three hundred bytes of output is not worth the flash. Every append is bounded
// and every string is escaped: the device name and an imported saver's name both
// arrive over BLE, and a stray quote in one of them would hand the phone
// unparseable JSON.
static size_t jsonFmt(char* out, size_t cap, size_t at, const char* fmt, ...) {
  if (at + 1 >= cap) return at;
  va_list ap;
  va_start(ap, fmt);
  const int n = vsnprintf(out + at, cap - at, fmt, ap);
  va_end(ap);
  if (n < 0) return at;
  return (at + (size_t)n >= cap) ? cap - 1 : at + (size_t)n;
}

static size_t jsonStr(char* out, size_t cap, size_t at, const char* s) {
  if (!s) s = "";
  if (at + 3 > cap) { if (at < cap) out[at] = '\0'; return at; }
  out[at++] = '"';
  for (; *s; s++) {
    const unsigned char c = (unsigned char)*s;
    if (c < 0x20) continue;                  // control bytes have no place here
    const size_t need = (c == '"' || c == '\\') ? 2 : 1;
    if (at + need + 2 > cap) break;          // closing quote plus terminator
    if (need == 2) out[at++] = '\\';
    out[at++] = (char)c;
  }
  out[at++] = '"';
  out[at] = '\0';
  return at;
}

static void publishStatus() {
  if (!gStatusChar) return;

  // Measured worst case is 276 bytes: a 20 byte name in nothing but quotes, the
  // seven built-in saver names, and a 15 byte custom one in quotes too. Well
  // inside the 512 byte attribute limit, and both helpers above truncate to a
  // still-terminated string rather than overrun if that ever stops being true.
  char j[384];
  size_t at = 0;

  at = jsonFmt(j, sizeof(j), at, "{\"name\":");
  at = jsonStr(j, sizeof(j), at, gSettings.name.c_str());
  at = jsonFmt(j, sizeof(j), at,
               ",\"pk\":\"%06u\",\"show\":%d,\"mode\":%d,\"screen\":%d,"
               "\"usb\":%d,\"hid\":%d,\"host\":\"%s\",\"pm\":%d,\"po\":%d,\"pw\":%u,\"btn\":%d,\"led\":%u,\"pad\":%d",
               gSettings.passkey, gSettings.showPasskey ? 1 : 0,
               (int)gSettings.mode, displayPresent() ? 1 : 0,
               (int)gSettings.usb, (int)gSettings.hid, hostName(gHost),
               (int)gSettings.pair, pairingOpen() ? 1 : 0, (unsigned)pairSecondsLeft(),
               NIB_HAS_BUTTON ? 1 : 0, (unsigned)gLeds, NIB_GAMEPAD ? 1 : 0);

  // "idx" is 255 for shuffle. "got" is the import high-water mark, so a phone
  // that reconnected mid-transfer resumes from it instead of starting over.
  // The built-in names are not sent: the page ships the same catalogue, and
  // the whole status has to fit one iOS notification (MTU 185, so 182 bytes).
  // Only an imported animation's name travels, as "cn".
  at = jsonFmt(j, sizeof(j), at,
               ",\"ss\":{\"on\":%d,\"idx\":%u,\"idle\":%u,\"custom\":%d,"
               "\"imp\":%u,\"got\":%u,\"n\":%u",
               screensaverEnabled() ? 1 : 0,
               (unsigned)screensaverSelected(),
               (unsigned)screensaverIdleSeconds(),
               screensaverHasCustom() ? 1 : 0,
               (unsigned)gLastImport,
               (unsigned)screensaverImportReceived(),
               (unsigned)screensaverCount());
  if (screensaverHasCustom()) {
    at = jsonFmt(j, sizeof(j), at, ",\"cn\":");
    at = jsonStr(j, sizeof(j), at, screensaverCustomName());
  }
  at = jsonFmt(j, sizeof(j), at, "}}");

  gStatusChar->setValue((uint8_t*)j, at);
  if (gConnHandle != NO_CONN) gStatusChar->notify();
}

static void announcePasskey() {
  // Without a screen this is the only way to learn the passkey, so it always
  // goes to serial regardless of the "hide it" setting.
  gLog->printf("[ble] passkey %06u\n", gSettings.passkey);
}

// ------------------------------------------------------------------- HID output
static void pressMods(uint8_t mods) {
  for (int i = 0; i < 8; i++)
    if (mods & (1 << i)) Keyboard.press(kModKeys[i]);
}

static void releaseMods(uint8_t mods) {
  for (int i = 0; i < 8; i++)
    if (mods & (1 << i)) Keyboard.release(kModKeys[i]);
}

static void tapKey(uint8_t mods, uint8_t usage) {
  pressMods(mods);
  if (usage) {
    Keyboard.pressRaw(usage);
    delay(NIB_KEY_PRESS_MS);
    Keyboard.releaseRaw(usage);
  }
  releaseMods(mods);
  delay(NIB_KEY_GAP_MS);
}

static void openPairing(const char* why) {
  gPairUntil = (millis() + NIB_PAIR_WINDOW_MS) | 1;
  displaySetPairing(true);
  displaySetActivity("pairing open");
  gLog->printf("[ble] pairing window open for %us (%s)\n",
               (unsigned)(NIB_PAIR_WINDOW_MS / 1000), why);
  publishStatus();
}

static void forgetAllPhones() {
  if (gConnHandle != NO_CONN) NimBLEDevice::getServer()->disconnect(gConnHandle);
  NimBLEDevice::deleteAllBonds();
  Keyboard.releaseAll();

  if (gSettings.mode == PasskeyMode::RandomOnUnpair) {
    gSettings.passkey = randomPasskey();
    settingsSave();
    NimBLEDevice::setSecurityPasskey(gSettings.passkey);
    displaySetPasskey(gSettings.passkey, gSettings.showPasskey);
    announcePasskey();
  }

  gLog->println("[ble] all bonds deleted, back to pairing");
  NimBLEDevice::startAdvertising();
  publishStatus();
}

// Records an import step's outcome and, when it failed, says so on the screen
// and in the log. Returns true when the step was accepted, so the caller can
// keep the happy path on one line.
static bool ssReport(const char* step, SsImport r) {
  gLastImport = (uint8_t)r;
  if (r == SsImport::Ok) return true;
  gLog->printf("[ss] import %s refused: %s\n", step, screensaverImportError(r));
  char note[24];
  snprintf(note, sizeof(note), "ss: %s", screensaverImportError(r));
  displaySetActivity(note);
  return false;
}

static void handlePacket(const uint8_t* d, size_t n) {
  if (n < 1) return;
  const uint8_t  op  = d[0];
  const uint8_t* p   = d + 1;
  const size_t   len = n - 1;
  char note[24];

  // Anything the user physically did wakes the screen. Pointer motion is in
  // here too, which is why this is separate from displaySetActivity(): OP_MOVE
  // deliberately never redraws, but it is still somebody's hand on the trackpad.
  switch (op) {
    case OP_TAP:  case OP_SECRET: case OP_DOWN: case OP_UP:
    case OP_MOVE: case OP_BTN:    case OP_RELEASE_ALL: case OP_CONSUMER: case OP_GAMEPAD:
      screensaverNotifyActivity();
      break;
    default:
      break;
  }

  switch (op) {
    case OP_TAP:
    case OP_SECRET:
      for (size_t i = 0; i + 1 < len; i += 2) tapKey(p[i], p[i + 1]);
      // A password must never reach the screen or the serial log, so only the
      // count of keystrokes is reported for OP_SECRET.
      if (op == OP_SECRET) snprintf(note, sizeof(note), "password sent");
      else                 snprintf(note, sizeof(note), "typed %u keys", (unsigned)(len / 2));
      displaySetActivity(note);
      break;

    case OP_DOWN:
      if (len >= 2) { pressMods(p[0]); if (p[1]) Keyboard.pressRaw(p[1]); }
      displaySetActivity("key held");
      break;

    case OP_UP:
      if (len >= 2) { if (p[1]) Keyboard.releaseRaw(p[1]); releaseMods(p[0]); }
      break;

    case OP_RELEASE_ALL:
      Keyboard.releaseAll();
      Mouse.release(MOUSE_LEFT);
      Mouse.release(MOUSE_RIGHT);
      Mouse.release(MOUSE_MIDDLE);
      displaySetActivity("all released");
      break;

    case OP_MOVE:
      if (len >= 3) Mouse.move((int8_t)p[0], (int8_t)p[1], (int8_t)p[2]);
      break;   // far too frequent to redraw the screen for

    case OP_CONSUMER:
      if (len >= 2) {
        Consumer.press((uint16_t)(p[0] | (p[1] << 8)));
        delay(NIB_KEY_PRESS_MS * 3);   // media keys want a visible press, not a blip
        Consumer.release();
        displaySetActivity("media key");
      }
      break;

    case OP_GAMEPAD:
#if NIB_GAMEPAD
      // [lx, ly, rx, ry, lt, rt (int8), hat, buttons u32 LE]: a whole state,
      // so a dropped packet is corrected by the next one.
      if (len >= 11) {
        Gamepad.send((int8_t)p[0], (int8_t)p[1], (int8_t)p[2], (int8_t)p[3],
                     (int8_t)p[4], (int8_t)p[5], p[6],
                     (uint32_t)p[7] | ((uint32_t)p[8] << 8) | ((uint32_t)p[9] << 16) | ((uint32_t)p[10] << 24));
      }
#endif
      break;

    case OP_BTN:
      if (len >= 2) {
        const uint8_t btn = p[0], action = p[1];
        if      (action == 0) Mouse.release(btn);
        else if (action == 1) Mouse.press(btn);
        else                  Mouse.click(btn);
        displaySetActivity(btn == 2 ? "right click" : "click");
      }
      break;

    // ---- settings ----------------------------------------------------------
    case OP_SET_PASSKEY:
      if (len >= 4) {
        gSettings.passkey =
            ((uint32_t)p[0] | ((uint32_t)p[1] << 8) |
             ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24)) % 1000000u;
        displaySetPasskey(gSettings.passkey, gSettings.showPasskey);
        displaySetActivity("passkey set");
        publishStatus();
      }
      break;

    case OP_SET_OPTIONS:
      if (len >= 2) {
        gSettings.showPasskey = p[0] != 0;
        gSettings.mode = (PasskeyMode)min<uint8_t>(p[1], 2);
        // A random passkey you cannot read is a locked door with no key, so a
        // screenless build is pinned to a fixed passkey.
        if (!displayPresent() && gSettings.mode != PasskeyMode::Fixed) {
          gSettings.mode = PasskeyMode::Fixed;
          gLog->println("[cfg] no screen: passkey mode forced to fixed");
        }
        if (len >= 3) gSettings.usb = (UsbMode)min<uint8_t>(p[2], 2);
#if !NIB_HAS_BUTTON && !defined(NIB_USB_MODE_FORCED)
        if (gSettings.usb != UsbMode::Full) {
          gSettings.usb = UsbMode::Full;
          gLog->println("[cfg] no button: the USB console stays on, it is the only way to reflash");
        }
#endif
        if (len >= 4) gSettings.hid = (HidIdentity)min<uint8_t>(p[3], 1);
        if (len >= 5) {
          gSettings.pair = (PairMode)min<uint8_t>(p[4], 1);
          displaySetPairing(pairingOpen());
        }
        displaySetPasskey(gSettings.passkey, gSettings.showPasskey);
        displaySetActivity("options set");
        publishStatus();
      }
      break;

    case OP_SET_NAME:
      if (len >= 1) {
        char buf[21];
        const size_t take = min(len, sizeof(buf) - 1);
        memcpy(buf, p, take);
        buf[take] = '\0';
        gSettings.name = buf;
        // The Wordmark saver draws this name, and it is the one setting that
        // shows without a reboot, so it is mirrored across immediately.
        screensaverSetWordmark(buf);
        displaySetActivity("name set");
        publishStatus();
      }
      break;

    case OP_APPLY:
      settingsSave();
      announcePasskey();
      displaySetActivity("saved, restarting");
      gLog->println("[cfg] saved, restarting");
      // The drawing task puts that on screen during this wait. It used to be
      // drawn from right here, which meant this task and the drawing task on the
      // same SPI bus at the same time - harmless when the screen was one line of
      // text, not harmless now that a screensaver frame can be in flight.
      delay(400);
      esp_restart();
      break;

    case OP_FORGET:
      forgetAllPhones();
      break;

    case OP_PAIR_OPEN:
      // Only an encrypted, bonded link can write here, so this is a paired
      // phone vouching for the next one.
      openPairing("opened from a paired phone");
      break;

    case OP_STATUS_REQ:
      // For a central that subscribed but could not read the characteristic.
      publishStatus();
      break;

    // ---- screensaver -------------------------------------------------------
    // Everything below persists itself the moment it changes, with no APPLY and
    // no reboot, because the phone's settings screen previews as you scroll it.
    case OP_SS_SET:
      if (len >= 2) {
        gLog->printf("[ss] set on=%u idx=%u\n", p[0], p[1]);
        screensaverSetEnabled(p[0] != 0);
        screensaverSelect(p[1]);            // clamps; 0xFF means shuffle
        // The timeout bytes are optional, so a phone that only wants to toggle
        // the saver can send two bytes and keep whatever is stored.
        if (len >= 4)
          screensaverSetIdleSeconds((uint16_t)(p[2] | ((uint16_t)p[3] << 8)));
        displaySetActivity("saver set");
        publishStatus();
      }
      break;

    case OP_SS_PREVIEW:
      if (len >= 1) {
        // Order matters: displaySetActivity() counts as activity, and activity
        // cancels a preview, so the preview is armed last.
        displaySetActivity("preview");
        screensaverPreview(p[0], 4000);
      }
      break;

    // The three import opcodes parse bytes straight off the link. Not one field
    // is trusted here: the header goes to screensaverImportBegin() whole, which
    // range-checks every part of it and refuses a declared length that does not
    // match the geometry, and every length below is derived from the packet that
    // actually arrived rather than from anything the phone claimed.
    case OP_SS_IMPORT_BEGIN:
      if (ssReport("begin", screensaverImportBegin(p, len)))
        displaySetActivity("importing");
      publishStatus();                      // "got" tells the phone where to start
      break;

    case OP_SS_IMPORT_DATA:
      // A packet too short to even hold its offset is refused rather than read
      // past the end of it.
      if (len < 2) {
        ssReport("data", SsImport::BadOffset);
      } else {
        ssReport("data", screensaverImportData(
                             (uint16_t)(p[0] | ((uint16_t)p[1] << 8)),
                             p + 2, len - 2));
      }
      break;   // no notify: chunks arrive far too fast to publish one each

    case OP_SS_IMPORT_COMMIT:
      // Up to 6 kB of blocking NVS write, which is exactly why every packet is
      // handled on this worker task and never in the BLE callback.
      if (len < 4) {
        ssReport("commit", SsImport::Incomplete);
      } else if (ssReport("commit", screensaverImportCommit(
                              (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                              ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24)))) {
        // The drawing task adopts the new animation at its next frame boundary.
        // Waiting for that means "names" already carries it. Bounded, because a
        // screenless build never gets here and a wedged loop must not hang this.
        for (int i = 0; i < 10 && !screensaverCustomName()[0]; i++) delay(20);
        displaySetActivity("saver imported");
      }
      publishStatus();
      break;

    case OP_SS_IMPORT_ABORT:
      screensaverImportAbort();
      gLastImport = (uint8_t)SsImport::NoSession;
      publishStatus();
      break;

    case OP_SS_CUSTOM_CLEAR:
      screensaverCustomClear();
      // Same handover as commit, in reverse: wait for the drawing task to drop
      // it, or the phone is told the custom saver is still there.
      for (int i = 0; i < 10 && screensaverHasCustom(); i++) delay(20);
      displaySetActivity("saver cleared");
      publishStatus();
      break;

    case OP_SS_CLOCK:
      // No RTC and no network on this dongle, so the phone is the only clock the
      // Hours saver can have. Deliberately not persisted: a confidently wrong
      // time after a reboot is worse than the uptime counter it falls back to.
      if (len >= 6) {
        screensaverSetClock((uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                                ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24),
                            (int16_t)(uint16_t)(p[4] | ((uint16_t)p[5] << 8)));
      }
      // No publishStatus(): nothing in the status changes, and the phone may
      // resend this on a timer.
      break;

    default:
      log_w("unknown opcode 0x%02x", op);
      break;
  }
}

static void hidTask(void*) {
  Packet pkt;
  for (;;) {
    if (xQueueReceive(gQueue, &pkt, portMAX_DELAY) == pdTRUE)
      handlePacket(pkt.data, pkt.len);
  }
}

// Holding BOOT escalates: fifteen seconds forgets every bonded phone, thirty
// restores every setting including the USB console. The second stage is the
// way back in if a setting ever locks you out of the app.
#if NIB_HAS_BUTTON
static void buttonTask(void*) {
  pinMode(NIB_BTN_PIN, INPUT_PULLUP);
  uint32_t downAt = 0;
  bool wasDown = false;
  bool unpaired = false;
  bool wasReset = false;

  for (;;) {
    const bool down = digitalRead(NIB_BTN_PIN) == (NIB_BTN_ACTIVE_LOW ? LOW : HIGH);

    if (down && !wasDown) { downAt = millis(); unpaired = wasReset = false; }

    if (down) {
      const uint32_t held = millis() - downAt;

      if (!unpaired && held >= NIB_UNPAIR_HOLD_MS) {
        unpaired = true;
        forgetAllPhones();
      }
      if (unpaired && !wasReset && held >= NIB_RESET_HOLD_MS) {
        wasReset = true;
        settingsResetToDefaults();
        gLog->println("[cfg] factory reset, release the button to restart");
      }

      // Ignore the first second so an accidental tap does not take the screen.
      // Three stages, each counting down to its own threshold: open pairing
      // (let go between 10 and 15 s), forget every phone, restore defaults.
      if (held > 1000) {
        const int stage = held < NIB_PAIR_HOLD_MS ? 0 : held < NIB_UNPAIR_HOLD_MS ? 1 : 2;
        const uint32_t target = stage == 0 ? NIB_PAIR_HOLD_MS
                              : stage == 1 ? NIB_UNPAIR_HOLD_MS : NIB_RESET_HOLD_MS;
        displaySetHold(held >= target ? 0 : (int)((target - held + 999) / 1000), stage);
      }
    }

    if (!down && wasDown) {
      displaySetHold(-1, 0);
      const uint32_t held = millis() - downAt;
      if (!unpaired && held >= NIB_PAIR_HOLD_MS) openPairing("button");
      // Restarting while BOOT is still held lands the chip in USB download
      // mode, which looks exactly like a dead dongle, so this waits.
      if (wasReset) { delay(200); esp_restart(); }
    }

    wasDown = down;
    delay(40);
  }
}

#endif  // NIB_HAS_BUTTON

// ----------------------------------------------------------------- BLE plumbing
class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    NimBLEAttValue v = c->getValue();
    if (v.length() == 0) return;

    // Clamped, not rejected. With a 517 byte MTU the phone can write more than
    // fits here, and every opcode either has a fixed length or - the screensaver
    // import - carries its own offset, so a short read is refused by the handler
    // and resent rather than quietly corrupting anything.
    Packet pkt;
    pkt.len = (uint16_t)min((size_t)v.length(), sizeof(pkt.data));
    memcpy(pkt.data, v.data(), pkt.len);
    xQueueSend(gQueue, &pkt, 0);
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    gConnHandle = desc->conn_handle;
    gBondsAtConnect = NimBLEDevice::getNumBonds();
    // Ask for a fast, stable connection: typing and pointer motion are
    // latency-sensitive and the defaults are tuned for battery life.
    s->updateConnParams(desc->conn_handle, 6, 12, 0, 200);
    displaySetLink(LinkState::Connected);
    displaySetActivity("ready");
    publishStatus();
    gLog->printf("[ble] phone connected (%s, %d bonds stored)\n",
                 desc->sec_state.bonded ? "bonded" : "new", NimBLEDevice::getNumBonds());
    // NimBLE answers the passkey from setSecurityPasskey() without calling
    // onPassKeyRequest(), so this is the moment a pairing may need it. The
    // console belongs to the computer this dongle already types into.
    announcePasskey();
  }

  void onDisconnect(NimBLEServer*) override {
    gConnHandle = NO_CONN;
    Keyboard.releaseAll();          // never leave a key stuck down
    displayRevealPasskey(false);
    displaySetLink(LinkState::Advertising);
    gLog->println("[ble] phone disconnected, advertising again");
    NimBLEDevice::startAdvertising();
  }

  uint32_t onPassKeyRequest() override {
    // Someone is pairing right now, so a hidden passkey is put on screen for
    // as long as that lasts. Hiding it protects an idle dongle, not this.
    displayRevealPasskey(true);
    announcePasskey();
    return gSettings.passkey;
  }

  void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
    displayRevealPasskey(false);
    if (!desc->sec_state.encrypted) {
      gLog->println("[ble] pairing FAILED, dropping connection");
      NimBLEDevice::getServer()->disconnect(desc->conn_handle);
    } else if (NimBLEDevice::getNumBonds() > gBondsAtConnect) {
      // A new bond. Allowed only while pairing is open; one phone per window.
      if (!pairingOpen()) {
        gLog->println(NIB_HAS_BUTTON
                      ? "[ble] new phone refused: pairing is closed (hold the button 10 s)"
                      : "[ble] new phone refused: pairing is closed (replug the dongle)");
        NimBLEDevice::deleteBond(NimBLEAddress(desc->peer_id_addr));
        NimBLEDevice::getServer()->disconnect(desc->conn_handle);
        displaySetActivity("pairing closed");
        return;
      }
      gPairUntil = 0;
      displaySetPairing(pairingOpen());
      gLog->println("[ble] new phone paired");
      displaySetActivity("paired");
    } else {
      gLog->println("[ble] paired and encrypted");
      displaySetActivity("paired");
    }
  }
};

// ------------------------------------------------------------------------ setup
void setup() {
  settingsLoad(displayPresent(), NIB_HAS_BUTTON);

  displayBegin();          // this is what calls screensaverBegin()
  // The Wordmark saver has no way to know the BLE name; settings owns that.
  screensaverSetWordmark(gSettings.name.c_str());
  displaySetName(gSettings.name.c_str());
  displaySetPairing(true);   // refined once the bond store is up (loop)
  displaySetLink(LinkState::Booting);
  displaySetPasskey(gSettings.passkey, gSettings.showPasskey);
  displayTick();

  gQueue = xQueueCreate(16, sizeof(Packet));
  xTaskCreatePinnedToCore(hidTask,    "hid", 4096, nullptr, 5, nullptr, 1);
#if NIB_HAS_BUTTON
  xTaskCreatePinnedToCore(buttonTask, "btn", 3072, nullptr, 2, nullptr, 1);
#endif

  // UART0 always carries the log, on pins that are not exposed over USB.
  Serial.begin(115200);

  if (gSettings.usb != UsbMode::Off) {
    // Full mode keeps the 1200 baud bootloader jump that the upload script
    // relies on. ConsoleRO keeps the port but refuses it.
    gCdc.enableReboot(gSettings.usb == UsbMode::Full);
    gCdc.begin(115200);
    gLog = &gCdc;
  }
  screensaverSetLog(gLog);

  // These only take effect because this firmware owns USB.begin(). With the
  // Arduino core starting USB before setup(), as it does by default, the
  // descriptor strings are already published and these calls do nothing.
  if (gSettings.hid == HidIdentity::Generic) {
    USB.manufacturerName("Generic");
    USB.productName("USB Keyboard");
  } else {
    USB.manufacturerName("nib");
    USB.productName(gSettings.name.c_str());
  }

  Keyboard.begin();
  Mouse.begin();
  Consumer.begin();
#if NIB_GAMEPAD
  Gamepad.begin();
#endif
  Keyboard.onEvent(ARDUINO_USB_HID_KEYBOARD_LED_EVENT, [](void*, esp_event_base_t, int32_t, void* data) {
    if (gUsbUpAt && !gLedEarly && millis() - gUsbUpAt < HOST_WINDOW_MS) gLedEarly = true;
    const auto* d = (arduino_usb_hid_keyboard_event_data_t*)data;
    if (d && d->leds != gLeds) { gLeds = d->leds; gLedsNews = true; }
  });
  USB.onEvent([](void*, esp_event_base_t, int32_t id, void*) {
    if (id == ARDUINO_USB_STARTED_EVENT) {          // configured by a host
      gLedEarly = false;
      gHost = Host::Unknown;
      gUsbUpAt = millis() | 1;
    }
  });
  USB.begin();   // must come last: it publishes the interfaces registered above

  delay(300);
  gLog->println("\n[usb] HID keyboard + mouse up");
  gLog->printf("[cfg] name %s, screen %s, usb mode %d\n",
               gSettings.name.c_str(), displayPresent() ? "yes" : "no",
               (int)gSettings.usb);

  NimBLEDevice::init(gSettings.name.c_str());
  NimBLEDevice::setMTU(517);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

#if NIB_REQUIRE_PAIRING
  NimBLEDevice::setSecurityAuth(true, true, true);   // bonding, MITM, secure connections
  // Link diagnostics on the console: why a connection ended, whether
  // encryption came up, and what connection parameters the central accepted.
  NimBLEDevice::setCustomGapHandler([](ble_gap_event* ev, void*) -> int {
    switch (ev->type) {
      case BLE_GAP_EVENT_DISCONNECT:
        gLog->printf("[ble] %lus link closed, reason 0x%03x\n",
                     (unsigned long)(millis() / 1000), ev->disconnect.reason);
        break;
      case BLE_GAP_EVENT_ENC_CHANGE:
        gLog->printf("[ble] %lus encryption %s (status %d), %d bonds stored\n",
                     (unsigned long)(millis() / 1000), ev->enc_change.status == 0 ? "on" : "FAILED",
                     ev->enc_change.status, NimBLEDevice::getNumBonds());
        break;
      case BLE_GAP_EVENT_CONN_UPDATE:
        gLog->printf("[ble] %lus params update status %d\n",
                     (unsigned long)(millis() / 1000), ev->conn_update.status);
        break;
      default:
        break;
    }
    return 0;
  });
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
  NimBLEDevice::setSecurityPasskey(gSettings.passkey);
  const uint32_t writeProps  = NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR |
                               NIMBLE_PROPERTY::WRITE_ENC;
  const uint32_t notifyProps = NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY;
  announcePasskey();
#else
  const uint32_t writeProps  = NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR;
  const uint32_t notifyProps = NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY;
  gLog->println("[ble] WARNING: pairing disabled, anyone nearby can type");
#endif

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(NIB_SERVICE_UUID);
  svc->createCharacteristic(NIB_RX_UUID, writeProps)
     ->setCallbacks(new RxCallbacks());
  gStatusChar = svc->createCharacteristic(NIB_STATUS_UUID, notifyProps);
  publishStatus();
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(NIB_SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setName(gSettings.name.c_str());
  adv->start();

  displaySetLink(LinkState::Advertising);
  gLog->printf("[ble] advertising as %s\n", gSettings.name.c_str());
  // A buttonless board opens a pairing window on every plug-in, so a dongle
  // whose phones are all lost can still take a new one (passkey required).
  if (NIB_BOOT_PAIR_MS && gSettings.pair == PairMode::Window) openPairing("plug-in, no button");
}

void loop() {
  // The savers pace their own frames off this call, and the fastest of them
  // wants one every 55 ms, so 50 ms was too coarse to hit it cleanly. Both
  // displayTick() and the saver's tick return immediately when nothing is due,
  // and this task sits at a lower priority than hidTask, so a frame in progress
  // is preempted by a keystroke rather than delaying one.
  displayTick();

  // Lock lights changed on the host: tell the phone (from here, not from the
  // USB task that received them).
  if (gLedsNews) { gLedsNews = false; publishStatus(); }

  // The pairing window closing is news for the screen and the phone.
  if (gPairUntil && (int32_t)(gPairUntil - millis()) <= 0) {
    gPairUntil = 0;
    displaySetPairing(pairingOpen());
    gLog->println("[ble] pairing window closed");
    publishStatus();
  }

  // Decide the host once the listening window has closed.
  if (gUsbUpAt && gHost == Host::Unknown && millis() - gUsbUpAt > HOST_WINDOW_MS) {
    gHost = gLedEarly ? Host::Pc : Host::Mac;
    gLog->printf("[usb] host looks like %s (lock lights %s)\n",
                 gHost == Host::Mac ? "a Mac" : "Windows or Linux",
                 gLedEarly ? "sent" : "not sent");
    publishStatus();
  }
  delay(20);
}
