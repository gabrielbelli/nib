#include <Arduino.h>

#include "config.h"
#include "screensaver.h"

#if NIB_LCD_ENABLED

#include <Preferences.h>
#include <esp_random.h>

// ---------------------------------------------------------------- drawing budget
//
// ST7735 over SPI at 15 MHz is about 12 us for 10 pixels, and every separate
// rectangle costs another ~25 us to set the address window. A full 160x80
// repaint is therefore ~14 ms of solid SPI, which is why none of these savers
// do one.
//
// The rule every renderer below obeys: no more than about 4000 pixels and 100
// rectangles per frame, so a frame costs ~6 ms, at 12-18 fps depending on the
// saver. That is under 10 % of one core, in the loop() task at priority 1 -
// the HID worker runs at priority 5 and preempts it, so typing never waits.
//
// Frame pacing is per saver: each one declares its own interval and the engine
// simply returns early until that interval has passed.

// -------------------------------------------------------------------- palette
// Nacre: warm neutrals, no saturated colour. The tints are for a hint of
// iridescence at low amplitude, never a hue you would call red or green.
static inline uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

static const uint16_t INK   = rgb(0, 0, 0);        // the field: true black, like the app
static const uint16_t SHADE = rgb(26, 23, 20);
static const uint16_t STONE = rgb(62, 56, 49);
static const uint16_t WARM  = rgb(124, 110, 96);
static const uint16_t PEARL = rgb(228, 218, 202);
static const uint16_t ROSE  = rgb(206, 168, 156);
static const uint16_t JADE  = rgb(146, 178, 166);
static const uint16_t SKY   = rgb(150, 168, 194);

// Linear blend in RGB565 space. Good enough at these amplitudes and costs
// nothing; a gamma-correct blend would not be visible on this panel.
static uint16_t mix(uint16_t a, uint16_t b, uint8_t t) {
  const int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  const int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  const int r = ar + ((br - ar) * t) / 255;
  const int g = ag + ((bg - ag) * t) / 255;
  const int bl = ab + ((bb - ab) * t) / 255;
  return (uint16_t)((r << 11) | (g << 5) | bl);
}

// One turn in 64 steps, -127..127. Every saver's motion comes from this, so
// nothing needs floating point.
static const int8_t kSin[64] = {
     0,  12,  25,  37,  49,  60,  71,  81,  90,  98, 106, 112, 117, 122, 125, 126,
   127, 126, 125, 122, 117, 112, 106,  98,  90,  81,  71,  60,  49,  37,  25,  12,
     0, -12, -25, -37, -49, -60, -71, -81, -90, -98,-106,-112,-117,-122,-125,-126,
  -127,-126,-125,-122,-117,-112,-106, -98, -90, -81, -71, -60, -49, -37, -25, -12,
};
static inline int isin(int phase) { return kSin[(uint8_t)phase & 63]; }

// ------------------------------------------------------------------- settings
static Preferences   ssPrefs;
static const char*   kNs = "nib_ss";

static bool     gEnabled  = true;
static uint8_t  gSelected = 0;
static uint16_t gIdleSecs = 60;

static char gWordmark[21] = NIB_DEVICE_NAME;

// ------------------------------------------------------------------- clock
static uint32_t gClockEpoch = 0;   // local seconds, tz already folded in
static uint32_t gClockSetAt = 0;
static bool     gClockValid = false;

// ------------------------------------------------------------------- engine
// Bounce first: it is the default, and with several dongles around it is the
// one that says which is which.
static const uint8_t BUILTIN_COUNT = 14;
static const uint8_t SS_MARK = 0, SS_PLASMA = 1, SS_STARS = 2, SS_MYSTIFY = 3,
                     SS_LIFE = 4, SS_MATRIX = 5, SS_PIPES = 6, SS_TOASTERS = 7,
                     SS_MAZE = 8, SS_FIRE = 9, SS_CUBE = 10, SS_FIREWORKS = 11,
                     SS_SWARM = 12, SS_SPIRO = 13, SS_CUSTOM = 14;

static const char* kNames[BUILTIN_COUNT] = {
  "Bounce", "Plasma", "Stars", "Mystify", "Life", "Matrix", "Pipes", "Toasters",
  "Maze", "Fire", "Cube", "Fireworks", "Swarm", "Spirograph",
};

static uint32_t gLastActivity = 0;
static bool     gInhibited    = false;
static bool     gActive       = false;
static bool     gRepaintOwed  = false;
static bool     gNeedsClear   = false;
static uint32_t gLastFrame    = 0;
static uint32_t gFrameNo      = 0;

static uint8_t  gRunning      = 0;       // the saver currently on screen
static uint32_t gRunningSince = 0;
static const uint32_t SHUFFLE_MS = 120000;

static uint8_t  gPreview      = 0xFE;    // 0xFE = not previewing
static Print*   gSsLog        = nullptr;
static uint32_t gPreviewUntil = 0;

// Built once by ensureRamps(): mix() is not constexpr, so these cannot be
// static initialisers.
static uint16_t gFlow[8];
static uint16_t gLustreField[2];
static bool     gRampReady = false;

static void ensureRamps() {
  if (gRampReady) return;
  gFlow[0] = INK;
  gFlow[1] = mix(INK, SHADE, 150);
  gFlow[2] = SHADE;
  gFlow[3] = mix(SHADE, STONE, 110);
  gFlow[4] = STONE;
  gFlow[5] = mix(STONE, WARM, 120);
  gFlow[6] = WARM;
  gFlow[7] = mix(WARM, PEARL, 60);
  gLustreField[0] = mix(INK, SHADE, 90);
  gLustreField[1] = mix(INK, SHADE, 30);
  gRampReady = true;
}

// ------------------------------------------------------- custom animation store
struct SsCustom {
  uint8_t  version;
  uint8_t  kind;
  uint8_t  w, h, frames;
  uint8_t  frameMs10;
  uint8_t  motion;
  uint8_t  pad;
  uint16_t tint;
  uint16_t back;
  uint16_t len;
  char     name[16];
};

static SsCustom  gCustomHdr;
static uint8_t*  gCustomPx    = nullptr;
static bool      gCustomValid = false;

// Written by whichever task handles BLE packets, adopted by the drawing task at
// a frame boundary. That keeps the swap off the render path without a mutex.
static SsCustom  gPendingHdr;
// screensaverImport* runs on the task that services BLE writes, while the tick
// path runs on loop(). Both free and reassign the same pointers, so every
// touch of the staging buffer takes this lock. A plain critical section will
// not do: free() and malloc() must not run inside one.
static SemaphoreHandle_t impLock = nullptr;

struct ImpGuard {
  ImpGuard()  { if (impLock) xSemaphoreTake(impLock, portMAX_DELAY); }
  ~ImpGuard() { if (impLock) xSemaphoreGive(impLock); }
};

static uint8_t*  gPendingPx   = nullptr;
static volatile bool gAdoptReq = false;
static volatile bool gClearReq = false;

static uint8_t* ssAlloc(size_t n) {
  uint8_t* p = (uint8_t*)ps_malloc(n);          // PSRAM first, it is plentiful
  if (!p) p = (uint8_t*)malloc(n);
  return p;
}

static uint32_t ssCrc32(const uint8_t* d, size_t n) {
  uint32_t c = 0xFFFFFFFFu;
  while (n--) {
    c ^= *d++;
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ ((c & 1) ? 0xEDB88320u : 0u);
  }
  return ~c;
}

// ---------------------------------------------------------------- persistence
static void ssSaveConfig() {
  ssPrefs.begin(kNs, false);
  ssPrefs.putBool("on", gEnabled);
  ssPrefs.putUChar("sel3", gSelected);   // "sel", "sel2" held older numberings
  ssPrefs.putUShort("idle", gIdleSecs);
  ssPrefs.end();
}

static void ssLoadCustom() {
  ssPrefs.begin(kNs, true);
  const size_t hn = ssPrefs.getBytesLength("cs.hdr");
  if (hn == sizeof(SsCustom)) {
    SsCustom h;
    ssPrefs.getBytes("cs.hdr", &h, sizeof(h));
    const size_t pn = ssPrefs.getBytesLength("cs.px");
    if (h.version == 1 && h.kind == 1 && h.len == pn && pn > 0 &&
        pn <= SS_CUSTOM_MAX_BYTES) {
      uint8_t* px = ssAlloc(pn);
      if (px && ssPrefs.getBytes("cs.px", px, pn) == pn) {
        gCustomHdr   = h;
        gCustomPx    = px;
        gCustomValid = true;
      } else {
        free(px);
      }
    }
  }
  ssPrefs.end();
}

// =============================================================== renderers
//
// Each takes the target, its size, and whether this is the first frame since
// the panel was cleared - the first frame is where static background goes.

#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>

// The app's palette. INK (true black) is defined above.
static const uint16_t C_TEXT   = rgb(242, 241, 237);
static const uint16_t C_MUTED  = rgb(120, 119, 114);
static const uint16_t C_FAINT  = rgb(40, 39, 37);
static const uint16_t C_ACCENT = rgb(237, 184, 114);

// Whole-frame and sprite pushes go through the panel's own bulk write, which
// the display module hands over. Through the plain Adafruit_GFX reference they
// would fall back to one address window per pixel.
static SsBlit gBlit = nullptr;
void screensaverSetBlit(SsBlit blit) { gBlit = blit; }
static void blit(Adafruit_GFX& g, int16_t x, int16_t y, uint16_t* px, int16_t w, int16_t h) {
  if (gBlit) gBlit(x, y, px, w, h);
  else g.drawRGBBitmap(x, y, px, w, h);
}

