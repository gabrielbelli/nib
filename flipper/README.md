# N.I.B. Dongle: Flipper Zero build

Make a **Flipper Zero** act as the N.I.B. dongle instead of the ESP32-S3: a BLE
GATT peripheral the phone web app connects to, bridged to a USB HID
keyboard+mouse on the host the Flipper is plugged into.

> **Status: working on hardware.** A clean `ufbt` build produces `dist/nib.fap`,
> passes `APPCHK`, and runs on a Flipper Zero (Unleashed firmware, **API 87.1**)
> as a plain external app, no firmware fork. Discovery over the 128-bit UUID,
> BLE-peripheral + USB-HID at once, PIN pairing, and typing on the host are all
> confirmed on a device.

## Verdict: yes, with one permanent UX caveat

A plain, unforked Flipper app advertises the fixed 128-bit N.I.B. service, Web
Bluetooth finds it, and keystrokes reach the host over USB. The only caveat is
not a technical gate:

> The Flipper has **no headless/background mode**. The app must stay in the
> foreground for the whole session; translation stops the instant you exit. The
> ESP32 dongle is always-on. This is inherent to the Flipper and not fixable in
> software.

## What was actually built and verified here

| Check | Result |
|---|---|
| Shared protocol decoder compiles (host `cc`, `-Wall -Wextra -Werror`) | **pass**, 0 warnings |
| Shared decoder unit test (`test/test_protocol.c`) | **pass**, 27/27 checks |
| Full FAP builds with `ufbt` (release 1.4.3, API 87.1) | **pass**, 0 warnings |
| `APPCHK` (catalogue validity) | **pass**, Target 7, API 87.1 |
| `dist/nib.fap` produced | yes (~9 KB, ARM EABI relocatable) |
| Run on a real Flipper | **pass**, discovery, PIN pairing and typing confirmed |

The exact commands and their output are reproducible; see **Build** below.

## Architecture

Four C files, three of them Flipper-specific, one deliberately not:

| File | Role | Flipper dependency |
|---|---|---|
| `nib_protocol.c/.h` | **wire-protocol decoder**, opcodes to sink callbacks | **none** (pure C11) |
| `nib.c` | app shell, GUI, input loop; binds the decoder's sink to HID+BLE | yes |
| `nib_hid.c/.h` | USB HID output (same exported API as BadUSB) | yes |
| `nib_ble.c/.h` | custom 128-bit GATT service + advertising profile | yes |
| `test/test_protocol.c` | host unit test for the decoder | none |

`nib_protocol.c` is the part that is **byte-for-byte identical** to the ESP32's
`handlePacket` (`../firmware/src/main.cpp`). It is written once, with no Flipper
or USB or BLE header in sight, and driven through a table of function pointers
(`NibProtocolSink`). The Flipper build points that sink at `nib_hid`; the host
test points it at recording stubs. This is why the same decode logic does not
have to be written twice and can be tested off-device.

### BLE: how the 128-bit service is advertised

`nib_ble.c` is modelled field-for-field on the firmware's own **Serial
service/profile** (`ble_glue/services/serial_service.c` +
`profiles/serial_profile.c`). It is a custom 128-bit service with a write-RX and a
notify-TX, which is exactly the shape N.I.B. needs and is how the Flipper mobile
app already discovers a Flipper by UUID. The one change: `get_gap_config`
advertises the fixed 128-bit N.I.B. UUID
(`GapConfig.adv_service.UUID_Type = UUID_TYPE_128` + `Service_UUID_128[16]`), so
`navigator.bluetooth.requestDevice({filters:[{services:[UUID]}]})` can match it.

The profile is swapped in via the **`Bt` record** (`RECORD_BT`), not
`furi_hal_bt_change_app` directly:

| Need | Call |
|---|---|
| Swap to our custom profile (restarts core2) | `bt_profile_start(bt, &nib_profile_template, &params)` |
| Restore the default (Serial/RPC) profile on exit | `bt_profile_restore_default(bt)` |
| Connection state | `bt_set_status_changed_callback(bt, cb, ctx)` |
| `OP_FORGET` (wipe bonds) | `bt_forget_bonded_devices(bt)` |

### The `<ble/ble.h>` question, resolved

The earlier recon flagged one thing it could not settle without a compiler:
does an external FAP's sysroot ship the ST copro umbrella header `<ble/ble.h>`
that the RX write-event handler needs? **Answer: no, it does not** (verified: a
build fails with `fatal error: ble/ble.h: No such file or directory`). But that
does **not** force a fork. Only three copro headers ship to external apps:

```
ble/core/ble_defs.h        CHAR_PROP_*, ATTR_PERMISSION_*, UUID_TYPE_128, PRIMARY_SERVICE
ble/core/ble_std.h         HCI_VENDOR_SPECIFIC_DEBUG_EVT_CODE
ble/core/auto/ble_types.h  aci_gatt_attribute_modified_event_rp0 (the write payload)
```

