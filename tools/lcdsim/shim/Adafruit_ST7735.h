// The panel, as an in-memory canvas: native 80x160 portrait, rotation 1 gives
// the 160x80 landscape the firmware draws in. GFXcanvas16 keeps RGB565.
#pragma once
#include <Adafruit_GFX.h>
#include <SPI.h>
#define ST77XX_BLACK 0x0000
#define ST77XX_WHITE 0xFFFF
#define INITR_MINI160x80 0x04
#define INITR_BLACKTAB 0x02
class Adafruit_ST7735 : public GFXcanvas16 {
 public:
  Adafruit_ST7735(SPIClass*, int, int, int) : GFXcanvas16(80, 160) {}
  void initR(uint8_t) {}
  void invertDisplay(bool) {}
 protected:
  void setColRowStart(int8_t, int8_t) {}
};
