#include <Arduino.h>

#include "config.h"
#include "display.h"
#include "screensaver.h"

#if NIB_LCD_ENABLED

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Adafruit_ST7789.h>

static SPIClass lcdSpi(FSPI);

#if NIB_LCD_DRIVER == NIB_ST7789
static Adafruit_ST7789 tft(&lcdSpi, NIB_LCD_CS, NIB_LCD_DC, NIB_LCD_RST);
#else
// Adafruit's INITR_MINI160x80 assumes a 24/0 RAM offset. The common 0.96in
// modules (this dongle among them) sit at 26/1, so the stock offset left the
// last column and the bottom two rows unwritten: a strip of power-on noise
// along two edges of every screen. The offsets are protected, hence the shim.
class Panel : public Adafruit_ST7735 {
 public:
  using Adafruit_ST7735::Adafruit_ST7735;
  void ramOffset(int8_t col, int8_t row) { setColRowStart(col, row); }
};
static Panel tft(&lcdSpi, NIB_LCD_CS, NIB_LCD_DC, NIB_LCD_RST);
#endif

#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>

// The app's palette, in RGB565: true black, warm off-white, one amber accent.
static constexpr uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
static constexpr uint16_t BG     = 0x0000;
static constexpr uint16_t TEXT   = rgb565(242, 241, 237);
static constexpr uint16_t MUTED  = rgb565(120, 119, 114);
static constexpr uint16_t FAINT  = rgb565(52, 51, 49);
static constexpr uint16_t ACCENT = rgb565(237, 184, 114);
static constexpr uint16_t GOOD   = rgb565(110, 200, 140);

// Shared state. Written by other tasks, drawn only by displayTick().
static volatile LinkState gLink       = LinkState::Booting;
static volatile int       gHold       = -1;
static volatile int       gHoldStage  = 0;
static volatile uint32_t  gPasskey    = 0;
static volatile bool      gPkVisible  = true;
static volatile bool      gPkRevealed = false;
static volatile bool      gPairOpen   = true;
static char               gActivity[24] = "";
static char               gName[21] = NIB_DEVICE_NAME;
static portMUX_TYPE       gLock = portMUX_INITIALIZER_UNLOCKED;

static bool      gDirty = true;
static LinkState lastLink = (LinkState)0xff;
static int       lastHold = -2;
static int       lastStage = -1;
static uint32_t  lastPk = 0xffffffff;
static bool      lastPkShown = false;
static char      lastActivity[24] = "\x01";
static bool      lastInhibit = false;

bool displayPresent() { return true; }

#ifdef NIB_LCDSIM
// tools/lcdsim renders this exact code into images on a computer.
Adafruit_GFX* displaySimCanvas() { return &tft; }
#endif

// Every setter counts as activity: something changed that is worth looking at,
// so the saver gets out of the way and the idle timer starts again. These are
// called from the BLE worker and the button task, which is why the saver's
// activity hook is documented as safe from any task.
void displaySetLink(LinkState s)   { gLink = s; gDirty = true; screensaverNotifyActivity(); }
void displaySetHold(int s, int stage) { gHold = s; gHoldStage = stage; gDirty = true; screensaverNotifyActivity(); }
void displayRevealPasskey(bool on) { gPkRevealed = on; gDirty = true; screensaverNotifyActivity(); }
void displaySetPairing(bool open) {
  if (open == gPairOpen) return;
  gPairOpen = open;
  gDirty = true;
  screensaverNotifyActivity();
}

void displaySetPasskey(uint32_t passkey, bool visible) {
  gPasskey = passkey;
  gPkVisible = visible;
  gDirty = true;
  screensaverNotifyActivity();
}

void displaySetName(const char* name) {
  if (!name || !*name) return;
  portENTER_CRITICAL(&gLock);
  strncpy(gName, name, sizeof(gName) - 1);
  gName[sizeof(gName) - 1] = '\0';
  portEXIT_CRITICAL(&gLock);
  gDirty = true;
}

void displaySetActivity(const char* text) {
  portENTER_CRITICAL(&gLock);
  strncpy(gActivity, text, sizeof(gActivity) - 1);
  gActivity[sizeof(gActivity) - 1] = '\0';
  portEXIT_CRITICAL(&gLock);
  gDirty = true;
  screensaverNotifyActivity();
}

