// Host-side unit test for the shared wire-protocol decoder (nib_protocol.c).
//
// This compiles and runs on any machine with a C compiler -- no Flipper SDK, no
// hardware. It is the proof that the shared decoder is correct and genuinely
// platform-independent. Build + run:
//
//   cc -std=c11 -Wall -Wextra -Werror -I.. test_protocol.c ../nib_protocol.c -o test_protocol
//   ./test_protocol
//
// It records every sink call into a log and asserts the decoder produced exactly
// the right calls for each packet, including the length-guard and SECRET rules.

#include "nib_protocol.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

// --- recording sink --------------------------------------------------------

typedef enum { EvTap, EvDown, EvUp, EvReleaseAll, EvMove, EvButton, EvForget, EvConsumer, EvStatusReq } EvKind;

typedef struct {
    EvKind kind;
    int a, b, c; // meaning depends on kind
} Ev;

typedef struct {
    Ev ev[64];
    int count;
} Log;

static void push(Log* l, Ev e) {
    if(l->count < (int)(sizeof(l->ev) / sizeof(l->ev[0]))) l->ev[l->count++] = e;
}

static void t_tap(void* c, uint8_t m, uint8_t u) {
    push(c, (Ev){EvTap, m, u, 0});
}
static void t_down(void* c, uint8_t m, uint8_t u) {
    push(c, (Ev){EvDown, m, u, 0});
}
static void t_up(void* c, uint8_t m, uint8_t u) {
    push(c, (Ev){EvUp, m, u, 0});
}
static void t_release_all(void* c) {
    push(c, (Ev){EvReleaseAll, 0, 0, 0});
}
static void t_move(void* c, int8_t dx, int8_t dy, int8_t w) {
    push(c, (Ev){EvMove, dx, dy, w});
}
static void t_button(void* c, uint8_t b, uint8_t a) {
    push(c, (Ev){EvButton, b, a, 0});
}
static void t_forget(void* c) {
    push(c, (Ev){EvForget, 0, 0, 0});
}

static void t_consumer(void* c, uint16_t u) {
    push(c, (Ev){EvConsumer, u, 0, 0});
}
static void t_status_req(void* c) {
    push(c, (Ev){EvStatusReq, 0, 0, 0});
}

static const NibProtocolSink kSink = {
    .tap = t_tap,
    .key_down = t_down,
    .key_up = t_up,
    .release_all = t_release_all,
    .move = t_move,
    .button = t_button,
    .forget = t_forget,
    .consumer = t_consumer,
    .status_req = t_status_req,
};

// --- test harness ----------------------------------------------------------

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                             \
    do {                                             \
        g_checks++;                                  \
        if(!(cond)) {                                \
            g_failures++;                            \
            printf("  FAIL: " __VA_ARGS__);          \
            printf("  (%s:%d)\n", __FILE__, __LINE__); \
        }                                            \
    } while(0)

static Log run(const uint8_t* pkt, size_t len, int* op_out) {
    Log l = {0};
    int op = nib_protocol_dispatch(&kSink, &l, pkt, len);
    if(op_out) *op_out = op;
    return l;
}

