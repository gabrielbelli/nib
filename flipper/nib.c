// N.I.B. (Nearby Input Bridge) - Flipper Zero app.
//
// The phone's web app writes packets to our BLE RX characteristic; each packet
// is decoded by the shared nib_protocol.c and replayed as USB keyboard, mouse
// and media keys on the computer the Flipper is plugged into.
//
// Threads:
//   BLE callback  copies each packet into a queue and returns at once
//   worker        drains the queue into USB HID, publishes the status JSON,
//                 and restarts BLE when a setting changes
//   GUI           the ViewDispatcher: a status screen and a Settings list
//
// Settings live on the Flipper: the advertised name, a keyboard disguise, and
// forgetting paired phones. They persist in the app's data folder. PIN pairing
// is always on and is not an option, so it cannot be turned off.

#include <furi.h>
#include <gui/gui.h>
#include <gui/view.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/variable_item_list.h>
#include <gui/modules/text_input.h>
#include <gui/elements.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>

#include "nib_hid.h"
#include "nib_ble.h"
#include "nib_protocol.h"

#define TAG "nib"
#define NIB_VERSION "flipper-1"
#define NIB_CONF_PATH APP_DATA_PATH("nib.conf")
#define NIB_PKT_MAX (64)
#define NIB_NAME_MAX (20)
#define NIB_GENERIC_NAME "USB Keyboard"

typedef enum {
    NibViewMain,
    NibViewSettings,
    NibViewName,
} NibViewId;

typedef struct {
    uint8_t len;
    uint8_t data[NIB_PKT_MAX];
} NibPacket;

typedef struct {
    bool connected;
    bool advertising;
    bool usb;
    bool pin;
    bool ble_ok;
    uint32_t keys;
    bool exit_hint;
    char note[28];
} NibMainModel;

typedef enum {
    NibFlagStop = 1 << 0,
    NibFlagStatus = 1 << 1, // publish the status JSON
    NibFlagRestart = 1 << 2, // PIN setting changed: restart the BLE profile
    NibFlagForget = 1 << 3, // wipe bonds, from the Settings list
    NibFlagToggle = 1 << 4, // start/stop advertising, from the OK button
} NibFlag;

typedef struct {
    Gui* gui;
    ViewDispatcher* dispatcher;
    View* main_view;
    VariableItemList* settings;
    TextInput* name_input;
    VariableItem* name_item; // the Name row, updated after an edit
    NotificationApp* notifications;

    FuriMessageQueue* packets;
    FuriThread* worker;

    bool pin; // saved: PIN pairing
    bool generic; // saved: advertise a neutral name instead of the brand
    char name[NIB_NAME_MAX + 1]; // saved: the branded name to advertise
    char name_edit[NIB_NAME_MAX + 1]; // scratch buffer for the text input

    uint32_t keys; // worker-only counter, mirrored into the model
    volatile int32_t exit_ticks; // set by a short Back press, counted by the worker
    char note[28]; // worker-only, mirrored into the model
} NibApp;

// The name actually advertised: neutral in generic mode, else the brand.
static const char* nib_effective_name(NibApp* app) {
    if(app->generic) return NIB_GENERIC_NAME;
    return app->name[0] ? app->name : "NIB";
}

// --- settings file ----------------------------------------------------------

