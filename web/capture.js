// Capture mode: grab this machine's keyboard and mouse and forward them to the
// dongle, the way a KVM does, minus the screen.
//
// The mental model is deliberate: capture behaves as if you unplugged your
// keyboard and plugged it into the far machine. `KeyboardEvent.code` names a
// PHYSICAL key position, and HID usage page 0x07 names the same positions with
// the same labels, so `code -> usage` is a static table with no layout
// parameter and keymap.js is not involved at all. The characters that come out
// are decided by the REMOTE machine's layout. Press the ABNT2 ç position while
// the far end has a US layout selected and you get `;`. That is correct for a
// KVM, and it is the opposite of the Type tab, where keymap.js targets the
// remote layout on purpose. The indicator says so.
//
// The table is the feature. It is checked against keymap.js from the other
// direction: keymap.js reaches the two ABNT2-only positions as
// ISO_BACKSLASH = 0x64 and INTL_RO = 0x87, which are exactly what Chrome
// reports as `IntlBackslash` and `IntlRo` on a Brazilian keyboard. Same key,
// same number, arrived at independently.
//
// Where the code/usage identity does NOT hold, and what happens:
//
//   soft keyboards (Android/iOS)  code is '' or 'Unidentified'  -> capture mode
//                                 is desktop only, SUPPORT.usable is false
//   an active IME                 keys never arrive, or isComposing -> dropped,
//                                 warned once, uncapturable
//   CapsLock                      the local OS toggles it whatever we do, so
//                                 forwarding 0x39 desyncs the two machines
//                                 -> never forwarded, spent as the Esc surrogate
//   NumLock                       same desync, but forwarded, and flagged
//   Fn, media, brightness, Globe  no DOM event exists at all -> unreachable
//   blank `code`                  unmappable -> counted in `dropped`, never guessed
//
// Usage from app.js:
//
//   import { createCapture, SUPPORT } from './capture.js?v=12';
//   if (SUPPORT.usable) {
//     const cap = createCapture({ surface: document.getElementById('shell') });
//     button.onclick = () => cap.toggle();          // must be a user gesture
//     cap.events.addEventListener('capturestop', (e) => log(e.detail.reason));
//   }
//
// Self-contained: it imports ./ble.js as the default transport and touches no
// DOM beyond the surface it is given, the overlay it owns, and its own
// listeners.

import * as bleTransport from './ble.js?v=12';

// --------------------------------------------------------------------- table
// KeyboardEvent.code -> USB HID usage ID, page 0x07. Modifiers are absent on
// purpose: this protocol carries them in a separate `mods` byte, so they live
// in MOD_BITS instead.

const T = Object.create(null);

// Letters. 'KeyA' is 0x04 and the alphabet is contiguous, so the US legend
// order - which is what `code` is labelled with - is the usage order.
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch, i) => {
  T['Key' + ch] = 0x04 + i;
});

// Digit row. 1..9 then 0, which is the HID order, not the keyboard order.
'123456789'.split('').forEach((d, i) => { T['Digit' + d] = 0x1e + i; });
T.Digit0 = 0x27;

// Whitespace and the big keys.
T.Enter     = 0x28;
T.Escape    = 0x29;
T.Backspace = 0x2a;
T.Tab       = 0x2b;
T.Space     = 0x2c;

// Punctuation, named for the US legend of the position.
T.Minus        = 0x2d;
T.Equal        = 0x2e;
T.BracketLeft  = 0x2f;
T.BracketRight = 0x30;
T.Backslash    = 0x31;   // also the #~ position on a UK ISO board
T.Semicolon    = 0x33;   // ç on ABNT2
T.Quote        = 0x34;
T.Backquote    = 0x35;
T.Comma        = 0x36;
T.Period       = 0x37;
T.Slash        = 0x38;

// Lock keys. Both carry per-machine state; see NEVER_FORWARD.
T.CapsLock = 0x39;
T.NumLock  = 0x53;

// F1-F12 are contiguous from 0x3a, F13-F24 from 0x68.
for (let i = 1; i <= 12; i++) T['F' + i] = 0x39 + i;
for (let i = 13; i <= 24; i++) T['F' + i] = 0x68 + (i - 13);

// The three keys above the navigation block.
T.PrintScreen = 0x46;
T.ScrollLock  = 0x47;
T.Pause       = 0x48;

// Navigation block.
T.Insert   = 0x49;
T.Home     = 0x4a;
T.PageUp   = 0x4b;
T.Delete   = 0x4c;
T.End      = 0x4d;
T.PageDown = 0x4e;

// Arrows, in HID order: right, left, down, up.
T.ArrowRight = 0x4f;
T.ArrowLeft  = 0x50;
T.ArrowDown  = 0x51;
T.ArrowUp    = 0x52;

// Keypad. NumpadEnter and NumpadDecimal are distinct positions from Enter and
// Period and must not be folded into them, or the remote numeric keypad stops
// behaving like one.
T.NumpadDivide   = 0x54;
T.NumpadMultiply = 0x55;
T.NumpadSubtract = 0x56;
T.NumpadAdd      = 0x57;
T.NumpadEnter    = 0x58;
for (let i = 1; i <= 9; i++) T['Numpad' + i] = 0x58 + i;   // Numpad1 = 0x59
T.Numpad0          = 0x62;
T.NumpadDecimal    = 0x63;
T.NumpadEqual      = 0x67;
T.NumpadComma      = 0x85;   // the ABNT2 and JIS keypad separator
T.NumpadParenLeft  = 0xb6;
T.NumpadParenRight = 0xb7;

// International and ISO positions. These two are the whole reason the table is
// positional rather than character-based.
T.IntlBackslash = 0x64;   // the key between left shift and Z on an ISO board
T.IntlRo        = 0x87;   // the ABNT2 key between ? and right shift
T.IntlYen       = 0x89;

// Odds and ends that still produce a DOM event.
T.ContextMenu = 0x65;
T.Power       = 0x66;
T.Help        = 0x75;
T.Again       = 0x79;
T.Undo        = 0x7a;
T.Cut         = 0x7b;
T.Copy        = 0x7c;
T.Paste       = 0x7d;
T.Find        = 0x7e;

