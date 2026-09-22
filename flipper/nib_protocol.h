#pragma once
// N.I.B. wire-protocol decoder -- shared, platform-independent C.
//
// This is the ONE place the opcode wire format is decoded. It has no Flipper,
// ESP32, USB or BLE dependency: it takes a raw packet and calls back into a
// table of function pointers (the "sink") that the platform fills in. The
// Flipper build points the sink at nib_hid; a host unit test points it at
// recording stubs (see test/test_protocol.c). The format is fixed in
// ../firmware/src/protocol.h and is byte-for-byte the same one the ESP32
// firmware decodes in main.cpp:handlePacket -- so it must not be written twice.
//
// Only the input opcodes live here, plus FORGET and STATUS_REQ. The ESP32's
// settings and screensaver opcodes are its own device state; the Flipper keeps
// its settings on its own screen, so those opcodes are ignored. So is GAMEPAD:
// the Flipper's stock USB descriptor has no gamepad.

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opcodes -- single source of truth, kept identical to firmware/src/protocol.h.
typedef enum {
    NibOpTap = 0x10, // [mods, usage]*n  tap each key in order
    NibOpDown = 0x11, // [mods, usage]    hold a key down
    NibOpUp = 0x12, // [mods, usage]    release a key
    NibOpReleaseAll = 0x13, // -               release every key and button
    NibOpConsumer = 0x14, // [lo, hi]        one press of a consumer-control key
    NibOpMove = 0x20, // [dx, dy, wheel] int8 each, relative mouse
    NibOpBtn = 0x21, // [button, action] 1=L 2=R 4=M; 0=up 1=down 2=click
    NibOpSecret = 0x30, // [mods, usage]*n  like TAP but never logged
    NibOpForget = 0x44, // -               wipe bonds
    NibOpStatusReq = 0x45, // -               publish the status now
} NibOpcode;

// The platform fills these in. Any callback may be NULL; a NULL callback for a
// given opcode makes that opcode a no-op. ctx is passed straight back.
typedef struct {
    void (*tap)(void* ctx, uint8_t mods, uint8_t usage); // press then release
    void (*key_down)(void* ctx, uint8_t mods, uint8_t usage);
    void (*key_up)(void* ctx, uint8_t mods, uint8_t usage);
    void (*release_all)(void* ctx);
    void (*move)(void* ctx, int8_t dx, int8_t dy, int8_t wheel);
    void (*button)(void* ctx, uint8_t button, uint8_t action);
    void (*forget)(void* ctx);
    void (*consumer)(void* ctx, uint16_t usage); // press then release
    void (*status_req)(void* ctx);
} NibProtocolSink;

// True for the one opcode whose payload must never be logged (protocol.h).
static inline bool nib_protocol_is_secret(uint8_t op) {
    return op == (uint8_t)NibOpSecret;
}

// Decode ONE packet (data[0] = opcode, rest = payload) and drive the sink.
// Returns the opcode processed, or -1 if the packet was empty. An unknown or
// out-of-scope opcode returns its value but calls nothing. Malformed payloads
// (too short for the opcode) are dropped, matching the ESP32 length guards.
int nib_protocol_dispatch(const NibProtocolSink* sink, void* ctx, const uint8_t* data, size_t len);

#ifdef __cplusplus
}
#endif
