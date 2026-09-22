// Host shim: just enough of the Arduino core to compile the firmware's drawing
// code (display.cpp, screensaver.cpp) on a computer. Time is simulated.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <math.h>
#include <string>
#include "Print.h"
typedef bool boolean;
typedef uint8_t byte;
extern uint32_t gSimMillis;
inline uint32_t millis() { return gSimMillis; }
inline void delay(uint32_t ms) { gSimMillis += ms; }
inline long random(long a, long b) { return a + rand() % (b - a); }
#define HIGH 1
#define LOW 0
#define OUTPUT 1
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
#ifndef PROGMEM
#define PROGMEM
#endif
#define pgm_read_byte(a) (*(const uint8_t*)(a))
#define pgm_read_word(a) (*(const uint16_t*)(a))
#define pgm_read_dword(a) (*(const uint32_t*)(a))
#define pgm_read_pointer(a) (*(void* const*)(a))
#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))
#define _swap_int16_t(a, b) { int16_t t = a; a = b; b = t; }
// FreeRTOS bits used by the firmware
typedef void* SemaphoreHandle_t;
#define portMAX_DELAY 0xffffffff
inline SemaphoreHandle_t xSemaphoreCreateMutex() { return (void*)1; }
inline int xSemaphoreTake(SemaphoreHandle_t, uint32_t) { return 1; }
inline int xSemaphoreGive(SemaphoreHandle_t) { return 1; }
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) (void)(x)
#define portEXIT_CRITICAL(x) (void)(x)
inline void* ps_malloc(size_t n) { return malloc(n); }
#define radians(d) ((d) * 0.017453292519943295)
#define degrees(r) ((r) * 57.29577951308232)
