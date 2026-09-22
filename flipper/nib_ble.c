#include "nib_ble.h"

#include <furi.h>
#include <furi_hal_bt.h>
#include <furi_hal_version.h>
#include <bt/bt_service/bt.h>
#include <furi_ble/gatt.h>
#include <furi_ble/profile_interface.h>
#include <furi_ble/event_dispatcher.h>
#include <gap.h>
#include <storage/storage.h>

// The in-tree Serial service pulls the whole ST copro stack via <ble/ble.h>.
// That umbrella header is NOT in an external FAP's sysroot (verified: `ufbt`
// on release 1.4.3 / API 88.2 -- `fatal error: ble/ble.h: No such file`). Only
// these three copro headers ship to external apps, so include them directly:
//   ble_defs.h     CHAR_PROP_*, ATTR_PERMISSION_*, UUID_TYPE_128, PRIMARY_SERVICE
//   ble_std.h      HCI_VENDOR_SPECIFIC_DEBUG_EVT_CODE
//   ble_types.h    aci_gatt_attribute_modified_event_rp0 (the write payload)
#include <ble/core/ble_defs.h>
#include <ble/core/ble_std.h>
#include <ble/core/auto/ble_types.h>

// The three thin HCI transport wrappers that <ble/ble.h> would have supplied are
// NOT shipped to external apps, but their layout is fixed STM32WB copro ABI (the
// event_dispatcher hands the handler an `hci_uart_pckt*` as its `void* event`).
// Mirror exactly that ABI here so the RX write handler compiles as a plain .fap.
// If a future SDK exports <ble/ble.h> to apps, delete this block and restore the
// single include. VSEVT code is the stock ACI GATT "attribute modified" opcode.
#ifndef ACI_GATT_ATTRIBUTE_MODIFIED_VSEVT_CODE
#define ACI_GATT_ATTRIBUTE_MODIFIED_VSEVT_CODE (0x0C01U)
#endif

typedef __PACKED_STRUCT {
    uint8_t type;
    uint8_t data[];
}
hci_uart_pckt;

typedef __PACKED_STRUCT {
    uint8_t evt;
    uint8_t plen;
    uint8_t data[];
}
hci_event_pckt;

typedef __PACKED_STRUCT {
    uint16_t ecode;
    uint8_t data[];
}
evt_blecore_aci;

// ===========================================================================
// N.I.B. custom 128-bit GATT service + advertising profile for the Flipper.
//
// This compiles into a valid FAP with ufbt (release 1.4.3, API 87.1); it is
// modelled line-for-line on the firmware's own Serial service/profile, using
// ONLY app-exported symbols. It has NOT been run on hardware. Verified against
// targets/f7/api_symbols.csv in the deployed SDK:
//
//   ble_gatt_service_add / ble_gatt_characteristic_init / _update / _delete
//   ble_event_dispatcher_register_svc_handler / _unregister_svc_handler
//   bt_profile_start / bt_profile_restore_default / bt_forget_bonded_devices
//   bt_set_status_changed_callback   (RECORD_BT)
//
// Reference sources (dev branch), copied field-for-field:
//   targets/f7/ble_glue/services/serial_service.c   (service + chars + evt handler)
//   targets/f7/ble_glue/profiles/serial_profile.c   (profile template + GapConfig)
//   targets/f7/ble_glue/furi_ble/gatt.h             (BleGattCharacteristic* structs)
//   targets/f7/ble_glue/gap.h                       (GapConfig.adv_service)
//
// The ONE thing the Serial profile does that we change: it advertises a 16-bit
// UUID. We advertise the fixed 128-bit N.I.B. UUID (adv_service.UUID_Type =
// UUID_TYPE_128) so Web Bluetooth can filter on it.
//
// BUILDS as a plain external .fap: <ble/ble.h> is NOT in the external sysroot,
// so this includes the three shipped copro headers directly and mirrors the
// three thin HCI transport wrappers locally (see the shim block below).
// ===========================================================================