void displayBegin() {
#if NIB_LCD_BL >= 0
  pinMode(NIB_LCD_BL, OUTPUT);
  digitalWrite(NIB_LCD_BL, NIB_LCD_BL_ACTIVE_LOW ? HIGH : LOW);  // off while it initialises
#endif

  lcdSpi.begin(NIB_LCD_SCLK, -1, NIB_LCD_MOSI, NIB_LCD_CS);

#if NIB_LCD_DRIVER == NIB_ST7789
  tft.init(NIB_LCD_W, NIB_LCD_H);
#elif NIB_LCD_W == 80 && NIB_LCD_H == 160
  tft.initR(INITR_MINI160x80);
  tft.ramOffset(NIB_LCD_COLSTART, NIB_LCD_ROWSTART);
#else
  tft.initR(INITR_BLACKTAB);
#endif

#if NIB_LCD_INVERT
  tft.invertDisplay(true);
#endif
  tft.setRotation(NIB_LCD_ROTATION);
  tft.fillScreen(BG);

#if NIB_LCD_BL >= 0
  digitalWrite(NIB_LCD_BL, NIB_LCD_BL_ACTIVE_LOW ? LOW : HIGH);
#endif

  // Only now that the panel answers: screensaverBegin() reads NVS and does not
  // draw, so it is safe here and the first displayTick() can already be a frame.
  screensaverSetBlit([](int16_t x, int16_t y, uint16_t* px, int16_t w, int16_t h) {
    tft.drawRGBBitmap(x, y, px, w, h);
  });
  screensaverBegin();
}

// Every screen is composed off-screen and pushed in one transfer, so nothing
// flickers and no text from the previous layout can survive under the new one.
static GFXcanvas16* gFrame = nullptr;

static void centred(Adafruit_GFX& g, const char* text, const GFXfont* font,
                    int16_t baseline, uint16_t colour, int16_t cx = -1) {
  g.setFont(font);
  g.setTextSize(1);
  g.setTextWrap(false);
  int16_t x1, y1; uint16_t w, h;
  g.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  if (cx < 0) cx = g.width() / 2;
  g.setTextColor(colour);
  g.setCursor(cx - (int16_t)w / 2 - x1, baseline);
  g.print(text);
}

// The small print: the built-in 5x7 face at 1x is the crispest thing this
// panel can show, so every label uses it, in capitals, spaced out by a pixel.
static int16_t label(Adafruit_GFX& g, int16_t x, int16_t y, const char* text,
                     uint16_t colour, bool alignRight = false) {
  g.setFont(nullptr);
  g.setTextSize(1);
  g.setTextWrap(false);
  g.setTextColor(colour);
  const int16_t w = (int16_t)strlen(text) * 7 - 1;
  int16_t cx = alignRight ? x - w : x;
  for (const char* c = text; *c; c++) { g.setCursor(cx, y); g.print(*c); cx += 7; }
  return w;
}

// Just the state, top left, behind its dot. The name is the big line below,
// so a brand label here only repeated it.
static void topRow(Adafruit_GFX& g, const char* state, uint16_t dot) {
  if (dot) g.fillCircle(8, 8, 2, dot);
  label(g, dot ? 15 : 6, 5, state, MUTED);
}

static void compose(Adafruit_GFX& g, LinkState link, int hold, int stage,
                    uint32_t pk, bool pkShown, const char* activity) {
  g.fillScreen(BG);
  if (hold >= 0) {
    // Stage 0 counts to the pairing window, 1 to forgetting every phone
    // (letting go during it opens the window), 2 to the factory reset.
    const int st = stage < 0 ? 0 : stage > 2 ? 2 : stage;
    static const char* const heads[3] = { "PAIR", "FORGET ALL", "RESET" };
    static const char* const notes[3] = { "then let go", "let go now to pair", "restores defaults" };
    topRow(g, heads[st], ACCENT);
    char buf[8];
    snprintf(buf, sizeof(buf), "%d", hold);
    centred(g, buf, &FreeSansBold24pt7b, 56, ACCENT);
    centred(g, notes[st], nullptr, 66, MUTED);
    return;
  }
  switch (link) {
    case LinkState::Booting:
      centred(g, "N.I.B.", &FreeSansBold18pt7b, 52, MUTED);
      break;

    case LinkState::Advertising:
      if (!gPairOpen) {
        // Paired phones can still connect; new ones need a window first.
        topRow(g, "READY", MUTED);
        centred(g, "Paired only", &FreeSansBold12pt7b, 44, TEXT);
        centred(g, NIB_HAS_BUTTON ? "hold button 10 s to add" : "replug to add a phone",
                nullptr, 62, MUTED);
        break;
      }
      topRow(g, "PAIRING", ACCENT);
      if (pkShown) {
        char buf[8];
        snprintf(buf, sizeof(buf), "%06u", (unsigned)pk);
        centred(g, buf, &FreeSansBold18pt7b, 52, TEXT);
        label(g, (g.width() - 7 * 7 + 1) / 2, 64, "PASSKEY", MUTED);
      } else {
        centred(g, "Ready", &FreeSansBold18pt7b, 50, TEXT);
        centred(g, "shown when a phone pairs", nullptr, 62, MUTED);
      }
      break;

    case LinkState::Connected:
      topRow(g, "CONNECTED", GOOD);
      // A long name steps down a size, then loses its tail, rather than
      // running off the panel.
      {
        static const GFXfont* const sizes[] = { &FreeSansBold18pt7b, &FreeSansBold12pt7b,
                                                &FreeSansBold9pt7b };
        char name[sizeof(gName)];
        strncpy(name, gName, sizeof(name));
        name[sizeof(name) - 1] = '\0';
        const GFXfont* font = sizes[2];
        int16_t x1, y1; uint16_t w, h;
        for (const GFXfont* f : sizes) {
          g.setFont(f);
          g.getTextBounds(name, 0, 0, &x1, &y1, &w, &h);
          if (w <= g.width() - 12) { font = f; break; }
        }
        g.setFont(font);
        for (size_t n = strlen(name); n > 1; n--) {
          g.getTextBounds(name, 0, 0, &x1, &y1, &w, &h);
          if (w <= g.width() - 12) break;
          name[n - 1] = '\0';
          if (n >= 3) { name[n - 2] = '.'; name[n - 3] = '.'; }
        }
        centred(g, name, font, font == sizes[0] ? 50 : 46, TEXT);
      }
      if (activity[0]) centred(g, activity, nullptr, 64, MUTED);
      break;
  }
}

