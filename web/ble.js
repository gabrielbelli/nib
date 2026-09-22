// Web Bluetooth transport. Must match firmware/src/config.h and protocol.h.

const SERVICE = '6e7d0001-b3f2-4c11-9a5d-0f1a2b3c4d5e';
const RX      = '6e7d0002-b3f2-4c11-9a5d-0f1a2b3c4d5e';
const STATUS  = '6e7d0003-b3f2-4c11-9a5d-0f1a2b3c4d5e';

export const OP = {
  TAP: 0x10, DOWN: 0x11, UP: 0x12, RELEASE_ALL: 0x13,
  CONSUMER: 0x14, GAMEPAD: 0x15,
  MOVE: 0x20, BTN: 0x21, SECRET: 0x30,
  SET_PASSKEY: 0x40, SET_OPTIONS: 0x41, SET_NAME: 0x42, APPLY: 0x43, FORGET: 0x44,
  STATUS_REQ: 0x45, PAIR_OPEN: 0x46,
  // The dongle's own screen. See firmware/src/protocol.h and screensaver.h.
  SS_SET: 0x50, SS_PREVIEW: 0x51,
  SS_IMPORT_BEGIN: 0x52, SS_IMPORT_DATA: 0x53,
  SS_IMPORT_COMMIT: 0x54, SS_IMPORT_ABORT: 0x55,
  SS_CUSTOM_CLEAR: 0x56, SS_CLOCK: 0x57,
};

// A GATT write throws if another is still in flight, so everything goes
// through one chain. Writes are fire-and-forget; a dropped keystroke is
// better than a stalled queue.
let chain = Promise.resolve();
let rxChar = null;
let device = null;

export const events = new EventTarget();

function emit(type, detail) {
  events.dispatchEvent(new CustomEvent(type, { detail }));
}

export function isConnected() {
  return !!(device?.gatt?.connected && rxChar);
}

// Chrome hands back the SAME BluetoothDevice object for a device re-picked
// within one origin, so addEventListener() on it accumulates: after N connects
// a single drop emitted N 'disconnected' events. One listener per device object,
// ever, tracked in a WeakSet so a forgotten device can still be collected.
const wiredDevices = new WeakSet();

function onDrop() {
  rxChar = null;
  emit('status', 'disconnected');
}

function wireDrop(dev) {
  if (!dev || wiredDevices.has(dev)) return;
  wiredDevices.add(dev);
  dev.addEventListener('gattserverdisconnected', onDrop);
}

export async function connect() {
  if (!navigator.bluetooth) {
    throw new Error(
      'This browser has no Web Bluetooth. Use Chrome on Android, or Bluefy on iOS.'
    );
  }

  device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE] }],
    optionalServices: [SERVICE],
  });

  wireDrop(device);

  // Everything from here on can reject, and a rejection that does not emit
  // 'disconnected' leaves the whole UI stuck on "Connecting" forever, because
  // 'gattserverdisconnected' never fires for a connection that never landed.
  emit('status', 'connecting');
  try {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    rxChar = await service.getCharacteristic(RX);

    // The status characteristic is optional - it only exists to surface firmware
    // state, so a failure here must not block typing.
    // Brave and Chrome on a Mac failed this silently: the characteristic needs
    // an encrypted link, the first request races the pairing that request
    // itself starts, it throws, and the status was never read again. So each
    // step is tried on its own, a few times, and a failure is reported.
    try {
      const st = await service.getCharacteristic(STATUS);
      let haveStatus = false;
      const readStatus = (view) => {
        // Firmware before this fix printed the passkey as a bare %06u, and a
        // passkey with a leading zero ("pk":000000) is not valid JSON.
        const text = new TextDecoder().decode(view).replace(/"pk":(\d+)/, '"pk":"$1"');
        try {
          emit('settings', JSON.parse(text));
          haveStatus = true;
          return true;
        } catch {
          emit('statusbad', { len: view.byteLength, head: text.slice(0, 24), tail: text.slice(-24) });
          return false;
        }
      };
      // A notification carries at most MTU - 3 bytes. If one arrives cut, the
      // JSON does not parse, so fetch the whole value with a (long) read.
      st.addEventListener('characteristicvaluechanged', (e) => {
        const view = e.target.value;
        if (readStatus(view)) return;
        if (!view.byteLength || new Uint8Array(view.buffer, view.byteOffset, 1)[0] !== 0x7b) {
          emit('firmware', new TextDecoder().decode(view));   // older firmware sent a plain string
          return;
        }
        st.readValue().then(readStatus).catch(() => { /* next notify retries */ });
      });
      const attempt = async (what, fn) => {
        for (let i = 0; i < 4; i++) {
          if (what === 'read' && haveStatus) return null;   // the push already delivered it
          try { return await fn(); } catch (err) {
            emit('statuserr', { what, attempt: i + 1, message: String(err && err.message || err) });
            if (!device.gatt.connected) throw err;
            await new Promise((r) => setTimeout(r, 400 + i * 600));
          }
        }
        return null;
      };
      // Subscribe first: Bluefy fails a read issued before the subscription
      // (error "2" every time), while desktop Chrome can fail the first
      // request of any kind while pairing. Then read; and whichever of the two
      // worked, ask the dongle to push its status over the subscription too,
      // so neither path depends on the other.
      const subscribed = await attempt('notify', () => st.startNotifications());
      if (subscribed) {
        try { await rxChar.writeValue(new Uint8Array([OP.STATUS_REQ])); } catch { /* older firmware */ }
      }
      const first = await attempt('read', () => st.readValue());
      if (first) readStatus(first);
    } catch { /* not fatal: typing works without the status */ }
  } catch (err) {
    rxChar = null;
    emit('status', 'disconnected');
    throw err;
  }

  emit('status', 'connected');
  return device.name ?? 'N.I.B.';
}