// One off-screen canvas, the size of the panel, shared by the savers that
// compose a whole frame (Clock, Plasma rows use their own line).
static GFXcanvas16* gCanvas = nullptr;
static GFXcanvas16* canvas(int16_t w, int16_t h) {
  if (!gCanvas) gCanvas = new GFXcanvas16(w, h);
  return (gCanvas && gCanvas->getBuffer()) ? gCanvas : nullptr;
}

// 256-step sine, 0..255, for the savers that want smooth fields.
static uint8_t kSin8[256];
static bool    kSin8Ready = false;
static void ensureSin8() {
  if (kSin8Ready) return;
  for (int i = 0; i < 256; i++) kSin8[i] = (uint8_t)(128 + 127 * sinf(i * 6.2831853f / 256));
  kSin8Ready = true;
}

static uint16_t lerp565(uint16_t a, uint16_t b, int t, int n) {
  return mix(a, b, (uint8_t)((t * 255) / n));
}

// ---- 1 Plasma --------------------------------------------------------------
// A slow interference field through the app's warm palette: black, ember,
// amber, pearl and back. Full resolution, one row at a time.
static uint16_t plPal[256];
static bool     plReady = false;
static uint16_t plRow[320];

static void ensurePlasma() {
  if (plReady) return;
  ensureSin8();
  // Mostly black, with the accent glowing through: the panel stays dark, as
  // the app does, and only the crests of the field light up.
  const uint16_t stops[8] = { INK, INK, INK, INK, rgb(34, 12, 6), rgb(130, 60, 28),
                              C_ACCENT, rgb(60, 22, 10) };
  for (int i = 0; i < 256; i++) {
    const int seg = i * 8 / 256, t = i * 8 % 256;
    plPal[i] = mix(stops[seg], stops[(seg + 1) % 8], (uint8_t)t);
  }
  plReady = true;
}

static void drawPlasma(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  (void)first;
  ensurePlasma();
  const uint32_t f = gFrameNo;
  const uint8_t t1 = (uint8_t)(f * 1), t2 = (uint8_t)(f * 2), t3 = (uint8_t)(f / 2);
  // A drifting centre for the radial term.
  const int16_t cx = (int16_t)(w / 2 + ((int)kSin8[(uint8_t)(f / 3)] - 128) * w / 512);
  const int16_t cy = (int16_t)(h / 2 + ((int)kSin8[(uint8_t)(f / 4 + 64)] - 128) * h / 512);
  if (w > (int16_t)(sizeof(plRow) / 2)) return;
  for (int16_t y = 0; y < h; y++) {
    const uint8_t sy = kSin8[(uint8_t)(y * 5 - t2)];
    const int dy = y - cy;
    for (int16_t x = 0; x < w; x++) {
      const int dx = x - cx;
      const uint8_t r = (uint8_t)((dx * dx + dy * dy * 4) >> 6);
      const int v = kSin8[(uint8_t)(x * 3 + t1)] + sy + kSin8[(uint8_t)((x + y) * 2 + t3)]
                  + kSin8[(uint8_t)(r - t2)];
      plRow[x] = plPal[(uint8_t)((v >> 2) + t3)];
    }
    blit(g, 0, y, plRow, w, 1);
  }
}

// ---- 2 Stars ---------------------------------------------------------------
// Flying through a star field. Near stars are brighter and two pixels wide;
// a few are tinted with the accent.
static const int SR_N = 140;
struct Star { int16_t x, y, z; int16_t px, py; uint8_t s; bool warm; };
static Star srStars[SR_N];

static void srReset(Star& st, bool anyDepth) {
  st.x = (int16_t)((int)(esp_random() % 2000) - 1000);
  st.y = (int16_t)((int)(esp_random() % 1000) - 500);
  st.z = anyDepth ? (int16_t)(40 + esp_random() % 960) : 1000;
  st.px = -1; st.s = 0;
  st.warm = (esp_random() % 7) == 0;
}

static void drawStars(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  if (first) for (auto& st : srStars) srReset(st, true);
  g.startWrite();
  for (auto& st : srStars) {
    if (st.px >= 0) g.writeFillRect(st.px, st.py, st.s, st.s, INK);
    st.z -= 9;
    if (st.z < 20) { srReset(st, false); continue; }
    const int16_t sx = (int16_t)(w / 2 + (int32_t)st.x * 90 / st.z);
    const int16_t sy = (int16_t)(h / 2 + (int32_t)st.y * 90 / st.z);
    if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { srReset(st, false); continue; }
    const int b = 330 - st.z / 3;                       // far ones faint, near ones full
    const uint8_t sz = st.z < 260 ? 2 : 1;
    const uint16_t c = mix(INK, st.warm ? C_ACCENT : C_TEXT, (uint8_t)(b < 90 ? 90 : b > 255 ? 255 : b));
    g.writeFillRect(sx, sy, sz, sz, c);
    st.px = sx; st.py = sy; st.s = sz;
  }
  g.endWrite();
}

// ---- 3 Mystify -------------------------------------------------------------
// Two polygons bouncing off the edges, each trailing spaced, fading copies of
// itself. The old Windows saver, in the app's colours. Composed off-screen and
// pushed whole, so crossing lines never leave gaps.
static const int MY_HIST = 16, MY_STEP = 4;      // four copies, four frames apart
struct MyPoly { int16_t x[4], y[4], vx[4], vy[4]; int16_t hx[MY_HIST][4], hy[MY_HIST][4]; uint8_t head; };
static MyPoly myP[2];

static void drawMystify(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  if (first) {
    for (auto& p : myP) {
      for (int i = 0; i < 4; i++) {
        p.x[i] = (int16_t)((esp_random() % w) * 16); p.y[i] = (int16_t)((esp_random() % h) * 16);
        p.vx[i] = (int16_t)((10 + esp_random() % 18) * ((esp_random() & 1) ? 1 : -1));
        p.vy[i] = (int16_t)((6 + esp_random() % 12) * ((esp_random() & 1) ? 1 : -1));
      }
      for (int k = 0; k < MY_HIST; k++) for (int i = 0; i < 4; i++) { p.hx[k][i] = p.x[i] >> 4; p.hy[k][i] = p.y[i] >> 4; }
      p.head = 0;
    }
  }
  GFXcanvas16* c = canvas(w, h);
  Adafruit_GFX& t = c ? (Adafruit_GFX&)*c : g;
  t.fillScreen(INK);
  const uint16_t base[2] = { C_ACCENT, rgb(150, 190, 230) };
  for (int n = 0; n < 2; n++) {
    MyPoly& p = myP[n];
    p.head = (uint8_t)((p.head + 1) % MY_HIST);
    for (int i = 0; i < 4; i++) {
      p.x[i] += p.vx[i]; p.y[i] += p.vy[i];
      if (p.x[i] < 0 || p.x[i] >= (w - 1) * 16) { p.vx[i] = -p.vx[i]; p.x[i] += 2 * p.vx[i]; }
      if (p.y[i] < 0 || p.y[i] >= (h - 1) * 16) { p.vy[i] = -p.vy[i]; p.y[i] += 2 * p.vy[i]; }
      p.hx[p.head][i] = p.x[i] >> 4; p.hy[p.head][i] = p.y[i] >> 4;
    }
    for (int k = MY_HIST / MY_STEP - 1; k >= 0; k--) {
      const uint8_t idx = (uint8_t)((p.head + MY_HIST - k * MY_STEP) % MY_HIST);
      const uint16_t col = mix(INK, base[n], (uint8_t)(255 - k * 60));
      for (int i = 0; i < 4; i++)
        t.drawLine(p.hx[idx][i], p.hy[idx][i], p.hx[idx][(i + 1) & 3], p.hy[idx][(i + 1) & 3], col);
    }
  }
  if (c) blit(g, 0, 0, c->getBuffer(), w, h);
}

// ---- 4 Life ----------------------------------------------------------------
// Conway's Game of Life on 3x3 cells. Newborn cells are amber and cool to a
// dim ember as they age; a stuck or empty world reseeds itself.
static const int LF_CELL = 3;
static uint8_t* lfA = nullptr;
static uint8_t* lfB = nullptr;
static int16_t  lfW = 0, lfH = 0;
static uint32_t lfSeedAt = 0, lfLastHash = 0;
static uint8_t  lfSame = 0;

static uint16_t lfColour(uint8_t age) {
  static const uint16_t young = C_ACCENT, old = rgb(90, 44, 30);
  return age >= 24 ? old : lerp565(young, old, age, 24);
}

static void lfSeed(Adafruit_GFX& g) {
  for (int i = 0; i < lfW * lfH; i++) lfA[i] = (esp_random() % 100) < 30 ? 1 : 0;
  lfSeedAt = millis(); lfSame = 0;
  g.fillScreen(INK);
}

