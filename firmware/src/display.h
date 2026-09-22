#pragma once
#include <stdint.h>

// The 160x80 LCD is a status light, not a UI. It answers three questions:
// is the dongle paired, what passkey does the phone want, and did that last
// keystroke actually go anywhere.
//
// Every function here compiles to nothing when NIB_LCD_ENABLED is 0, so
// boards without a screen need no #ifdefs anywhere else. The same is true of
// screensaver.h, which this module owns the wiring for.

enum class LinkState : uint8_t { Booting, Advertising, Connected };

void displayBegin();

// Safe to call from any task - these only set state. Drawing happens in
// displayTick(), because SPI writes are far too slow for a BLE callback.
void displaySetLink(LinkState s);
void displaySetActivity(const char* text);
// seconds counts down to the next threshold; stage 0 is unpair, 1 is factory
// reset. Pass -1 for seconds when the button is not held.
void displaySetHold(int seconds, int stage);
void displaySetPasskey(uint32_t passkey, bool visible);

// Put the passkey on screen even when it is normally hidden. Used while a
// phone is actually trying to pair, so a hidden passkey is still usable.
void displayRevealPasskey(bool on);
// Whether a new phone may pair right now. When not, the idle screen says how
// to open a window instead of showing the passkey.
void displaySetPairing(bool open);

// Call from loop(). This also drives the screensaver: it ticks it first, hands
// it the panel while it is running, and redraws the status layout from scratch
// when it gives the panel back. Call it often - every 20 ms or so - because the
// savers pace their own frames off it. See screensaver.h.
// The device name, shown large while a phone is connected.
void displaySetName(const char* name);
void displayTick();

// True when this build has a screen at all, so callers can fall back to
// serial and refuse settings that would need one.
bool displayPresent();