static void nib_conf_load(NibApp* app) {
    // Defaults: secure PIN on, branded name, generic off.
    app->pin = true;
    app->generic = false;
    strlcpy(app->name, "NIB", sizeof(app->name));

    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    // Layout: [reserved][generic][name bytes...]. PIN is always on.
    uint8_t buf[2 + NIB_NAME_MAX + 1] = {0};
    if(storage_file_open(file, NIB_CONF_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        size_t n = storage_file_read(file, buf, sizeof(buf) - 1);
        if(n >= 2) app->generic = buf[1] != 0;
        if(n > 2) {
            buf[n] = '\0';
            strlcpy(app->name, (char*)buf + 2, sizeof(app->name));
            if(app->name[0] == '\0') strlcpy(app->name, "NIB", sizeof(app->name));
        }
    }
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
}

static void nib_conf_save(NibApp* app) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    uint8_t buf[2 + NIB_NAME_MAX + 1];
    buf[0] = app->pin ? 1 : 0;
    buf[1] = app->generic ? 1 : 0;
    size_t nlen = strlcpy((char*)buf + 2, app->name, NIB_NAME_MAX + 1);
    if(nlen > NIB_NAME_MAX) nlen = NIB_NAME_MAX;
    if(storage_file_open(file, NIB_CONF_PATH, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        storage_file_write(file, buf, 2 + nlen);
    }
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
}

// --- decoder sink: each opcode calls an nib_hid helper ----------------------

static void sink_tap(void* ctx, uint8_t mods, uint8_t usage) {
    NibApp* app = ctx;
    nib_hid_tap(mods, usage);
    app->keys++;
}
static void sink_key_down(void* ctx, uint8_t mods, uint8_t usage) {
    NibApp* app = ctx;
    nib_hid_key_down(mods, usage);
    app->keys++;
}
static void sink_key_up(void* ctx, uint8_t mods, uint8_t usage) {
    UNUSED(ctx);
    nib_hid_key_up(mods, usage);
}
static void sink_release_all(void* ctx) {
    UNUSED(ctx);
    nib_hid_release_all();
}
static void sink_move(void* ctx, int8_t dx, int8_t dy, int8_t wheel) {
    UNUSED(ctx);
    nib_hid_move(dx, dy, wheel);
}
static void sink_button(void* ctx, uint8_t button, uint8_t action) {
    UNUSED(ctx);
    nib_hid_button(button, action);
}
static void sink_consumer(void* ctx, uint16_t usage) {
    NibApp* app = ctx;
    nib_hid_consumer(usage);
    app->keys++;
}
static void sink_forget(void* ctx) {
    NibApp* app = ctx;
    furi_thread_flags_set(furi_thread_get_id(app->worker), NibFlagForget);
}
static void sink_status_req(void* ctx) {
    NibApp* app = ctx;
    furi_thread_flags_set(furi_thread_get_id(app->worker), NibFlagStatus);
}

static const NibProtocolSink nib_sink = {
    .tap = sink_tap,
    .key_down = sink_key_down,
    .key_up = sink_key_up,
    .release_all = sink_release_all,
    .move = sink_move,
    .button = sink_button,
    .forget = sink_forget,
    .consumer = sink_consumer,
    .status_req = sink_status_req,
};

// BLE thread: copy the packet into the queue and return. The worker drains it.
static void nib_on_rx(const uint8_t* data, size_t len, void* context) {
    NibApp* app = context;
    if(len == 0) return;
    NibPacket pkt;
    pkt.len = len > NIB_PKT_MAX ? NIB_PKT_MAX : (uint8_t)len;
    memcpy(pkt.data, data, pkt.len);
    if(furi_message_queue_put(app->packets, &pkt, 0) != FuriStatusOk) {
        FURI_LOG_W(TAG, "rx queue full, packet dropped");
    }
}

// The status the web app reads on connect. Same field names as the ESP32; "dev"
// = flipper tells it to hide what only the ESP32 has (screen, screensavers,
// name, passkey, USB and gamepad settings).
static void nib_publish_status(NibApp* app) {
    char json[176];
    snprintf(
        json,
        sizeof(json),
        "{\"name\":\"%s\",\"dev\":\"flipper\",\"fw\":\"%s\",\"screen\":0,"
        "\"btn\":1,\"pad\":0,\"pm\":0,\"pin\":%d,\"host\":\"\"}",
        nib_effective_name(app),
        NIB_VERSION,
        app->pin ? 1 : 0);
    nib_ble_set_status(json);
}

static void nib_sync_model(NibApp* app, bool advertising, bool connected, bool usb, bool ble_ok, bool exit_hint) {
    with_view_model(
        app->main_view,
        NibMainModel * m,
        {
            m->connected = connected;
            m->advertising = advertising;
            m->usb = usb;
            m->pin = app->pin;
            m->ble_ok = ble_ok;
            m->keys = app->keys;
            m->exit_hint = exit_hint;
            strlcpy(m->note, app->note, sizeof(m->note));
        },
        true);
}

// --- worker thread ----------------------------------------------------------
// Owns the USB HID side and the BLE profile lifetime. The GUI and BLE callback
// only queue work and set flags; all HID output and stack calls happen here.

static int32_t nib_worker(void* context) {
    NibApp* app = context;

    void* prev_usb = nib_hid_begin();

    // Start the BLE profile once, silent. It stays up for the whole session;
    // pairing mode just turns advertising on and off. Nothing is discoverable
    // until the user presses Pair.
    bool ble_ok = nib_ble_start(nib_on_rx, app, app->pin, nib_effective_name(app));
    if(!ble_ok) FURI_LOG_E(TAG, "BLE profile failed to start");
    bool advertising = false; // discoverable (in pairing mode)
    bool connected = false;
    nib_publish_status(app);
    nib_sync_model(app, advertising, connected, nib_hid_is_connected(), ble_ok, false);

    bool running = true;
    while(running) {
        // Drain any queued packets, then wait briefly for a flag or a timeout.
        NibPacket pkt;
        while(furi_message_queue_get(app->packets, &pkt, 0) == FuriStatusOk) {
            nib_protocol_dispatch(&nib_sink, app, pkt.data, pkt.len);
        }

        uint32_t flags = furi_thread_flags_wait(
            NibFlagStop | NibFlagStatus | NibFlagRestart | NibFlagForget | NibFlagToggle,
            FuriFlagWaitAny,
            50);
        if(flags == (uint32_t)FuriFlagErrorTimeout) flags = 0;

        if(flags & NibFlagToggle) {
            if(connected) {
                // Disconnect the phone; the loop below returns us to Ready.
                nib_ble_disconnect();
            } else if(advertising) {
                nib_ble_set_discoverable(false); // leave pairing mode
                advertising = false;
            } else if(ble_ok) {
                nib_ble_set_discoverable(true); // enter pairing mode
                advertising = true;
                nib_publish_status(app);
            }
        }
        if(flags & NibFlagForget) {
            nib_ble_forget_bonds();
            strlcpy(app->note, "paired phones forgotten", sizeof(app->note));
        }
        if(flags & NibFlagRestart) {
            // A name/disguise change: the advertised name is read when the
            // profile starts, so restart it. Always return to Ready (silent);
            // renaming never turns broadcasting back on. Skip while connected.
            if(!connected) {
                nib_hid_release_all();
                nib_ble_stop();
                ble_ok = nib_ble_start(nib_on_rx, app, app->pin, nib_effective_name(app));
                advertising = false;
                nib_ble_set_discoverable(false);
                nib_publish_status(app);
            }
        }
        if(flags & NibFlagStatus) {
            nib_publish_status(app);
        }
        if(flags & NibFlagStop) {
            running = false;
        }

        bool now = nib_ble_is_connected();
        if(now && !connected) {
            connected = true; // a phone paired or reconnected; the stack stops advertising
            advertising = false;
            nib_publish_status(app);
            app->note[0] = '\0';
        } else if(!now && connected) {
            // The phone dropped: return to Ready. Stay silent, do not re-advertise.
            connected = false;
            advertising = false;
            nib_ble_set_discoverable(false);
            app->note[0] = '\0';
        }

        bool exit_hint = app->exit_ticks > 0;
        if(exit_hint) app->exit_ticks--;
        nib_sync_model(app, advertising, connected, nib_hid_is_connected(), ble_ok, exit_hint);
    }

    nib_hid_release_all();
    nib_ble_stop();
    nib_hid_end(prev_usb);
    return 0;
}

// --- main view: the status screen -------------------------------------------

static void nib_main_draw(Canvas* canvas, void* model) {
    NibMainModel* m = model;
    canvas_clear(canvas);

    // A small USB indicator, top-left: filled when a host is attached.
    canvas_set_font(canvas, FontSecondary);
    if(m->usb) {
        canvas_draw_disc(canvas, 5, 5, 2);
    } else {
        canvas_draw_circle(canvas, 5, 5, 2);
    }
    canvas_draw_str(canvas, 11, 8, m->usb ? "USB" : "No USB");

    // The brand mark: N, I, B each inside its own circle.
    const char* letters[3] = {"N", "I", "B"};
    const int cx[3] = {40, 64, 88};
    canvas_set_font(canvas, FontPrimary);
    for(int i = 0; i < 3; i++) {
        canvas_draw_disc(canvas, cx[i], 19, 9);
        canvas_set_color(canvas, ColorWhite);
        canvas_draw_str_aligned(canvas, cx[i], 20, AlignCenter, AlignCenter, letters[i]);
        canvas_set_color(canvas, ColorBlack);
    }

    // One status line: exit hint, then an ephemeral note, then the link state.
    canvas_set_font(canvas, FontSecondary);
    const char* status;
    if(m->exit_hint) {
        status = "Hold Back to exit";
    } else if(m->note[0]) {
        status = m->note;
    } else if(m->connected) {
        status = "Connected";
    } else if(m->advertising) {
        status = m->ble_ok ? "Pairing mode" : "Bluetooth error";
    } else {
        status = "Ready";
    }
    canvas_draw_str_aligned(canvas, 64, 45, AlignCenter, AlignBottom, status);

    // Native button hints: OK enters/leaves pairing, Right opens settings.
    const char* action = m->connected ? "Disconnect" : (m->advertising ? "Cancel" : "Pair");
    elements_button_left(canvas, action);
    elements_button_right(canvas, "Settings");
}

static bool nib_main_input(InputEvent* event, void* context) {
    NibApp* app = context;
    if(event->type == InputTypeShort &&
       (event->key == InputKeyLeft || event->key == InputKeyOk)) {
        // Left (or OK) toggles pairing mode. Nothing is discoverable until then.
        furi_thread_flags_set(furi_thread_get_id(app->worker), NibFlagToggle);
        return true;
    }
    if(event->type == InputTypeShort && event->key == InputKeyRight) {
        view_dispatcher_switch_to_view(app->dispatcher, NibViewSettings);
        return true;
    }
    if(event->key == InputKeyBack) {
        // Hold Back to exit. A short press only shows the hint, so an accidental
        // tap never drops the session. 40 worker ticks ~= 2 s.
        if(event->type == InputTypeLong) {
            view_dispatcher_stop(app->dispatcher);
        } else if(event->type == InputTypeShort) {
            app->exit_ticks = 40;
        }
        return true;
    }
    return false;
}

// --- settings list ----------------------------------------------------------

static void nib_restart_ble(NibApp* app) {
    furi_thread_flags_set(furi_thread_get_id(app->worker), NibFlagRestart);
}

static void nib_generic_changed(VariableItem* item) {
    NibApp* app = variable_item_get_context(item);
    uint8_t index = variable_item_get_current_value_index(item);
    variable_item_set_current_value_text(item, index ? "On" : "Off");
    app->generic = index != 0;
    nib_conf_save(app);
    nib_restart_ble(app);
}

// The Name row shows the advertised name; in generic mode it shows the neutral
// one and is not editable through this row.
static void nib_update_name_item(NibApp* app) {
    if(!app->name_item) return;
    variable_item_set_current_value_text(app->name_item, nib_effective_name(app));
}

static void nib_name_input_done(void* context) {
    NibApp* app = context;
    strlcpy(app->name, app->name_edit, sizeof(app->name));
    if(app->name[0] == '\0') strlcpy(app->name, "NIB", sizeof(app->name));
    nib_conf_save(app);
    nib_update_name_item(app);
    nib_restart_ble(app);
    view_dispatcher_switch_to_view(app->dispatcher, NibViewSettings);
}

static void nib_open_name_input(NibApp* app) {
    strlcpy(app->name_edit, app->name, sizeof(app->name_edit));
    text_input_reset(app->name_input);
    text_input_set_header_text(app->name_input, "Advertised name");
    text_input_set_result_callback(
        app->name_input, nib_name_input_done, app, app->name_edit, sizeof(app->name_edit), false);
    view_dispatcher_switch_to_view(app->dispatcher, NibViewName);
}

typedef enum {
    NibItemDisguise = 0,
    NibItemName,
    NibItemForget,
} NibItem;

static void nib_settings_enter(void* context, uint32_t index) {
    NibApp* app = context;
    if(index == NibItemName) {
        if(!app->generic) nib_open_name_input(app);
    } else if(index == NibItemForget) {
        furi_thread_flags_set(furi_thread_get_id(app->worker), NibFlagForget);
    }
}

static void nib_build_settings(NibApp* app) {
    VariableItem* item;

    item = variable_item_list_add(app->settings, "Disguise as keyboard", 2, nib_generic_changed, app);
    variable_item_set_current_value_index(item, app->generic ? 1 : 0);
    variable_item_set_current_value_text(item, app->generic ? "On" : "Off");

    // A display row; OK opens the text input (see nib_settings_enter).
    app->name_item = variable_item_list_add(app->settings, "Name", 1, NULL, app);
    nib_update_name_item(app);

    variable_item_list_add(app->settings, "Forget paired phones", 1, NULL, app);
    variable_item_list_set_enter_callback(app->settings, nib_settings_enter, app);
}

// --- navigation -------------------------------------------------------------

static uint32_t nib_exit_to_main(void* context) {
    UNUSED(context);
    return NibViewMain;
}

static uint32_t nib_exit_to_settings(void* context) {
    UNUSED(context);
    return NibViewSettings;
}

// --- entry point ------------------------------------------------------------

int32_t nib_app(void* arg) {
    UNUSED(arg);
    NibApp* app = malloc(sizeof(NibApp));
    memset(app, 0, sizeof(NibApp));

    nib_conf_load(app);

    app->packets = furi_message_queue_alloc(32, sizeof(NibPacket));
    app->gui = furi_record_open(RECORD_GUI);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->dispatcher = view_dispatcher_alloc();

    // Main status view.
    app->main_view = view_alloc();
    view_allocate_model(app->main_view, ViewModelTypeLocking, sizeof(NibMainModel));
    view_set_context(app->main_view, app);
    view_set_draw_callback(app->main_view, nib_main_draw);
    view_set_input_callback(app->main_view, nib_main_input);
    view_dispatcher_add_view(app->dispatcher, NibViewMain, app->main_view);

    // Settings list.
    app->settings = variable_item_list_alloc();
    nib_build_settings(app);
    view_set_previous_callback(
        variable_item_list_get_view(app->settings), nib_exit_to_main);
    view_dispatcher_add_view(
        app->dispatcher, NibViewSettings, variable_item_list_get_view(app->settings));

    // Name editor (text input). Back returns to the settings list.
    app->name_input = text_input_alloc();
    view_set_previous_callback(text_input_get_view(app->name_input), nib_exit_to_settings);
    view_dispatcher_add_view(app->dispatcher, NibViewName, text_input_get_view(app->name_input));

    // Start the worker before showing UI so USB and BLE are up on first draw.
    app->worker = furi_thread_alloc_ex("NibWorker", 4096, nib_worker, app);
    furi_thread_start(app->worker);

    view_dispatcher_attach_to_gui(app->dispatcher, app->gui, ViewDispatcherTypeFullscreen);
    view_dispatcher_switch_to_view(app->dispatcher, NibViewMain);
    view_dispatcher_run(app->dispatcher);

    // Stop the worker and tear everything down.
    furi_thread_flags_set(furi_thread_get_id(app->worker), NibFlagStop);
    furi_thread_join(app->worker);
    furi_thread_free(app->worker);

    view_dispatcher_remove_view(app->dispatcher, NibViewMain);
    view_dispatcher_remove_view(app->dispatcher, NibViewSettings);
    view_dispatcher_remove_view(app->dispatcher, NibViewName);
    view_free(app->main_view);
    variable_item_list_free(app->settings);
    text_input_free(app->name_input);
    view_dispatcher_free(app->dispatcher);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_GUI);
    furi_message_queue_free(app->packets);
    free(app);
    return 0;
}