// ST's stack takes 128-bit UUIDs as raw bytes in LITTLE-ENDIAN order, i.e. the
// textual UUID reversed. Verified against serial_service_uuid.inc byte order.
//
//   service 6e7d0001-b3f2-4c11-9a5d-0f1a2b3c4d5e
//   rx      6e7d0002-b3f2-4c11-9a5d-0f1a2b3c4d5e
//   status  6e7d0003-b3f2-4c11-9a5d-0f1a2b3c4d5e
#define NIB_UUID_SERVICE                                                       \
    {0x5e, 0x4d, 0x3c, 0x2b, 0x1a, 0x0f, 0x5d, 0x9a,                           \
     0x11, 0x4c, 0xf2, 0xb3, 0x01, 0x00, 0x7d, 0x6e}
#define NIB_UUID_RX                                                            \
    {0x5e, 0x4d, 0x3c, 0x2b, 0x1a, 0x0f, 0x5d, 0x9a,                           \
     0x11, 0x4c, 0xf2, 0xb3, 0x02, 0x00, 0x7d, 0x6e}
#define NIB_UUID_STATUS                                                        \
    {0x5e, 0x4d, 0x3c, 0x2b, 0x1a, 0x0f, 0x5d, 0x9a,                           \
     0x11, 0x4c, 0xf2, 0xb3, 0x03, 0x00, 0x7d, 0x6e}

static const Service_UUID_t nib_service_uuid = {.Service_UUID_128 = NIB_UUID_SERVICE};

// Largest RX packet we accept. Protocol packets are tiny (a TAP burst is the
// biggest: 1 opcode + up to ~20 [mods,usage] pairs). 64 is generous.
#define NIB_RX_MAX_LEN (64)

// --- GATT characteristics --------------------------------------------------

typedef enum {
    NibCharRx = 0,
    NibCharStatus,
    NibCharCount,
} NibCharId;

// The status is a short JSON object, the same shape the ESP32 sends. A notify
// carries MTU-3 bytes; the web app falls back to a long read when one is cut.
#define NIB_STATUS_MAX (160)

// Callback-backed value: at creation `data` is NULL and only the maximum length
// is wanted; on update `context` is the NUL-terminated JSON to publish.
static bool nib_status_data(const void* context, const uint8_t** data, uint16_t* len) {
    if(data == NULL) {
        *len = NIB_STATUS_MAX;
        return false;
    }
    const char* json = context ? context : "{}";
    size_t n = strlen(json);
    if(n > NIB_STATUS_MAX) n = NIB_STATUS_MAX;
    *data = (const uint8_t*)json;
    *len = (uint16_t)n;
    return false; // we keep ownership
}

static const BleGattCharacteristicParams nib_chars[NibCharCount] = {
    [NibCharRx] =
        {.name = "RX",
         .data_prop_type = FlipperGattCharacteristicDataFixed,
         .data.fixed.length = NIB_RX_MAX_LEN,
         .uuid.Char_UUID_128 = NIB_UUID_RX,
         .uuid_type = UUID_TYPE_128,
         .char_properties = CHAR_PROP_WRITE | CHAR_PROP_WRITE_WITHOUT_RESP,
         .security_permissions = ATTR_PERMISSION_NONE,
         .gatt_evt_mask = GATT_NOTIFY_ATTRIBUTE_WRITE,
         .is_variable = CHAR_VALUE_LEN_VARIABLE},
    [NibCharStatus] =
        {.name = "STATUS",
         .data_prop_type = FlipperGattCharacteristicDataCallback,
         .data.callback.fn = nib_status_data,
         .data.callback.context = NULL,
         .uuid.Char_UUID_128 = NIB_UUID_STATUS,
         .uuid_type = UUID_TYPE_128,
         .char_properties = CHAR_PROP_READ | CHAR_PROP_NOTIFY,
         .security_permissions = ATTR_PERMISSION_NONE,
         .gatt_evt_mask = GATT_DONT_NOTIFY_EVENTS,
         .is_variable = CHAR_VALUE_LEN_VARIABLE}};