// Volume keys, when the browser reports them as keyboard usages rather than
// consumer-page media keys. Chrome has used both names over time.
T.AudioVolumeMute = 0x7f;
T.AudioVolumeUp   = 0x80;
T.AudioVolumeDown = 0x81;
T.VolumeMute      = 0x7f;
T.VolumeUp        = 0x80;
T.VolumeDown      = 0x81;

// CJK input-mode keys. They reach the remote as key positions; whether the
// remote does anything with them is the remote's business.
T.KanaMode   = 0x88;
T.Convert    = 0x8a;
T.NonConvert = 0x8b;
T.Lang1      = 0x90;   // HangulMode / Kana
T.Lang2      = 0x91;   // Hanja / Eisu
T.Lang3      = 0x92;   // Katakana
T.Lang4      = 0x93;   // Hiragana
T.Lang5      = 0x94;   // ZenkakuHankaku

export const CODE_TO_USAGE = Object.freeze(T);

// Modifier bitmask, as protocol.h defines it. `code` distinguishes sides, so
// right AltGr survives as bit 64 - which is what the ABNT2 third level needs.
export const MOD_BITS = Object.freeze({
  ControlLeft: 1,  ShiftLeft: 2,  AltLeft: 4,  MetaLeft: 8,
  ControlRight: 16, ShiftRight: 32, AltRight: 64, MetaRight: 128,
});

// One mask per modifier name, because getModifierState() cannot tell sides apart.
const SIDE_MASKS = Object.freeze({
  Control: 1 | 16,
  Shift:   2 | 32,
  Alt:     4 | 64,
  Meta:    8 | 128,
});

// Keys never forwarded as held keys. Caps Lock is forwarded, but specially:
// each local toggle becomes one tap on the far side (macOS reports keydown on
// lock and keyup on unlock, other systems a keydown per press), and the far
// computer's real lock state comes back from the dongle for the panel.
export const NEVER_FORWARD = Object.freeze(new Set([]));
const MAC_CAPS = /mac/i.test((typeof navigator !== 'undefined'
  && (navigator.userAgentData?.platform || navigator.platform)) || '');

const USAGE_TO_CODE = (() => {
  const rev = new Map();
  // First name wins, so `VolumeUp` does not displace `AudioVolumeUp`.
  for (const [code, usage] of Object.entries(CODE_TO_USAGE)) {
    if (!rev.has(usage)) rev.set(usage, code);
  }
  return rev;
})();

/** @returns {number} the HID usage for a physical position, or 0 if unmappable. */
export function codeToUsage(code) {
  if (!code) return 0;
  return CODE_TO_USAGE[code] ?? 0;
}

/** @returns {string|null} the canonical `code` for a usage. For tests and the indicator. */
export function usageToCode(usage) {
  return USAGE_TO_CODE.get(usage) ?? null;
}

// -------------------------------------------------------------------- probes

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

export function probeSupport() {
  if (!hasDom) {
    return Object.freeze({
      pointerLock: false, unadjustedMovement: false, keyboardLock: false,
      fullscreen: false, touchOnly: false, usable: false,
      why: 'no DOM',
    });
  }

  const root = document.documentElement;
  const secure = window.isSecureContext !== false;

  const fine = window.matchMedia?.('(any-pointer: fine)').matches ?? true;
  const touchy = (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
  const touchOnly = !fine && touchy;

  const pointerLock = typeof root.requestPointerLock === 'function';

  // Best effort only. Chromium shipped the unadjustedMovement option alongside
  // pointerrawupdate, so the presence of that event is the cheapest proxy; the
  // truth is only known when requestPointerLock() returns a Promise at start().
  const unadjustedMovement = pointerLock && 'onpointerrawupdate' in root;

  const keyboardLock =
    secure && typeof navigator.keyboard?.lock === 'function';

  const fullscreen =
    (typeof root.requestFullscreen === 'function' ||
     typeof root.webkitRequestFullscreen === 'function') &&
    document.fullscreenEnabled !== false;

  // `why` has to cover every requirement `usable` is later ANDed with, or the
  // caller ends up with usable:false and why:'' — which is how the whole Capture
  // section used to vanish from Safari and Firefox with no explanation at all.
  // Keyboard Lock is an ENHANCEMENT, not a requirement. It only adds the keys
  // the browser otherwise keeps for itself - Escape, Tab, and the Meta combos.
  // Every ordinary key and the whole mouse work on Pointer Lock alone, so
  // requiring it here is what made capture report itself unusable on most
  // browsers and drop the desktop back to a phone trackpad.
  let why = '';
  if (touchOnly) why = 'capture mode needs a physical keyboard and mouse';
  else if (!secure) why = 'capture mode needs a secure context (https)';
  else if (!pointerLock) why = 'this browser cannot lock the pointer';

  const limits = [];
  if (!why && !keyboardLock) {
    limits.push('Escape and the system shortcuts stay with this computer');
  }

  return Object.freeze({
    pointerLock, unadjustedMovement, keyboardLock, fullscreen, touchOnly,
    usable: !why,
    why,
    limits,
  });
}

/**
 * The live answer. Mutated in place by refreshSupport() rather than replaced,
 * so `import { SUPPORT }` keeps seeing the current values.
 *
 * It is NOT fixed for the session: pairing a Bluetooth mouse to a phone, or a
 * keyboard to an iPad, flips `(any-pointer: fine)` and with it `touchOnly`.
 */
export const SUPPORT = { ...probeSupport() };

/** Fires 'change' whenever SUPPORT was re-probed and something moved. */
export const supportEvents = new EventTarget();

export function refreshSupport() {
  const next = probeSupport();
  const moved = Object.keys(next).some((k) => SUPPORT[k] !== next[k]);
  Object.assign(SUPPORT, next);
  if (moved) {
    try {
      supportEvents.dispatchEvent(new CustomEvent('change', { detail: { ...SUPPORT } }));
    } catch { /* old engine */ }
  }
  return SUPPORT;
}

if (hasDom && typeof window.matchMedia === 'function') {
  try {
    const mq = window.matchMedia('(any-pointer: fine)');
    const onPointerKindChange = () => refreshSupport();
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onPointerKindChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onPointerKindChange);
  } catch { /* no matchMedia: the first probe stands */ }
}