static void drawLife(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  if (!lfA) {
    lfW = w / LF_CELL; lfH = h / LF_CELL;
    lfA = ssAlloc((size_t)lfW * lfH); lfB = ssAlloc((size_t)lfW * lfH);
    if (!lfA || !lfB) return;
    first = true;
  }
  if (first || millis() - lfSeedAt > 90000 || lfSame > 20) lfSeed(g);
  const int16_t ox = (w - lfW * LF_CELL) / 2, oy = (h - lfH * LF_CELL) / 2;
  uint32_t hash = 2166136261u; int pop = 0;
  g.startWrite();
  for (int16_t y = 0; y < lfH; y++) {
    for (int16_t x = 0; x < lfW; x++) {
      int n = 0;
      for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const int xx = (x + dx + lfW) % lfW, yy = (y + dy + lfH) % lfH;
        n += lfA[yy * lfW + xx] ? 1 : 0;
      }
      const uint8_t cur = lfA[y * lfW + x];
      uint8_t nxt = 0;
      if (cur) nxt = (n == 2 || n == 3) ? (uint8_t)(cur < 250 ? cur + 1 : cur) : 0;
      else     nxt = (n == 3) ? 1 : 0;
      lfB[y * lfW + x] = nxt;
      if (nxt) { pop++; hash = (hash ^ (uint32_t)(y * lfW + x)) * 16777619u; }
      const bool changed = (cur == 0) != (nxt == 0) || (nxt && nxt <= 25 && lfColour(cur) != lfColour(nxt));
      if (changed || first)
        g.writeFillRect(ox + x * LF_CELL, oy + y * LF_CELL, LF_CELL - 1, LF_CELL - 1,
                        nxt ? lfColour(nxt - 1) : INK);
    }
  }
  g.endWrite();
  uint8_t* t = lfA; lfA = lfB; lfB = t;
  if (hash == lfLastHash || pop < 12) lfSame++; else lfSame = 0;
  lfLastHash = hash;
}

// ---- 5 Bounce --------------------------------------------------------------
// The device name gliding corner to corner and changing colour at every wall,
// like the DVD logo. With several dongles around, it also says which is which.
static GFXcanvas16* bnSprite = nullptr;
static int16_t bnX = 0, bnY = 0, bnVx = 1, bnVy = 1, bnW = 0, bnH = 0;
static uint8_t bnHue = 0;
static const int16_t BN_PAD = 1;

static void bnRender() {
  static const uint16_t hues[5] = { C_ACCENT, C_TEXT, rgb(150, 190, 230), rgb(226, 150, 160), rgb(150, 210, 170) };
  bnSprite->fillScreen(INK);
  bnSprite->setFont(&FreeSansBold12pt7b);
  bnSprite->setTextWrap(false);
  int16_t x1, y1; uint16_t tw, th;
  bnSprite->getTextBounds(gWordmark, 0, 0, &x1, &y1, &tw, &th);
  bnSprite->setTextColor(hues[bnHue % 5]);
  bnSprite->setCursor(BN_PAD - x1, BN_PAD - y1);
  bnSprite->print(gWordmark);
}

static void drawBounce(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  if (first || !bnSprite) {
    delete bnSprite; bnSprite = nullptr;
    GFXcanvas16 probe(1, 1);
    probe.setFont(&FreeSansBold12pt7b);
    probe.setTextWrap(false);            // a 1 px canvas would wrap every glyph
    int16_t x1, y1; uint16_t tw, th;
    probe.getTextBounds(gWordmark, 0, 0, &x1, &y1, &tw, &th);
    bnW = (int16_t)min((int)tw + 2 * BN_PAD, (int)w);
    bnH = (int16_t)min((int)th + 2 * BN_PAD, (int)h);
    bnSprite = new GFXcanvas16(bnW, bnH);
    if (!bnSprite->getBuffer()) { delete bnSprite; bnSprite = nullptr; return; }
    bnX = (int16_t)(esp_random() % (w - bnW + 1)); bnY = (int16_t)(esp_random() % (h - bnH + 1));
    bnVx = (esp_random() & 1) ? 1 : -1; bnVy = (esp_random() & 1) ? 1 : -1;
    bnRender();
  }
  bool hit = false;
  bnX += bnVx; bnY += bnVy;
  if (bnX <= 0 || bnX >= w - bnW) { bnVx = -bnVx; bnX = bnX <= 0 ? 0 : w - bnW; hit = true; }
  if (bnY <= 0 || bnY >= h - bnH) { bnVy = -bnVy; bnY = bnY <= 0 ? 0 : h - bnH; hit = true; }
  if (hit) { bnHue++; bnRender(); }
  // The sprite's one-pixel black border erases the trail of a one-pixel step.
  blit(g, bnX, bnY, bnSprite->getBuffer(), bnW, bnH);
}

// ---- 5 Matrix --------------------------------------------------------------
// Digital rain. Each column drops a bright head at its own speed, leaving a
// trail that fades through green; glyphs under the trail flicker to new ones.
static const int MX_CW = 6, MX_CH = 8;           // the built-in 5x7 face, one cell
static const int MX_COLS = 160 / MX_CW + 1, MX_ROWS = 80 / MX_CH + 1;
static uint8_t  mxGlyph[MX_COLS][MX_ROWS];
static uint8_t  mxLight[MX_COLS][MX_ROWS];       // 255 = the head, fading to 0
static int16_t  mxHead[MX_COLS];                 // head row, in 1/4 cells
static uint8_t  mxSpeed[MX_COLS];                // 1/4 cells per frame

static uint8_t mxRandGlyph() {
  // Digits, capitals and a few symbols from the built-in face: the closest
  // this panel gets to the film's half-width katakana.
  static const char set[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$+-*/=<>:;|";
  const uint32_t r = esp_random();
  if ((r & 7) == 0) return (uint8_t)(0xB3 + (r >> 8) % 40);   // box-drawing shapes, no solid blocks
  return (uint8_t)set[(r >> 8) % (sizeof(set) - 1)];
}

static void mxDrop(int c, bool anywhere) {
  mxHead[c] = anywhere ? (int16_t)(-(int)(esp_random() % (MX_ROWS * 8)) * 4 / 4)
                       : (int16_t)(-(int)(esp_random() % (MX_ROWS * 2)) * 4);
  mxSpeed[c] = (uint8_t)(1 + esp_random() % 3);
}

static void drawMatrix(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  const int cols = min((int)MX_COLS, w / MX_CW + 1), rows = min((int)MX_ROWS, h / MX_CH + 1);
  if (first) {
    for (int c = 0; c < cols; c++) {
      for (int r = 0; r < rows; r++) { mxGlyph[c][r] = mxRandGlyph(); mxLight[c][r] = 0; }
      mxDrop(c, true);
    }
  }
  for (int c = 0; c < cols; c++) {
    for (int r = 0; r < rows; r++) {
      if (mxLight[c][r] > 14) mxLight[c][r] -= 14; else mxLight[c][r] = 0;
      if (mxLight[c][r] && (esp_random() % 23) == 0) mxGlyph[c][r] = mxRandGlyph();
    }
    const int before = mxHead[c] >> 2;
    mxHead[c] += mxSpeed[c];
    const int now = mxHead[c] >> 2;
    for (int r = max(before, 0); r <= now && r < rows; r++) {
      if (r < 0) continue;
      mxLight[c][r] = 255;
      mxGlyph[c][r] = mxRandGlyph();
    }
    if (now - 14 > rows) mxDrop(c, false);
  }

  GFXcanvas16* cv = canvas(w, h);
  Adafruit_GFX& t = cv ? (Adafruit_GFX&)*cv : g;
  t.fillScreen(INK);
  t.setFont(nullptr);
  t.setTextSize(1);
  t.setTextWrap(false);
  t.cp437(true);
  const uint16_t head = rgb(210, 255, 220), bright = rgb(60, 255, 110), deep = rgb(0, 70, 25);
  for (int c = 0; c < cols; c++) {
    const int hr = mxHead[c] >> 2;
    for (int r = 0; r < rows; r++) {
      const uint8_t L = mxLight[c][r];
      if (!L) continue;
      const uint16_t col = (r == hr) ? head
                         : (L > 128 ? mix(deep, bright, (uint8_t)((L - 128) * 2))
                                    : mix(INK, deep, (uint8_t)(L * 2)));
      t.drawChar(c * MX_CW, r * MX_CH, mxGlyph[c][r], col, col, 1);
    }
  }
  if (cv) blit(g, 0, 0, cv->getBuffer(), w, h);
}

// Shared by the classics below: the persistent canvas, and a quick way to
// push it. Savers that accumulate (Pipes, Maze, Spirograph) draw into it
// without clearing; the rest clear it themselves.
static inline uint32_t rnd(uint32_t n) { return n ? esp_random() % n : 0; }
static void push(Adafruit_GFX& g, GFXcanvas16* c) { if (c) blit(g, 0, 0, c->getBuffer(), c->width(), c->height()); }
static uint16_t shade(uint16_t c, int k) {        // k 0..255: 0 black, 128 as is, 255 near white
  return k < 128 ? mix(INK, c, (uint8_t)(k * 2)) : mix(c, 0xFFFF, (uint8_t)((k - 128) * 2));
}
static const uint16_t kVivid[7] = { 0xF800, 0x07E0, 0x001F, 0xFFE0, 0x07FF, 0xF81F, 0xC618 };

// ---- 6 Pipes ---------------------------------------------------------------
// The Windows 3D Pipes, flattened onto a grid: shaded tubes grow cell by
// cell, turn with a ball joint, and start again in a new colour when stuck.
static const int PP_C = 6;                        // cell pitch, px; the tube is 4 of them
static uint8_t  ppGrid[160 / PP_C][80 / PP_C];
struct Pipe { int8_t x, y, dx, dy; uint16_t col; bool alive; };
static Pipe     ppP[2];
static uint16_t ppSteps = 0;

// A tube runs the full cell along its axis and 4 px across it, centred, so
// neighbours never touch; the four rows are shaded as a lit cylinder.
static void ppTube(Adafruit_GFX& t, int x, int y, bool horiz, uint16_t col) {
  static const int k[4] = { 90, 170, 230, 120 };
  for (int i = 0; i < 4; i++) {
    const uint16_t c = shade(col, k[i]);
    if (horiz) t.drawFastHLine(x * PP_C, y * PP_C + 1 + i, PP_C, c);
    else       t.drawFastVLine(x * PP_C + 1 + i, y * PP_C, PP_C, c);
  }
}
static void ppJoint(Adafruit_GFX& t, int x, int y, uint16_t col) {
  const int cx = x * PP_C + 3, cy = y * PP_C + 3;
  t.fillCircle(cx, cy, 3, shade(col, 120));
  t.fillCircle(cx, cy, 2, shade(col, 170));
  t.drawPixel(cx - 1, cy - 1, shade(col, 240));
}
static void ppSpawn(Pipe& p, int gw, int gh) {
  for (int tries = 0; tries < 40; tries++) {
    const int x = (int)rnd(gw), y = (int)rnd(gh);
    if (ppGrid[x][y]) continue;
    p.x = (int8_t)x; p.y = (int8_t)y;
    const int d = (int)rnd(4);
    p.dx = (int8_t)(d == 0 ? 1 : d == 1 ? -1 : 0); p.dy = (int8_t)(d == 2 ? 1 : d == 3 ? -1 : 0);
    p.col = kVivid[rnd(6)]; p.alive = true; ppGrid[x][y] = 1;
    return;
  }
  p.alive = false;
}
static void drawPipes(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  const int gw = min(w / PP_C, 160 / PP_C), gh = min(h / PP_C, 80 / PP_C);
  if (first || ppSteps > 260) {
    c->fillScreen(INK); memset(ppGrid, 0, sizeof(ppGrid)); ppSteps = 0;
    for (auto& p : ppP) ppSpawn(p, gw, gh);
  }
  for (auto& p : ppP) {
    if (!p.alive) { ppSpawn(p, gw, gh); continue; }
    bool turned = false;
    if (rnd(100) < 14) { const int8_t t = p.dx; p.dx = p.dy; p.dy = t; if (rnd(2)) { p.dx = -p.dx; p.dy = -p.dy; } turned = true; }
    int nx = p.x + p.dx, ny = p.y + p.dy;
    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || ppGrid[nx][ny]) {
      // try the two perpendiculars before giving up
      bool ok = false;
      for (int k = 0; k < 2 && !ok; k++) {
        const int8_t dx = k ? -p.dy : p.dy, dy = k ? p.dx : -p.dx;
        const int ax = p.x + dx, ay = p.y + dy;
        if (ax >= 0 && ay >= 0 && ax < gw && ay < gh && !ppGrid[ax][ay]) { p.dx = dx; p.dy = dy; nx = ax; ny = ay; ok = true; turned = true; }
      }
      if (!ok) { ppJoint(*c, p.x, p.y, p.col); p.alive = false; continue; }
    }
    if (turned) ppJoint(*c, p.x, p.y, p.col);
    else ppTube(*c, p.x, p.y, p.dx != 0, p.col);
    p.x = (int8_t)nx; p.y = (int8_t)ny; ppGrid[nx][ny] = 1;
    ppTube(*c, nx, ny, p.dx != 0, p.col);
    ppSteps++;
  }
  push(g, c);
}

