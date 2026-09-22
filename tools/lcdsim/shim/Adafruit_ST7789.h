#pragma once
#include "Adafruit_ST7735.h"
class Adafruit_ST7789 : public Adafruit_ST7735 { public: using Adafruit_ST7735::Adafruit_ST7735; void init(int, int) {} };
