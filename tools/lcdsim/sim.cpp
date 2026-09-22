// Renders the firmware's real screen code (display.cpp, screensaver.cpp) to
// PPM frames, so the dongle's screen can be looked at without the dongle.
//   ./lcdsim out/     -> home_*.ppm, then saver<N>_<frame>.ppm
#include <Arduino.h>
#include "../../firmware/src/display.h"
#include "../../firmware/src/screensaver.h"
uint32_t gSimMillis = 1000;
Adafruit_GFX* displaySimCanvas();

static void dump(const char* dir, const char* name) {
  GFXcanvas16* c = (GFXcanvas16*)displaySimCanvas();
  char path[512]; snprintf(path, sizeof path, "%s/%s.ppm", dir, name);
  FILE* f = fopen(path, "wb");
  const int w = c->width(), h = c->height();
  fprintf(f, "P6 %d %d 255\n", w, h);
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    uint16_t p = c->getPixel(x, y);
    uint8_t r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
    uint8_t px[3] = { (uint8_t)(r * 255 / 31), (uint8_t)(g * 255 / 63), (uint8_t)(b * 255 / 31) };
    fwrite(px, 1, 3, f);
  }
  fclose(f);
}
static void run(uint32_t ms, uint32_t step = 10) { for (uint32_t t = 0; t < ms; t += step) { gSimMillis += step; displayTick(); } }

int main(int argc, char** argv) {
  const char* dir = argc > 1 ? argv[1] : "out";
  srand(7);
  displayBegin();
  screensaverSetIdleSeconds(3600);           // keep savers out of the home shots
  displaySetPasskey(424242, true);
  displaySetLink(LinkState::Booting);            run(50);  dump(dir, "home_1_booting");
  displaySetLink(LinkState::Advertising);        run(50);  dump(dir, "home_2_waiting");
  displaySetPasskey(424242, false);              run(50);  dump(dir, "home_3_waiting_hidden");
  displaySetPasskey(424242, true);
  displaySetLink(LinkState::Connected);
  displaySetActivity("ready");                   run(50);  dump(dir, "home_4_connected");
  displaySetActivity("typed 14 chars");          run(50);  dump(dir, "home_5_typing");
  displaySetName("Living room PC");              run(50);  dump(dir, "home_5b_long_name");
  displaySetName("N.I.B.");
  displaySetLink(LinkState::Advertising); displaySetPairing(false); run(50); dump(dir, "home_2b_paired_only");
  displaySetPairing(true); displaySetLink(LinkState::Connected);
  displaySetHold(3, 1);                          run(50);  dump(dir, "home_6a_let_go");
  displaySetHold(9, 0);                          run(50);  dump(dir, "home_6_pair");
  displaySetHold(4, 2);                          run(50);  dump(dir, "home_7_reset");
  displaySetHold(-1, 0);                         run(50);

  const int n = screensaverCount();
  for (int i = 0; i < n; i++) {
    screensaverPreview((uint8_t)i, 60000);
    for (int fr = 0; fr < 120; fr++) {         // 12 s at 10 fps
      run(100);
      char name[64]; snprintf(name, sizeof name, "saver%d_%03d", i, fr); dump(dir, name);
    }
    screensaverNotifyActivity(); run(50);
  }
  printf("%d savers\n", n);
  for (int i = 0; i < n; i++) printf("%d %s\n", i, screensaverName((uint8_t)i));
  return 0;
}