// ---- 7 Toasters ------------------------------------------------------------
// After Dark's Flying Toasters: chrome toasters flapping across the sky with
// the odd slice of toast, down and to the left, forever.
struct Flyer { int16_t x, y; uint8_t kind, phase, speed; };
static Flyer tsF[7];
static void tsPlace(Flyer& f, int16_t w, int16_t h, bool anywhere) {
  f.kind = rnd(4) == 0 ? 1 : 0; f.phase = (uint8_t)rnd(8); f.speed = (uint8_t)(2 + rnd(3));
  if (anywhere) { f.x = (int16_t)(rnd(w + 40) * 4); f.y = (int16_t)(rnd(h + 20) * 4 - 80); }
  else if (rnd(2)) { f.x = (int16_t)((w + 10 + rnd(30)) * 4); f.y = (int16_t)(rnd(h) * 4 - 60); }
  else { f.x = (int16_t)(rnd(w + 40) * 4); f.y = (int16_t)(-24 * 4); }
}
static void tsToaster(Adafruit_GFX& t, int x, int y, uint8_t phase) {
  const uint16_t chrome = rgb(200, 200, 208), dark = rgb(90, 92, 100), hi = rgb(250, 250, 255);
  t.fillRoundRect(x, y + 4, 16, 11, 3, chrome);
  t.drawFastHLine(x + 3, y + 6, 10, dark);           // slot
  t.drawFastHLine(x + 2, y + 5, 12, hi);
  t.fillRect(x + 12, y + 10, 3, 2, dark);            // lever
  // wings: four flap positions, up, level, down, level
  const int f = (phase / 2) % 4, wy = f == 0 ? -10 : f == 2 ? 3 : -4;
  const uint16_t wing = rgb(250, 250, 252), wingBack = rgb(170, 172, 182);
  t.fillTriangle(x + 7, y + 6, x + 12, y + 6, x + 20, y + 6 + wy, wingBack);   // far wing
  t.fillTriangle(x + 3, y + 6, x + 9, y + 6, x - 6, y + 6 + wy, wing);         // near wing
  t.drawLine(x + 3, y + 6, x - 6, y + 6 + wy, rgb(150, 152, 160));
}
static void tsToast(Adafruit_GFX& t, int x, int y) {
  t.fillRoundRect(x, y, 10, 9, 2, rgb(150, 92, 40));
  t.fillRect(x + 1, y + 2, 8, 6, rgb(222, 168, 96));
}
static void drawToasters(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  if (first) for (auto& f : tsF) tsPlace(f, w, h, true);
  c->fillScreen(INK);
  for (auto& f : tsF) {
    f.x -= f.speed * 2; f.y += f.speed; f.phase++;
    const int x = f.x / 4, y = f.y / 4;
    if (x < -24 || y > h + 2) { tsPlace(f, w, h, false); continue; }
    if (f.kind) tsToast(*c, x, y); else tsToaster(*c, x, y, f.phase);
  }
  push(g, c);
}

// ---- 8 Maze ----------------------------------------------------------------
// xscreensaver's maze: carved by a depth-first walk you can watch, then solved
// the same way, the search in the accent and the answer in white.
static const int MZ_P = 4;                        // cell pitch: 3 px corridor, 1 px wall
static const int MZ_W = 160 / MZ_P, MZ_H = 80 / MZ_P;
static uint8_t  mzCell[MZ_W][MZ_H];               // bit0 visited, bit1 open E, bit2 open S, bit3 on path, bit4 searched
static uint16_t mzStack[MZ_W * MZ_H];
static int      mzTop = 0, mzPhase = 0, mzWait = 0, mzW = MZ_W, mzH = MZ_H;

static void mzRect(Adafruit_GFX& t, int x, int y, uint16_t c) { t.fillRect(x * MZ_P + 1, y * MZ_P + 1, MZ_P - 1, MZ_P - 1, c); }
static void mzOpen(Adafruit_GFX& t, int x, int y, int nx, int ny, uint16_t c) {
  if (nx > x) mzCell[x][y] |= 2; else if (nx < x) mzCell[nx][ny] |= 2;
  else if (ny > y) mzCell[x][y] |= 4; else mzCell[nx][ny] |= 4;
  const int ax = min(x, nx), ay = min(y, ny);
  if (nx != x) t.drawFastVLine(ax * MZ_P + MZ_P, ay * MZ_P + 1, MZ_P - 1, c);
  else         t.drawFastHLine(ax * MZ_P + 1, ay * MZ_P + MZ_P, MZ_P - 1, c);
}
static bool mzLinked(int x, int y, int nx, int ny) {
  if (nx > x) return mzCell[x][y] & 2; if (nx < x) return mzCell[nx][ny] & 2;
  if (ny > y) return mzCell[x][y] & 4; return mzCell[nx][ny] & 4;
}
static void drawMaze(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  const uint16_t wall = rgb(70, 68, 64), floorc = rgb(20, 20, 22), carve = C_TEXT;
  if (first || mzPhase == 3) {
    if (!first && --mzWait > 0) return;
    mzW = min(MZ_W, (w - 1) / MZ_P); mzH = min(MZ_H, (h - 1) / MZ_P);
    c->fillScreen(INK);
    c->fillRect(0, 0, mzW * MZ_P + 1, mzH * MZ_P + 1, wall);
    memset(mzCell, 0, sizeof(mzCell));
    mzTop = 0; mzStack[mzTop++] = 0; mzCell[0][0] = 1; mzRect(*c, 0, 0, carve);
    mzPhase = 0;
  }
  static const int8_t DX[4] = { 1, -1, 0, 0 }, DY[4] = { 0, 0, 1, -1 };
  for (int step = 0; step < 6; step++) {
    if (mzPhase == 0) {                               // carving
      if (!mzTop) {
        for (int x = 0; x < mzW; x++) for (int y = 0; y < mzH; y++) { mzCell[x][y] &= ~1; }
        for (int x = 0; x < mzW; x++) for (int y = 0; y < mzH; y++) mzRect(*c, x, y, floorc);
        for (int x = 0; x < mzW; x++) for (int y = 0; y < mzH; y++) {
          if (mzCell[x][y] & 2) c->drawFastVLine(x * MZ_P + MZ_P, y * MZ_P + 1, MZ_P - 1, floorc);
          if (mzCell[x][y] & 4) c->drawFastHLine(x * MZ_P + 1, y * MZ_P + MZ_P, MZ_P - 1, floorc);
        }
        mzTop = 0; mzStack[mzTop++] = 0; mzCell[0][0] |= 1 | 16; mzPhase = 1; break;
      }
      const int x = mzStack[mzTop - 1] % MZ_W, y = mzStack[mzTop - 1] / MZ_W;
      int opts[4], n = 0;
      for (int d = 0; d < 4; d++) { const int nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < mzW && ny < mzH && !(mzCell[nx][ny] & 1)) opts[n++] = d; }
      if (!n) { mzRect(*c, x, y, mzCell[x][y] & 1 ? floorc : carve); mzTop--; if (mzTop) { const int px = mzStack[mzTop - 1] % MZ_W, py = mzStack[mzTop - 1] / MZ_W; mzOpen(*c, px, py, x, y, floorc); } continue; }
      const int d = opts[rnd(n)], nx = x + DX[d], ny = y + DY[d];
      mzCell[nx][ny] |= 1; mzOpen(*c, x, y, nx, ny, carve); mzRect(*c, nx, ny, carve);
      mzStack[mzTop++] = (uint16_t)(ny * MZ_W + nx);
    } else if (mzPhase == 1) {                        // solving, top left to bottom right
      if (!mzTop) { mzPhase = 3; mzWait = 60; break; }
      const int x = mzStack[mzTop - 1] % MZ_W, y = mzStack[mzTop - 1] / MZ_W;
      mzRect(*c, x, y, C_TEXT);
      if (x == mzW - 1 && y == mzH - 1) { mzPhase = 3; mzWait = 70; break; }
      int d = 0; bool moved = false;
      for (; d < 4; d++) { const int nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < mzW && ny < mzH && !(mzCell[nx][ny] & 16) && mzLinked(x, y, nx, ny)) {
          mzCell[nx][ny] |= 16; mzStack[mzTop++] = (uint16_t)(ny * MZ_W + nx);
          if (nx != x) c->drawFastVLine(min(x, nx) * MZ_P + MZ_P, y * MZ_P + 1, MZ_P - 1, C_TEXT);
          else         c->drawFastHLine(x * MZ_P + 1, min(y, ny) * MZ_P + MZ_P, MZ_P - 1, C_TEXT);
          moved = true; break; } }
      if (!moved) {                                   // dead end: mark it searched, back up
        mzRect(*c, x, y, rgb(120, 70, 30)); mzTop--;
        if (mzTop) { const int px = mzStack[mzTop - 1] % MZ_W, py = mzStack[mzTop - 1] / MZ_W;
          if (px != x) c->drawFastVLine(min(x, px) * MZ_P + MZ_P, y * MZ_P + 1, MZ_P - 1, rgb(120, 70, 30));
          else         c->drawFastHLine(x * MZ_P + 1, min(y, py) * MZ_P + MZ_P, MZ_P - 1, rgb(120, 70, 30)); }
      }
    }
  }
  push(g, c);
}

