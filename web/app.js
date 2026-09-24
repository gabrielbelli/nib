// N.I.B. — the page.
//
// Four things are on screen at rest: the trackpad (which IS the page), a
// status pill that is also the connect button, a hamburger, and one corner
// button whose tap swaps pad and keyboard and whose hold enters full screen.
// Everything else is one level deeper, in the drawer.
//
// This file is the only orchestrator. Every module it imports is wired here or
// it does not exist:
//
//   ble.js          transport
//   keymap.js       characters -> HID usage codes, per host layout
//   motion.js       the one spring integrator
//   pad.js          createTrackpad  -> owns #stage-pad
//   dots.js         createDotField  -> the dot field under #stage-pad
//   osk.js          createKeyboard  -> owns #stage-keys
//   osk-presets.js  the 60% / 65% / compact / full / numpad / nav geometry
//   fullscreen.js   createImmersive -> the full-screen shell
//   capture.js      createCapture   -> desktop KVM mode, hidden elsewhere

import { tap as haptic } from './haptics.js?v=12';
import * as ble from './ble.js?v=12';
import { textToKeys, KEY, LAYOUTS, DEFAULT_LAYOUT } from './keymap.js?v=12';
import { spring, project, rubberband, prefersReducedMotion } from './motion.js?v=12';
import { createTrackpad, GESTURES } from './pad.js?v=12';
import { createDotField } from './dots.js?v=12';
import { createKeyboard } from './osk.js?v=12';
import { createPads } from './pads.js?v=12';
import {
  OSK_ACTIONS, OSK_DEFAULT_PRESET, OSK_METRICS, OSK_PRESET_LIST,
} from './osk-presets.js?v=12';
import { createImmersive } from './fullscreen.js?v=12';
import { createCapture, SUPPORT, supportEvents } from './capture.js?v=12';
import * as target from './target.js?v=12';

const $ = (sel) => document.querySelector(sel);
const body = document.body;

// Browser storage can throw in private mode, and everything kept here is a
// convenience rather than something the app depends on.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

// ===========================================================================
// the toast — what used to be a permanent footer line
// ===========================================================================

const toast = $('#nib-toast');
const logEl = $('#log');
const TOAST_MS = 2200;

let toastSpring = null;
let toastTimer = null;

// It slides from the top edge and leaves to the top edge: enter and exit share
// one path, so the thing never appears to come from nowhere.
function paintToast(v) {
  const t = Math.max(0, Math.min(1, v / 100));
  toast.style.opacity = String(t);
  toast.style.transform = `translateY(${(t - 1) * 8}px) scale(${0.96 + 0.04 * t})`;
  toast.style.pointerEvents = 'none';
  // .is-out is the resting off state. Nothing toggled it, so the toast shipped
  // visible with its placeholder text sitting beside the connect pill.
  toast.classList.toggle('is-out', t < 0.02);
}

function toastTo(to) {
  if (toastSpring) { toastSpring.revive().retarget(to); return; }
  toastSpring = spring({
    from: to > 0 ? 0 : 100, to, bounce: 0, duration: 0.28,
    onframe: paintToast,
    ondone: () => { toastSpring = null; paintToast(to); },
  });
}

function log(msg) {
  if (!msg) return;
  logEl.textContent = msg;
  toastTo(100);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastTo(0), TOAST_MS);
}

paintToast(0);

// ===========================================================================
// the host's keyboard layout — set once per computer, so it lives in the drawer
// ===========================================================================

const layoutSel = $('#layout');
let layout = store.get('nib.layout', DEFAULT_LAYOUT);
if (!LAYOUTS[layout]) layout = DEFAULT_LAYOUT;

for (const [id, { label }] of Object.entries(LAYOUTS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = label;
  layoutSel.append(opt);
}
layoutSel.value = layout;
layoutSel.addEventListener('change', () => {
  layout = layoutSel.value;
  store.set('nib.layout', layout);
  buildEchoTable();
  kb?.setLayout(layout);
  log(`layout: ${LAYOUTS[layout].label}`);
});

const toKeys = (text) => textToKeys(text, layout);

// ===========================================================================
// the echo — the only proof a keystroke landed
// ===========================================================================
// You cannot see the far computer, so in keys mode the space above the keyboard
// echoes the characters that were actually sent. Reversed out of the SAME table
// that produced them, so it is honest about the host layout. Secrets never
// reach this: ble.secret() is a separate path that does not call echo().

const echoEl = $('#nib-echo');
const ECHO_MAX = 28;
const ECHO_IDLE_MS = 6000;

const NAMED = new Map();
for (const [name, usage] of Object.entries(KEY)) {
  if (!NAMED.has(usage)) NAMED.set(usage, name);
}
const NAMED_GLYPH = {
  ENTER: '⏎', TAB: '⇥', BACKSPACE: '⌫', ESC: '⎋',
  DELETE: '⌦', LEFT: '←', RIGHT: '→', UP: '↑', DOWN: '↓',
  SPACE: ' ',
};

let echoTable = new Map();
let echoText = '';
let echoTimer = null;

function buildEchoTable() {
  echoTable = new Map();
  const table = (LAYOUTS[layout] ?? LAYOUTS[DEFAULT_LAYOUT]).table;
  for (const [ch, steps] of table) {
    if (steps.length !== 1) continue;             // composed: not one keystroke
    const [mods, usage] = steps[0];
    const key = (mods << 8) | usage;
    if (!echoTable.has(key)) echoTable.set(key, ch);
  }
}
buildEchoTable();

function glyphFor(mods, usage) {
  const named = NAMED.get(usage);
  if (named && NAMED_GLYPH[named]) return NAMED_GLYPH[named];
  const exact = echoTable.get((mods << 8) | usage);
  if (exact) return exact;
  // A modifier was OR-ed on by the app rather than by the table, so look the
  // bare key up and let the combination show as a chord.
  const bare = echoTable.get(usage);
  if (bare && mods) return `⌘${bare}`;
  return bare ?? (named ? `[${named.toLowerCase()}]` : '');
}

function echo(keys) {
  if (!keys?.length) return;
  let out = '';
  for (const [mods, usage] of keys) out += glyphFor(mods, usage);
  if (!out) return;
  echoText = (echoText + out).slice(-ECHO_MAX);
  echoEl.textContent = echoText;
  clearTimeout(echoTimer);
  echoTimer = setTimeout(() => { echoText = ''; echoEl.textContent = ''; }, ECHO_IDLE_MS);
}

/** Everything non-secret goes through here, so the echo cannot be forgotten. */
function sendKeys(keys) {
  if (!keys?.length) return;
  ble.tap(keys);
  echo(keys);
}

function sendKey(usage, mods = 0) { sendKeys([[mods, usage]]); }

/** Passwords and secret snippets. Never echoed, never logged as text. */
function sendSecret(keys) {
  if (!keys?.length) return;
  ble.secret(keys);
}

// ===========================================================================
// connection — the status pill IS the connect button
// ===========================================================================

const connectBtn = $('#connect');
const statusEl = $('#status');
const connLabel = $('#nib-conn-label');
const subEl = $('#nib-sub');

/** The only writer of the connection UI, so no path can leave it half-painted. */
function paintConn(s) {
  const state = s === 'connected' ? 'on' : s === 'connecting' ? 'wait' : 'off';

  // The pill has children now, so this writes to the label span. Setting
  // textContent on the button itself would wipe the dot and the name.
  statusEl.textContent = s;
  statusEl.className = 'status ' + state + ' nib-sr';
  connLabel.textContent = s === 'connected' ? 'Disconnect' : s === 'connecting' ? 'Connecting' : 'Connect';
  body.dataset.conn = state;
  subEl.textContent = s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : 'not connected';
}

connectBtn.addEventListener('click', async () => {
  if (ble.isConnected()) { ble.disconnect(); return; }
  try {
    connectBtn.disabled = true;
    const name = await ble.connect();
    log(`connected to ${name}`);
  } catch (err) {
    log(err.message);
  } finally {
    connectBtn.disabled = false;
    // Terminal-state guard. ble.js now always emits 'disconnected' on a failed
    // connect, but nothing about this pill may depend on that: a stuck
    // "Connecting" with a pulsing dot and no way back is the worst possible
    // outcome of a cancelled chooser.
    if (!ble.isConnected() && body.dataset.conn === 'wait') paintConn('disconnected');
  }
});

ble.events.addEventListener('status', (e) => {
  const s = e.detail;
  // Read by the self-updater in index.html: never reload under a live link.
  window.__nibLinked = s === 'connected' || s === 'connecting';
  if (s === 'disconnected' && window.__nibUpd?.pending) {
    location.replace(window.__nibUpd.pending);
    return;
  }
  paintConn(s);

  if (s === 'connected') {
    // One packet, and it cannot make anything worse: the far computer may still
    // be holding a modifier or a mouse button from before the drop, and
    // fire-and-forget writes mean nothing here can know.
    try { ble.releaseAll(); } catch { /* ignore */ }
  } else {
    ssSupported = null;
    paintScreensaver();
  }
});
ble.events.addEventListener('error', (e) => log('ble: ' + e.detail));
ble.events.addEventListener('firmware', (e) => log('dongle: ' + e.detail));
// Development telemetry: a status that does not parse leaves the Dongle section
// locked, and only the phone knows what it actually received.
ble.events.addEventListener('statuserr', (e) => { try { fieldReport && fieldReport('statuserr', e.detail); } catch { /* telemetry only */ } });
ble.events.addEventListener('statusbad', (e) => { try { fieldReport && fieldReport('statusbad', e.detail); } catch { /* telemetry only */ } });
ble.events.addEventListener('settings', (e) => { try { fieldReport && fieldReport('status', { ss: !!e.detail?.ss, n: e.detail?.ss?.n }); } catch { /* telemetry only */ } });

// ===========================================================================
// modifiers — one owner, so the drawer chips and the keycaps agree
// ===========================================================================
// Tap Cmd, then tap a key or type a letter, and the modifier applies to that
// one keystroke, then clears. Hold to latch it on.

const LATCH_MS = 500;
let stickyMods = 0;
let latchedMods = 0;

function paintMods() {
  for (const b of document.querySelectorAll('.btn.mod')) {
    const bit = Number(b.dataset.mod);
    b.classList.toggle('on', !!((stickyMods | latchedMods) & bit));
    b.classList.toggle('latched', !!(latchedMods & bit));
  }
  kb?.refresh();
}

// A click that lands more than this after the last pointerdown on the same
// element was synthesised - VoiceOver's double-tap, TalkBack's activation,
// Tab+Enter - rather than produced by that pointer sequence.
const SYNTHETIC_AFTER = 700;

/** Shared by the drawer chips and by osk.js, so both behave identically. */
function bindMod(btn, bit) {
  let timer = null;
  let lastPointerAt = -Infinity;

  const clear = () => { clearTimeout(timer); timer = null; };

  const toggle = () => {
    // A tap must undo a latch, or the only way out is a second long-press.
    if (latchedMods & bit) { latchedMods &= ~bit; stickyMods &= ~bit; }
    else stickyMods ^= bit;
    paintMods();
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    lastPointerAt = performance.now();
    e.preventDefault();
    // Without capture a pointerup that happens a few pixels outside the chip is
    // delivered to whatever is under the finger, this handler never runs, the
    // 500ms latch timer survives, and the modifier silently latches on its own.
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    timer = setTimeout(() => {
      timer = null;
      latchedMods ^= bit;
      stickyMods &= ~bit;
      paintMods();
    }, LATCH_MS);
  });

  btn.addEventListener('pointerup', () => {
    if (!timer) return;
    clear();
    toggle();
  });

  // Every way a press can end without a pointerup has to clear the timer.
  btn.addEventListener('pointercancel', clear);
  btn.addEventListener('pointerleave', clear);
  btn.addEventListener('lostpointercapture', clear);

  // The only path assistive tech and the keyboard have. bindMod is handed to
  // osk.js, so this reaches every modifier keycap as well as the four chips.
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (performance.now() - lastPointerAt > SYNTHETIC_AFTER) toggle();
  });
}

for (const b of document.querySelectorAll('#mods .btn.mod')) {
  bindMod(b, Number(b.dataset.mod));
}

function takeMods() {
  const m = stickyMods | latchedMods;
  stickyMods = 0;
  paintMods();
  return m;
}

/**
 * The panic path, as a function rather than only a button. #panic lives inside
 * the sheet, which fullscreen.js marks inert, so a keyboard action that reached
 * it through $('#panic').click() silently did nothing in full screen.
 */
function releaseEverything() {
  stickyMods = latchedMods = 0;
  paintMods();
  kb?.stopRepeat();
  trackpad?.release();
  ble.releaseAll();
  log('released everything');
}

$('#panic').addEventListener('click', releaseEverything);