int main(void) {
    printf("nib_protocol host test\n");

    // TAP: two key pairs -> two tap calls, in order.
    {
        uint8_t pkt[] = {NibOpTap, 0x02, 0x04, 0x00, 0x28}; // Shift+a, then Enter
        int op;
        Log l = run(pkt, sizeof(pkt), &op);
        CHECK(op == NibOpTap, "tap opcode returned\n");
        CHECK(l.count == 2, "tap produced 2 calls, got %d\n", l.count);
        CHECK(l.ev[0].kind == EvTap && l.ev[0].a == 0x02 && l.ev[0].b == 0x04, "tap[0] mods+usage\n");
        CHECK(l.ev[1].kind == EvTap && l.ev[1].a == 0x00 && l.ev[1].b == 0x28, "tap[1] mods+usage\n");
    }

    // SECRET decodes exactly like TAP; and is flagged as never-log.
    {
        uint8_t pkt[] = {NibOpSecret, 0x00, 0x04, 0x00, 0x05};
        int op;
        Log l = run(pkt, sizeof(pkt), &op);
        CHECK(op == NibOpSecret, "secret opcode returned\n");
        CHECK(l.count == 2, "secret produced 2 taps, got %d\n", l.count);
        CHECK(nib_protocol_is_secret((uint8_t)op), "secret flagged never-log\n");
        CHECK(!nib_protocol_is_secret(NibOpTap), "tap not flagged secret\n");
    }

    // TAP with a trailing odd byte: the dangling byte is ignored (matches ESP32).
    {
        uint8_t pkt[] = {NibOpTap, 0x00, 0x04, 0x00}; // 1.5 pairs
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1, "odd tap payload -> 1 call, got %d\n", l.count);
    }

    // DOWN / UP need 2 payload bytes.
    {
        uint8_t down[] = {NibOpDown, 0x01, 0x1D};
        Log l = run(down, sizeof(down), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvDown && l.ev[0].a == 0x01 && l.ev[0].b == 0x1D, "down ok\n");

        uint8_t up[] = {NibOpUp, 0x01, 0x1D};
        l = run(up, sizeof(up), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvUp, "up ok\n");

        uint8_t shortpkt[] = {NibOpDown, 0x01}; // only 1 payload byte
        l = run(shortpkt, sizeof(shortpkt), NULL);
        CHECK(l.count == 0, "short down dropped, got %d\n", l.count);
    }

    // RELEASE_ALL: no payload.
    {
        uint8_t pkt[] = {NibOpReleaseAll};
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvReleaseAll, "release_all ok\n");
    }

    // MOVE: signed dx/dy/wheel, needs 3 bytes.
    {
        uint8_t pkt[] = {NibOpMove, 0xFF, 0x0A, 0xFE}; // dx=-1, dy=+10, wheel=-2
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvMove, "move produced 1 call\n");
        CHECK(l.ev[0].a == -1 && l.ev[0].b == 10 && l.ev[0].c == -2, "move signed decode a=%d b=%d c=%d\n", l.ev[0].a, l.ev[0].b, l.ev[0].c);

        uint8_t shortpkt[] = {NibOpMove, 0x01, 0x02}; // only 2 bytes
        l = run(shortpkt, sizeof(shortpkt), NULL);
        CHECK(l.count == 0, "short move dropped\n");
    }

    // BTN: button + action.
    {
        uint8_t pkt[] = {NibOpBtn, 0x02, 0x02}; // right button, click
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvButton && l.ev[0].a == 2 && l.ev[0].b == 2, "btn ok\n");
    }

    // FORGET: no payload.
    {
        uint8_t pkt[] = {NibOpForget};
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvForget, "forget ok\n");
    }

    // CONSUMER: little-endian 16-bit usage; needs 2 bytes.
    {
        uint8_t pkt[] = {NibOpConsumer, 0xCD, 0x00}; // play/pause
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvConsumer && l.ev[0].a == 0xCD, "consumer ok\n");
        uint8_t hi[] = {NibOpConsumer, 0x23, 0x02}; // AC Home 0x0223
        l = run(hi, sizeof(hi), NULL);
        CHECK(l.count == 1 && l.ev[0].a == 0x0223, "consumer high byte, got 0x%x\n", l.ev[0].a);
        uint8_t shortpkt[] = {NibOpConsumer, 0xCD};
        l = run(shortpkt, sizeof(shortpkt), NULL);
        CHECK(l.count == 0, "short consumer dropped\n");
    }

    // STATUS_REQ: no payload.
    {
        uint8_t pkt[] = {NibOpStatusReq};
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 1 && l.ev[0].kind == EvStatusReq, "status_req ok\n");
    }

    // GAMEPAD: no gamepad on the Flipper's USB, so it is ignored.
    {
        uint8_t pkt[16] = {0x15};
        Log l = run(pkt, sizeof(pkt), NULL);
        CHECK(l.count == 0, "gamepad ignored\n");
    }

    // Empty packet -> -1, nothing called.
    {
        int op;
        Log l = run(NULL, 0, &op);
        CHECK(op == -1, "empty packet returns -1\n");
        CHECK(l.count == 0, "empty packet calls nothing\n");
    }

    // Unknown / out-of-scope opcode (a settings op) -> returned, nothing called.
    {
        uint8_t pkt[] = {0x43, 0x01}; // OP_APPLY on the ESP32; out of scope here
        int op;
        Log l = run(pkt, sizeof(pkt), &op);
        CHECK(op == 0x43, "unknown opcode value returned\n");
        CHECK(l.count == 0, "unknown opcode calls nothing\n");
    }

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    if(g_failures == 0) printf("PASS\n");
    else printf("FAIL\n");
    return g_failures == 0 ? 0 : 1;
}