// --- Service instance ------------------------------------------------------

typedef struct {
    uint16_t svc_handle;
    BleGattCharacteristicInstance chars[NibCharCount];
    GapSvcEventHandler* event_handler;
    NibRxCallback rx_cb;
    void* rx_ctx;
} NibGattSvc;

// GATT event handler: fires on every attribute write. Mirrors the RX branch of
// serial_service.c's ble_svc_serial_event_handler. The value handle is the
// characteristic handle + 1.
static BleEventAckStatus nib_svc_event_handler(void* event, void* context) {
    NibGattSvc* svc = context;
    BleEventAckStatus ret = BleEventNotAck;

    hci_event_pckt* event_pckt = (hci_event_pckt*)(((hci_uart_pckt*)event)->data);
    evt_blecore_aci* blecore_evt = (evt_blecore_aci*)event_pckt->data;

    if(event_pckt->evt == HCI_VENDOR_SPECIFIC_DEBUG_EVT_CODE &&
       blecore_evt->ecode == ACI_GATT_ATTRIBUTE_MODIFIED_VSEVT_CODE) {
        aci_gatt_attribute_modified_event_rp0* attr =
            (aci_gatt_attribute_modified_event_rp0*)blecore_evt->data;

        if(attr->Attr_Handle == svc->chars[NibCharRx].handle + 1) {
            if(svc->rx_cb && attr->Attr_Data_Length > 0) {
                svc->rx_cb(attr->Attr_Data, attr->Attr_Data_Length, svc->rx_ctx);
            }
            ret = BleEventAckFlowEnable;
        }
    }
    return ret;
}

static NibGattSvc* nib_svc_start(bool pin) {
    NibGattSvc* svc = malloc(sizeof(NibGattSvc));

    svc->event_handler =
        ble_event_dispatcher_register_svc_handler(nib_svc_event_handler, svc);

    // service decl(1) + RX(decl+value=2) + STATUS(decl+value+cccd=3) = 6; pad to 8.
    if(!ble_gatt_service_add(
           UUID_TYPE_128, &nib_service_uuid, PRIMARY_SERVICE, 8, &svc->svc_handle)) {
        ble_event_dispatcher_unregister_svc_handler(svc->event_handler);
        free(svc);
        return NULL;
    }
    for(uint8_t i = 0; i < NibCharCount; i++) {
        // init copies the descriptor, so a stack copy can carry the PIN choice.
        BleGattCharacteristicParams params = nib_chars[i];
        if(i == NibCharRx && pin) {
            params.security_permissions = ATTR_PERMISSION_AUTHEN_WRITE;
        }
        ble_gatt_characteristic_init(svc->svc_handle, &params, &svc->chars[i]);
    }
    return svc;
}

static void nib_svc_stop(NibGattSvc* svc) {
    if(!svc) return;
    ble_event_dispatcher_unregister_svc_handler(svc->event_handler);
    for(uint8_t i = 0; i < NibCharCount; i++) {
        ble_gatt_characteristic_delete(svc->svc_handle, &svc->chars[i]);
    }
    ble_gatt_service_delete(svc->svc_handle);
    free(svc);
}

// --- Profile template ------------------------------------------------------

typedef struct {
    FuriHalBleProfileBase base;
    NibGattSvc* svc;
} NibBleProfile;
_Static_assert(offsetof(NibBleProfile, base) == 0, "base must be first");

// Callbacks + context are handed in through bt_profile_start's `params`.
typedef struct {
    NibRxCallback rx_cb;
    void* rx_ctx;
    const char* adv_name;
    bool pin; // PIN pairing with bonding, shown on the Flipper's screen
} NibProfileParams;