export function disconnect() {
  if (device?.gatt?.connected) device.gatt.disconnect();
  rxChar = null;
}

function send(bytes) {
  if (!rxChar) return;
  const char = rxChar;
  chain = chain
    .then(() =>
      char.writeValueWithoutResponse
        ? char.writeValueWithoutResponse(bytes)
        : char.writeValue(bytes)
    )
    .catch((err) => emit('error', err.message));
}

// Same queue, but acknowledged and awaitable. Keystrokes want the unacked path
// - a dropped one is better than a stalled queue - but a file upload needs both
// real backpressure and a way to know it arrived, so it pays for the round trip.
function sendAcked(bytes) {
  if (!rxChar) return Promise.reject(new Error('not connected'));
  const char = rxChar;
  const settled = chain.then(() => char.writeValue(bytes));
  chain = settled.catch(() => {});   // one failed upload must not wedge typing
  return settled;
}

// Keep each packet inside the smallest MTU we are likely to negotiate.
const CHUNK = 128;

const KEYS_PER_PACKET = Math.floor((CHUNK - 1) / 2);

function sendKeyOp(op, keys) {
  for (let i = 0; i < keys.length; i += KEYS_PER_PACKET) {
    const slice = keys.slice(i, i + KEYS_PER_PACKET);
    const buf = new Uint8Array(1 + slice.length * 2);
    buf[0] = op;
    slice.forEach(([mods, usage], j) => {
      buf[1 + j * 2] = mods;
      buf[2 + j * 2] = usage;
    });
    send(buf);
  }
}

export const tap    = (keys) => sendKeyOp(OP.TAP, keys);
export const secret = (keys) => sendKeyOp(OP.SECRET, keys);

export const tapOne = (usage, mods = 0) => tap([[mods, usage]]);

export function keyDown(usage, mods = 0) { send(new Uint8Array([OP.DOWN, mods, usage])); }
export function keyUp(usage, mods = 0)   { send(new Uint8Array([OP.UP,   mods, usage])); }
export function releaseAll()             { send(new Uint8Array([OP.RELEASE_ALL])); }

const clamp = (v) => Math.max(-127, Math.min(127, Math.round(v)));

export function move(dx, dy, wheel = 0) {
  if (!dx && !dy && !wheel) return;
  send(new Uint8Array([OP.MOVE, clamp(dx) & 0xff, clamp(dy) & 0xff, clamp(wheel) & 0xff]));
}

// button: 1 left, 2 right, 4 middle. action: 0 up, 1 down, 2 click.
export function button(btn, action) { send(new Uint8Array([OP.BTN, btn, action])); }

// ---------------------------------------------------------------- settings
// All of these persist on the dongle. apply() saves and restarts it, which is
// required because the BLE name and passkey are only read when the stack starts.

export function setPasskey(value) {
  const pk = Math.abs(Number(value) | 0) % 1000000;
  send(new Uint8Array([
    OP.SET_PASSKEY, pk & 0xff, (pk >> 8) & 0xff, (pk >> 16) & 0xff, (pk >> 24) & 0xff,
  ]));
}

// mode: 0 fixed, 1 new passkey every boot, 2 new passkey whenever bonds are wiped
// usb:  0 console + host may reflash, 1 console only, 2 no serial device at all
// hid:  0 identifies by its own name, 1 identifies as a plain USB keyboard
export function setOptions({ showPasskey, mode, usb = 0, hid = 0, pair = 0 }) {
  send(new Uint8Array([
    OP.SET_OPTIONS, showPasskey ? 1 : 0, mode & 0xff, usb & 0xff, hid & 0xff, pair & 0xff,
  ]));
}