// ---- 9 Fire ----------------------------------------------------------------
// The demoscene fire: a hot bottom row, every pixel the cooling average of the
// ones beneath it, through black, red, orange, yellow and white.
static uint8_t* frHeat = nullptr;
static uint16_t frPal[256];
static void drawFire(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  const int fw = w / 2, fh = h / 2 + 2;              // half resolution: chunkier, and a real fire's scale
  if (!frHeat) { frHeat = ssAlloc((size_t)fw * fh); if (!frHeat) return;
    for (int i = 0; i < 256; i++) {
      const int r = min(255, i * 3), gg = max(0, min(255, i * 3 - 255)), b = max(0, min(255, i * 3 - 510));
      frPal[i] = rgb((uint8_t)r, (uint8_t)gg, (uint8_t)b);
    } }
  if (first) memset(frHeat, 0, (size_t)fw * fh);
  for (int x = 0; x < fw; x++) frHeat[(fh - 1) * fw + x] = (uint8_t)(rnd(4) ? 160 + rnd(96) : rnd(60));
  for (int y = 0; y < fh - 1; y++) for (int x = 0; x < fw; x++) {
    const int b = (y + 1) * fw;
    const int s = frHeat[b + (x + fw - 1) % fw] + frHeat[b + x] + frHeat[b + (x + 1) % fw]
                + frHeat[min(fh - 1, y + 2) * fw + x];
    const int v = (s >> 2) - 4 - (int)rnd(3);   // cooling: flames reach about half way up
    frHeat[y * fw + x] = (uint8_t)(v < 0 ? 0 : v);
  }
  uint16_t* px = c->getBuffer();
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) px[y * w + x] = frPal[frHeat[min(fh - 1, y / 2) * fw + min(fw - 1, x / 2)]];
  push(g, c);
}

// ---- 10 Cube ---------------------------------------------------------------
// A solid cube tumbling in space, faces lit by their angle to the light.
static float cbA = 0, cbB = 0;
static void drawCube(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  if (first) { cbA = 0.3f; cbB = 0.6f; }
  cbA += 0.045f; cbB += 0.031f;
  static const int8_t V[8][3] = { {-1,-1,-1},{1,-1,-1},{1,1,-1},{-1,1,-1},{-1,-1,1},{1,-1,1},{1,1,1},{-1,1,1} };
  static const uint8_t F[6][4] = { {0,1,2,3},{5,4,7,6},{4,0,3,7},{1,5,6,2},{4,5,1,0},{3,2,6,7} };
  const float ca = cosf(cbA), sa = sinf(cbA), cb = cosf(cbB), sb = sinf(cbB);
  float P[8][3]; int16_t S[8][2];
  for (int i = 0; i < 8; i++) {
    float x = V[i][0], y = V[i][1], z = V[i][2];
    float x1 = x * ca - z * sa, z1 = x * sa + z * ca;
    float y1 = y * cb - z1 * sb, z2 = y * sb + z1 * cb;
    P[i][0] = x1; P[i][1] = y1; P[i][2] = z2 + 4.2f;
    S[i][0] = (int16_t)(w / 2 + x1 * 92 / P[i][2]); S[i][1] = (int16_t)(h / 2 + y1 * 92 / P[i][2]);
  }
  c->fillScreen(INK);
  static const uint16_t faceCol[6] = { C_ACCENT, 0x5D1F, 0xF3CE, 0x7FEF, 0xFFF4, 0xB5DF };
  for (int f = 0; f < 6; f++) {
    const float* a = P[F[f][0]]; const float* b = P[F[f][1]]; const float* d = P[F[f][2]];
    const float ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2], vx = d[0]-a[0], vy = d[1]-a[1], vz = d[2]-a[2];
    const float nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    if (nx * a[0] + ny * a[1] + nz * a[2] >= 0) continue;      // facing away
    const float len = sqrtf(nx*nx + ny*ny + nz*nz);
    const float lit = (-nx * 0.4f - ny * 0.6f - nz * 0.7f) / len;
    const int k = (int)(60 + 150 * (lit < 0 ? 0 : lit));
    const uint16_t col = shade(faceCol[f], k);
    const int16_t* p0 = S[F[f][0]]; const int16_t* p1 = S[F[f][1]]; const int16_t* p2 = S[F[f][2]]; const int16_t* p3 = S[F[f][3]];
    c->fillTriangle(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], col);
    c->fillTriangle(p0[0], p0[1], p2[0], p2[1], p3[0], p3[1], col);
    c->drawLine(p0[0], p0[1], p1[0], p1[1], INK); c->drawLine(p1[0], p1[1], p2[0], p2[1], INK);
    c->drawLine(p2[0], p2[1], p3[0], p3[1], INK); c->drawLine(p3[0], p3[1], p0[0], p0[1], INK);
  }
  push(g, c);
}

// ---- 11 Fireworks ----------------------------------------------------------
// Rockets climb from the bottom and burst into falling, fading sparks. The
// whole frame dims a little each step, which is what draws the trails.
struct Spark { int16_t x, y, vx, vy; uint16_t col; uint8_t life; };
static Spark fwS[140];
static int16_t fwRx = -1, fwRy = 0, fwRv = 0; static uint16_t fwRc = 0;
static void fwDim(GFXcanvas16* c) {
  uint16_t* p = c->getBuffer(); const int n = c->width() * c->height();
  for (int i = 0; i < n; i++) { const uint16_t v = p[i]; if (v) p[i] = mix(INK, v, 214); }
}
static void drawFireworks(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  if (first) { c->fillScreen(INK); for (auto& s : fwS) s.life = 0; fwRx = -1; }
  fwDim(c);
  if (fwRx < 0 && rnd(12) == 0) { fwRx = (int16_t)((20 + rnd(w - 40)) * 16); fwRy = (int16_t)(h * 16); fwRv = (int16_t)(-(26 + rnd(10))); fwRc = kVivid[rnd(6)]; }   // apex a third to half way up
  if (fwRx >= 0) {
    fwRy += fwRv; fwRv += 1;
    c->fillRect(fwRx / 16, fwRy / 16, 1, 2, rgb(255, 230, 180));
    if (fwRv >= -6) {                                  // apex: burst
      int n = 0;
      for (auto& s : fwS) if (!s.life && n < 46) {
        const float a = (n++) * 6.2831853f / 46, sp = 14 + rnd(6);
        s.x = fwRx; s.y = fwRy; s.vx = (int16_t)(cosf(a) * sp); s.vy = (int16_t)(sinf(a) * sp);
        s.col = rnd(5) ? fwRc : 0xFFFF; s.life = (uint8_t)(40 + rnd(25));
      }
      fwRx = -1;
    }
  }
  for (auto& s : fwS) if (s.life) {
    s.x += s.vx; s.y += s.vy; if (s.life & 1) s.vy += 1; s.vx = (int16_t)(s.vx * 31 / 32); s.life--;
    const int x = s.x / 16, y = s.y / 16;
    if (x < 0 || y < 0 || x >= w || y >= h) { s.life = 0; continue; }
    c->drawPixel(x, y, s.life > 20 ? s.col : mix(INK, s.col, (uint8_t)(s.life * 12)));
  }
  push(g, c);
}