static FuriHalBleProfileBase* nib_profile_start(FuriHalBleProfileParams profile_params);
static void nib_profile_stop(FuriHalBleProfileBase* base);
static void nib_profile_get_gap_config(GapConfig* config, FuriHalBleProfileParams profile_params);

static const FuriHalBleProfileTemplate nib_profile_callbacks = {
    .start = nib_profile_start,
    .stop = nib_profile_stop,
    .get_gap_config = nib_profile_get_gap_config,
};
#define nib_profile_template (&nib_profile_callbacks)

static FuriHalBleProfileBase* nib_profile_start(FuriHalBleProfileParams profile_params) {
    NibProfileParams* p = profile_params;

    NibBleProfile* profile = malloc(sizeof(NibBleProfile));
    profile->base.config = nib_profile_template;
    profile->svc = nib_svc_start(p ? p->pin : false);
    if(profile->svc && p) {
        profile->svc->rx_cb = p->rx_cb;
        profile->svc->rx_ctx = p->rx_ctx;
    }
    return &profile->base;
}

static void nib_profile_stop(FuriHalBleProfileBase* base) {
    furi_check(base);
    NibBleProfile* profile = (NibBleProfile*)base;
    nib_svc_stop(profile->svc);
    // Note: `base` itself is freed by the BT service after stop() returns.
}

#define NIB_CONN_INT_MIN (0x06) // 7.5 ms
#define NIB_CONN_INT_MAX (0x24) // 45 ms

static void nib_profile_get_gap_config(GapConfig* config, FuriHalBleProfileParams profile_params) {
    NibProfileParams* p = profile_params;
    furi_check(config);

    memset(config, 0, sizeof(GapConfig));

    // THE make-or-break line: advertise our fixed 128-bit service UUID so
    // navigator.bluetooth.requestDevice({filters:[{services:[UUID]}]}) matches.
    config->adv_service.UUID_Type = UUID_TYPE_128;
    memcpy(config->adv_service.Service_UUID_128, (const uint8_t[])NIB_UUID_SERVICE, 16);

    config->appearance_char = 0x03C1; // HID keyboard, cosmetic only
    // With PIN on, the stock Bt service shows the code on the Flipper's screen
    // and the phone asks for it once; the bond is kept in our own key file.
    const bool pin = p && p->pin;
    config->bonding_mode = pin;
    config->pairing_method = pin ? GapPairingPinCodeShow : GapPairingNone;

    config->conn_param.conn_int_min = NIB_CONN_INT_MIN;
    config->conn_param.conn_int_max = NIB_CONN_INT_MAX;
    config->conn_param.slave_latency = 0;
    config->conn_param.supervisor_timeout = 0;

    // A different address from the Flipper's own profile. Phones cache the GATT
    // layout per address, and would otherwise look for the Serial service here.
    // The HID app adds 1 to this byte; we add 2 so neither collides.
    memcpy(config->mac_address, furi_hal_version_get_ble_mac(), sizeof(config->mac_address));
    config->mac_address[2] += 2;

    // The firmware reads adv_name[0] as the advertising AD type and the name
    // from adv_name[1] (furi_hal_version's own name buffer is stored that way).
    // Write a plain string here and the phone reads 'N' as the AD type and shows
    // no name. Prepend AD_TYPE_COMPLETE_LOCAL_NAME so the chooser shows the name.
    const char* name = (p && p->adv_name) ? p->adv_name : "NIB";
    config->adv_name[0] = AD_TYPE_COMPLETE_LOCAL_NAME;
    strlcpy(config->adv_name + 1, name, FURI_HAL_VERSION_DEVICE_NAME_LENGTH - 1);
}

// --- Public module API -----------------------------------------------------

static struct {
    Bt* bt;
    FuriHalBleProfileBase* profile;
    NibProfileParams params;
    volatile bool connected;
    char status[NIB_STATUS_MAX + 1];
} nib_ble = {0};