The write payload struct and the vendor event code, the parts that carry the
data, are present. Only the three thin HCI transport wrappers
(`hci_uart_pckt`, `hci_event_pckt`, `evt_blecore_aci`) are missing, and their
layout is fixed STM32WB copro ABI. `nib_ble.c` includes the three real headers
and mirrors those three wrappers locally, with a comment to delete the shim if a
future SDK ever exports `<ble/ble.h>` to apps. It stays a plain `.fap`.

## Build

Build in a local venv, so the SDK and ARM toolchain live under `flipper/.ufbt/`
(set by `UFBT_HOME`) instead of a global install.

```bash
cd flipper
python3 -m venv .venv-ufbt
. .venv-ufbt/bin/activate
pip install ufbt

export UFBT_HOME="$PWD/.ufbt"   # keep SDK + toolchain local to the repo
ufbt update                     # fetch the pinned SDK (release channel here)
ufbt                            # -> dist/nib.fap   (builds with NO Flipper attached)
```

`ufbt` downloads the SDK and an ARM toolchain on first run, and the FAP builds
with no hardware attached. You only need a Flipper to install and run it.

> **SDK version.** This builds and runs against the **release** channel (firmware
> `1.4.3`, API `87.1`). If you build against a different channel, re-run
> `ufbt update` and rebuild. The BLE symbols and struct layouts are
> version-sensitive.

### Host unit test (no SDK, no hardware)

```bash
cd flipper/test
cc -std=c11 -Wall -Wextra -Werror -I.. test_protocol.c ../nib_protocol.c -o test_protocol
./test_protocol            # -> "27 checks, 0 failures / PASS"
```

## Install (any of)

- `ufbt launch` over USB (build + install + run; needs a connected Flipper)
- **qFlipper**: drag `dist/nib.fap` onto the SD card under `apps/USB/`
- **Flipper mobile app**: Apps / file transfer
- Plain **SD copy** to `apps/USB/nib.fap`

## On the device

- **Boots to Ready, silent.** USB HID is claimed, but nothing is advertised until
  you enter pairing mode. Press **Pair** (Left, or OK) to advertise; the screen
  reads **Pairing mode**, then **Connected** once a phone joins.
- **PIN pairing, always on.** The profile uses `GapPairingPinCodeShow` with
  bonding, and the RX characteristic needs an authenticated write
  (`ATTR_PERMISSION_AUTHEN_WRITE`). The code shows on the Flipper's screen.
- **Own bonds.** Keys live in the app's own storage path, so N.I.B. never touches
  the phones paired to the Flipper's own Bluetooth, and vice versa. Settings →
  *Forget paired phones* clears them.
- **Settings** (Right button): edit the advertised **Name** (keyboard supports
  letters, digits and underscore), toggle **Disguise as keyboard** to advertise
  as a plain `USB Keyboard`, or forget paired phones.
- **Hold Back to exit.** A short Back press only shows a hint, so the session is
  never dropped by an accidental tap. On exit, USB and the default BLE profile are
  restored.

### Confirmed on hardware

Discovery over the 128-bit UUID, BLE peripheral + USB HID at once, the RX write
path and ABI shim, PIN pairing and bonding, typing/pointer/media opcodes on the
host, and clean teardown on Back. The shared decoder has a host unit test
(`test/test_protocol.c`, 27 checks) covering the length guards and the SECRET
no-log rule.

### Known limits

- **No background mode.** The app must stay in the foreground; typing stops when
  you exit. Inherent to the Flipper.
- **No gamepad.** The stock `usb_hid` descriptor has no gamepad, so the app's
  gamepad layouts do nothing here (keyboard, mouse and media work).
- **No BIOS/KVM.** Stock `usb_hid` is report-protocol with report IDs, so it will
  not work in a BIOS or a boot-protocol-only KVM. The ESP32 build has the same
  limit.

## Scope note

The bridged opcodes are the input ones plus a couple of session opcodes: TAP,
DOWN, UP, RELEASE_ALL, CONSUMER (media), MOVE, BTN, SECRET, FORGET and
STATUS_REQ. GAMEPAD is ignored (no gamepad descriptor). The ESP32's settings and
screensaver opcodes (`0x40` to `0x57`, minus FORGET and STATUS_REQ) are its own device
state (NVS, passkey, OLED) and are out of scope. The Flipper keeps its settings
on its own screen. The decoder returns unknown opcodes untouched.

## Catalogue

`APPCHK` passes, so it is submittable in principle (PR to
`flipper-application-catalog`: needs a 10×10 icon, screenshots, `manifest.yml`).
**Acceptance is discretionary** and HID-injection-adjacent tools are the kind
Flipper may reject, so treat catalogue listing as optional, not the delivery path.
Sideloading via qFlipper/SD always works regardless. (An icon is not required to
build or sideload; the FAP builds with the default icon today.)

Protocol is fixed in `../firmware/src/protocol.h`.