// ---- 12 Swarm --------------------------------------------------------------
// xscreensaver's swarm: a darting wasp and a cloud of bees that chase it.
struct Bee { int16_t x, y, px, py, vx, vy; };
static Bee sw[36]; static Bee swW;
static void drawSwarm(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  if (first) {
    swW = { (int16_t)(w * 8), (int16_t)(h * 8), 0, 0, 30, 20 };
    for (auto& b : sw) b = { (int16_t)(rnd(w) * 16), (int16_t)(rnd(h) * 16), 0, 0, 0, 0 };
  }
  // the wasp: random steering, bounded speed, bounces off the edges
  swW.vx += (int16_t)rnd(15) - 7; swW.vy += (int16_t)rnd(15) - 7;
  swW.vx = (int16_t)max(-44, min(44, (int)swW.vx)); swW.vy = (int16_t)max(-34, min(34, (int)swW.vy));
  swW.px = swW.x; swW.py = swW.y; swW.x += swW.vx; swW.y += swW.vy;
  if (swW.x < 0 || swW.x >= w * 16) { swW.vx = -swW.vx; swW.x += 2 * swW.vx; }
  if (swW.y < 0 || swW.y >= h * 16) { swW.vy = -swW.vy; swW.y += 2 * swW.vy; }
  c->fillScreen(INK);
  for (int i = 0; i < 36; i++) {
    Bee& b = sw[i];
    b.vx += (int16_t)((swW.x - b.x) / 64 + (int)rnd(9) - 4); b.vy += (int16_t)((swW.y - b.y) / 64 + (int)rnd(9) - 4);
    b.vx = (int16_t)max(-36, min(36, (int)b.vx)); b.vy = (int16_t)max(-36, min(36, (int)b.vy));
    b.px = b.x; b.py = b.y; b.x += b.vx; b.y += b.vy;
    const uint16_t bc = shade(C_ACCENT, 150 + (i % 4) * 25);
    c->drawLine(b.px / 16, b.py / 16, b.x / 16, b.y / 16, bc);
    c->drawLine(b.px / 16, b.py / 16 + 1, b.x / 16, b.y / 16 + 1, bc);
  }
  c->drawLine(swW.px / 16, swW.py / 16, swW.x / 16, swW.y / 16, C_TEXT);
  c->drawLine(swW.px / 16 + 1, swW.py / 16, swW.x / 16 + 1, swW.y / 16, C_TEXT);
  push(g, c);
}

// ---- 13 Spirograph ---------------------------------------------------------
// A hypotrochoid drawn a little at a time; when it closes, it fades out and a
// new wheel starts.
static int   spR, spr, spd, spT, spEnd; static uint16_t spCol; static int16_t spLx, spLy;
static int gcd(int a, int b) { while (b) { const int t = a % b; a = b; b = t; } return a; }
static void spNew(int16_t w, int16_t h) {
  // Small wheels in a big ring give the many-petalled curves; the pen sits
  // near the wheel's rim. Capped so one figure closes within a minute.
  for (int tries = 0; tries < 20; tries++) {
    spR = 60 + (int)rnd(40); spr = spR / 7 + (int)rnd(spR / 3);
    if (spr / gcd(spR, spr) <= 18) break;
  }
  spd = spr * (6 + (int)rnd(7)) / 10;
  spT = 0; spEnd = 360 * (spr / gcd(spR, spr)); spCol = kVivid[rnd(6)]; spLx = -1;
}
static void drawSpiro(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  GFXcanvas16* c = canvas(w, h); if (!c) return;
  if (first) { c->fillScreen(INK); spNew(w, h); }
  if (spT >= spEnd) {                                  // closed: fade, then a new one
    fwDim(c); if (++spT > spEnd + 40) { c->fillScreen(INK); spNew(w, h); }
    push(g, c); return;
  }
  const float scale = (h / 2 - 3) / (float)(spR - spr + spd);
  for (int k = 0; k < 10 && spT < spEnd; k++, spT++) {
    const float t = spT * 0.0174533f;
    const float x = (spR - spr) * cosf(t) + spd * cosf((spR - spr) * t / spr);
    const float y = (spR - spr) * sinf(t) - spd * sinf((spR - spr) * t / spr);
    const int16_t sx = (int16_t)(w / 2 + x * scale * 1.35f), sy = (int16_t)(h / 2 + y * scale);
    // the ink drifts through the palette as the figure is drawn
    const int seg = (spT * 6 / spEnd) % 6, tt = (spT * 6 * 255 / spEnd) % 255;
    const uint16_t col = mix(kVivid[seg], kVivid[(seg + 1) % 6], (uint8_t)tt);
    if (spLx >= 0) c->drawLine(spLx, spLy, sx, sy, col);
    spLx = sx; spLy = sy;
  }
  push(g, c);
}

// ---- 14 Custom --------------------------------------------------------------
// Imported 1-bit frames. Every pixel of the sprite rectangle is repainted each
// frame as horizontal runs, so a changing frame never leaves stale pixels
// behind and only the movement sliver needs a separate erase.
static int16_t cuX = 0, cuY = 0, cuVx = 5, cuVy = 3;
static int16_t cuLastX = -1, cuLastY = -1;
static uint8_t cuFrame = 0;
static uint32_t cuFrameAt = 0;
static uint16_t cuLastTint = 0;

static void drawMono(Adafruit_GFX& g, const uint8_t* bits, uint8_t sw, uint8_t sh,
                     int16_t x0, int16_t y0, uint16_t on, uint16_t off) {
  const uint8_t stride = (uint8_t)((sw + 7) >> 3);
  g.startWrite();
  for (uint8_t y = 0; y < sh; y++) {
    const uint8_t* row = bits + (size_t)y * stride;
    uint8_t x = 0;
    while (x < sw) {
      const bool v = (row[x >> 3] >> (7 - (x & 7))) & 1;
      uint8_t run = 1;
      while (x + run < sw) {
        const uint8_t xx = (uint8_t)(x + run);
        if ((((row[xx >> 3] >> (7 - (xx & 7))) & 1) != 0) != v) break;
        run++;
      }
      g.writeFastHLine((int16_t)(x0 + x), (int16_t)(y0 + y), run, v ? on : off);
      x = (uint8_t)(x + run);
    }
  }
  g.endWrite();
}

static void eraseSliver(Adafruit_GFX& g, int16_t ox, int16_t oy, int16_t nx,
                        int16_t ny, int16_t sw, int16_t sh, uint16_t c) {
  const int16_t dx = nx - ox, dy = ny - oy;
  if (!dx && !dy) return;
  g.startWrite();
  if (dx > 0)      g.writeFillRect(ox, oy, dx, sh, c);
  else if (dx < 0) g.writeFillRect(nx + sw, oy, -dx, sh, c);
  if (dy > 0)      g.writeFillRect(ox, oy, sw, dy, c);
  else if (dy < 0) g.writeFillRect(ox, ny + sh, sw, -dy, c);
  g.endWrite();
}

static void drawCustom(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  if (!gCustomValid) return;
  const SsCustom& c = gCustomHdr;
  const int16_t sw = c.w, sh = c.h;

  if (first) {
    cuX = (int16_t)(((w - sw) / 2) << 4);
    cuY = (int16_t)(((h - sh) / 2) << 4);
    cuVx = (esp_random() & 1) ? 5 : -5;
    cuVy = (esp_random() & 1) ? 3 : -3;
    cuFrame = 0;
    cuFrameAt = millis();
    cuLastX = cuLastY = -1;
    cuLastTint = 0;
    if (c.back != INK) g.fillScreen(c.back);
  }

  // A sprite as wide or tall as the panel has nowhere to travel, so it is
  // pinned rather than left rattling between the two edge clamps.
  const bool canMove = (sw < w) && (sh < h);
  if (canMove && (c.motion == 1 || c.motion == 3)) {
    cuX += cuVx;
    if (c.motion == 1) cuY += cuVy;
    if ((cuX >> 4) < 0)            { cuX = 0;                 cuVx = -cuVx; }
    if ((cuX >> 4) + sw > w)       { cuX = (w - sw) << 4;     cuVx = -cuVx; }
    if ((cuY >> 4) < 0)            { cuY = 0;                 cuVy = -cuVy; }
    if ((cuY >> 4) + sh > h)       { cuY = (h - sh) << 4;     cuVy = -cuVy; }
  }

  const uint32_t now = millis();
  const uint32_t ivl = (uint32_t)c.frameMs10 * 10;
  bool advanced = false;
  if (c.frames > 1 && now - cuFrameAt >= ivl) {
    cuFrameAt = now;
    cuFrame = (uint8_t)((cuFrame + 1) % c.frames);
    advanced = true;
  }

  const int16_t x = cuX >> 4, y = cuY >> 4;
  const bool moved = (x != cuLastX || y != cuLastY);
  uint16_t tint = c.tint;
  if (c.motion == 2) {
    const int amp = isin((int)(gFrameNo / 3));   // ~6 s pulse
    tint = mix(c.back, c.tint, (uint8_t)(115 + (amp + 127) * 140 / 254));
  }
  // Repainting the sprite is the expensive part, so it only happens when
  // something about it actually changed.
  if (!moved && !advanced && tint == cuLastTint) return;
  cuLastTint = tint;

  if (cuLastX >= 0 && moved)
    eraseSliver(g, cuLastX, cuLastY, x, y, sw, sh, c.back);

  const uint8_t stride = (uint8_t)((sw + 7) >> 3);
  drawMono(g, gCustomPx + (size_t)cuFrame * stride * sh, c.w, c.h, x, y, tint,
           c.back);
  cuLastX = x; cuLastY = y;
}