// A phone will serve a cached bundle for a day, and a soft reload hands back
// exactly the same files. This drops what the browser is holding and changes
// the URL, so the fetch is real.
$('#reload').addEventListener('click', async () => {
  try {
    if (window.caches) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch { /* nothing cached, or storage blocked */ }
  releaseEverything();
  const url = new URL(location.href);
  url.searchParams.set('r', String(Math.floor(performance.now())));
  location.replace(url.toString());
});

// ===========================================================================
// typing with the phone's own keyboard — the path that gets autocorrect
// ===========================================================================
// Soft keyboards do not produce reliable keydown events, so watch the value and
// send the difference. That also gets backspace and autocorrect rewrites right.

const live = $('#live');
const liveSecret = $('#live-secret');
let prev = '';

/** The one flag that separates "send text" from "send a secret". */
const liveIsSecret = () => !!liveSecret?.checked;

function sendTyped(keys) {
  if (!keys?.length) return;
  if (liveIsSecret()) sendSecret(keys); else sendKeys(keys);
}

live.addEventListener('input', () => {
  const cur = live.value;
  let i = 0;
  while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;

  const deletions = prev.length - i;
  const added = cur.slice(i);
  prev = cur;

  if (deletions > 0) {
    sendTyped(Array.from({ length: deletions }, () => [0, KEY.BACKSPACE]));
  }
  if (added) {
    const mods = takeMods();
    const { keys, skipped } = toKeys(added);
    if (mods && keys.length) keys[0][0] |= mods;
    sendTyped(keys);
    // The characters themselves are the leak, so a secret only ever gets the
    // fact that something was dropped.
    if (skipped.length) {
      log(liveIsSecret()
        ? 'some characters are not on this layout'
        : `not on this layout: ${skipped.join('')}`);
    }
  }
});

live.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const mods = takeMods();
    if (liveIsSecret()) sendSecret([[mods, KEY.ENTER]]);
    else sendKey(KEY.ENTER, mods);
    live.value = prev = '';
  }
});

// Autocorrect is the whole point of this box - the diff-based send above exists
// so a rewrite reaches the far computer - but a secret must not be handed to the
// keyboard's dictionary, and whatever is already in the box must not survive the
// switch into secrecy.
liveSecret?.addEventListener('change', () => {
  const on = liveSecret.checked;
  live.setAttribute('autocorrect', on ? 'off' : 'on');
  live.spellcheck = !on;
  if (!on) return;
  live.value = prev = '';
  log('this box is a secret now');
});

// ===========================================================================
// passwords
// ===========================================================================

// The heading above these fields promises "never stored, never logged", so the
// toast may not publish the password's length - neither as a key count nor as a
// count of characters that were dropped. Both narrow a guess.
function typeSecret(text, { enter = false, what = 'password' } = {}) {
  if (!text) { log('nothing to type'); return; }
  const { keys, skipped } = toKeys(text);
  sendSecret(keys);
  if (enter) ble.tapOne(KEY.ENTER);
  log(skipped.length
    ? `${what} typed, but some characters are not on the ${LAYOUTS[layout].label} layout`
    : `${what} typed`);
}

$('#type-pass').addEventListener('click', () => typeSecret($('#pass').value));
$('#type-pass-enter').addEventListener('click', () => typeSecret($('#pass').value, { enter: true }));
$('#type-user').addEventListener('click', () => typeSecret($('#user').value, { what: 'username' }));

$('#type-both').addEventListener('click', () => {
  const user = $('#user').value;
  const pass = $('#pass').value;
  if (!user || !pass) { log('need both fields'); return; }
  sendSecret(toKeys(user).keys);
  ble.tapOne(KEY.TAB);
  sendSecret(toKeys(pass).keys);
  ble.tapOne(KEY.ENTER);
  log('typed username, tab, password, enter');
});

$('#clear-pw').addEventListener('click', () => {
  $('#user').value = '';
  $('#pass').value = '';
  log('fields cleared');
});

// ===========================================================================
// snippets
// ===========================================================================

const snipList = $('#snips');
const editor = $('#snip-editor');
let snippets = store.get('nib.snippets', []);
let editingId = null;

function saveSnippets() { store.set('nib.snippets', snippets); }

function typeSnippet(s) {
  const { keys, skipped } = toKeys(s.text);
  if (s.secret) sendSecret(keys); else sendKeys(keys);
  if (s.enter) ble.tapOne(KEY.ENTER);
  log(skipped.length
    ? (s.secret
      ? `sent "${s.name}", some characters not on this layout`
      : `sent "${s.name}", ${skipped.length} character(s) not on this layout`)
    : `sent "${s.name}"`);
}

function renderSnippets() {
  snipList.textContent = '';
  if (!snippets.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No snippets yet.';
    snipList.append(p);
    return;
  }

  for (const s of snippets) {
    const row = document.createElement('div');
    row.className = 'snip';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    if (s.secret) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'secret';
      name.append(tag);
    }
    const peek = document.createElement('div');
    peek.className = 'peek';
    // A snippet marked secret is never shown back, only typed - and the mask is
    // a fixed width, because a mask that matches the length publishes the length.
    peek.textContent = s.secret ? '••••••••' : s.text;
    meta.append(name, peek);

    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn';
    send.textContent = 'Type';
    send.addEventListener('click', () => typeSnippet(s));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn small';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      editingId = s.id;
      $('#snip-name').value = s.name;
      $('#snip-text').value = s.text;
      $('#snip-enter').checked = !!s.enter;
      $('#snip-secret').checked = !!s.secret;
      editor.open = true;
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      snippets = snippets.filter((x) => x.id !== s.id);
      saveSnippets();
      renderSnippets();
      log(`deleted "${s.name}"`);
    });

    row.append(meta, send, edit, del);
    snipList.append(row);
  }
}

function resetEditor() {
  editingId = null;
  $('#snip-name').value = '';
  $('#snip-text').value = '';
  $('#snip-enter').checked = false;
  $('#snip-secret').checked = false;
  editor.open = false;
}

$('#snip-save').addEventListener('click', () => {
  const name = $('#snip-name').value.trim();
  const text = $('#snip-text').value;
  if (!name || !text) { log('a snippet needs a name and some text'); return; }

  const entry = {
    id: editingId ?? String(Date.now()),
    name,
    text,
    enter: $('#snip-enter').checked,
    secret: $('#snip-secret').checked,
  };

  const at = snippets.findIndex((x) => x.id === entry.id);
  if (at >= 0) snippets[at] = entry; else snippets.push(entry);

  saveSnippets();
  renderSnippets();
  resetEditor();
  log(`saved "${name}"`);
});

$('#snip-cancel').addEventListener('click', (e) => { e.preventDefault(); resetEditor(); });

renderSnippets();

// ===========================================================================
// the dongle's settings
// ===========================================================================

const setNote = $('#set-note');
const setName = $('#set-name');
const setPk = $('#set-pk');
const setModeSel = $('#set-mode');
const setShow = $('#set-show');
const setUsb = $('#set-usb');
const setHid = $('#set-hid');
let dongleHasScreen = true;

ble.events.addEventListener('settings', (e) => {
  const s = e.detail;
  setName.value = s.name ?? '';
  setPk.value = String(s.pk ?? '').padStart(6, '0');
  setModeSel.value = String(s.mode ?? 0);
  setShow.checked = !!s.show;
  setUsb.value = String(s.usb ?? 0);
  setHid.value = String(s.hid ?? 0);
  $('#set-pair').value = String(s.pm ?? 0);
  paintButtonless(s.btn !== 0);   // older firmware sends no "btn": it has one
  // Firmware without pairing windows reports no "pm": hide what it cannot do.
  $('#set-pair-open').hidden = s.pm !== 1;
  $('#set-pair-open').textContent = s.po && s.pw
    ? `Pairing open, ${Math.ceil(s.pw / 60)} min left` : 'Let a new phone pair (2 min)';
  dongleHasScreen = s.screen !== 0;

  // Without a screen there is nothing to read a passkey from, so the options
  // that depend on one are not offered at all.
  setShow.disabled = !dongleHasScreen;
  for (const opt of setModeSel.options) {
    if (opt.value !== '0') opt.disabled = !dongleHasScreen;
  }
  $('#set-show-note').textContent = dongleHasScreen
    ? 'Off: shown only while pairing.'
    : 'No screen: the passkey is fixed and printed on the USB console.';
  setNote.textContent = '';
  setNote.hidden = true;
  // Fresh values from the dongle: nothing is unsaved.
  $('#set-savebar').hidden = true;

  adoptScreensaver(s.ss, dongleHasScreen);
  target.setDetected(s.host);
});

$('#set-pair-open').addEventListener('click', () => {
  ble.openPairing();
  log('pairing open for 2 minutes: pair the new phone now');
});

$('#set-pk-random').addEventListener('click', () => {
  const pk = Math.floor(Math.random() * 1000000);
  setPk.value = String(pk).padStart(6, '0');
  log('new passkey generated, press Save to apply');
});

$('#set-save').addEventListener('click', () => {
  if (!ble.isConnected()) { log('connect first'); return; }

  const name = setName.value.trim() || 'N.I.B.';
  const pk = Number(setPk.value.replace(/\D/g, '')) % 1000000;
  const pkMode = dongleHasScreen ? Number(setModeSel.value) : 0;

  ble.setName(name);
  ble.setPasskey(pk);
  ble.setOptions({
    showPasskey: setShow.checked,
    mode: pkMode,
    usb: Number(setUsb.value),
    hid: Number(setHid.value),
    pair: Number($('#set-pair').value),
  });
  ble.apply();
  log('saved, dongle is restarting - reconnect in a few seconds');
});

// Two taps: the first arms it for three seconds, the second wipes.
let forgetArmed = 0;
$('#set-forget').addEventListener('click', (e) => {
  const b = e.currentTarget;
  if (!ble.isConnected()) { log('connect first'); return; }
  if (!forgetArmed) {
    b.textContent = 'Tap again to wipe every phone';
    b.classList.add('is-armed');
    forgetArmed = setTimeout(() => {
      forgetArmed = 0; b.textContent = 'Wipe all paired phones'; b.classList.remove('is-armed');
    }, 3000);
    return;
  }
  clearTimeout(forgetArmed); forgetArmed = 0;
  b.textContent = 'Wipe all paired phones'; b.classList.remove('is-armed');
  ble.forget();
  log('wiped every paired phone, including this one');
});

// The pairing form saves as one: its save bar appears once anything changed.
for (const el of document.querySelectorAll('#set-form input, #set-form select')) {
  el.addEventListener('input', () => { $('#set-savebar').hidden = false; });
  el.addEventListener('change', () => { $('#set-savebar').hidden = false; });
}

// ===========================================================================
// the trackpad — it is not a panel, it is the page
// ===========================================================================

const padEl = $('#stage-pad');

const trackpad = createTrackpad({ surface: padEl, ble, log, store });

// The dot field under the pad: a grid revealed around each finger, a wake
// behind a moving one, and a ring out of every click. dots.js draws it; this
// only feeds it contacts.
const dots = createDotField(padEl);

/** Called from onViewport() and whenever the pad changes container. */
function invalidatePadRect() {
  dots.invalidate();
  trackpad?.invalidateGeometry?.();
}

// Both paths, because pad.js calls preventDefault() on touchstart, and which of
// touch and pointer survives that differs between engines. The de-duplication
// rule is attachRecogniser()'s: where touch events exist the touch path owns
// every finger, and the pointer path takes the mouse, plus a pen that produced
// no touch. It must be a capability test, not a latch set by the first
// touchstart: Chromium fires pointerdown BEFORE touchstart, so a latch let the
// first finger after load in twice and parked a second halo where it landed.
const dotsHasTouch = 'ontouchstart' in window;
let dotsTouchLive = 0;
const notPad = (t) => !!(t && t.closest && t.closest('.pad-corner,.pad-ignore,button,a,input,select,textarea'));
const pointerIsFinger = (e) => dotsHasTouch && e.pointerType !== 'mouse'
  && !(e.pointerType === 'pen' && dotsTouchLive === 0);

padEl.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    dotsTouchLive++;
    if (!notPad(t.target)) dots.down(`t${t.identifier}`, t.clientX, t.clientY);
  }
}, { passive: true });
padEl.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) dots.move(`t${t.identifier}`, t.clientX, t.clientY);
}, { passive: true });
const dotsTouchEnd = (e) => {
  for (const t of e.changedTouches) {
    dotsTouchLive = Math.max(0, dotsTouchLive - 1);
    dots.up(`t${t.identifier}`);
  }
};
padEl.addEventListener('touchend', dotsTouchEnd, { passive: true });
padEl.addEventListener('touchcancel', dotsTouchEnd, { passive: true });

padEl.addEventListener('pointerdown', (e) => {
  if (pointerIsFinger(e) || (e.pointerType === 'mouse' && e.button > 0) || notPad(e.target)) return;
  dots.down(`p${e.pointerId}`, e.clientX, e.clientY);
}, { passive: true });
padEl.addEventListener('pointermove', (e) => {
  if (!pointerIsFinger(e)) dots.move(`p${e.pointerId}`, e.clientX, e.clientY);
}, { passive: true });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  padEl.addEventListener(type, (e) => dots.up(`p${e.pointerId}`), { passive: true });
}