void displayTick() {
  const LinkState link = gLink;
  const int       hold = gHold;
  const int       stage = gHoldStage;
  const uint32_t  pk = gPasskey;
  const bool      pkShown = gPkVisible || gPkRevealed;

  // Two things on this screen somebody is actively reading: the passkey while a
  // phone is mid-pairing, and the button countdown. The saver is pinned off for
  // as long as either lasts. A passkey merely left on the idle screen is not one
  // of them - that is precisely the static layout the saver exists to move.
  const bool inhibit = (hold >= 0) || gPkRevealed;
  if (inhibit != lastInhibit) {
    lastInhibit = inhibit;
    screensaverInhibit(inhibit);
  }

  // Unconditional: deciding when to wake up is part of the tick's job, and it
  // paces itself, so this costs almost nothing when there is no frame due.
  screensaverTick(tft, tft.width(), tft.height());
  if (screensaverActive()) return;            // the saver owns the panel

  // It just handed the panel back, so this layout is gone. Forcing lastLink to
  // an impossible value makes the redraw below take the full-relayout path.
  if (screensaverConsumeRepaint()) {
    gDirty = true;
    lastLink = (LinkState)0xff;
  }

  char activity[24];
  portENTER_CRITICAL(&gLock);
  memcpy(activity, gActivity, sizeof(activity));
  portEXIT_CRITICAL(&gLock);

  if (!gDirty && link == lastLink && hold == lastHold && stage == lastStage &&
      pk == lastPk && pkShown == lastPkShown && strcmp(activity, lastActivity) == 0)
    return;

  const bool relayout = (link != lastLink) || (hold >= 0) != (lastHold >= 0) ||
                        stage != lastStage;
  gDirty = false;

  (void)relayout;
  if (!gFrame) gFrame = new GFXcanvas16(tft.width(), tft.height());
  if (gFrame && gFrame->getBuffer()) {
    compose(*gFrame, link, hold, stage, pk, pkShown, activity);
    tft.drawRGBBitmap(0, 0, gFrame->getBuffer(), gFrame->width(), gFrame->height());
  } else {
    compose(tft, link, hold, stage, pk, pkShown, activity);   // no memory: draw direct
  }

  lastLink = link;
  lastHold = hold;
  lastStage = stage;
  lastPk = pk;
  lastPkShown = pkShown;
  memcpy(lastActivity, activity, sizeof(lastActivity));
}

#else  // NIB_LCD_ENABLED

// Screen compiled out: same API, no code. Boards without a panel report the
// passkey over serial instead, and refuse the settings that would need eyes.
bool displayPresent() { return false; }

void displayBegin() {}
void displaySetLink(LinkState) {}
void displaySetActivity(const char*) {}
void displaySetHold(int, int) {}
void displaySetPasskey(uint32_t, bool) {}
void displayRevealPasskey(bool) {}
void displaySetPairing(bool) {}
void displaySetName(const char*) {}
void displayTick() {}

#endif // NIB_LCD_ENABLED