// ------------------------------------------------------------------ dispatch
static uint16_t saverInterval(uint8_t idx) {
  switch (idx) {
    case SS_PLASMA:  return 50;
    case SS_STARS:   return 33;
    case SS_MYSTIFY: return 40;
    case SS_LIFE:    return 110;
    case SS_MATRIX:  return 60;
    case SS_PIPES:   return 45;
    case SS_TOASTERS: return 50;
    case SS_MAZE:    return 20;
    case SS_FIRE:    return 40;
    case SS_CUBE:    return 40;
    case SS_FIREWORKS: return 35;
    case SS_SWARM:   return 35;
    case SS_SPIRO:   return 25;
    case SS_MARK:    return 40;
    default: {
      // A still custom animation can pace itself; a moving one needs a steady
      // cadence for the motion regardless of how slow its frames are.
      const uint32_t ms = (uint32_t)gCustomHdr.frameMs10 * 10;
      if (gCustomHdr.motion == 0) return (uint16_t)(ms < 40 ? 40 : ms);
      return (uint16_t)(ms < 70 ? (ms < 40 ? 40 : ms) : 70);
    }
  }
}

static void renderFrame(Adafruit_GFX& g, int16_t w, int16_t h, bool first) {
  switch (gRunning) {
    case SS_PLASMA:  drawPlasma(g, w, h, first);  break;
    case SS_STARS:   drawStars(g, w, h, first);   break;
    case SS_MYSTIFY: drawMystify(g, w, h, first); break;
    case SS_LIFE:    drawLife(g, w, h, first);    break;
    case SS_MATRIX:  drawMatrix(g, w, h, first);  break;
    case SS_PIPES:   drawPipes(g, w, h, first);   break;
    case SS_TOASTERS: drawToasters(g, w, h, first); break;
    case SS_MAZE:    drawMaze(g, w, h, first);    break;
    case SS_FIRE:    drawFire(g, w, h, first);    break;
    case SS_CUBE:    drawCube(g, w, h, first);    break;
    case SS_FIREWORKS: drawFireworks(g, w, h, first); break;
    case SS_SWARM:   drawSwarm(g, w, h, first);   break;
    case SS_SPIRO:   drawSpiro(g, w, h, first);   break;
    case SS_MARK:    drawBounce(g, w, h, first);  break;
    default:        drawCustom(g, w, h, first);   break;
  }
}

// ==================================================================== API
static void impMaintain();   // drops a transfer whose phone walked away

uint8_t screensaverCount() {
  return (uint8_t)(BUILTIN_COUNT + ((gCustomValid || gAdoptReq) ? 1 : 0));
}

const char* screensaverName(uint8_t index) {
  if (index == SS_SHUFFLE) return "Shuffle";
  if (index < BUILTIN_COUNT) return kNames[index];
  if (index == SS_CUSTOM && gCustomValid)
    return gCustomHdr.name[0] ? gCustomHdr.name : "Custom";
  return "";
}

void screensaverSetLog(Print* out) { gSsLog = out; }

void screensaverBegin() {
  if (!impLock) impLock = xSemaphoreCreateMutex();
  ssPrefs.begin(kNs, true);
  gEnabled  = ssPrefs.getBool("on", NIB_DEFAULT_SAVER_ON);
  gSelected = ssPrefs.getUChar("sel3", NIB_DEFAULT_SAVER);
  gIdleSecs = ssPrefs.getUShort("idle", NIB_DEFAULT_SAVER_IDLE);
  ssPrefs.end();

  ssLoadCustom();

  if (gSelected != SS_SHUFFLE && gSelected >= screensaverCount()) gSelected = 0;
  if (gIdleSecs && gIdleSecs < 5) gIdleSecs = 5;
  if (gIdleSecs > 3600) gIdleSecs = 3600;

  ensureRamps();
  gLastActivity = millis();
}

void screensaverSetEnabled(bool on) {
  if (on == gEnabled) return;
  gEnabled = on;
  if (!on && gActive) { gActive = false; gRepaintOwed = true; }
  gLastActivity = millis();
  ssSaveConfig();
}

bool screensaverEnabled() { return gEnabled; }

void screensaverSelect(uint8_t index) {
  if (index != SS_SHUFFLE && index >= screensaverCount()) index = 0;
  if (index == gSelected) return;
  gSelected = index;
  if (gActive) { gActive = false; gRepaintOwed = true; }   // re-enter cleanly
  gLastActivity = millis();
  ssSaveConfig();
}

uint8_t screensaverSelected() { return gSelected; }

void screensaverSetIdleSeconds(uint16_t s) {
  if (s && s < 5) s = 5;
  if (s > 3600) s = 3600;
  if (s == gIdleSecs) return;
  gIdleSecs = s;
  gLastActivity = millis();
  ssSaveConfig();
}

uint16_t screensaverIdleSeconds() { return gIdleSecs; }

void screensaverSetWordmark(const char* name) {
  if (!name || !*name) return;
  strncpy(gWordmark, name, sizeof(gWordmark) - 1);
  gWordmark[sizeof(gWordmark) - 1] = '\0';
  if (gActive && gRunning == SS_MARK) gNeedsClear = true;
}

void screensaverSetClock(uint32_t epochSeconds, int16_t tzOffsetMinutes) {
  gClockEpoch = epochSeconds + (int32_t)tzOffsetMinutes * 60;
  gClockSetAt = millis();
  gClockValid = true;
}

bool screensaverHasClock() { return gClockValid; }

void screensaverNotifyActivity() {
  gLastActivity = millis();
  gPreview = 0xFE;
  if (gActive) { gActive = false; gRepaintOwed = true; }
}

void screensaverInhibit(bool on) {
  gInhibited = on;
  if (on) {
    gLastActivity = millis();
    if (gActive) { gActive = false; gRepaintOwed = true; }
  }
}

bool screensaverActive() { return gActive; }

void screensaverPreview(uint8_t index, uint16_t ms) {
  if (index != SS_SHUFFLE && index >= screensaverCount()) return;
  gPreview = index;
  gPreviewUntil = millis() + (ms ? ms : 4000);
  gActive = false;         // fall into it through the normal entry path
  gLastActivity = 0;
}

bool screensaverConsumeRepaint() {
  const bool r = gRepaintOwed;
  gRepaintOwed = false;
  return r;
}

static uint8_t pickShuffle() {
  const uint8_t n = screensaverCount();
  if (n <= 1) return 0;
  uint8_t next = gRunning;
  for (int guard = 0; guard < 8 && next == gRunning; guard++)
    next = (uint8_t)(esp_random() % n);
  return next;
}

void screensaverTick(Adafruit_GFX& gfx, uint16_t w, uint16_t h) {
  const uint32_t now = millis();

  // --- maintenance, done even while the saver is asleep ---------------------
  impMaintain();
  if (gClearReq) {
    gClearReq = false;
    free(gCustomPx); gCustomPx = nullptr;
    gCustomValid = false;
    if (gSelected == SS_CUSTOM) { gSelected = 0; ssSaveConfig(); }
    if (gActive && gRunning == SS_CUSTOM) { gActive = false; gRepaintOwed = true; }
  }
  if (gAdoptReq) {
    ImpGuard lock;
    gAdoptReq = false;
    free(gCustomPx);
    gCustomPx    = gPendingPx;
    gCustomHdr   = gPendingHdr;
    gPendingPx   = nullptr;
    gCustomValid = true;
    if (gActive && gRunning == SS_CUSTOM) gNeedsClear = true;
  }

  const bool previewing = (gPreview != 0xFE) && (int32_t)(gPreviewUntil - now) > 0;
  if (gPreview != 0xFE && !previewing) {
    gPreview = 0xFE;
    if (gActive) { gActive = false; gRepaintOwed = true; }
    gLastActivity = now;
    return;
  }

  // --- should it be running? ------------------------------------------------
  if (!gActive) {
    if (gInhibited) return;
    if (!previewing && (!gEnabled || gIdleSecs == 0)) return;
    if (!previewing && (now - gLastActivity) < (uint32_t)gIdleSecs * 1000) return;

    const uint8_t want = previewing ? gPreview : gSelected;
    gRunning = (want == SS_SHUFFLE) ? pickShuffle() : want;
    if (gRunning >= BUILTIN_COUNT && !gCustomValid) gRunning = 0;
    gRunningSince = now;
    gActive      = true;
    if (gSsLog) gSsLog->printf("[ss] showing %s (%s)\n", screensaverName(gRunning),
                               previewing ? "preview" : "idle");
    gNeedsClear  = true;
    gLastFrame   = 0;
    gFrameNo     = 0;
  }

  if (!previewing && gSelected == SS_SHUFFLE && now - gRunningSince > SHUFFLE_MS) {
    gRunning = pickShuffle();
    if (gRunning >= BUILTIN_COUNT && !gCustomValid) gRunning = 0;
    gRunningSince = now;
    gNeedsClear = true;
  }

  const uint16_t ivl = saverInterval(gRunning);
  if (gLastFrame && (now - gLastFrame) < ivl) return;
  gLastFrame = now ? now : 1;

  ensureRamps();

  bool first = false;
  if (gNeedsClear) {
    gNeedsClear = false;
    gfx.fillScreen(INK);
    first = true;
    gFrameNo = 0;
  }

  renderFrame(gfx, (int16_t)w, (int16_t)h, first);
  gFrameNo++;
}