// A click throws one ring per finger; grabbing the button throws a softer one.
trackpad.recogniser.on('tap', ({ fingers, x, y }) => dots.ripple(x, y, fingers));
trackpad.recogniser.on('holdstart', ({ x, y }) => dots.ripple(x, y, 1, 0.6));

// ---- the pad's own settings, one level deeper --------------------------------

const padOpts = trackpad.getOptions();
const speed = $('#speed');
speed.value = String(padOpts.sensitivity);
const speedVal = $('#speed-val');
const paintSpeed = () => { speedVal.textContent = `${Number(speed.value).toFixed(1)}×`; };
paintSpeed();
speed.addEventListener('input', () => {
  trackpad.setOptions({ sensitivity: Number(speed.value) });
  paintSpeed();
});

// Scroll speed, separate from pointer speed. Left to right is slow to fast, so
// the slider is inverted onto the divisor: 1 -> 24 (slowest), 10 -> 2.4. The
// default 3 is exactly today's divisor of 8, so nobody's feel changes, and it
// persists through setOptions() into the existing nib.pad key - no new one.
const SCROLL_SPAN = 24;
const scrollSpeed = $('#scroll-speed');
const toSlider = (divisor) =>
  Math.min(10, Math.max(1, SCROLL_SPAN / (Number(divisor) || 8)));

scrollSpeed.value = String(toSlider(padOpts.scrollDivisor));
const scrollVal = $('#scroll-speed-val');
const paintScroll = () => { scrollVal.textContent = String(Math.round(Number(scrollSpeed.value) * 10) / 10); };
paintScroll();
scrollSpeed.addEventListener('input', () => {
  const v = Math.min(10, Math.max(1, Number(scrollSpeed.value) || 3));
  trackpad.setOptions({ scrollDivisor: SCROLL_SPAN / v });
  paintScroll();
});

const padNatural = $('#pad-natural');
padNatural.checked = padOpts.naturalScroll !== false;
padNatural.addEventListener('change', () => {
  trackpad.setOptions({ naturalScroll: padNatural.checked });
});

const padHaptics = $('#pad-haptics');
padHaptics.checked = padOpts.haptics !== false;
padHaptics.addEventListener('change', () => {
  trackpad.setOptions({ haptics: padHaptics.checked });
});

const cornerSeg = $('#pad-corner');
function paintCornerSeg(side) {
  for (const b of cornerSeg.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.corner === side);
    b.setAttribute('aria-pressed', String(b.dataset.corner === side));
  }
}
paintCornerSeg(padOpts.corner === 'left' ? 'left' : 'right');
cornerSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-corner]');
  if (!b) return;
  const side = b.dataset.corner;
  trackpad.setOptions({ corner: side });
  imm?.setOptions({ corner: side });
  // The published hook for stylesheets that want to mirror anything by hand.
  // pad.js and fullscreen.js each mirror their own corner in JS, so nothing
  // depends on this; it is written so a rule CAN exist, and documented so the
  // next reader does not spend an afternoon looking for the one that reads it.
  body.dataset.corner = side;
  paintCornerSeg(side);
  invalidatePadRect();
  log(side === 'left' ? 'left hand' : 'right hand');
});
body.dataset.corner = padOpts.corner === 'left' ? 'left' : 'right';

// ---- the shell: a desktop does not get a full-page trackpad -----------------
// Never sniffed from the user agent. A touchscreen Windows laptop matches both
// `pointer: fine` and `any-pointer: coarse`, and an iPad with a paired mouse
// matches `any-pointer: fine` but `pointer: coarse`, so the query asks about the
// PRIMARY pointer and the answer is overridable. Input binding is never gated on
// any of this: pad.js binds both paths and filters per event by pointerType.
const SHELL_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 700px)';
const shellMq = window.matchMedia ? window.matchMedia(SHELL_QUERY) : null;
const shellSeg = $('#shell-seg');
const SHELLS = ['auto', 'phone', 'desktop'];

// ?shell=phone|desktop forces the shell for one load, so the phone layout can
// be opened and inspected on a machine that reports a fine pointer.
// ---- touch router ------------------------------------------------------------
// Field telemetry from a real iPhone (iOS 18.7, WKWebView) in landscape: every
// tap on the top controls arrived with the right clientX/clientY but with a
// TARGET 59px to the right - exactly the left safe-area inset. The engine hit-
// tests touches in a coordinate space that ignores the inset while reporting
// coordinates that include it (WebKit, FB19543269 family). Layout is correct,
// elementFromPoint is correct, only dispatch is wrong. So: on every pointer
// and touch event, compare the target with the element actually under the
// finger; if they disagree and either is a button, kill the misrouted event
// and activate the button under the finger instead. When the engine is right
// this never fires.
(() => {
  const btnOf = (n) => (n && n.closest ? n.closest('button, [role="button"]') : null);
  let armed = null;                      // the button the finger went down on
  let phantom = null;                    // the button the engine wrongly targeted
  let bypass = false;                   // set while we activate the right button ourselves
  const under = (e) => {
    const x = e.clientX ?? (e.touches && e.touches[0] && e.touches[0].clientX) ?? (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientX);
    const y = e.clientY ?? (e.touches && e.touches[0] && e.touches[0].clientY) ?? (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientY);
    // No coordinates, or 0,0: a keyboard, screen-reader or programmatic
    // activation. Those have no finger to route by, and must pass untouched.
    if (x == null || y == null || (x === 0 && y === 0)) return null;
    return document.elementFromPoint(x, y);
  };
  const misrouted = (e) => {
    const real = under(e);
    if (!real) return null;
    const tb = btnOf(e.target), rb = btnOf(real);
    if (!tb && !rb) return null;         // neither side is a button: not ours
    if (tb === rb) return null;          // routed correctly
    // Only "the finger is inside the target" is a match (the target button, the
    // finger on its glyph). The reverse, "the target is inside the real element",
    // is not: once the page has gone inert, elementFromPoint returns <body>,
    // which contains every button, and that let a misrouted click through.
    if (e.target === real || (e.target.contains && e.target.contains(real))) return null;
    return { real, rb };
  };
  const kill = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click']) {
    document.addEventListener(type, (e) => {
      if (bypass) return;
      const m = misrouted(e);
      if (!m) return;
      kill(e);
      if (type === 'pointerdown' || type === 'touchstart') {
        armed = m.rb;
        if (armed) { armed.classList.add('is-pressed'); }
        // The engine's pick still gets :active, so the wrong button would
        // shrink while the right one answers. Mark it so the stylesheet can
        // hold it still until the finger lifts.
        phantom = btnOf(e.target);
        if (phantom) phantom.classList.add('is-phantom');
        try { fieldReport && fieldReport('misroute', { type, tap: [Math.round(e.clientX ?? 0), Math.round(e.clientY ?? 0)], target: btnOf(e.target)?.id || e.target.id || e.target.className, under: m.rb ? m.rb.id : (m.real.id || m.real.className) }); } catch { /* telemetry only */ }
      } else if (type === 'pointerup' || type === 'touchend') {
        const b = armed; armed = null;
        if (phantom) { phantom.classList.remove('is-phantom'); phantom = null; }
        if (b) { b.classList.remove('is-pressed'); if (m.rb === b) { bypass = true; try { b.click(); } finally { bypass = false; } } }
      } else if (type === 'pointercancel' || type === 'touchcancel') {
        if (armed) armed.classList.remove('is-pressed');
        if (phantom) phantom.classList.remove('is-phantom');
        armed = null; phantom = null;
      }
      // a misrouted click is swallowed: the up already activated the right button
    }, true);
  }
})();

const shellParam = new URLSearchParams(location.search).get('shell');