#define NIB_KEYS_PATH APP_DATA_PATH(".nib.keys")

static void nib_bt_status_cb(BtStatus status, void* context) {
    UNUSED(context);
    nib_ble.connected = (status == BtStatusConnected);
}

bool nib_ble_start(NibRxCallback rx_cb, void* context, bool pin, const char* name) {
    furi_check(nib_ble.bt == NULL);

    nib_ble.params.rx_cb = rx_cb;
    nib_ble.params.rx_ctx = context;
    nib_ble.params.adv_name = (name && name[0]) ? name : "NIB";
    nib_ble.params.pin = pin;
    nib_ble.connected = false;

    nib_ble.bt = furi_record_open(RECORD_BT);
    bt_disconnect(nib_ble.bt);
    furi_delay_ms(200);
    // Our bonds live in our own file, so Forget never touches the phones paired
    // with the Flipper app, and theirs never leak into N.I.B.
    bt_keys_storage_set_storage_path(nib_ble.bt, NIB_KEYS_PATH);
    bt_set_status_changed_callback(nib_ble.bt, nib_bt_status_cb, NULL);

    // Swap the system BLE profile for ours. Restarts core2 and REPLACES the
    // default Serial/RPC profile (the Flipper mobile app link is down while we
    // run). bt_profile_restore_default() in nib_ble_stop() puts it back.
    nib_ble.profile = bt_profile_start(nib_ble.bt, nib_profile_template, &nib_ble.params);
    if(!nib_ble.profile) {
        FURI_LOG_E("nib", "bt_profile_start failed");
        bt_set_status_changed_callback(nib_ble.bt, NULL, NULL);
        bt_keys_storage_set_default_path(nib_ble.bt);
        furi_record_close(RECORD_BT);
        nib_ble.bt = NULL;
        return false;
    }

    // Start silent. The profile is up, but nothing is advertised until the app
    // enters pairing mode via nib_ble_set_discoverable(true).
    furi_hal_bt_stop_advertising();
    return true;
}

void nib_ble_set_discoverable(bool on) {
    if(!nib_ble.bt) return;
    if(on) {
        furi_hal_bt_start_advertising();
    } else {
        furi_hal_bt_stop_advertising();
    }
}

void nib_ble_disconnect(void) {
    if(nib_ble.bt) bt_disconnect(nib_ble.bt);
}

void nib_ble_stop(void) {
    if(!nib_ble.bt) return;
    furi_hal_bt_stop_advertising();
    bt_set_status_changed_callback(nib_ble.bt, NULL, NULL);
    bt_disconnect(nib_ble.bt);
    furi_delay_ms(200);
    bt_keys_storage_set_default_path(nib_ble.bt);
    if(!bt_profile_restore_default(nib_ble.bt)) FURI_LOG_E("nib", "restore default profile failed");
    furi_record_close(RECORD_BT);
    nib_ble.bt = NULL;
    nib_ble.profile = NULL;
    nib_ble.connected = false;
}

bool nib_ble_set_status(const char* json) {
    // Store a copy: the stack reads the value on every later read request.
    strlcpy(nib_ble.status, json, sizeof(nib_ble.status));
    if(!nib_ble.profile) return false;
    NibBleProfile* profile = (NibBleProfile*)nib_ble.profile;
    if(!profile->svc) return false;
    return ble_gatt_characteristic_update(
        profile->svc->svc_handle, &profile->svc->chars[NibCharStatus], nib_ble.status);
}

bool nib_ble_is_connected(void) {
    return nib_ble.connected;
}

void nib_ble_forget_bonds(void) {
    if(nib_ble.bt) {
        bt_forget_bonded_devices(nib_ble.bt);
        return;
    }
    // Radio is off: drop the bond file directly so idle-mode Forget still works.
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_simply_remove(storage, NIB_KEYS_PATH);
    furi_record_close(RECORD_STORAGE);
}