// ============================================================ custom import
static uint8_t*  impBuf = nullptr;
static uint16_t  impLen = 0;
static uint16_t  impGot = 0;
static uint32_t  impTouched = 0;
static SsCustom  impHdr;
static bool      impOpen = false;
static const uint32_t IMPORT_IDLE_MS = 60000;

const char* screensaverImportError(SsImport r) {
  switch (r) {
    case SsImport::Ok:          return "ok";
    case SsImport::BadHeader:   return "bad header";
    case SsImport::TooBig:      return "too big";
    case SsImport::NoMemory:    return "out of memory";
    case SsImport::BadOffset:   return "wrong offset";
    case SsImport::Incomplete:  return "incomplete";
    case SsImport::BadCrc:      return "checksum mismatch";
    case SsImport::TooDetailed: return "too detailed to draw";
    case SsImport::NoSession:   return "no transfer open";
    case SsImport::StoreFailed: return "could not store";
  }
  return "?";
}

// Callers hold impLock.
static void impDrop() {
  free(impBuf);
  impBuf = nullptr;
  impLen = impGot = 0;
  impOpen = false;
}

// Worst-case draw cost of a 1-bit frame is one address-window setup per colour
// run, so a dithered photograph would blow the frame budget even though it fits
// in memory. Counting the runs at import time refuses it up front instead of
// shipping a saver that stutters. It also keeps custom savers to the flat,
// quiet shapes the rest of the set is made of.
static const uint32_t MAX_RUNS = 384;

static uint32_t worstFrameRuns(const uint8_t* d, uint8_t sw, uint8_t sh,
                               uint8_t frames) {
  const uint8_t stride = (uint8_t)((sw + 7) >> 3);
  uint32_t worst = 0;
  for (uint8_t f = 0; f < frames; f++) {
    uint32_t runs = 0;
    for (uint8_t y = 0; y < sh; y++) {
      const uint8_t* row = d + ((size_t)f * sh + y) * stride;
      int prev = -1;
      for (uint8_t x = 0; x < sw; x++) {
        const int v = (row[x >> 3] >> (7 - (x & 7))) & 1;
        if (v != prev) { runs++; prev = v; }
      }
    }
    if (runs > worst) worst = runs;
  }
  return worst;
}

SsImport screensaverImportBegin(const uint8_t* p, size_t n) {
  ImpGuard lock;
  if (!p || n < 14) return SsImport::BadHeader;
  if (p[0] != 'N' || p[1] != 1 || p[2] != 1) return SsImport::BadHeader;

  SsCustom h;
  memset(&h, 0, sizeof(h));
  h.version   = p[1];
  h.kind      = p[2];
  h.w         = p[3];
  h.h         = p[4];
  h.frames    = p[5];
  h.frameMs10 = p[6];
  h.motion    = p[7];
  h.tint      = (uint16_t)(p[8]  | ((uint16_t)p[9]  << 8));
  h.back      = (uint16_t)(p[10] | ((uint16_t)p[11] << 8));
  h.len       = (uint16_t)(p[12] | ((uint16_t)p[13] << 8));

  size_t nameLen = n - 14;
  if (nameLen > sizeof(h.name) - 1) nameLen = sizeof(h.name) - 1;
  for (size_t i = 0; i < nameLen; i++) {
    const uint8_t c = p[14 + i];
    h.name[i] = (c >= 0x20 && c < 0x7F) ? (char)c : ' ';
  }

  if (h.w < 8 || h.w > SS_CUSTOM_MAX_W)   return SsImport::BadHeader;
  if (h.h < 8 || h.h > SS_CUSTOM_MAX_H)   return SsImport::BadHeader;
  if (h.frames < 1 || h.frames > SS_CUSTOM_MAX_FRAMES) return SsImport::BadHeader;
  if (h.motion > 3)                       return SsImport::BadHeader;
  if (h.frameMs10 < 4) h.frameMs10 = 4;

  const uint32_t want = (uint32_t)((h.w + 7) >> 3) * h.h * h.frames;
  if (h.len != want)                      return SsImport::BadHeader;
  if (h.len == 0 || h.len > SS_CUSTOM_MAX_BYTES) return SsImport::TooBig;

  // Same header while a session is already open: this is a reconnect, so keep
  // what already arrived and let the phone resume from importReceived().
  if (impOpen && impLen == h.len &&
      memcmp(&impHdr, &h, sizeof(h)) == 0 && impBuf) {
    impTouched = millis();
    return SsImport::Ok;
  }

  impDrop();
  impBuf = ssAlloc(h.len);
  if (!impBuf) return SsImport::NoMemory;
  impHdr = h;
  impLen = h.len;
  impGot = 0;
  impOpen = true;
  impTouched = millis();
  return SsImport::Ok;
}

SsImport screensaverImportData(uint16_t offset, const uint8_t* data, size_t n) {
  ImpGuard lock;
  if (!impOpen || !impBuf) return SsImport::NoSession;
  if (!data || n == 0) return SsImport::Ok;
  // Out of order is refused rather than buffered: the phone knows the
  // high-water mark and resending from it is simpler than a received-map.
  if (offset > impGot || (uint32_t)offset + n > impLen) return SsImport::BadOffset;
  memcpy(impBuf + offset, data, n);
  if (offset + n > impGot) impGot = (uint16_t)(offset + n);
  impTouched = millis();
  return SsImport::Ok;
}

SsImport screensaverImportCommit(uint32_t crc) {
  ImpGuard lock;
  if (!impOpen || !impBuf) return SsImport::NoSession;
  if (impGot != impLen)    return SsImport::Incomplete;
  if (ssCrc32(impBuf, impLen) != crc) return SsImport::BadCrc;
  if (worstFrameRuns(impBuf, impHdr.w, impHdr.h, impHdr.frames) > MAX_RUNS)
    return SsImport::TooDetailed;

  // Flash is touched exactly once, here, with a payload already known to be
  // whole. Anything that went wrong earlier left the stored animation alone.
  ssPrefs.begin(kNs, false);
  const bool okH = ssPrefs.putBytes("cs.hdr", &impHdr, sizeof(impHdr)) == sizeof(impHdr);
  const bool okP = ssPrefs.putBytes("cs.px", impBuf, impLen) == impLen;
  ssPrefs.end();
  if (!okH || !okP) {
    ssPrefs.begin(kNs, false);
    ssPrefs.remove("cs.hdr");
    ssPrefs.remove("cs.px");
    ssPrefs.end();
    return SsImport::StoreFailed;
  }

  // Hand the buffer to the drawing task rather than swapping it here.
  free(gPendingPx);
  gPendingPx = impBuf;
  gPendingHdr = impHdr;
  impBuf = nullptr;
  impOpen = false;
  impLen = impGot = 0;
  gAdoptReq = true;
  return SsImport::Ok;
}

void screensaverImportAbort() {
  ImpGuard lock;
  impDrop();
}

uint16_t screensaverImportReceived() { return impOpen ? impGot : 0; }

bool screensaverHasCustom() { return gCustomValid || gAdoptReq; }

const char* screensaverCustomName() {
  if (!gCustomValid) return "";
  return gCustomHdr.name[0] ? gCustomHdr.name : "Custom";
}

void screensaverCustomClear() {
  ssPrefs.begin(kNs, false);
  ssPrefs.remove("cs.hdr");
  ssPrefs.remove("cs.px");
  ssPrefs.end();
  gClearReq = true;
}

// A session left open by a phone that walked away is dropped, so the staging
// buffer is not held forever. Called from the tick path.
static void impMaintain() {
  ImpGuard lock;
  if (impOpen && millis() - impTouched > IMPORT_IDLE_MS) impDrop();
}

#else  // NIB_LCD_ENABLED

// No panel: same API, no code. A screenless build has nothing to save.
uint8_t     screensaverCount() { return 0; }
void        screensaverSetLog(Print*) {}
void        screensaverSetBlit(SsBlit) {}
const char* screensaverName(uint8_t) { return ""; }
void        screensaverBegin() {}
void        screensaverSetEnabled(bool) {}
bool        screensaverEnabled() { return false; }
void        screensaverSelect(uint8_t) {}
uint8_t     screensaverSelected() { return 0; }
void        screensaverSetIdleSeconds(uint16_t) {}
uint16_t    screensaverIdleSeconds() { return 0; }
void        screensaverSetWordmark(const char*) {}
void        screensaverSetClock(uint32_t, int16_t) {}
bool        screensaverHasClock() { return false; }
void        screensaverNotifyActivity() {}
void        screensaverInhibit(bool) {}
bool        screensaverActive() { return false; }
void        screensaverPreview(uint8_t, uint16_t) {}
bool        screensaverConsumeRepaint() { return false; }
void        screensaverTick(Adafruit_GFX&, uint16_t, uint16_t) {}

const char* screensaverImportError(SsImport) { return "no screen"; }
SsImport    screensaverImportBegin(const uint8_t*, size_t) { return SsImport::BadHeader; }
SsImport    screensaverImportData(uint16_t, const uint8_t*, size_t) { return SsImport::NoSession; }
SsImport    screensaverImportCommit(uint32_t) { return SsImport::NoSession; }
void        screensaverImportAbort() {}
uint16_t    screensaverImportReceived() { return 0; }
bool        screensaverHasCustom() { return false; }
const char* screensaverCustomName() { return ""; }
void        screensaverCustomClear() {}

#endif // NIB_LCD_ENABLED