// ---- field report -----------------------------------------------------------
// Development only: the page measures itself on the real device and posts the
// numbers to the dev server, because an emulator never reproduced what the
// phone showed. Fires on load, after every rotation, and whenever a tap lands
// within 60px of a top control but is not answered by that control.
const FIELD_ON = /^(bluehid\.gabrielbelli\.com|192\.168\.|localhost)/.test(location.host);
function fieldReport(why, extra = {}) {
  if (!FIELD_ON) return;
  try {
    const cs = getComputedStyle(document.documentElement);
    const ctl = {};
    for (const id of ['connect', 'nib-menu', 'nib-mode']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const who = (x, y) => { const h = document.elementFromPoint(x, y); const b = h && h.closest('button'); return b ? b.id : (h ? (h.id || h.className || h.tagName) : null); };
      // Centre, then 2px inside each corner of the box: a round button hit-tests
      // as a disc, and this is where a finger 4px from the corner ends up.
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]].map(([x, y]) => who(x, y));
      ctl[id] = { r: [r.left, r.top, r.width, r.height].map(Math.round), hit: hits[0], corners: hits.slice(1),
        op: getComputedStyle(el).opacity, vis: getComputedStyle(el).visibility };
    }
    const vv = window.visualViewport;
    const rep = {
      t: Date.now(), why, ua: navigator.userAgent, url: location.href,
      // true under Playwright and every other automation: the server keeps those
      // reports out of the field log, so a real phone can never be mistaken for one.
      wd: navigator.webdriver === true,
      win: [innerWidth, innerHeight], out: [outerWidth, outerHeight], dpr: devicePixelRatio,
      vv: vv ? [vv.width, vv.height, vv.offsetLeft, vv.offsetTop, vv.pageLeft, vv.pageTop, vv.scale].map((n) => Math.round(n * 100) / 100) : null,
      scroll: [scrollX, scrollY], orient: (screen.orientation && screen.orientation.type) || window.orientation,
      safe: ['t', 'r', 'b', 'l'].map((k) => cs.getPropertyValue('--safe-' + k).trim()),
      chromeT: cs.getPropertyValue('--chrome-t').trim(), p: document.documentElement.style.getPropertyValue('--p'),
      drawer: document.body.dataset.drawer, mode: document.body.dataset.mode, shell: document.body.dataset.shell,
      stage: (() => { const r = document.getElementById('nib-stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })(),
      chrome: (() => { const r = document.getElementById('nib-chrome').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })(),
      dvh: CSS.supports('height', '100dvh'), ctl,
      // Which copy of the code this is, and the numbers that tell a WKWebView
      // whose layout size lags the screen apart from one that agrees with it.
      ver: ((document.querySelector('meta[name="nib-v"]') || {}).content || '').replace(/^\?v=/, ''),
      doc: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      screen: [screen.width, screen.height], standalone: !!navigator.standalone,
      // The head script's self-updater: did it run on this device, what did it
      // see, what did it do. Plus the two flags that gate every one of its checks.
      upd: window.__nibUpd || null, hidden: document.hidden, focus: document.hasFocus(),
      ...extra,
    };
    const blob = new Blob([JSON.stringify(rep)], { type: 'application/json' });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/probe', blob))) {
      fetch('/probe', { method: 'POST', body: JSON.stringify(rep), keepalive: true }).catch(() => {});
    }
  } catch { /* never let telemetry break the app */ }
}
setTimeout(() => fieldReport('load'), 1200);
window.addEventListener('orientationchange', () => setTimeout(() => fieldReport('rotate'), 1000));
window.addEventListener('resize', () => { clearTimeout(fieldReport._t); fieldReport._t = setTimeout(() => fieldReport('resize'), 900); });
const describe = (n) => (n ? (n.id || n.className || n.tagName) : null);
// The control a tap was meant for: the one whose box contains the point, else
// the nearest within 60px. Checking containment first is what stops a clean
// tap on the keyboard button being logged as a miss on its neighbour.
function expectedControl(x, y) {
  let best = null, bestD = 61;
  for (const id of ['connect', 'nib-menu', 'nib-mode']) {
    const el = document.getElementById(id); if (!el) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    const d = Math.max(r.left - x, x - r.right, r.top - y, y - r.bottom);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}
document.addEventListener('pointerdown', (e) => {
  const id = expectedControl(e.clientX, e.clientY);
  if (!id) return;
  const target = e.target && e.target.closest ? e.target.closest('button') : null;
  if (target && target.id === id) return;
  // `efp` is what the DOM says is at the tapped point right now. If it names the
  // control but the event's target does not, the engine dispatched the touch to
  // an element at some OTHER point: the WKWebView touch-misdirect signature.
  const efp = document.elementFromPoint(e.clientX, e.clientY);
  fieldReport('miss', { tap: [Math.round(e.clientX), Math.round(e.clientY)], expected: id,
    got: describe(e.target), efp: describe(efp && efp.closest ? (efp.closest('button') || efp) : efp),
    ptype: e.pointerType, page: [Math.round(e.pageX), Math.round(e.pageY)] });
}, true);
// The raw touch, before pointer events are synthesised from it. Reported only
// when the target the engine chose is not the element under the finger and one
// of the two is a top control, so a phone that hits the iOS 18.5 misdirect bug
// (FB19543269) says so in its own words: both points, both elements.
let lastTouchReport = 0;
document.addEventListener('touchstart', (e) => {
  const t = e.changedTouches && e.changedTouches[0]; if (!t) return;
  const under = document.elementFromPoint(t.clientX, t.clientY);
  const tb = e.target && e.target.closest ? e.target.closest('button') : null;
  const ub = under && under.closest ? under.closest('button') : null;
  const ids = ['connect', 'nib-menu', 'nib-mode'];
  const involved = (tb && ids.includes(tb.id)) || (ub && ids.includes(ub.id)) || expectedControl(t.clientX, t.clientY);
  if (!involved || (tb || e.target) === (ub || under)) return;
  if (performance.now() - lastTouchReport < 1500) return;
  lastTouchReport = performance.now();
  const tt = e.targetTouches && e.targetTouches[0];
  fieldReport('misdirect', { touch: [Math.round(t.clientX), Math.round(t.clientY)], touchPage: [Math.round(t.pageX), Math.round(t.pageY)],
    targetTouch: tt ? [Math.round(tt.clientX), Math.round(tt.clientY)] : null,
    target: describe(tb || e.target), under: describe(ub || under) });
}, { capture: true, passive: true });
// ?probe=1 writes the measured hit rectangle of every floating control into a
// data attribute, so a render can be compared against where taps actually land.
if (new URLSearchParams(location.search).get('probe') === '1') {
  // Draws each control's MEASURED hit rectangle as a red box, on screen, plus
  // the numbers. A screenshot then shows the icon and its hit box together;
  // if they do not coincide, the offset is visible instead of argued about.
  const draw = () => {
    document.querySelectorAll('.probe-box').forEach((n) => n.remove());
    const lines = [];
    for (const id of ['connect', 'nib-menu', 'nib-mode']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'probe-box';
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`
        + 'border:2px solid #ff2d2d;pointer-events:none;z-index:9999;box-sizing:border-box';
      document.body.append(box);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      lines.push(`${id} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} -> ${hit ? (hit.id || hit.className || hit.tagName) : 'null'}`);
    }
    const vv = window.visualViewport;
    lines.push(`win ${window.innerWidth}x${window.innerHeight} vv ${vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) + ' @' + Math.round(vv.offsetLeft) + ',' + Math.round(vv.offsetTop) + ' scale ' + vv.scale.toFixed(2) : 'n/a'}`);
    lines.push(`safe ${getComputedStyle(document.documentElement).getPropertyValue('--safe-l').trim()} / ${getComputedStyle(document.documentElement).getPropertyValue('--safe-r').trim()}`);
    const txt = document.createElement('pre');
    txt.className = 'probe-box';
    txt.style.cssText = 'position:fixed;left:8px;bottom:8px;margin:0;padding:6px 8px;background:#000;color:#ff2d2d;'
      + 'font:11px/1.3 ui-monospace,monospace;z-index:9999;pointer-events:none;border:1px solid #ff2d2d';
    txt.textContent = lines.join('\n');
    document.body.append(txt);
    document.body.dataset.probe = JSON.stringify(lines);
  };
  setTimeout(draw, 900);
  window.addEventListener('resize', () => setTimeout(draw, 400));
  window.addEventListener('orientationchange', () => setTimeout(draw, 800));
}
// ?menu=open opens the sheet on load, so its resting state can be rendered and
// inspected without a click.
if (new URLSearchParams(location.search).get('menu') === 'open') {
  requestAnimationFrame(() => { try { openDrawer(); } catch { /* not ready */ } });
}
let shellPref = SHELLS.includes(shellParam) ? shellParam : store.get('nib.shell', 'auto');
if (!SHELLS.includes(shellPref)) shellPref = 'auto';

const resolveShell = () =>
  (shellPref === 'auto' ? (shellMq?.matches ? 'desktop' : 'phone') : shellPref);

function paintShellSeg() {
  for (const b of shellSeg.querySelectorAll('button')) {
    const on = b.dataset.shell === shellPref;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function applyShell() {
  const next = resolveShell();
  const changed = body.dataset.shell !== next;
  body.dataset.shell = next;
  paintShellSeg();
  if (changed) {
    // The pad's box just changed size, so every cached rectangle is stale.
    invalidatePadRect();
    onViewport();
    arrangeForShell();
    paintCapCard();
  }
}

shellSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-shell]');
  if (!b) return;
  shellPref = SHELLS.includes(b.dataset.shell) ? b.dataset.shell : 'auto';
  store.set('nib.shell', shellPref);
  applyShell();
  log(`layout: ${resolveShell()}${shellPref === 'auto' ? ' (auto)' : ''}`);
});

// A window dragged between a laptop screen and a 4K monitor crosses this.
if (shellMq?.addEventListener) shellMq.addEventListener('change', applyShell);
else shellMq?.addListener?.(applyShell);

// The gesture list is the coach, permanently: pad.js's on-pad hints stop after
// three sessions, and after that this is where "three fingers" is written down.
const gestureBox = $('#pad-gestures');
const gestureRows = [];
for (const g of GESTURES) {
  const seen = gestureRows.find((r) => r.action === g.action);
  if (seen) { seen.help += ', or ' + g.help; continue; }
  gestureRows.push({ action: g.action, help: g.help });
}
for (const g of gestureRows) {
  const row = document.createElement('div');
  row.className = 'nib-gesture';
  const what = document.createElement('span');
  what.className = 'nib-gesture-do';
  what.textContent = g.action;
  const help = document.createElement('span');
  help.className = 'nib-gesture-help';
  help.textContent = g.help;
  row.append(what, help);
  gestureBox.append(row);
}

// ===========================================================================
// the on-screen keyboard
// ===========================================================================

const keysShell = $('#stage-keys');
// The attribute goes, because fullscreen.js moves this element into its own
// stage and must not have to know about it. Visibility is the mode spring's job
// from here on, and it starts closed.
keysShell.hidden = false;
keysShell.style.visibility = 'hidden';

// No shipped preset emits TRACKPAD, RELEASE_ALL or CLOSE - the members exist so
// a host can inject its own chrome into a row - so none of this runs today. It is
// kept and made correct rather than deleted, because an unreachable handler that
// is also wrong is the trap: whoever adds the key would find CLOSE doing nothing
// outside full screen and RELEASE_ALL doing nothing inside it.
function onOskAction(name) {
  switch (name) {
    case OSK_ACTIONS.TRACKPAD:
      setMode('pad');
      break;
    case OSK_ACTIONS.RELEASE_ALL:
      // Never $('#panic').click(): #panic is inside the sheet, which
      // fullscreen.js marks inert, so the click would be swallowed.
      releaseEverything();
      break;
    case OSK_ACTIONS.CLOSE:
      // Outside full screen there is nothing to exit, and imm.exit() no-ops
      // silently. Leaving the keyboard is what the key means either way.
      if (imm?.open) imm.exit(); else setMode('pad');
      break;
    default: break;
  }
}

let preset = store.get('nib.osk.preset', OSK_DEFAULT_PRESET);
if (!OSK_METRICS[preset]) preset = OSK_DEFAULT_PRESET;

const kb = createKeyboard({
  mount: '#stage-keys',
  preset,
  onKeys: (keys) => { echo(keys); return ble.tap(keys); },
  onConsumer: (usage) => ble.consumer(usage),
  getLayout: () => layout,
  getMods: () => stickyMods | latchedMods,
  getLatched: () => latchedMods,
  takeMods,
  bindMod,
  onAction: onOskAction,
  log,
  isConnected: ble.isConnected,
  haptics: store.get('nib.osk.haptics', true),
});

// The remote-style layouts (TV remote, Slides, Media) are full-screen control
// surfaces, not key grids: they take over #stage-keys when picked.
const pads = createPads({
  mount: '#stage-keys',
  onKeys: (keys) => { echo(keys); return ble.tap(keys); },
  onConsumer: (usage) => ble.consumer(usage),
  onGamepad: (state) => ble.gamepad(state),
  haptics: store.get('nib.osk.haptics', true),
});
function applyPreset(id) {
  if (pads.show(id)) { kb.el.hidden = true; return; }
  pads.hide();
  kb.el.hidden = false;
  kb.setPreset(id);
}
applyPreset(preset);

// ---- the size picker, in the drawer rather than on the keyboard --------------

const presetBox = $('#osk-presets');
const presetNow = $('#osk-preset-now');

function paintPresets() {
  for (const b of document.querySelectorAll('#osk-presets .nib-preset, #osk-remotes .nib-preset')) {
    const on = b.dataset.preset === preset;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  presetNow.textContent = OSK_PRESET_LIST.find((p) => p.id === preset)?.label ?? preset;
}

for (const p of OSK_PRESET_LIST) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'nib-preset';
  b.dataset.preset = p.id;

  const label = document.createElement('span');
  label.className = 'nib-preset-label';
  label.textContent = p.label;

  const hint = document.createElement('span');
  hint.className = 'nib-preset-hint';
  hint.textContent = p.hint;

  const metric = document.createElement('span');
  metric.className = 'nib-preset-metric';
  metric.textContent = pads.has(p.id) ? 'full screen' : `${p.rows} rows · ${p.units}u`;

  b.append(label, hint, metric);
  b.addEventListener('click', () => {
    preset = p.id;
    store.set('nib.osk.preset', preset);
    applyPreset(preset);
    paintPresets();
    log(`keyboard: ${p.label}`);
  });
  // Full-screen pads and Nav are remotes, not keyboard sizes.
  (pads.has(p.id) || p.id === 'nav' ? $('#osk-remotes') : presetBox).append(b);
}
paintPresets();

const oskHaptics = $('#osk-haptics');
oskHaptics.checked = store.get('nib.osk.haptics', true);
oskHaptics.addEventListener('change', () => {
  store.set('nib.osk.haptics', oskHaptics.checked);
  kb.setHaptics(oskHaptics.checked);
  pads.setHaptics(oskHaptics.checked);
});

// ===========================================================================
// the sheet
// ===========================================================================
// One number is the state: x = 0 open, x = W closed, where W is the viewport
// width - the sheet is full-bleed, so there is no second width to drift out of
// step with the real one. The controller writes --p = 1 - x/W on #nib-drawer
// once per frame, and the stylesheet derives the transform and the stage's
// push-back from it. Dragged left past open, x goes negative and --p goes above
// 1, which is the rubber-band.
//
// Gone with the side pane: #nib-scrim (an invisible layer at z-index 50 that ate
// every tap for 360ms after each one), #nib-edge (a dead 24px column over the
// right of the pad and over the keyboard's Backspace/Enter/arrow keys), the
// edge-pull gesture, leadingEdge()'s `window.innerWidth - W` arithmetic, and
// with it the whole class of W-drift bugs.

const drawer = $('#nib-drawer');
const drawerBody = $('#nib-drawer-body');
const drawerGrab = $('#nib-drawer-grab');
const menuBtn = $('#nib-menu');
const stage = $('#nib-stage');
const chrome = $('#nib-chrome');
const capSectEl = $('#sect-capture');
// The footer that holds the About line and Reload: capture sits just above it on a phone.
const aboutEl = $('#nib-about').closest('.nib-about') || $('#nib-about');

drawer.tabIndex = -1;
drawerGrab.style.touchAction = 'none';

const fallbackW = () => document.documentElement.clientWidth || window.innerWidth || 1;
let W = fallbackW();
let x = W;
let drawerSpring = null;
// Where the LIVE spring is going. Never re-derived from W, because W is mutated
// by the resize path underneath a running spring: a closing spring whose `to`
// was 359 (portrait) failed `359 >= 420` (landscape), took the "open" branch,
// and marked the stage AND the chrome inert while the sheet was off-screen. The
// whole app went dead and could only be recovered by a reload, because the back
// gesture had already been given up.
let drawerTo = W;
let drawerFrame = null;
let dragging = null;

function paintDrawer() {
  drawerFrame = null;
  const p = (1 - x / W).toFixed(4);
  drawer.style.setProperty('--p', p);
  // The stage is a sibling of the sheet, not a child, so it can only read --p if
  // it reaches an ancestor of both. One write, once per frame.
  document.documentElement.style.setProperty('--p', p);
}

function writeX(v) {
  x = v;
  if (drawerFrame == null) drawerFrame = requestAnimationFrame(paintDrawer);
}

/**
 * Everything behind the sheet goes inert, except the burger.
 *
 * The burger's aria-expanded="true" and its burger-into-X transform both claim
 * it closes the sheet, and until now the close branch of its click handler was
 * unreachable dead code: it was inert AND under the scrim. Skipping it here
 * makes the claim true for the keyboard and for assistive tech. Whether it is
 * also visible over a full-bleed sheet is theme.css's call, not this file's.
 *
 * #nib-chrome is never inerted as a whole, because inert is inherited and a
 * descendant cannot opt back out of it. Its children are inerted one by one.
 */
function setInert(on) {
  try { stage.inert = on; } catch { /* old engine: aria-modal still holds */ }
  for (const el of Array.from(chrome.children)) {
    if (el === menuBtn) continue;
    try { el.inert = on; } catch { /* ignore */ }
  }
}

function reveal() {
  if (!drawer.hidden) return;
  drawer.hidden = false;
  W = drawer.offsetWidth || fallbackW();   // one forced layout, once per open
  x = W;
  paintDrawer();
}

function conceal() {
  drawer.hidden = true;
  setInert(false);
}

// The one place the sheet reaches a resting state. Closed means the CURRENT
// width and open means zero, never the width captured when a spring started:
// rotate during a close and that number is 462px stale.
function finishDrawer() {
  drawerSpring = null;
  clearTimeout(drawerWatchdog);
  x = drawerTo > 0 ? W : 0;
  paintDrawer();
  if (drawerTo > 0) {
    body.dataset.drawer = 'closed';
    const hadFocus = drawer.contains(document.activeElement);
    conceal();
    if (hadFocus) menuBtn.focus?.({ preventScroll: true });
  } else {
    body.dataset.drawer = 'open';
    setInert(true);
  }
}

let drawerWatchdog = null;

function springDrawer(to, velocity = 0, bounce = 0) {
  drawerSpring?.cancel();
  drawerTo = to;
  // Already there: finish now. A spring from x to x never produced a frame
  // and left data-drawer at "drag" for good - a tap on the open sheet's
  // handle was enough to do it.
  if (Math.abs(x - to) < 0.5) { finishDrawer(); return; }
  // Whatever cancels or stalls this spring, the sheet must still land.
  clearTimeout(drawerWatchdog);
  drawerWatchdog = setTimeout(() => { if (!dragging) reconcileDrawer(); }, 1200);
  drawerSpring = spring({
    from: x, to, velocity, bounce, duration: 0.36,
    onframe: writeX,
    ondone: () => {
      finishDrawer();
    },
  });
}

function openDrawer() {
  reveal();
  menuBtn.setAttribute('aria-expanded', 'true');
  body.dataset.drawer = 'drag';
  takeHistory('sheet');
  // Immediately, not in ondone: for the 360ms the sheet is arriving, Tab could
  // otherwise walk straight into the page behind it.
  setInert(true);
  drawer.focus?.({ preventScroll: true });
  springDrawer(0, 0, 0);
}

function closeDrawer({ fromHistory = false, keepHistory = false, velocity = 0, bounce = 0 } = {}) {
  if (drawer.hidden) return;
  menuBtn.setAttribute('aria-expanded', 'false');
  body.dataset.drawer = 'drag';
  // Released here rather than in ondone, so the sheet can never hold the page
  // hostage while it animates out.
  setInert(false);
  if (!fromHistory && !keepHistory) releaseHistory('sheet');
  springDrawer(W, velocity, bounce);
}

const drawerOpen = () => !drawer.hidden && (drawerSpring ? drawerTo === 0 : x < W / 2);

// ---- one history lease, for the sheet AND full screen ------------------------
// Two owners pushing their own entries raced: fireLong() called closeDrawer(),
// which calls history.back() - asynchronous - and then synchronously entered
// full screen, which pushed its own entry. The pending back() landed on THAT
// entry, closing full screen the instant it opened and orphaning one, so the
// next back gesture left the app entirely. One entry, one owner, transferred
// between owners rather than popped and re-pushed.

let historyOwner = null;        // null | 'sheet' | 'immersive'

function takeHistory(owner) {
  if (historyOwner === owner) return;
  if (historyOwner) { historyOwner = owner; return; }     // transfer, no push
  try {
    history.pushState({ nibOverlay: owner }, '');
    historyOwner = owner;
  } catch { historyOwner = null; }
}

function releaseHistory(owner) {
  if (historyOwner !== owner) return;
  historyOwner = null;
  try { history.back(); } catch { /* ignore */ }
}

window.addEventListener('popstate', () => {
  // A popstate carries the state of the entry being returned TO, never the one
  // that was pushed, so there is no tag to read back: owning the lease IS the
  // tag. Not ours means the user really is leaving the page.
  const owner = historyOwner;
  if (!owner) return;
  historyOwner = null;
  if (owner === 'sheet') closeDrawer({ fromHistory: true });
  else imm?.exit();
});

// ---- taps -------------------------------------------------------------------

// Press feedback is CSS (:active on .nib-icon and .btn), not an inline
// transform written on pointerdown: that one was cleared only by a pointerup,
// pointercancel or pointerleave delivered to the button itself, and a rotation,
// a URL-bar reveal or a system gesture on iOS can swallow all three, after
// which the burger stayed at scale(0.94) - 41px, under the 44px minimum - for
// the rest of the session.

menuBtn.addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()));
$('#nib-drawer-close').addEventListener('click', () => closeDrawer());
$('#nib-done').addEventListener('click', () => closeDrawer());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen()) { e.preventDefault(); closeDrawer(); }
});

// ---- the soft keyboard ------------------------------------------------------
// There was no handling of it anywhere. body.nib is position:fixed;inset:0, so a
// browser answers a focus near the bottom by offsetting the VISUAL viewport -
// fixed layers do not follow, and on iOS the offset can outlive the keyboard.
// That is literally "paints in one place, hit-tests in another".

drawerBody.addEventListener('focusin', (e) => {
  const field = e.target;
  if (!field?.scrollIntoView) return;
  // After the viewport has actually settled, not during the focus event.
  requestAnimationFrame(() => {
    try { field.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  });
});

drawerBody.addEventListener('focusout', () => {
  // Clamps the leftover iOS visual-viewport offset that otherwise persists after
  // the keyboard closes.
  requestAnimationFrame(() => { try { window.scrollTo(0, 0); } catch { /* ignore */ } });
});

// ---- dragging ---------------------------------------------------------------
// Hysteresis of 10px before committing, so a tap on the handle still counts as a
// tap. The grab offset is respected, so the sheet stays glued exactly where it
// was taken hold of.

const HYSTERESIS = 10;

function beginDrag(e, kind) {
  if (dragging) return;

  // A pointerdown during the spring catches it mid-flight: seed from the live
  // value so nothing jumps, and REMEMBER what it was going to do, so a press
  // that turns out not to be a drag can resume it instead of guessing.
  let interrupted = null;
  if (drawerSpring) {
    x = drawerSpring.value;
    interrupted = drawerTo;
    drawerSpring.cancel();
    drawerSpring = null;
    paintDrawer();
  }

  dragging = {
    kind,
    id: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    grab: e.clientX + x,
    interrupted,
    live: false,
    t: performance.now(),
    lastX: e.clientX,
    v: 0,
  };
}

function moveDrag(e) {
  if (!dragging || e.pointerId !== dragging.id) return;
  const dx = e.clientX - dragging.startX;
  const dy = e.clientY - dragging.startY;

  if (!dragging.live) {
    // A vertical intent belongs to the sheet's own scrolling, not to us.
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > HYSTERESIS) {
      const d = dragging;
      dragging = null;
      // Handing the gesture back to the scroller must still re-settle whatever
      // spring the pointerdown cancelled, or the sheet stays frozen mid-flight.
      if (d.interrupted != null) settleTo(d.interrupted);
      return;
    }
    if (Math.abs(dx) < HYSTERESIS) return;
    dragging.live = true;
    reveal();
    body.dataset.drawer = 'drag';
    try { e.target.setPointerCapture(dragging.id); } catch { /* ignore */ }
  }

  const now = performance.now();
  const dt = Math.max(1, now - dragging.t);
  dragging.v = ((dragging.lastX - e.clientX) / dt) * 1000;
  dragging.t = now;
  dragging.lastX = e.clientX;

  let next = dragging.grab - e.clientX;
  if (next < 0) next = -rubberband(-next, W);       // past open: resist, never stop
  if (next > W) next = W + rubberband(next - W, W);
  writeX(next);
}

function endDrag(e) {
  if (!dragging || (e && e.pointerId !== dragging.id)) return;
  const d = dragging;
  dragging = null;

  // A press that never became a drag still cancelled the running spring, and
  // motion.js's cancel() deliberately does not call ondone. Returning here left
  // data-drawer stuck at "drag", --p frozen around 0.4, the stage at
  // scale(0.99), and conceal() never run - the frozen layout the user hit.
  if (!d.live) {
    const to = d.interrupted != null ? d.interrupted : (x < W / 2 ? 0 : W);
    const frozen = body.dataset.drawer === 'drag';
    if (!drawerSpring && (frozen || Math.abs(x - to) > 0.5)) settleTo(to);
    return;
  }

  // The target comes from where the flick is GOING, not from where the finger
  // let go, so a small throw commits the whole way.
  const end = x + project(d.v);
  settleTo(end < W / 2 ? 0 : W, d.v, Math.abs(d.v) > 80 ? 0.12 : 0);
}

/** Spring to an end state and make the aria and the history entry agree with it. */
function settleTo(to, velocity = 0, bounce = 0) {
  if (to === 0) {
    menuBtn.setAttribute('aria-expanded', 'true');
    takeHistory('sheet');
  } else {
    menuBtn.setAttribute('aria-expanded', 'false');
    releaseHistory('sheet');
  }
  springDrawer(to, velocity, bounce);
}

function dragSource(el, kind, guard) {
  el.addEventListener('pointerdown', (e) => {
    if (guard && !guard(e)) return;
    beginDrag(e, kind);
  });
  el.addEventListener('pointermove', moveDrag);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('lostpointercapture', endDrag);
}

dragSource(drawerGrab, 'pane');

// The body drags too, but only from the top of its scroll, or a scroll gesture
// would fight the sheet — and never from a control that owns horizontal drag
// of its own, which is what would otherwise make the two sliders unusable.
const OWNS_DRAG = 'input,select,textarea,button,a,summary,.snip';
dragSource(drawerBody, 'pane', (e) => drawerBody.scrollTop <= 0 && !e.target.closest(OWNS_DRAG));

// Scroll edge effect instead of a 1px divider under the sticky header.
drawerBody.addEventListener('scroll', () => {
  drawer.classList.toggle('is-scrolled', drawerBody.scrollTop > 0);
}, { passive: true });

/**
 * On a desktop, forwarding the real mouse and keyboard beats dragging a real
 * pointer across a simulated pad, so Capture leads. On a phone it is last,
 * because it can never fire there at all.
 */
function arrangeForShell() {
  if (capSectEl.hidden) return;
  if (body.dataset.shell === 'desktop') {
    if (drawerBody.firstElementChild !== capSectEl) drawerBody.prepend(capSectEl);
    capSectEl.open = true;
  } else {
    if (capSectEl.nextElementSibling !== aboutEl) drawerBody.insertBefore(capSectEl, aboutEl);
  }
}

// ===========================================================================
// the one viewport re-measure
// ===========================================================================
// This is the missing piece behind every "rotating the screen breaks the
// buttons" report. There used to be a single `resize` handler that early-
// returned unless the drawer's width changed, so a rotation that kept it the
// same left every other measurement stale.
//
// The read is deferred through one requestAnimationFrame because iOS Safari
// reports pre-rotation metrics inside the resize handler itself.

let viewportFrame = null;

// --safe-b and friends are env() expressions, and getComputedStyle() hands back
// a custom property's UNRESOLVED token stream - parseFloat('env(...)') is NaN.
// A probe element makes the browser resolve them for us.
const travelProbe = document.createElement('div');
travelProbe.setAttribute('aria-hidden', 'true');
travelProbe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;'
  + 'visibility:hidden;pointer-events:none;'
  + 'height:calc(var(--safe-b, 0px) + var(--gutter, 16px)'
  + ' + var(--tap-mode, 56px) + var(--chrome-t, 12px))';
document.body.append(travelProbe);

/**
 * How far down the mode button travels in pad mode, as one measured number.
 *
 * It used to be `calc(100dvh - --safe-b - --gutter - --tap-mode - --chrome-t)`
 * applied inside a `position:fixed; inset:0` layer. The fixed box resolves
 * against the LAYOUT viewport and dvh against the DYNAMIC one; they differ by
 * the URL bar's height, they differ by a different amount in each orientation,
 * and --chrome-t is itself redefined by the (max-height: 560px) query that flips
 * exactly on rotation. A measured number absorbs all four.
 */
function writeModeTravel() {
  const h = chrome.clientHeight || window.innerHeight || 0;
  const inset = travelProbe.getBoundingClientRect().height;
  // The button lives in the top row now, so there is nothing to travel past.
  // Kept writing the variable because the ring and the sheet still read it.
  const travel = 0;
  document.documentElement.style.setProperty('--mode-travel', `${travel.toFixed(1)}px`);
}

/** The keyboard's entrance origin is px, so it goes stale on every rotation. */
function clearKeysOrigin() {
  keysShell.style.transformOrigin = '';
  keysShell.style.removeProperty('--origin-x');
  keysShell.style.removeProperty('--origin-y');
}

// A hosting app that keeps its web view out of the notch still hands the page
// the notch as env(safe-area-inset-*). Bluefy in landscape: the view is 734px
// wide on an 852px screen, and env() says 59px left and right anyway. Honouring
// both puts the controls 59px to the right of where they belong. When the window
// is already narrower than the screen by at least the two insets, the host has
// done the job: zero ours and drop viewport-fit=cover, the thing that asked for
// insets in the first place. Sticky, because the host does not change mid-run.
let hostInsetOn = false;
function hostInset(root) {
  if (hostInsetOn) return;
  const cs = getComputedStyle(root);
  const px = (k) => parseFloat(cs.getPropertyValue('--safe-' + k)) || 0;
  const l = px('l'), r = px('r');
  const deficit = (window.outerWidth || 0) - window.innerWidth;
  if (!(l + r > 0 && deficit >= l + r - 2)) return;
  hostInsetOn = true;
  root.style.setProperty('--safe-l', '0px');
  root.style.setProperty('--safe-r', '0px');
  root.dataset.hostInset = '1';
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.content = meta.content.replace(/,?\s*viewport-fit=cover/, '');
  try { fieldReport && fieldReport('hostinset', { l, r, deficit }); } catch { /* telemetry only */ }
}

function measureViewport() {
  viewportFrame = null;
  const root = document.documentElement;
  const vv = window.visualViewport;

  // The two numbers that make a fixed sheet agree with the soft keyboard on the
  // engines that ignore interactive-widget= (iOS).
  const vh = vv?.height || window.innerHeight || 0;
  if (vh) root.style.setProperty('--vvh', `${Math.round(vh)}px`);
  root.style.setProperty('--vvtop', `${Math.round(vv?.offsetTop || 0)}px`);

  // Landscape moves the horizontal pair too. A notch takes a bite out of one
  // side, and the visual viewport can be both narrower than the layout one and
  // offset from it. Writing only the vertical pair left every fixed layer
  // painting at layout coordinates and hit-testing somewhere else.
  const vw = vv?.width || window.innerWidth || 0;
  if (vw) root.style.setProperty('--vvw', `${Math.round(vw)}px`);
  root.style.setProperty('--vvleft', `${Math.round(vv?.offsetLeft || 0)}px`);

  hostInset(root);

  writeModeTravel();
  clearKeysOrigin();
  invalidatePadRect();

  // ---- the sheet's own geometry ----------------------------------------
  // No `next === W` early return: everything above has to run on every signal.
  const next = drawer.hidden ? fallbackW() : (drawer.offsetWidth || fallbackW());
  if (next) {
    const p = W ? 1 - x / W : 0;
    W = next;
    x = (1 - p) * W;
    if (drawerSpring) {
      const t = drawerTo > 0 ? W : 0;
      drawerSpring.retarget(t);
      drawerTo = t;
    }
    paintDrawer();
  }

  // ---- self-heal --------------------------------------------------------
  // Whatever went wrong, a rotation is the moment to notice and recover, because
  // the alternative is a reload.
  const state = body.dataset.drawer;
  if (state === 'open' && drawer.hidden) {
    body.dataset.drawer = 'closed';
    menuBtn.setAttribute('aria-expanded', 'false');
    x = W;
    paintDrawer();
    conceal();
  } else if (state === 'open' && !drawerSpring && !dragging && 1 - x / W < 0.5) {
    springDrawer(0);
  } else if (state === 'drag' && !drawerSpring && !dragging) {
    settleTo(x < W / 2 ? 0 : W);
  }
}

function onViewport() {
  if (viewportFrame != null) return;
  viewportFrame = requestAnimationFrame(measureViewport);
}

// Five signals, because no one of them fires for every case: `resize` misses an
// iOS soft keyboard, `orientationchange` fires before the metrics settle,
// visualViewport catches the keyboard and the URL bar, and the ResizeObserver
// catches a desktop window drag and anything that resizes the root without a
// window event at all.
// A rotation needs more than one look. iOS reports the pre-rotation box
// synchronously and for a frame or two afterwards, and because onViewport
// coalesces into a single rAF, the stale reading wins and every later signal
// inside that frame is swallowed. So a rotation forces a re-measure again once
// the metrics have settled, which is what makes landscape hit boxes agree with
// what is on screen.
function remeasureNow() {
  if (viewportFrame != null) {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = null;
  }
  measureViewport();
  reconcileDrawer();
}

// The sheet has exactly two resting states, and --p must agree with whichever
// one data-drawer names. A rotation during the closing spring left data-drawer
// at "closed" with --p frozen at 0.54: the stage stayed scaled, and the chrome,
// whose opacity is derived from --p, painted the icons at 14%. Whenever nothing
// is animating or dragging, snap the numbers to the named state.
function reconcileDrawer() {
  if (dragging) return;
  if (drawerSpring) { drawerSpring.cancel(); drawerSpring = null; finishDrawer(); return; }
  const state = body.dataset.drawer;
  if (state === 'closed' && x !== W) { x = W; paintDrawer(); if (!drawer.hidden) conceal(); }
  else if (state === 'open' && x !== 0) { x = 0; paintDrawer(); }
  else if (state === 'drag') { settleTo(x < W / 2 ? 0 : W); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(reconcileDrawer, 50); });

function onRotate() {
  onViewport();
  for (const delay of [120, 350, 700]) setTimeout(remeasureNow, delay);
}

window.addEventListener('resize', onViewport);
window.addEventListener('orientationchange', onRotate);
// The modern event, which fires on engines where the legacy one does not.
try { screen.orientation?.addEventListener('change', onRotate); } catch { /* ignore */ }
window.visualViewport?.addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('scroll', onViewport);
try {
  new ResizeObserver(onViewport).observe(document.documentElement);
} catch { /* no ResizeObserver: the four window signals still cover most of it */ }

paintDrawer();
measureViewport();

// ===========================================================================
// the mode switch — one control, two gestures, identical in both views
// ===========================================================================

const modeBtn = $('#nib-mode');
const ring = $('#nib-mode-ring');
const HOLD_MS = 600;
const HOLD_SLOP = 24;

let mode = 'pad';
let modeSpring = null;
let modeAt = 0;          // 0 = pad, 100 = keys

// Declared here, assigned far below. setMode() reads `imm?.open`, and optional
// chaining does NOT protect against the temporal dead zone: with `const imm`
// declared after this point, any setMode() before that line threw a
// ReferenceError. Nothing reached it before; the desktop shell might.
let imm = null;

function paintStage(v) {
  modeAt = v;
  const t = Math.max(0, Math.min(1, v / 100));

  // The keyboard materialises: blur radius and scale animate together, from
  // the button that opened it.
  keysShell.style.visibility = t < 0.002 ? 'hidden' : 'visible';
  keysShell.style.opacity = String(Math.max(0.001, t));
  keysShell.style.transform = `scale(${(0.96 + 0.04 * t).toFixed(4)}) translateY(${((1 - t) * 8).toFixed(2)}px)`;
  keysShell.style.filter = t > 0.995 ? 'none' : `blur(${((1 - t) * 6).toFixed(2)}px)`;
  // 0.98, not 0.5: at the halfway frame the keys are still blurred, scaled and
  // mid-jump, so a thumb already down would hit a key that is about to move.
  keysShell.style.pointerEvents = t > 0.98 ? 'auto' : 'none';

  // The pad crosses on opacity and 1.5% of scale only. No blur: animating a
  // backdrop-sized blur on a phone drops frames, and the two cross anyway so
  // the stage never flashes black.
  padEl.style.opacity = String(1 - t);
  padEl.style.transform = `scale(${(1 - 0.015 * t).toFixed(4)})`;
  // A thumb resting above the keys must never move the host pointer - and nor
  // must an arrow key, so the pad leaves the tab order with it.
  padEl.style.pointerEvents = t > 0.02 ? 'none' : 'auto';
  padEl.tabIndex = t > 0.02 ? -1 : 0;

  // Driven, never un-hidden. Toggling `hidden` grew grid row 2 from 0 to ~26px
  // on one frame, which yanked row 3 - the keyboard - 26px upward under the
  // thumb, mid-animation. theme.css reserves the box unconditionally instead.
  echoEl.style.opacity = String(t);
  echoEl.style.visibility = t < 0.002 ? 'hidden' : 'visible';
}

/**
 * Measure the keyboard's entrance origin against the KEYBOARD, not the stage.
 *
 * --origin-x/y are applied as a transform-origin on #stage-keys, which resolves
 * against its own ~200-260px border box; measuring them from the top of a
 * full-height stage put the origin roughly 550px outside it on an 844px phone,
 * so the "scales out of the button you pressed" effect never happened at all.
 * Both rects are read BEFORE data-mode flips, because the button is mid-translate
 * transition afterwards.
 */
function writeKeysOrigin() {
  const r = modeBtn.getBoundingClientRect();
  const k = keysShell.getBoundingClientRect();
  if (!k.width || !k.height) return;
  const ox = Math.max(0, Math.min(k.width, r.left + r.width / 2 - k.left));
  const oy = Math.max(0, Math.min(k.height, r.top + r.height / 2 - k.top));
  keysShell.style.setProperty('--origin-x', `${ox.toFixed(1)}px`);
  keysShell.style.setProperty('--origin-y', `${oy.toFixed(1)}px`);
  keysShell.style.transformOrigin = 'var(--origin-x) var(--origin-y)';
}

function setMode(next, { animate = true } = {}) {
  const want = next === 'keys' ? 'keys' : 'pad';
  if (imm?.open) { imm.show(want); return; }

  // Measured first, while the button is still where it looks.
  if (want === 'keys') writeKeysOrigin();

  mode = want;
  body.dataset.mode = mode;
  modeBtn.setAttribute('aria-label', mode === 'pad'
    ? 'Show the on-screen keyboard'
    : 'Show the trackpad');

  if (mode === 'keys') {
    trackpad.release();                       // no button may survive the swap
  } else {
    echoText = '';
    echoEl.textContent = '';
  }

  const to = mode === 'keys' ? 100 : 0;
  if (!animate || prefersReducedMotion()) {
    modeSpring?.cancel();
    modeSpring = null;
    paintStage(to);
    return;
  }
  // Re-targeting the SAME spring is what lets the keyboard be caught halfway
  // and sent back without a jump or a velocity brick wall.
  if (modeSpring) { modeSpring.revive().retarget(to); return; }
  modeSpring = spring({
    from: modeAt, to, bounce: 0, duration: 0.34,
    onframe: paintStage,
    ondone: () => { modeSpring = null; paintStage(to); },
  });
}

// ---- the two gestures -------------------------------------------------------

let holdRaf = null;
let holdFrom = 0;
let longFired = false;
let pressAt = null;

function paintRing(p) {
  ring.style.setProperty('--p', p.toFixed(1));
  ring.classList.toggle('is-on', p > 0.5);
}

function holdStop({ unwind = true } = {}) {
  if (holdRaf != null) cancelAnimationFrame(holdRaf);
  holdRaf = null;
  if (!unwind) { paintRing(0); return; }
  // Unwind rather than snap: a ring that vanishes reads as a glitch.
  const from = Number(ring.style.getPropertyValue('--p')) || 0;
  if (from < 1) { paintRing(0); return; }
  const t0 = performance.now();
  const back = (now) => {
    const k = Math.min(1, (now - t0) / 140);
    paintRing(from * (1 - k));
    if (k < 1) holdRaf = requestAnimationFrame(back); else holdRaf = null;
  };
  holdRaf = requestAnimationFrame(back);
}

function holdStart() {
  // Full screen is gone, so the hold does nothing. Kept as a no-op rather than
  // unpicking every caller, and the ring never fills because it never starts.
  if (true) return;
  longFired = false;
  holdFrom = performance.now();
  if (prefersReducedMotion()) {
    // The threshold is intent, not decoration, so 600ms stays. Only the
    // per-frame animation goes.
    holdRaf = setTimeout(() => { holdRaf = null; paintRing(100); fireLong(); }, HOLD_MS);
    return;
  }
  const step = (now) => {
    const p = Math.min(100, ((now - holdFrom) / HOLD_MS) * 100);
    paintRing(p);
    if (p >= 100) { holdRaf = null; fireLong(); return; }
    holdRaf = requestAnimationFrame(step);
  };
  holdRaf = requestAnimationFrame(step);
}

function fireLong() {
  longFired = true;
  // Visual, haptic and action on the same frame, or the illusion breaks.
  haptic(12);
  paintRing(100);
  // keepHistory, and then let full screen take the SAME lease over: the old
  // code's history.back() was still in flight when imm.enter() pushed its own
  // entry, so the pop landed on the entry full screen had just created and shut
  // it again a frame after it opened.
  if (drawerOpen()) closeDrawer({ keepHistory: true });
  imm?.enter(mode === 'keys' ? 'keys' : 'pad');
  setTimeout(() => paintRing(0), 180);
}

/** The tap half of the control: swap the panel. */
function modeTap() { setMode(mode === 'pad' ? 'keys' : 'pad'); }

let modePointerAt = -Infinity;

modeBtn.addEventListener('pointerdown', (e) => {
  modePointerAt = performance.now();
  // A mouse press must keep its focus and its click; only a touch needs the
  // default suppressed, and swallowing it unconditionally is part of why
  // keyboard and AT activation never reached this button.
  if (e.pointerType !== 'mouse') e.preventDefault();
  pressAt = { x: e.clientX, y: e.clientY, t: modePointerAt };
  modeBtn.style.transform = 'scale(0.92)';
  try { modeBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  holdStart();
});

for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  modeBtn.addEventListener(ev, () => { modePointerAt = performance.now(); }, true);
}

// VoiceOver's double-tap, TalkBack's activation and Tab+Enter all dispatch a
// click and nothing else, so without this the mode button could not be reached
// at all by any of them.
modeBtn.addEventListener('click', (e) => {
  e.preventDefault();
  // Age is measured from the pointer's RELEASE, not its press. Measuring from
  // the press made every hold longer than SYNTHETIC_AFTER look like assistive
  // technology, so hold-to-fullscreen also swapped the mode on the way out.
  if (performance.now() - modePointerAt > SYNTHETIC_AFTER) modeTap();
});

// The hold gesture has no keyboard equivalent, so give it one and say so in the
// label, which setMode() keeps in step.


modeBtn.addEventListener('pointermove', (e) => {
  if (!pressAt || longFired) return;
  if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > HOLD_SLOP) {
    pressAt = null;
    if (prefersReducedMotion()) { clearTimeout(holdRaf); holdRaf = null; paintRing(0); }
    else holdStop();
    modeBtn.style.transform = '';
  }
});

function modeRelease() {
  modeBtn.style.transform = '';
  if (prefersReducedMotion() && holdRaf != null) { clearTimeout(holdRaf); holdRaf = null; }
  else holdStop();
  const press = pressAt;
  pressAt = null;
  // The long press already did something; the release must not also swap.
  if (longFired) { longFired = false; return; }
  if (!press) return;
  if (performance.now() - press.t >= HOLD_MS) return;
  modeTap();
}

modeBtn.addEventListener('pointerup', modeRelease);
// The press scale is inline because the hold gesture clears it on slop, so it
// must also be cleared by whatever ends a press WITHOUT a pointerup reaching
// this button: capture lost (rotation, system gesture), the page losing focus
// or going to the background, or the viewport turning.
const modeUnpress = () => { modeBtn.style.transform = ''; };
modeBtn.addEventListener('lostpointercapture', modeUnpress);
window.addEventListener('blur', modeUnpress);
window.addEventListener('orientationchange', modeUnpress);
document.addEventListener('visibilitychange', () => { if (document.hidden) modeUnpress(); });
modeBtn.addEventListener('pointercancel', () => {
  modeBtn.style.transform = '';
  pressAt = null;
  longFired = false;
  if (prefersReducedMotion() && holdRaf != null) { clearTimeout(holdRaf); holdRaf = null; }
  else holdStop();
});

paintRing(0);
paintStage(0);

// ===========================================================================
// full screen
// ===========================================================================
// fullscreen.js owns it, and its own .fs-corner does the same tap-to-swap and
// hold-to-leave, in the same place. Hold to go in, hold to come out.

imm = createImmersive({
  trackpad,
  keyboard: { element: keysShell },
  log,
  store,
  corner: padOpts.corner === 'left' ? 'left' : 'right',
  options: {
    holdMs: HOLD_MS,
    holdSlop: HOLD_SLOP,
    padAboveKeys: false,
    // app.js holds the single history lease for the whole overlay stack, so the
    // shell must not push an entry of its own. Two owners is the race.
    history: false,
  },
  onchange: (s) => {
    if (s.open) {
      takeHistory('immersive');
      // Whatever it is showing, show it fully: no half-materialised keyboard
      // inside the shell.
      modeSpring?.cancel();
      modeSpring = null;
      mode = s.panel === 'keys' ? 'keys' : 'pad';
      body.dataset.mode = mode;
      clearKeysOrigin();
      paintStage(mode === 'keys' ? 100 : 0);
    } else {
      releaseHistory('immersive');
      // Spatial consistency: come back to the panel it was left on.
      setMode(s.panel === 'keys' ? 'keys' : 'pad', { animate: false });
    }
    // The pad has just moved into or out of the full-screen shell, so every
    // rectangle cached against it is from the wrong box.
    invalidatePadRect();
    onViewport();
  },
});

// ===========================================================================
// the dongle's screensavers
// ===========================================================================
// Names come from the firmware catalogue when the dongle reports them, so the
// menu cannot drift from what is actually installed. Until a connected dongle
// says it runs savers, every control here is disabled and says why - a panel
// that silently does nothing is worse than no panel.

const SS_FALLBACK = ['Bounce', 'Plasma', 'Stars', 'Mystify', 'Life', 'Matrix', 'Pipes',
  'Toasters', 'Maze', 'Fire', 'Cube', 'Fireworks', 'Swarm', 'Spirograph'];
const SS_SHUFFLE = 0xff;

const ssEnable = $('#ss-enable');
const ssPick = $('#ss-pick');
const ssIdle = $('#ss-idle');
const ssNote = $('#ss-note');
const ssFile = $('#ss-file');
const ssProgress = $('#ss-progress');
const ssClear = $('#ss-clear');

let ssSupported = null;          // null = unknown, false = firmware is older
let ssState = { on: 1, idx: 0, idle: 60, custom: 0, imp: 0, got: 0, names: SS_FALLBACK };
let ssBusy = false;
let ssPending = false;           // picked before the dongle's status arrived

const ssFileBtn = $('#ss-file-btn');

// A real button, not a <label for> over a clipped input. The input is still
// clipped to inset(50%) but is now tabindex="-1" and aria-hidden, because a
// focusable invisible control put a Tab stop on nothing at all.
$('#ss-connect').addEventListener('click', () => { $('#connect').click(); });

ssFileBtn.addEventListener('click', () => {
  if (ssFileBtn.disabled) return;
  ssFile.click();
});

const ssControls = () => [
  ssEnable, ssIdle, ssFile, ssFileBtn, $('#ss-preview'), ssClear,
  ...ssPick.querySelectorAll('button'),
];

function paintScreensaver() {
  // The settings themselves never need the dongle to be there: a change made
  // offline is kept and sent the moment it connects. Only what has to happen on
  // the dongle right now (preview, import) waits for a link. Firmware that
  // cannot run savers, or an import in flight, locks everything.
  const usable = ssSupported !== false && !ssBusy;
  // Offline: preview and import cannot work, so they make way for the button
  // that fixes that, instead of sitting there greyed out.
  $('#ss-connect').hidden = ssSupported !== null;
  $('#ss-live').hidden = ssSupported === null;
  const live = ssSupported === true && !ssBusy;
  for (const el of ssControls()) el.disabled = !live;
  for (const el of [ssEnable, ssIdle, ...ssPick.querySelectorAll('button')]) el.disabled = !usable;

  ssEnable.checked = !!ssState.on;
  ssIdle.value = String(ssState.idle ?? 60);
  if (![...ssIdle.options].some((o) => o.value === ssIdle.value)) ssIdle.value = '60';
  ssClear.hidden = !ssState.custom;

  for (const b of ssPick.querySelectorAll('button')) {
    const on = Number(b.dataset.saver) === Number(ssState.idx);
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }

  if (ssSupported === false) {
    ssNote.textContent = 'This firmware has no screensavers. Reflash to use them.';
  } else if (ssSupported === null) {
    ssNote.textContent = 'Sent when the dongle connects.';
  } else if (!ssBusy) {
    ssNote.textContent = 'PNG or GIF, 1-bit, up to 128×64, 16 frames.';
  }
}

function saverButton(index, name, shot) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'nib-saver';
  b.dataset.saver = String(index);
  const frame = document.createElement('span');
  frame.className = 'nib-saver-shot';
  frame.append(shot);
  const label = document.createElement('span');
  label.className = 'nib-saver-name';
  label.textContent = name;
  b.append(frame, label);
  return b;
}

// Thumbnails are frames of the real firmware code, rendered by tools/lcdsim.
// Only the built-ins have one; an imported animation and Shuffle get a glyph.
function buildSavers(names) {
  ssPick.textContent = '';
  const list = names?.length ? names : SS_FALLBACK;
  const glyph = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    return svg;
  };
  list.forEach((name, index) => {
    let shot;
    if (index < SS_FALLBACK.length) {
      shot = document.createElement('img');
      shot.src = `savers/${index}.png?v=1`;
      shot.alt = '';
      shot.decoding = 'async';
    } else {
      shot = glyph('M4 16l4-4 3 3 5-6 4 5M4 5h16v14H4z');
    }
    ssPick.append(saverButton(index, name, shot));
  });
  ssPick.append(saverButton(SS_SHUFFLE, 'Shuffle',
    glyph('M4 7h3c4 0 6 10 10 10h3M4 17h3c1.6 0 2.8-1.6 3.9-3.6M14 9.6C15 8 16 7 17 7h3M18 4l3 3-3 3M18 14l3 3-3 3')));
}

buildSavers(SS_FALLBACK);

function adoptScreensaver(ss, hasScreen) {
  if (!hasScreen) { ssSupported = false; paintScreensaver(); return; }
  if (!ss || typeof ss !== 'object') { ssSupported = false; paintScreensaver(); return; }
  ssSupported = true;
  const picked = ssPending ? { on: ssState.on, idx: ssState.idx, idle: ssState.idle } : null;
  ssState = {
    on: ss.on ?? 1,
    idx: ss.idx ?? 0,
    idle: ss.idle ?? 60,
    custom: ss.custom ?? 0,
    // The firmware's own verdict on the last import step, and how much of the
    // payload it safely holds. Both mean the page never has to guess.
    imp: ss.imp ?? 0,
    got: ss.got ?? 0,
    // Newer firmware sends only the count and an imported animation's name,
    // so the status fits one iOS notification. Older firmware sent the list.
    names: Array.isArray(ss.names) && ss.names.length ? ss.names
      : ss.custom ? [...SS_FALLBACK, ss.cn || 'Custom'] : SS_FALLBACK,
  };
  if (picked) {
    ssPending = false;
    Object.assign(ssState, picked);
    // pushSaver() reads the controls, so they have to show the kept values first.
    ssEnable.checked = !!ssState.on;
    ssIdle.value = String(ssState.idle);
    pushSaver();
  }
  buildSavers(ssState.names);
  paintScreensaver();
  for (const settle of ssWaiters.splice(0)) settle(ssState);
}

// The dongle republishes its status after BEGIN, COMMIT, ABORT and CLEAR, so an
// import can be driven off what the firmware actually did rather than off hope.
const ssWaiters = [];
function nextSsStatus(ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const at = ssWaiters.indexOf(settle);
      if (at >= 0) ssWaiters.splice(at, 1);
      resolve(null);
    }, ms);
    const settle = (state) => { clearTimeout(timer); resolve(state); };
    ssWaiters.push(settle);
  });
}

// SsImport, in screensaver.h's order.
const SS_ERR = [
  null,
  'the dongle refused the header',
  'too big for the dongle',
  'the dongle could not find room for it',
  'a chunk arrived out of order',
  'the dongle was still missing part of it',
  'it arrived corrupted',
  'too much detail to draw inside one frame',
  'the dongle had no import open',
  'the dongle could not store it',
];

function pushSaver() {
  if (ssSupported !== true) return;
  ble.ssSet({
    enabled: ssEnable.checked,
    index: Number(ssState.idx) & 0xff,
    idleSeconds: Number(ssIdle.value),
  });
}

ssEnable.addEventListener('change', () => {
  ssState.on = ssEnable.checked ? 1 : 0;
  if (ssSupported !== true) ssPending = true;
  pushSaver();
  log(ssEnable.checked ? 'screensaver on' : 'screensaver off');
});

ssIdle.addEventListener('change', () => {
  ssState.idle = Number(ssIdle.value);
  if (ssSupported !== true) ssPending = true;
  pushSaver();
  log(ssState.idle ? `starts after ${ssIdle.selectedOptions[0].textContent}` : 'never starts');
});

ssPick.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-saver]');
  if (!b || b.disabled) return;
  ssState.idx = Number(b.dataset.saver);
  if (ssSupported !== true) ssPending = true;
  pushSaver();
  // Picking one shows it on the dongle straight away. Otherwise the choice only
  // becomes visible after a minute of idling, which reads as "did nothing".
  if (ssSupported === true) ble.ssPreview(Number(ssState.idx) & 0xff);
  paintScreensaver();
  log(`screensaver: ${b.textContent}, showing on the dongle`);
  try { fieldReport && fieldReport('saver', { pick: b.textContent, idx: ssState.idx, supported: ssSupported }); } catch { /* telemetry only */ }
});

$('#ss-preview').addEventListener('click', () => {
  if (ssSupported !== true) return;
  ble.ssPreview(Number(ssState.idx) & 0xff);
  log('previewing on the dongle');
});

ssClear.addEventListener('click', () => {
  if (ssSupported !== true) return;
  ble.ssCustomClear();
  ssState.custom = 0;
  // The imported animation sits at index names.length, so `>= length - 1` also
  // caught the last built-in (Wordmark) — and Shuffle is 0xff, so `255 >= 6` was
  // always true and clearing a custom animation silently threw away a Shuffle
  // choice. Only the one index that has actually gone is reset.
  if (Number(ssState.idx) === ssState.names.length) ssState.idx = 0;
  paintScreensaver();
  log('imported animation removed');
});

// ---- import ----------------------------------------------------------------
// One bit per pixel, thresholded rather than dithered: the engine supplies the
// motion, the user supplies the shape, and a flat shape is the house style.

const SS_ON_565 = 0xedce;        // the accent, in RGB565
const SS_FIELD_565 = 0x0000;

async function toMono(file) {
  const bitmap = await createImageBitmap(file);
  const limit = Math.min(
    ble.SS_IMPORT.MAX_W / bitmap.width,
    ble.SS_IMPORT.MAX_H / bitmap.height,
    1,
  );
  const w = Math.max(8, Math.min(ble.SS_IMPORT.MAX_W, Math.round(bitmap.width * limit)));
  const h = Math.max(8, Math.min(ble.SS_IMPORT.MAX_H, Math.round(bitmap.height * limit)));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  bitmap.close?.();

  const stride = Math.ceil(w / 8);
  const bits = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let cx = 0; cx < w; cx++) {
      const i = (y * w + cx) * 4;
      const a = px[i + 3] / 255;
      const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      if (a > 0.5 && lum > 0.5) bits[y * stride + (cx >> 3)] |= 0x80 >> (cx & 7);
    }
  }
  return { w, h, frames: 1, bits };
}

function ssHeader({ w, h, frames, bits }, name) {
  const label = new TextEncoder().encode(name.slice(0, 15));
  const head = new Uint8Array(14 + label.length);
  head[0] = ble.SS_IMPORT.MAGIC;
  head[1] = ble.SS_IMPORT.VERSION;
  head[2] = ble.SS_IMPORT.KIND_1BIT;
  head[3] = w;
  head[4] = h;
  head[5] = frames;
  head[6] = 10;                        // 100 ms per frame
  head[7] = 1;                         // bounce: a still logo still drifts
  head[8] = SS_ON_565 & 0xff;
  head[9] = (SS_ON_565 >> 8) & 0xff;
  head[10] = SS_FIELD_565 & 0xff;
  head[11] = (SS_FIELD_565 >> 8) & 0xff;
  head[12] = bits.length & 0xff;
  head[13] = (bits.length >> 8) & 0xff;
  head.set(label, 14);
  return head;
}

ssFile.addEventListener('change', async () => {
  const file = ssFile.files?.[0];
  ssFile.value = '';
  if (!file) return;
  if (ssSupported !== true) { log('connect a dongle that runs savers first'); return; }

  ssBusy = true;
  paintScreensaver();
  ssProgress.hidden = false;
  ssProgress.style.setProperty('--p', '0');

  try {
    const frame = await toMono(file);
    if (frame.bits.length > ble.SS_IMPORT.MAX_BYTES) {
      throw new Error(`too big: ${frame.bits.length} bytes, the limit is ${ble.SS_IMPORT.MAX_BYTES}`);
    }

    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 15) || 'Custom';
    ssNote.textContent = `sending ${frame.w}×${frame.h}, ${frame.bits.length} bytes…`;

    // BEGIN republishes the status, and its "got" says where the dongle wants
    // the first chunk. Normally 0; after an interrupted attempt at the SAME
    // image it is the high-water mark, which is the protocol's resume path, so
    // a dropped connection costs only what had not arrived yet.
    const begun = nextSsStatus();
    await ble.ssImportBegin(ssHeader(frame, name));
    const afterBegin = await begun;
    if (afterBegin?.imp) throw new Error(SS_ERR[afterBegin.imp] ?? 'refused');

    const total = frame.bits.length;
    const from = Math.min(afterBegin?.got ?? 0, total);
    if (from) log(`resuming from ${from} of ${total} bytes`);

    const chunk = ble.SS_IMPORT.CHUNK;
    for (let off = from; off < total; off += chunk) {
      const end = Math.min(off + chunk, total);
      await ble.ssImportData(off, frame.bits.subarray(off, end));
      ssProgress.style.setProperty('--p', (end / total).toFixed(3));
    }

    const committed = nextSsStatus();
    await ble.ssImportCommit(ble.crc32(frame.bits));
    const done = await committed;
    ssProgress.style.setProperty('--p', '1');

    if (!done) log('sent, but the dongle did not answer');
    else if (done.imp) throw new Error(SS_ERR[done.imp] ?? 'refused');
    else log('stored on the dongle');
  } catch (err) {
    try { ble.ssImportAbort(); } catch { /* best effort */ }
    log('import failed: ' + (err?.message ?? 'unknown'));
  } finally {
    ssBusy = false;
    paintScreensaver();
    setTimeout(() => { ssProgress.hidden = true; }, 600);
  }
});

paintScreensaver();

// ===========================================================================
// capture — present only where it can actually work
// ===========================================================================
// Pointer lock and keyboard lock are desktop-only. Offering a phone a control
// that cannot fire is not minimalism, it is a lie, so the section stays hidden.

const capSect = $('#sect-capture');
const capState = $('#cap-state');
const capToggle = $('#cap-toggle');
const capDegraded = $('#cap-degraded');

// The primary Capture button, on the pad card itself. Forwarding the real mouse
// and keyboard is strictly better than dragging a real pointer across a
// simulated pad, so on a desktop it leads rather than hiding in the sheet.
// .pad-ignore keeps attachRecogniser's ignore() off it.
const capCard = document.createElement('button');
capCard.type = 'button';
capCard.className = 'cap-surface pad-ignore';
capCard.id = 'cap-card';
capCard.hidden = true;
const capTitle = document.createElement('span');
capTitle.className = 'cap-surface-title';
const capHint = document.createElement('span');
capHint.className = 'cap-surface-hint';
capCard.append(capTitle, capHint);
padEl.append(capCard);

let capture = null;

function paintCapture(on, notes) {
  capState.textContent = on ? 'on' : 'off';
  capToggle.textContent = on ? 'Stop capture' : 'Start capture';
  capTitle.textContent = on ? 'Controlling the other computer' : 'Click to take control';
  capHint.textContent = on ? 'Ctrl+Alt releases' : 'your mouse and keyboard, sent to the dongle';
  capSect.classList.toggle('is-on', on);
  capDegraded.textContent = notes?.length ? notes.join(' \u00b7 ') : '';
}

/**
 * Re-evaluated whenever SUPPORT moves, because it can: pairing a Bluetooth
 * mouse to a phone or a keyboard to an iPad flips (any-pointer: fine) and with
 * it `touchOnly`. SUPPORT.usable now covers pointer lock and keyboard lock too,
 * so the old `usable && pointerLock && keyboardLock` gate, which could be false
 * while SUPPORT.why was empty, can no longer make the section vanish in silence
 * on Safari and Firefox - exactly what this file says it refuses to do.
 */
function paintSupport() {
  if (SUPPORT.usable) {
    capSect.hidden = false;
    capToggle.disabled = false;
    if (!capture) {
      capture = createCapture({ transport: ble, surface: document.documentElement, modMap: target.modMap, targetIsMac: target.isApple });
      capture.events.addEventListener('capturestart', (e) => {
        paintCapture(true, e.detail?.degraded);
        log('capturing \u00b7 Ctrl+Alt releases');
      });
      capture.events.addEventListener('capturestop', (e) => {
        paintCapture(false, null);
        log('capture stopped' + (e.detail?.reason ? ` (${e.detail.reason})` : ''));
      });
      capture.events.addEventListener('capturewarn', (e) => log('capture: ' + e.detail?.message));
      capToggle.addEventListener('click', () => { capture.toggle(); });
      capCard.addEventListener('click', () => { capture.toggle(); });
    }
    paintCapture(false, null);
  } else if (!SUPPORT.touchOnly) {
    // A desktop that could nearly do it deserves the reason; a phone does not
    // need to be told about a feature it can never have.
    capSect.hidden = false;
    capToggle.disabled = true;
    capState.textContent = 'unavailable';
    capDegraded.textContent = SUPPORT.why || 'not available in this browser';
  } else {
    capSect.hidden = true;
  }
  paintCapCard();
  arrangeForShell();
}

function paintCapCard() {
  const on = SUPPORT.usable && body.dataset.shell === 'desktop';
  capCard.hidden = !on;
  body.dataset.capture = on ? 'surface' : 'none';
}

supportEvents.addEventListener('change', paintSupport);
paintSupport();

// ===========================================================================
// last words
// ===========================================================================

// Never leave a modifier or a mouse button held if the page goes away
// mid-shortcut.
window.addEventListener('pagehide', () => {
  try { trackpad.release(); } catch { /* ignore */ }
  ble.releaseAll();
});

paintMods();

// Last, because it can move the Capture section and re-measure everything.
applyShell();
onViewport();

// No startup toast. The pill already reports the connection, and a hint
// floating over an otherwise empty black screen is the loudest thing on it.
if (ble.isConnected()) log('connected');

// ===========================================================================
// the computer on the other end
// ===========================
// ===========================================================================
// the computer on the other end: Windows, Mac or Linux
// ===========================================================================
// The dongle sends key positions, so this only changes names (Win or Cmd, Alt
// or Opt), the order of those keys on the on-screen keyboard, and whether
// capture swaps Cmd and Ctrl. "Auto" follows the dongle's guess from how the
// computer enumerated it, and means Windows until it has one.
const targetSel = $('#target');
const TARGET_NAME = { win: 'Windows', mac: 'Mac', linux: 'Linux' };

function paintTarget() {
  targetSel.value = target.getChoice();
  const auto = targetSel.querySelector('option[value="auto"]');
  const d = target.getDetected();
  auto.textContent = d === 'mac' ? 'Auto (Mac)' : d === 'pc' ? 'Auto (Windows)' : 'Auto (Windows)';
  for (const b of document.querySelectorAll('#mods [data-mod]')) {
    const name = target.modLabel(Number(b.dataset.mod));
    if (name) b.textContent = name;
  }
  try { kb.render(); } catch { /* keyboard not built yet */ }
}

targetSel.addEventListener('change', () => {
  target.setChoice(targetSel.value);
  log(`computer: ${TARGET_NAME[target.target()]}`
    + (target.crossPlatform() ? ', modifiers translated in capture' : ''));
});
target.events.addEventListener('change', paintTarget);
target.events.addEventListener('change', () => { try { capture?.refreshIndicator(); } catch { /* not built */ } });
paintTarget();

// ---- dongles with no button -------------------------------------------------
// Its USB console must stay on (the only way left to reflash it), a pairing
// window opens on every plug-in, and restoring defaults means reflashing.
const PAIR_NOTE = {
  button: 'Open a window here, or hold the dongle\'s button 10 s.',
  none: 'Open a window here, or replug the dongle.',
};
const RESET_NOTE = {
  button: 'Locked out? Hold the dongle\'s button 30 s to reset it.',
  none: 'No button: erase and reflash to reset. The USB console stays on for that.',
};
function paintButtonless(hasButton) {
  const k = hasButton ? 'button' : 'none';
  for (const opt of setUsb.options) if (opt.value !== '0') opt.disabled = !hasButton;
  $('#set-pair-note').textContent = PAIR_NOTE[k];
  $('#set-reset-note').textContent = RESET_NOTE[k];
}

// ---- modifier translation in capture ------------------------------------------
const modmapSel = $('#modmap');
const modmapCustom = $('#modmap-custom');
const FAM_LABEL = { ctrl: 'Ctrl', alt: 'Alt / Opt', meta: 'Win / Cmd' };
for (const sel of modmapCustom.querySelectorAll('select')) {
  for (const f of ['ctrl', 'alt', 'meta']) {
    const o = document.createElement('option');
    o.value = f; o.textContent = FAM_LABEL[f];
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    const m = {};
    for (const s of modmapCustom.querySelectorAll('select')) m[s.dataset.fam] = s.value;
    target.setCustomMap(m);
  });
}

function paintModmap() {
  modmapSel.value = target.getMapChoice();
  modmapCustom.hidden = target.getMapChoice() !== 'custom';
  const cm = target.getCustomMap();
  for (const s of modmapCustom.querySelectorAll('select')) s.value = cm[s.dataset.fam];
  // Say what actually happens right now, in this pair of platforms.
  const note = $('#modmap-note');
  if (!target.crossPlatform()) {
    note.textContent = 'Both ends are the same kind of computer, so keys go across as they are.';
    return;
  }
  const here = target.controller() === 'mac' ? 'mac' : 'win';
  const there = target.target();
  const fm = target.familyMap();
  const parts = ['ctrl', 'alt', 'meta'].map((f) =>
    `${target.familyName(f, here)} → ${target.familyName(fm[f], there)}`);
  note.textContent = parts.join(' · ');
}

modmapSel.addEventListener('change', () => target.setMapChoice(modmapSel.value));
target.events.addEventListener('change', paintModmap);
paintModmap();