// ------------------------------------------------------------------ defaults

const DEFAULTS = {
  surface: null,                 // document.documentElement
  transport: null,               // ./ble.js
  requireConnection: true,
  fullscreen: false,             // never forced; Keyboard Lock is a bonus, not worth a takeover
  keyboardLock: 'auto',          // 'auto' | 'off'
  unadjustedMovement: true,
  sensitivity: 1.0,
  scrollPixelsPerTick: 40,
  naturalScroll: true,
  flushMs: 20,                   // 50 Hz; see the note on rAF below
  maxMovePacketsPerFlush: 3,
  releaseHoldMs: 600,
  escapeSurrogate: null,         // Esc itself goes across now; no stand-in needed
  modMap: () => ({}),            // KeyboardEvent.code -> code to send (modifier translation)
  targetIsMac: () => false,      // names the far side's keys in the panel
  idleReleaseMs: 120000,
  showKeyNames: false,
  indicator: true,
};

// DOM button numbers are not HID button bits.
const DOM_TO_HID = { 0: 1, 1: 4, 2: 2 };



// Chrome refuses a pointer-lock request for about a second after the user
// exited one, with 'The user has exited the lock before this request was
// completed'. Debounce past it rather than look broken.
const RELOCK_COOLDOWN_MS = 1250;

const LOCK_SETTLE_MS = 1500;
const STATS_MS = 250;

const clamp8 = (v) => (v > 127 ? 127 : v < -127 ? -127 : v);

// ------------------------------------------------------------------- session

