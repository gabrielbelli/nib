#include "nib_protocol.h"

// Decode one wire packet. The length guards below mirror the ESP32's
// handlePacket (firmware/src/main.cpp) exactly: TAP/SECRET walk [mods,usage]
// pairs and ignore a trailing odd byte, DOWN/UP need 2 bytes, MOVE needs 3,
// BTN and CONSUMER need 2, RELEASE_ALL/FORGET/STATUS_REQ take no payload.
int nib_protocol_dispatch(const NibProtocolSink* sink, void* ctx, const uint8_t* data, size_t len) {
    if(len < 1) return -1;

    const uint8_t op = data[0];
    const uint8_t* p = data + 1;
    const size_t n = len - 1;

    switch(op) {
    case NibOpTap:
    case NibOpSecret: // identical to TAP on the wire; caller must not log it
        if(sink->tap) {
            for(size_t i = 0; i + 1 < n; i += 2) {
                sink->tap(ctx, p[i], p[i + 1]);
            }
        }
        break;

    case NibOpDown:
        if(n >= 2 && sink->key_down) sink->key_down(ctx, p[0], p[1]);
        break;

    case NibOpUp:
        if(n >= 2 && sink->key_up) sink->key_up(ctx, p[0], p[1]);
        break;

    case NibOpReleaseAll:
        if(sink->release_all) sink->release_all(ctx);
        break;

    case NibOpMove:
        if(n >= 3 && sink->move) sink->move(ctx, (int8_t)p[0], (int8_t)p[1], (int8_t)p[2]);
        break;

    case NibOpBtn:
        if(n >= 2 && sink->button) sink->button(ctx, p[0], p[1]);
        break;

    case NibOpForget:
        if(sink->forget) sink->forget(ctx);
        break;

    case NibOpConsumer:
        if(n >= 2 && sink->consumer) sink->consumer(ctx, (uint16_t)(p[0] | (p[1] << 8)));
        break;

    case NibOpStatusReq:
        if(sink->status_req) sink->status_req(ctx);
        break;

    default:
        // Unknown / out-of-scope opcode (settings, screensaver): ignore.
        break;
    }

    return (int)op;
}
