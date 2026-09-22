#pragma once
#include <stddef.h>
#include <stdint.h>

#include <Adafruit_GFX.h>

// Screensavers for the 160x80 ST7735.
//
// This board has no backlight GPIO - the panel is lit whenever the dongle has
// power - so a screensaver here cannot dim or blank anything. All it can do is
// change what is drawn. That reframes the job: it is not about saving power, it
// is about not parking a bright static layout on one set of pixels for days,
// and about the thing looking calm when nobody is typing.
//
// Consequences that shaped every saver below:
//   - low mean luminance, always some motion, nothing bright held still
//   - a strict per-frame drawing budget (see screensaver.cpp), because SPI to
//     this panel is slow and typing must never wait for a pixel
//   - no delay() anywhere: screensaverTick() draws one frame and returns
//
// This module does not own the panel. It never touches display.h, never calls
// SPI directly, and only draws through the Adafruit_GFX handed to it.
//
// Wiring it up, from display.cpp:
//
//   displayBegin()       -> screensaverBegin()
//   any display setter   -> screensaverNotifyActivity()
//   passkey on screen or
//   button countdown     -> screensaverInhibit(true) while that lasts
//
//   displayTick():
//     screensaverTick(tft, tft.width(), tft.height());  // always: it paces itself
//     if (screensaverActive()) return;                  // the saver owns the panel
//     if (screensaverConsumeRepaint()) <force a full status redraw>
//     ... the existing status drawing ...
//
// The tick has to be called unconditionally, because deciding to wake up is
// part of its job.
//
// That last one matters: the pairing passkey and the factory-reset countdown
// are the two things on this screen somebody is actively reading. A saver must
// never cover them.

// ---------------------------------------------------------------- catalogue
// Built-in savers, in menu order. Index 0 is the default.
//
//   0  Bounce    the device name gliding and changing colour at each wall.
//   1  Plasma    a slow interference field in the app's warm palette.
//   2  Stars     flying through a star field.
//   3  Mystify   two polygons bouncing, trailing fading copies.
//   4  Life      Conway's Game of Life, newborn cells amber, ageing to ember.
//   5  Matrix    digital rain, green glyphs falling at their own speeds.
//   6  Custom    only present once a custom animation has been imported.
uint8_t     screensaverCount();

// Human-readable name for a menu. Valid for 0..count-1, and for SS_SHUFFLE.
const char* screensaverName(uint8_t index);

// Cycle through every available saver, changing every two minutes. Accepted by
// screensaverSelect() and reported by screensaverSelected().
static const uint8_t SS_SHUFFLE = 0xFF;

// ------------------------------------------------------------------ lifecycle
// Loads settings and any stored custom animation from NVS. Call once, after
// the panel is up. Does not draw.
void screensaverBegin();

// Where to report what the panel is showing ("[ss] showing Drift (preview)").
// Optional; the test harness reads it over the USB console to prove a pick
// reached the screen. Pass nullptr to silence it.
class Print;
void screensaverSetLog(Print* out);

// Bulk pixel push for whole frames and sprites. The display module passes its
// panel's drawRGBBitmap, which writes one address window per block instead of
// one per pixel. Without it the savers fall back to the slow generic path.
typedef void (*SsBlit)(int16_t x, int16_t y, uint16_t* px, int16_t w, int16_t h);
void screensaverSetBlit(SsBlit blit);

// ---------------------------------------------------------- configuration
// These persist in NVS immediately, and only write when the value actually
// changed, so a phone spamming the setter does not wear out flash.
void     screensaverSetEnabled(bool on);
bool     screensaverEnabled();
void     screensaverSelect(uint8_t index);       // index, or SS_SHUFFLE
uint8_t  screensaverSelected();
void     screensaverSetIdleSeconds(uint16_t s);  // clamped 5..3600; 0 = never
uint16_t screensaverIdleSeconds();

// The name shown by the Wordmark saver. Not persisted here - it mirrors the
// BLE device name, which settings.cpp already owns. Defaults to NIB_DEVICE_NAME.
void screensaverSetWordmark(const char* name);

// Wall clock for the Hours saver. The dongle has no RTC and no network, so
// this is the only way it can know the time; the phone sends it after it
// connects. Not persisted: it goes stale across a reboot, and a confidently
// wrong clock is worse than an honest uptime counter.
void screensaverSetClock(uint32_t epochSeconds, int16_t tzOffsetMinutes);
bool screensaverHasClock();

// ------------------------------------------------------------------- runtime
void screensaverNotifyActivity();   // resets the idle timer, wakes if asleep
void screensaverInhibit(bool on);   // pin it off while the screen is needed
bool screensaverActive();

// Show one saver right now for `ms` milliseconds without changing the stored
// selection, so the phone's settings screen can preview it. Any real activity
// cancels the preview.
void screensaverPreview(uint8_t index, uint16_t ms);

// True exactly once after the saver has given the panel back, so the caller
// knows its own layout is gone and must be redrawn from scratch.
bool screensaverConsumeRepaint();