export function createCapture(options = {}) {
  const opts = { ...DEFAULTS, ...options };

  const transport = opts.transport ?? bleTransport;
  const surface =
    opts.surface ?? (hasDom ? document.documentElement : null);

  const events = new EventTarget();

  // ---- state ----
  let active = false;
  let arming = false;
  let mods = 0;
  let buttons = 0;
  const heldCodes = new Set();
  // Set when a disconnect stranded held state on the far computer.
  let heldOnDisconnect = false;

  let keyboardLockOn = false;
  let pointerLockOn = false;
  let unadjusted = false;
  let weTookFullscreen = false;
  let degraded = [];

  let keys = 0, moves = 0, wheels = 0, dropped = 0;
  let since = null;

  let accX = 0, accY = 0, accWheelPx = 0;
  let flushTimer = null;
  let statsTimer = null;
  let idleTimer = null;
  let lastActivity = 0;
  let lastUnlockAt = 0;
  let starting = false;

  let escHoldTimer = null;
  let escPending = false;
  let chordArmed = false;        // Ctrl+Alt down with nothing else yet: release on let-go
  let physMods = 0;              // modifier bits by physical key, before any translation
  // Modifier translation (see target.js): read per key, so a change in the
  // menu applies to the next keystroke without restarting capture.
  const mapCode = (code) => {
    const m = typeof opts.modMap === 'function' ? opts.modMap() : opts.modMap;
    return (m && m[code]) || code;
  };
  let mouseFree = false;         // the browser took the mouse back (Esc); keyboard still ours
  let escSentAt = 0;

  const warned = new Set();
  let titleBefore = null;

  const ind = { root: null, nodes: null };

  // ---- helpers ----

  const emit = (type, detail) =>
    events.dispatchEvent(new CustomEvent(type, { detail }));

  function warnOnce(code, message) {
    if (warned.has(code)) return;
    warned.add(code);
    emit('capturewarn', { code, message });
    setIndicatorText();
  }

  function neverForward(code) {
    if (NEVER_FORWARD.has(code)) return true;
    return !!opts.escapeSurrogate && code === opts.escapeSurrogate;
  }

  function touch() { lastActivity = Date.now(); }

  function activity(kind, code) {
    touch();
    emit('captureactivity', { kind, mods, code, dropped });
    if (ind.nodes) pulse();
  }

  function snapshot() {
    return {
      active,
      mods,
      heldCodes: [...heldCodes],
      buttons,
      keyboardLock: keyboardLockOn,
      pointerLock: pointerLockOn,
      unadjusted,
      keys, moves, wheels, dropped,
      since,
    };
  }

  // ---- outgoing key traffic -------------------------------------------------
  // Two rules from reading the firmware:
  //
  // 1. OP_UP does `releaseRaw(usage); releaseMods(mods)`, so sending
  //    keyUp(usage, currentMods) would release Ctrl on the far machine while
  //    the user is still physically holding it. Modifiers therefore travel in
  //    their own packets - keyDown(0, bit) / keyUp(0, bit), which the
  //    `if (p[1])` guard in handlePacket makes modifier-only - and every normal
  //    key goes with mods 0. The two kinds of state stay orthogonal.
  //
  // 2. Never tap() in capture mode. tapKey() blocks the firmware loop with
  //    BLUEHID_KEY_PRESS_MS + BLUEHID_KEY_GAP_MS of delay() and destroys real
  //    press timing. Down/up costs one extra packet and preserves hold,
  //    chording and drag-select.

  function pressMod(bit, code) {
    if (!bit || (mods & bit)) return;
    mods |= bit;
    if (code) heldCodes.add(code);
    transport.keyDown(0, bit);
    activity('mod', code);
  }

  function releaseModBits(bits) {
    if (!bits) return;
    mods &= ~bits;
    transport.keyUp(0, bits);
    activity('mod');
  }

  function pressKey(usage, code) {
    transport.keyDown(usage, 0);
    keys++;
    if (code) heldCodes.add(code);
    activity('key', code);
  }

  function releaseKey(usage, code) {
    transport.keyUp(usage, 0);
    if (code) heldCodes.delete(code);
    activity('key', code);
  }

  // One packet, OP_RELEASE_ALL, appended last to the same ordered chain in
  // ble.js so it cannot overtake a pending keydown. The firmware does
  // Keyboard.releaseAll() plus all three Mouse.release() calls. Enumerating
  // individual ups would be more packets and more chances for one of them to be
  // the one that gets dropped, leaving behind exactly the stuck Ctrl this is
  // meant to prevent.
  function releaseEverything(send = true) {
    if (send) transport.releaseAll();
    mods = 0;
    buttons = 0;
    heldCodes.clear();
  }

  // ---- mouse ---------------------------------------------------------------

  // A 20 ms timer, not requestAnimationFrame. rAF is 120 Hz on a ProMotion
  // display, and 120 move packets a second into a 15 ms BLE connection
  // interval builds an unbounded queue in ble.js, whose chain is
  // fire-and-forget with no backpressure at all. 50 Hz is below human
  // perception for pointer motion and stays inside the link budget.
  function flush() {
    if (!active) return;

    let dx = Math.trunc(accX);
    let dy = Math.trunc(accY);
    accX -= dx;
    accY -= dy;

    // Ticks now, remainder kept, so a slow trackpad scroll still moves.
    const perTick = Math.max(1, opts.scrollPixelsPerTick);
    let ticks = Math.trunc(accWheelPx / perTick);
    accWheelPx -= ticks * perTick;
    // HID wheel is positive up; DOM deltaY is positive scrolling down.
    let w = opts.naturalScroll ? -ticks : ticks;

    if (!dx && !dy && !w) return;

    let sent = 0;
    const budget = Math.max(1, opts.maxMovePacketsPerFlush);
    while ((dx || dy || w) && sent < budget) {
      const sx = clamp8(dx);
      const sy = clamp8(dy);
      const sw = sent === 0 ? clamp8(w) : 0;   // wheel rides the first packet only
      transport.move(sx, sy, sw);
      dx -= sx; dy -= sy; w -= sw;
      sent++;
      if (sx || sy) moves++;
      if (sw) wheels++;
    }

    // A lagging cursor is worse than a slightly short flick, so leftover
    // movement is dropped rather than queued. Leftover wheel is not: scroll is
    // discrete and a lost tick is a lost line, so it goes back in the bucket.
    if (dx || dy) {
      dropped++;
      touch();
    }
    if (w) accWheelPx += (opts.naturalScroll ? -w : w) * perTick;
  }

  function onMouseMove(e) {
    if (!active || mouseFree) return;
    // movementX/Y under unadjustedMovement are raw, OS-acceleration-free
    // deltas. That is the right signal: the remote machine applies its own
    // acceleration curve, and forwarding already-accelerated deltas
    // accelerates twice and feels swimmy.
    accX += e.movementX * opts.sensitivity;
    accY += e.movementY * opts.sensitivity;
    touch();
  }

  function onMouseDown(e) {
    if (!active) return;
    e.preventDefault();
    if (mouseFree) {
      // This click only takes the mouse back; it is not sent across.
      const wait = RELOCK_COOLDOWN_MS - (Date.now() - lastUnlockAt);
      if (wait > 0) { emit('capturewarn', { code: 'cooldown', message: 'a moment, then click again' }); return; }
      lockPointer().then((r) => { if (r.ok) { pointerLockOn = true; mouseFree = false; setIndicatorText(); } });
      return;
    }
    const hid = DOM_TO_HID[e.button];
    if (!hid) {                     // back/forward have no bit in this report
      dropped++;
      warnOnce('extra-buttons', 'mouse buttons 4 and 5 are not in the HID report');
      return;
    }
    buttons |= hid;
    // Press and release, never click: drag and text selection need the hold,
    // and the remote OS times its own double-click from the real intervals.
    transport.button(hid, 1);
    activity('button');
  }

  function onMouseUp(e) {
    if (!active) return;
    e.preventDefault();
    if (mouseFree) return;
    const hid = DOM_TO_HID[e.button];
    if (!hid) return;
    buttons &= ~hid;
    transport.button(hid, 0);
    activity('button');
  }

  function onWheel(e) {
    if (mouseFree) { if (active) e.preventDefault(); return; }
    if (!active) return;
    e.preventDefault();
    // deltaMode: 0 pixels, 1 lines, 2 pages.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    accWheelPx += e.deltaY * scale;
    if (e.deltaX) {
      // The report has no AC Pan axis, so there is nowhere for this to go.
      dropped++;
      warnOnce('no-horizontal-scroll', 'horizontal scroll cannot be sent');
    }
    touch();
  }

  function swallow(e) { if (active) e.preventDefault(); }

  // ---- keyboard ------------------------------------------------------------

  // Release-only reconciliation. If the browser says a modifier is up and we
  // think it is down, let it go. This self-heals the Cmd+Tab hole: Cmd down is
  // seen, Tab is stolen by the OS, and the Cmd up never arrives. It is
  // release-only because getModifierState() cannot tell left from right, and
  // guessing a side to PRESS would be wrong.
  function reconcile(e) {
    if (typeof e.getModifierState !== 'function') return;
    for (const [name, mask] of Object.entries(SIDE_MASKS)) {
      const stuck = mods & mask;
      if (stuck && !e.getModifierState(name)) {
        releaseModBits(stuck);
        for (const code of [...heldCodes]) {
          if ((MOD_BITS[code] ?? 0) & mask) heldCodes.delete(code);
        }
      }
    }
  }

  function onKeyDown(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();

    // An IME eats the keys before the page sees them; the few that leak
    // through are composition noise.
    if (e.isComposing || e.key === 'Process') {
      dropped++;
      warnOnce('ime', 'capture needs an input source with no IME');
      return;
    }

    // The local OS auto-repeats a held key AND the remote OS auto-repeats a
    // held HID key. Forwarding local repeats gives double repeat. The honest
    // consequence: repeat rate and delay are the remote machine's.
    if (e.repeat) { touch(); return; }

    reconcile(e);

    const phys = e.code;
    const code = mapCode(phys);

    // The release gesture: Ctrl and Alt pressed together and let go with
    // nothing else in between, as VMware does. Any other key while they are
    // down disarms it, so Ctrl+Alt+Del and every other chord still go across.
    // The release gesture is physical Ctrl+Alt, whatever the swap sends.
    const bitDown = MOD_BITS[phys];
    if (bitDown) { physMods |= bitDown; paintIndicator(); }
    if (bitDown && (bitDown & (1 | 16 | 4 | 64))) {
      if ((physMods & (1 | 16)) && (physMods & (4 | 64)) && !(physMods & (2 | 32 | 8 | 128))) chordArmed = true;
    } else {
      chordArmed = false;
    }

    // Escape is an ordinary key: it always reaches the other computer. Without
    // Keyboard Lock the browser also frees the mouse on it; the keyboard stays
    // captured and a click takes the mouse back (onPointerLockChange).
    if (code === 'Escape') {
      escSentAt = Date.now();
      sendKey('Escape');
      return;
    }

    // The surrogate. macOS reports CapsLock down on lock and up on unlock, so
    // only the down edge is used and its keyup is ignored.
    if (opts.escapeSurrogate && code === opts.escapeSurrogate) {
      sendKey('Escape');
      return;
    }

    if (code === 'CapsLock') { sendKey('CapsLock'); return; }
    if (neverForward(code)) { touch(); return; }

    const bit = MOD_BITS[code];
    if (bit) { pressMod(bit, code); return; }

    const usage = codeToUsage(code);
    if (!usage) {
      dropped++;
      if (!code || code === 'Unidentified') {
        warnOnce('no-code', 'this keyboard reports no physical key positions');
      }
      touch();
      return;
    }
    if (code === 'NumLock') {
      warnOnce('numlock-desync', 'Num Lock state can desync from the remote machine');
    }
    if (heldCodes.has(code)) { touch(); return; }   // repeat the browser did not flag
    pressKey(usage, code);
  }

  function onKeyUp(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();

    const phys = e.code;
    const code = mapCode(phys);

    if (code === 'Escape') return;   // sent whole on keydown

    if (opts.escapeSurrogate && code === opts.escapeSurrogate) return;
    if (code === 'CapsLock') { if (MAC_CAPS) sendKey('CapsLock'); return; }   // macOS: keyup = unlock
    if (neverForward(code)) return;

    const bit = MOD_BITS[code];
    if (bit) {
      if (mods & bit) {
        heldCodes.delete(code);
        releaseModBits(bit);
      }
      physMods &= ~(MOD_BITS[phys] || 0);
      paintIndicator();
      if (chordArmed && (MOD_BITS[phys] & (1 | 16 | 4 | 64))) {
        chordArmed = false;
        stop('chord');
      }
      return;
    }

    // A late keyup for something we no longer believe is held is ignored.
    if (!heldCodes.has(code)) return;
    const usage = codeToUsage(code);
    if (usage) releaseKey(usage, code);
    else heldCodes.delete(code);
  }

  // ---- lifecycle signals ---------------------------------------------------

  function onPointerLockChange() {
    const locked = document.pointerLockElement === surface;
    if (locked) {
      pointerLockOn = true;
      mouseFree = false;
      setIndicatorText();
      return;
    }
    lastUnlockAt = Date.now();
    pointerLockOn = false;
    if (!active || arming) return;
    // The browser let go of the mouse, almost always because Esc was pressed.
    // That is not a request to stop capturing: the keyboard stays with the
    // other computer, the Esc goes there too (if its keydown was swallowed by
    // the browser), and a click grabs the mouse again.
    if (Date.now() - escSentAt > 400) sendKey('Escape');
    if (buttons) { transport.button(buttons, 0); buttons = 0; }
    mouseFree = true;
    setIndicatorText();
  }

  function onFullscreenChange() {
    if (!active || arming) return;
    if (weTookFullscreen && !document.fullscreenElement) stop('fullscreen');
  }

  const onBlur       = () => { if (active) stop('blur'); };
  const onVisibility = () => { if (active && document.hidden) stop('hidden'); };
  const onPageHide   = () => { if (active) stop('pagehide'); };

  function onTransportStatus(e) {
    if (e.detail === 'connected') {
      // The far computer may still have keys and buttons down from before the
      // drop, because stop('disconnected') could only clear our local copy.
      // One RELEASE_ALL packet, and it cannot make anything worse.
      if (!heldOnDisconnect) return;
      heldOnDisconnect = false;
      try { transport.releaseAll(); } catch { /* best effort */ }
      emit('capturewarn', { message: 're-sent a release after reconnect' });
      return;
    }
    if (e.detail !== 'disconnected') return;
    if (!active) return;
    stop('disconnected');   // clears local state without sending
  }

  // ---- arming -------------------------------------------------------------

  function waitForPointerLock() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
        clearTimeout(timer);
        resolve(ok);
      };
      const onChange = () => finish(document.pointerLockElement === surface);
      const onError  = () => finish(false);
      const timer = setTimeout(() => finish(document.pointerLockElement === surface),
                               LOCK_SETTLE_MS);
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
    });
  }

  // Fallback ladder: unadjustedMovement -> bare requestPointerLock -> keyboard
  // only, said out loud in the indicator.
  async function lockPointer() {
    if (typeof surface.requestPointerLock !== 'function') {
      return { ok: false, raw: false };
    }

    if (opts.unadjustedMovement) {
      try {
        const r = surface.requestPointerLock({ unadjustedMovement: true });
        if (r && typeof r.then === 'function') {
          await r;
          return { ok: true, raw: true };
        }
        // An older engine ignored the options object entirely.
        const ok = await waitForPointerLock();
        if (ok) return { ok: true, raw: false };
      } catch { /* fall through to the bare request */ }
    }

    try {
      const r = surface.requestPointerLock();
      if (r && typeof r.then === 'function') {
        await r;
        return { ok: true, raw: false };
      }
      return { ok: await waitForPointerLock(), raw: false };
    } catch {
      return { ok: false, raw: false };
    }
  }

  async function goFullscreen() {
    if (document.fullscreenElement) return false;
    const req = surface.requestFullscreen ?? surface.webkitRequestFullscreen;
    if (typeof req !== 'function') return false;
    try {
      await req.call(surface, { navigationUI: 'hide' });
      return !!document.fullscreenElement;
    } catch {
      return false;
    }
  }

  async function start() {
    if (active || starting) return active;

    if (!hasDom) return false;
    if (!SUPPORT.usable) {
      emit('capturewarn', { code: 'unsupported', message: SUPPORT.why });
      return false;
    }
    if (opts.requireConnection && !transport.isConnected()) {
      emit('capturewarn', { code: 'offline', message: 'connect the dongle first' });
      return false;
    }
    const waited = Date.now() - lastUnlockAt;
    if (waited < RELOCK_COOLDOWN_MS) {
      emit('capturewarn', {
        code: 'cooldown',
        message: `wait a moment (${Math.ceil((RELOCK_COOLDOWN_MS - waited) / 100) / 10}s)`,
      });
      return false;
    }

    starting = true;
    arming = true;
    chordArmed = false;
    physMods = 0;
    mouseFree = false;
    degraded = [];
    warned.clear();

    // Start the remote clean. The consequence, stated: a modifier already
    // physically held when capture starts is not forwarded until it is
    // released and pressed again. Seeding from getModifierState() cannot tell
    // which side is down, and would guess.
    releaseEverything(true);

    try {
      if (opts.fullscreen) {
        weTookFullscreen = await goFullscreen();
        if (!weTookFullscreen && !document.fullscreenElement) {
          degraded.push('not fullscreen, browser chords may escape');
        }
      }

      keyboardLockOn = false;
      if (opts.keyboardLock !== 'off' && typeof navigator.keyboard?.lock === 'function') {
        try {
          await navigator.keyboard.lock();
          // The lock resolves anywhere, but only bites in fullscreen.
          keyboardLockOn = !!document.fullscreenElement;
        } catch { /* denied; degrade */ }
      }
      if (!keyboardLockOn) {
        degraded.push('browser chords not captured (no Keyboard Lock)');
      }

      const lock = await lockPointer();
      pointerLockOn = lock.ok;
      unadjusted = lock.ok && lock.raw;
      if (!pointerLockOn) degraded.push('keyboard only, pointer lock refused');
      else if (!unadjusted) degraded.push('pointer uses this machine\'s acceleration');

      if (!transport.isConnected()) degraded.push('dongle offline');

      active = true;
      since = Date.now();
      keys = moves = wheels = dropped = 0;
      accX = accY = accWheelPx = 0;
      touch();

      addLiveListeners();
      flushTimer = setInterval(flush, Math.max(8, opts.flushMs));
      statsTimer = setInterval(() => emit('capturestats', snapshot()), STATS_MS);
      idleTimer  = setInterval(checkIdle, 1000);

      if (opts.indicator) showIndicator();
      markTitle(true);

      emit('capturestart', {
        keyboardLock: keyboardLockOn,
        pointerLock: pointerLockOn,
        unadjusted,
        degraded: [...degraded],
      });
      return true;
    } catch (err) {
      arming = false;
      starting = false;
      teardown();
      emit('capturestop', { reason: 'error', message: err?.message });
      return false;
    } finally {
      arming = false;
      starting = false;
    }
  }

  function checkIdle() {
    if (!active || !opts.idleReleaseMs) return;
    if (Date.now() - lastActivity > opts.idleReleaseMs) stop('idle');
  }

  function stop(reason = 'manual') {
    if (!active) {
      // Still idempotent about the overlay and the title, in case arming died
      // halfway.
      hideIndicator();
      markTitle(false);
      return;
    }
    active = false;
    chordArmed = false;
    physMods = 0;
    mouseFree = false;

    // Everything held goes, in one packet, appended last to the ordered chain.
    // Except on a disconnect, where there is nowhere left to send it — so
    // remember that the far computer is still holding things, exactly the way
    // pad.js remembers a held left button, and resend on reconnect.
    if (reason === 'disconnected' && (mods || buttons || heldCodes.size)) {
      heldOnDisconnect = true;
    }
    releaseEverything(reason !== 'disconnected');
    accX = accY = accWheelPx = 0;   // residual sub-pixel motion is noise now
    teardown();

    if (keyboardLockOn) {
      try { navigator.keyboard.unlock(); } catch { /* nothing to do */ }
    }
    keyboardLockOn = false;

    if (document.pointerLockElement === surface) {
      try { document.exitPointerLock(); } catch { /* nothing to do */ }
      lastUnlockAt = Date.now();
    }
    pointerLockOn = false;
    unadjusted = false;

    if (weTookFullscreen && reason !== 'fullscreen' && document.fullscreenElement) {
      try { document.exitFullscreen()?.catch?.(() => {}); } catch { /* nothing to do */ }
    }
    weTookFullscreen = false;

    hideIndicator();
    markTitle(false);
    since = null;
    emit('capturestop', { reason });
  }

  function teardown() {
    removeLiveListeners();
    clearInterval(flushTimer); flushTimer = null;
    clearInterval(statsTimer); statsTimer = null;
    clearInterval(idleTimer);  idleTimer = null;
    clearTimeout(escHoldTimer); escHoldTimer = null;
    escPending = false;
  }

  // ---- listeners ----------------------------------------------------------

  const live = [];

  function on(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    live.push([target, type, fn, options]);
  }

  function addLiveListeners() {
    // Capture phase on window, so nothing reaches the local app.
    on(window, 'keydown', onKeyDown, true);
    on(window, 'keyup', onKeyUp, true);

    on(document, 'mousemove', onMouseMove, true);
    on(document, 'mousedown', onMouseDown, true);
    on(document, 'mouseup', onMouseUp, true);
    on(document, 'wheel', onWheel, { passive: false, capture: true });
    on(document, 'contextmenu', swallow, true);
    on(document, 'auxclick', swallow, true);
    on(document, 'dragstart', swallow, true);
    on(document, 'selectstart', swallow, true);

    on(document, 'pointerlockchange', onPointerLockChange);
    on(document, 'pointerlockerror', onPointerLockChange);
    on(document, 'fullscreenchange', onFullscreenChange);
    on(document, 'webkitfullscreenchange', onFullscreenChange);
    on(document, 'visibilitychange', onVisibility);
    on(window, 'blur', onBlur);
    on(window, 'pagehide', onPageHide);
  }

  function removeLiveListeners() {
    while (live.length) {
      const [target, type, fn, options] = live.pop();
      target.removeEventListener(type, fn, options);
    }
  }

  // The dongle can vanish while idle too, so this one lives for the whole
  // session rather than only while captured.
  const statusEvents = transport.events;
  statusEvents?.addEventListener?.('status', onTransportStatus);
  statusEvents?.addEventListener?.('settings', (e) => {
    if (typeof e.detail?.led !== 'number') return;
    hostLeds = e.detail.led;
    paintIndicator();
  });

  // ---- indicator ---------------------------------------------------------
  // A captured session with no feedback is a keylogger you forgot about, so
  // this is not decorative.

  const CSS = `
.bh-cap{position:fixed;inset:0;z-index:2147483000;pointer-events:none;
  font:13px/1.4 var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif);
  color:var(--text,#f2f1ed)}
.bh-cap-frame{position:absolute;inset:0;box-shadow:inset 0 0 0 2px var(--accent,#edb872)}
.bh-cap-panel{position:absolute;left:50%;top:max(16px,env(safe-area-inset-top));
  transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);
  padding:12px 14px;border-radius:16px;background:#0b0b0a;
  border:1px solid rgb(255 255 255 / 12%);box-shadow:0 12px 32px rgb(0 0 0 / 70%)}
.bh-cap-head{display:flex;align-items:center;gap:10px;justify-content:space-between}
.bh-cap-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
.bh-cap-dot{width:7px;height:7px;border-radius:50%;background:var(--accent,#edb872);opacity:.4;
  transition:opacity .12s linear}
.bh-cap-dot.on{opacity:1}
.bh-cap-how{font-size:12px;color:var(--muted,#9c9b95)}
.bh-cap-how b{color:var(--text,#f2f1ed);font-weight:600}
.bh-cap-row{margin-top:10px;display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap}
.bh-cap-sep{width:1px;align-self:stretch;margin:2px 4px;background:rgb(255 255 255 / 10%)}
.bh-cap-k{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:44px}
.bh-cap-cap{display:flex;align-items:center;justify-content:center;gap:4px;height:28px;
  padding:0 9px;border-radius:7px;background:#151413;border:1px solid rgb(255 255 255 / 14%);
  box-shadow:inset 0 -2px 0 rgb(0 0 0 / 45%);color:var(--muted,#9c9b95);font-size:12px;
  font-weight:500;white-space:nowrap;transition:background .08s,color .08s,border-color .08s}
.bh-cap-cap.on{background:var(--accent,#edb872);border-color:var(--accent,#edb872);color:#0b0b0a;
  box-shadow:none}
.bh-cap-to{font-size:10px;color:var(--accent,#edb872);letter-spacing:.02em;min-height:12px}
.bh-cap-lock{font-size:10px;letter-spacing:.08em;font-weight:600}
.bh-cap-note{margin-top:10px;font-size:11px;color:var(--muted,#9c9b95);max-width:560px}
`;

  // Physical modifier keys, drawn with the controlling machine's names; a
  // translated one shows where it lands on the other computer.
  const MODS = [
    { fam: 'ctrl', bits: 1 | 16, mac: '⌃ Ctrl', pc: 'Ctrl' },
    { fam: 'alt',  bits: 4 | 64, mac: '⌥ Opt',  pc: 'Alt' },
    { fam: 'meta', bits: 8 | 128, mac: '⌘ Cmd', pc: 'Win' },
    { fam: 'shift', bits: 2 | 32, mac: '⇧ Shift', pc: 'Shift' },
  ];
  const FAM_CODE = { ctrl: 'ControlLeft', alt: 'AltLeft', meta: 'MetaLeft' };
  const CODE_FAM = { ControlLeft: 'ctrl', AltLeft: 'alt', MetaLeft: 'meta' };
  let hostLeds = null;   // the far computer's lock lights, from the dongle

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildIndicator() {
    const root = el('div', 'bh-cap');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const style = el('style');
    style.textContent = CSS;
    root.append(style, el('div', 'bh-cap-frame'));

    const panel = el('div', 'bh-cap-panel');
    const head = el('div', 'bh-cap-head');
    const title = el('div', 'bh-cap-title');
    const dot = el('span', 'bh-cap-dot');
    title.append(dot, el('span', null, 'Controlling the other computer'));
    const how = el('div', 'bh-cap-how');
    head.append(title, how);

    const row = el('div', 'bh-cap-row');
    const modNodes = [];
    for (const m of MODS) {
      const k = el('div', 'bh-cap-k');
      const cap = el('span', 'bh-cap-cap');
      const to = el('span', 'bh-cap-to');
      k.append(cap, to);
      row.append(k);
      modNodes.push({ m, cap, to });
    }
    row.append(el('span', 'bh-cap-sep'));
    const lockNodes = new Map();
    for (const [name, bit] of [['CAPS', 2], ['NUM', 1]]) {
      const k = el('div', 'bh-cap-k');
      const cap = el('span', 'bh-cap-cap bh-cap-lock', name);
      k.append(cap, el('span', 'bh-cap-to'));
      row.append(k);
      lockNodes.set(bit, cap);
    }
    row.append(el('span', 'bh-cap-sep'));
    const btnNodes = new Map();
    for (const [label, bit] of [['L', 1], ['M', 4], ['R', 2]]) {
      const k = el('div', 'bh-cap-k');
      k.style.minWidth = '28px';
      const cap = el('span', 'bh-cap-cap', label);
      k.append(cap, el('span', 'bh-cap-to'));
      row.append(k);
      btnNodes.set(bit, cap);
    }

    const note = el('div', 'bh-cap-note');
    panel.append(head, row, note);
    root.append(panel);

    ind.root = root;
    ind.nodes = { dot, how, modNodes, lockNodes, btnNodes, note };
  }

  function releaseWord() {
    return mouseFree ? 'Click for the mouse · <b>Ctrl+Alt</b> releases' : '<b>Ctrl+Alt</b> releases';
  }

  function setIndicatorText() {
    if (!ind.nodes) return;
    const n = ind.nodes;
    n.how.innerHTML = releaseWord();

    // Key legends: this machine's names, and where each one lands.
    const mac = MAC_CAPS;
    const map = (typeof opts.modMap === 'function' ? opts.modMap() : opts.modMap) || {};
    const farMac = !!opts.targetIsMac?.();
    for (const { m, cap, to } of n.modNodes) {
      cap.textContent = mac ? m.mac : m.pc;
      const sent = m.fam === 'shift' ? 'shift' : (CODE_FAM[map[FAM_CODE[m.fam]]] || m.fam);
      const crossing = mac !== farMac;
      const farName = { ctrl: farMac ? '⌃ Ctrl' : 'Ctrl', alt: farMac ? '⌥ Opt' : 'Alt',
                        meta: farMac ? '⌘ Cmd' : 'Win', shift: 'Shift' }[sent];
      to.textContent = crossing && farName.replace(/^\S+ /, '') !== cap.textContent.replace(/^\S+ /, '')
        ? '→ ' + farName.replace(/^[⌃⌥⌘⇧] /, '') : '';
    }

    // One quiet line instead of a list: what stays on this computer.
    const bits = [];
    if (!keyboardLockOn) bits.push('browser shortcuts');
    bits.push('OS shortcuts like ' + (mac ? 'Cmd+Tab' : 'Alt+Tab'));
    const extra = [...degraded.filter((d) => !/Keyboard Lock/.test(d))];
    if (warned.has('ime')) extra.push('an input method is swallowing keys');
    n.note.textContent = 'Stays on this computer: ' + bits.join(', ') + '.'
      + (extra.length ? ' ' + extra.join('; ') + '.' : '');
  }

  function prettyCode(code) {
    return code.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  let pulseTimer = null;
  function pulse() {
    const dot = ind.nodes?.dot;
    if (!dot) return;
    dot.classList.add('on');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => dot.classList.remove('on'), 90);
  }

  function paintIndicator() {
    if (!ind.nodes) return;
    const n = ind.nodes;
    for (const { m, cap } of n.modNodes) cap.classList.toggle('on', !!(physMods & m.bits));
    for (const [bit, cap] of n.btnNodes) cap.classList.toggle('on', !!(buttons & bit));
    for (const [bit, cap] of n.lockNodes) {
      cap.classList.toggle('on', hostLeds != null && !!(hostLeds & bit));
      cap.style.opacity = hostLeds == null ? '.4' : '';
      cap.title = hostLeds == null ? 'waiting for the other computer' : '';
    }
  }

  function showIndicator() {
    if (!ind.root) buildIndicator();
    // The default surface is <html>, which is a poor parent for a panel, so in
    // that one case the overlay goes in <body> instead.
    const host = surface === document.documentElement
      ? (document.body ?? document.documentElement)
      : surface;
    host.appendChild(ind.root);
    setIndicatorText();
    paintIndicator();
    events.addEventListener('capturestats', paintIndicator);
  }

  function hideIndicator() {
    events.removeEventListener('capturestats', paintIndicator);
    clearTimeout(pulseTimer);
    ind.root?.remove();
  }

  function markTitle(on) {
    if (typeof document === 'undefined') return;
    if (on) {
      if (titleBefore == null) titleBefore = document.title;
      document.title = '● CAPTURED — ' + titleBefore;
    } else if (titleBefore != null) {
      document.title = titleBefore;
      titleBefore = null;
    }
  }

  // ---- public surface ----------------------------------------------------

  // One-shot by physical position. While captured it goes as down/up so it
  // keeps the same timing discipline as everything else; while idle a single
  // TAP packet is cheaper and the firmware's own press delay is harmless.
  function sendKey(code, extraMods = 0) {
    const bit = MOD_BITS[code];
    if (bit) {
      transport.keyDown(0, bit | extraMods);
      transport.keyUp(0, bit | extraMods);
      keys++;
      if (active) activity('mod', code);
      return;
    }
    const usage = codeToUsage(code);
    if (!usage) { dropped++; return; }

    if (active) {
      if (extraMods) transport.keyDown(0, extraMods);
      transport.keyDown(usage, 0);
      transport.keyUp(usage, 0);
      if (extraMods) transport.keyUp(0, extraMods);
      keys++;
      activity('key', code);
    } else {
      transport.tapOne(usage, extraMods);
      keys++;
    }
  }

  const LIVE_OPTIONS = new Set([
    'sensitivity', 'scrollPixelsPerTick', 'naturalScroll', 'maxMovePacketsPerFlush',
    'releaseHoldMs', 'escapeSurrogate', 'modMap', 'targetIsMac', 'showKeyNames', 'idleReleaseMs',
    'requireConnection', 'unadjustedMovement', 'fullscreen', 'keyboardLock',
    'indicator', 'flushMs',
  ]);

  function setOption(name, value) {
    if (!LIVE_OPTIONS.has(name)) return;
    opts[name] = value;
    if (name === 'flushMs' && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = setInterval(flush, Math.max(8, opts.flushMs));
    }
    if (active) { setIndicatorText(); paintIndicator(); }
  }

  const session = {
    start,
    stop,
    toggle: () => (active ? (stop('manual'), Promise.resolve(false)) : start()),
    isActive: () => active,
    refreshIndicator: () => { setIndicatorText(); paintIndicator(); },
    state: snapshot,
    sendKey,
    sendEscape: () => sendKey('Escape'),
    setOption,
    getOptions: () => Object.freeze({ ...opts }),
    events,
    destroy() {
      stop('manual');
      statusEvents?.removeEventListener?.('status', onTransportStatus);
      hideIndicator();
      ind.root = null;
      ind.nodes = null;
    },
  };

  return session;
}

export default createCapture;