/** Let one new phone pair during the next two minutes. */
export function openPairing() { send(new Uint8Array([OP.PAIR_OPEN])); }

export function setName(name) {
  const bytes = new TextEncoder().encode(name.slice(0, 20));
  const buf = new Uint8Array(1 + bytes.length);
  buf[0] = OP.SET_NAME;
  buf.set(bytes, 1);
  send(buf);
}

export function apply()  { send(new Uint8Array([OP.APPLY])); }
/** One press of a USB consumer-control key: volume, play/pause, Home, Back. */
export function consumer(usage) {
  send(new Uint8Array([OP.CONSUMER, usage & 0xff, (usage >> 8) & 0xff]));
}

/**
 * The whole gamepad state in one packet: sticks and triggers -127..127,
 * hat 0 (centre) or 1..8 clockwise from up, and a 32-bit button mask.
 */
export function gamepad({ lx = 0, ly = 0, rx = 0, ry = 0, lt = -127, rt = -127, hat = 0, buttons = 0 }) {
  const i8 = (v) => Math.max(-127, Math.min(127, Math.round(v))) & 0xff;
  send(new Uint8Array([
    OP.GAMEPAD, i8(lx), i8(ly), i8(rx), i8(ry), i8(lt), i8(rt), hat & 0xff,
    buttons & 0xff, (buttons >>> 8) & 0xff, (buttons >>> 16) & 0xff, (buttons >>> 24) & 0xff,
  ]));
}

export function forget() { send(new Uint8Array([OP.FORGET])); }

// -------------------------------------------------------------- screensaver
// The dongle's 160x80 panel is lit whenever it has power, so a screensaver
// there cannot dim anything - it only stops a bright static layout burning in.
// The firmware owns the motion; the phone only picks one and, optionally,
// uploads a 1-bit sprite for it to animate.

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

/** idleSeconds 0 means never. index 0xFF is Shuffle. */
export function ssSet({ enabled = true, index = 0, idleSeconds = 60 }) {
  const idle = Math.max(0, Math.min(3600, idleSeconds | 0));
  send(new Uint8Array([OP.SS_SET, enabled ? 1 : 0, index & 0xff, ...u16(idle)]));
}

export function ssPreview(index) {
  send(new Uint8Array([OP.SS_PREVIEW, index & 0xff]));
}

export function ssCustomClear() { send(new Uint8Array([OP.SS_CUSTOM_CLEAR])); }

/**
 * The dongle has no RTC and no network, so this is the only way its clock saver
 * can know the time. Not persisted on purpose: a confidently wrong clock is
 * worse than an honest uptime counter.
 */
export function ssClock(date = new Date()) {
  const epoch = Math.floor(date.getTime() / 1000);
  const tz = -date.getTimezoneOffset();          // JS reports the inverse
  send(new Uint8Array([
    OP.SS_CLOCK,
    epoch & 0xff, (epoch >>> 8) & 0xff, (epoch >>> 16) & 0xff, (epoch >>> 24) & 0xff,
    tz & 0xff, (tz >> 8) & 0xff,
  ]));
}

// Import. The payload layout is fixed by firmware/src/screensaver.h; nothing
// touches NVS until COMMIT has checked the CRC, so an interrupted upload
// changes nothing on the dongle.
export const SS_IMPORT = Object.freeze({
  MAGIC: 0x4e, VERSION: 1, KIND_1BIT: 1,
  MAX_BYTES: 6144, MAX_W: 128, MAX_H: 64, MAX_FRAMES: 16,
  CHUNK: 120,                                   // 3 header bytes + 120 <= 128
});

export function ssImportBegin(header) { return sendAcked(withOp(OP.SS_IMPORT_BEGIN, header)); }

export function ssImportData(offset, data) {
  const buf = new Uint8Array(3 + data.length);
  buf[0] = OP.SS_IMPORT_DATA;
  buf[1] = offset & 0xff;
  buf[2] = (offset >> 8) & 0xff;
  buf.set(data, 3);
  return sendAcked(buf);
}

export function ssImportCommit(crc) {
  return sendAcked(new Uint8Array([
    OP.SS_IMPORT_COMMIT,
    crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff,
  ]));
}

export function ssImportAbort() { send(new Uint8Array([OP.SS_IMPORT_ABORT])); }

function withOp(op, bytes) {
  const buf = new Uint8Array(1 + bytes.length);
  buf[0] = op;
  buf.set(bytes, 1);
  return buf;
}

/** IEEE CRC32, the zlib polynomial, to match screensaverImportCommit(). */
export const crc32 = (() => {
  let table = null;
  return (bytes) => {
    if (!table) {
      table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
})();