// Draw at most one frame. Cheap and safe to call every loop() pass; it paces
// itself and returns immediately when there is nothing to do.
void screensaverTick(Adafruit_GFX& gfx, uint16_t w, uint16_t h);

// ------------------------------------------------------- custom import
// A user-supplied animation, uploaded from the phone over BLE.
//
// Format choice, and why. The options were raw RGB565 frames, an
// indexed-palette bitmap, a 1-bit animation, or a parametric recipe.
//   - raw RGB565 is 25.6 kB for a single full frame. It does not fit NVS, and
//     pushing one costs ~14 ms of SPI. Rejected on both counts.
//   - a 4bpp indexed bitmap is still 6.4 kB per frame, so at most one frame
//     fits, and worst-case draw cost is a full-screen repaint. Rejected.
//   - a parametric recipe is tiny and robust but there is nothing to import:
//     the interesting part would all be firmware, and the user cannot draw
//     their own logo with it. Rejected as an import format; the built-ins
//     already are the parametric ones.
//   - 1-bit frames won. 128x64 is 1 kB per frame, a 64x32 sprite is 256 B, so
//     a short animation fits NVS with room to spare. One bit per pixel also
//     forces the result to stay in the house style - flat shapes in a single
//     warm tint over a dark field, not a dithered photo.
//
// The engine supplies the motion, the user supplies the shape. So a 1-frame
// logo still breathes or drifts rather than sitting still and burning in.
//
// Wire format. Opcodes are the orchestrator's to assign; the payload layout is
// fixed here. All 16-bit values little endian, matching the rest of protocol.h.
//
//   BEGIN, 14 bytes plus an optional name:
//     0     'N'  (0x4E) magic
//     1     format version, currently 1
//     2     kind, currently 1 = 1-bit frame strip
//     3     width  in pixels, 8..128
//     4     height in pixels, 8..64
//     5     frame count, 1..16
//     6     frame interval in units of 10 ms, 4..255 (40 ms .. 2.55 s)
//     7     motion: 0 still, 1 bounce, 2 pulse, 3 slide
//     8-9   "on" pixel colour, RGB565
//     10-11 field colour behind it, RGB565
//     12-13 payload length, must equal ceil(w/8)*h*frames and be <= 6144
//     14+   optional display name, up to 15 bytes of ASCII, no terminator
//
//   DATA, per chunk: 2-byte little endian offset, then up to ~126 bytes of
//   payload. Chunks must arrive in order; the offset is carried explicitly so
//   the phone can resume rather than restart.
//
//   COMMIT: a 4-byte little endian CRC32 (IEEE, the zlib polynomial) over the
//   whole payload.
//
//   ABORT: no payload.
//
// Row stride is ceil(w/8). Bit 7 of the first byte is the leftmost pixel. Frame
// k starts at k*stride*h. A 1 bit is the "on" colour, a 0 bit is the field.
//
// Surviving a disconnection, and not bricking. Chunks accumulate in a heap
// buffer (PSRAM when available), never in flash, so an interrupted transfer
// costs nothing and changes nothing. NVS is written exactly once, at COMMIT,
// after the CRC has been checked - so a half-received animation can never
// replace a good one, and the dongle cannot end up storing garbage it will try
// to draw on every boot. An abandoned session is dropped after 60 s. Reconnect
// within that window and BEGIN with an identical header resumes from
// screensaverImportReceived(); anything else starts over.
//
// The one blocking moment is COMMIT itself: writing ~6 kB to NVS takes a few
// hundred milliseconds on whichever task calls it. Do it from the worker task
// that handles BLE packets, never from a BLE callback.

// Limits, so the phone can be told rather than guess.
static const uint16_t SS_CUSTOM_MAX_BYTES  = 6144;  // fits the 20 kB NVS partition
static const uint8_t  SS_CUSTOM_MAX_W      = 128;
static const uint8_t  SS_CUSTOM_MAX_H      = 64;
static const uint8_t  SS_CUSTOM_MAX_FRAMES = 16;

enum class SsImport : uint8_t {
  Ok = 0,
  BadHeader,     // magic, version, kind or a field out of range
  TooBig,        // declared length over SS_CUSTOM_MAX_BYTES
  NoMemory,      // could not allocate the staging buffer
  BadOffset,     // chunk is not the next one expected
  Incomplete,    // commit before every byte arrived
  BadCrc,        // payload did not survive the trip
  TooDetailed,   // too many colour runs per row to draw inside the frame budget
  NoSession,     // data or commit with no begin
  StoreFailed,   // NVS refused the write; the previous animation is untouched
};

const char* screensaverImportError(SsImport r);

SsImport screensaverImportBegin(const uint8_t* header, size_t n);
SsImport screensaverImportData(uint16_t offset, const uint8_t* data, size_t n);
SsImport screensaverImportCommit(uint32_t crc32);
void     screensaverImportAbort();

// Highest byte offset safely received, for resuming an interrupted transfer.
uint16_t screensaverImportReceived();

bool        screensaverHasCustom();
const char* screensaverCustomName();
void        screensaverCustomClear();
