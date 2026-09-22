// On-screen keyboard.
//
// This file draws keys and sends each press as a HID tap. It owns NO layout
// data of its own, in either sense of the word:
//
//   · GEOMETRY - which keys, where, how wide - comes from osk-presets.js.
//     That is the user's "60% / 65% / compact / full / numpad / nav" choice.
//   · CHARACTERS come from keymap.js at press time. Every printable key in a
//     preset carries a CHARACTER, never a usage code, so the same preset is
//     correct on US and on ABNT2.
//
// The two never need to agree about anything but character identity, which is
// why there is no third table to keep in step. A US-shaped preset played
// against the ABNT2 table turns the positions whose character is only
// reachable through a dead key into that dead key automatically - which is
// exactly what real ABNT2 hardware does. See charVariant() below.
//
// Contract classes (theme.css styles these):
//   .osk .osk-row .osk-key .osk-key.wide .osk-key.xwide
//   .osk-key.mod .osk-key.on .osk-key.latched .osk-key.dead .osk-key.ghost
//   .osk-gap   - a non-interactive spacer, from a preset entry of type 'gap'
//
// The mount element carries --osk-rows and --osk-units, rewritten from
// OSK_METRICS on every preset change, so the stylesheet can size keys from
// those two numbers without measuring anything.
//
// Usage from app.js:
//
//   const kb = createKeyboard({
//     mount: '#stage-keys',
//     preset: 'compact',                   // an id from OSK_PRESET_ORDER
//     onKeys: (keys) => ble.tap(keys),     // [[mods, usage], ...]
//     getLayout: () => layout,             // 'us' | 'abnt2'
//     getMods:  () => stickyMods | latchedMods,
//     takeMods,                            // consumes the sticky bits
//     bindMod,                             // app's shared tap/long-press binder
//     onAction: (name) => ...,             // OSK_ACTIONS vocabulary
//     log,
//     isConnected: ble.isConnected,
//   });
//
// getMods/takeMods/bindMod are optional. Pass all three and the app keeps sole
// ownership of modifier state, so .btn.mod and .osk-key.mod light together and
// a latched Cmd survives a switch back to the text box. Pass none and the
// keyboard keeps its own sticky/latched pair so it still works standalone.

import { tap as haptic } from './haptics.js?v=12';
import { modLabel, isApple } from './target.js?v=1';
import * as keymap from './keymap.js?v=12';
import {
  OSK_ACTIONS,
  OSK_DEFAULT_PRESET,
  OSK_METRICS,
  OSK_PRESET_ORDER,
  getLayer,
  getPreset,
} from './osk-presets.js?v=12';

const { MOD, KEY, LAYOUTS, DEFAULT_LAYOUT } = keymap;

// ---------------------------------------------------------------- dead keys
// All this block does now is recognise a dead STEP when the layout table hands
// one back. keymap.js may export DEAD directly; until it does, the same five
// steps are recovered from the ABNT2 table, where each bare mark is authored
// as the dead step followed by space. Either way there is one definition.
const DEAD_MARKS = {
  ACUTE: '´', GRAVE: '`', TILDE: '~', CIRCUMFLEX: '^', DIAERESIS: '¨',
};

const DEAD = (() => {
  if (keymap.DEAD) return keymap.DEAD;
  const table = LAYOUTS.abnt2?.table;
  const out = {};
  for (const [name, mark] of Object.entries(DEAD_MARKS)) {
    const steps = table?.get(mark);
    if (steps && steps.length === 2) out[name] = steps[0];
  }
  return out;
})();

const DEAD_STEPS = Object.entries(DEAD).map(([name, step]) => ({
  step, mark: DEAD_MARKS[name] ?? name,
}));

const deadFor = (step) =>
  DEAD_STEPS.find((d) => d.step[0] === step[0] && d.step[1] === step[1]) ?? null;

// Repeat: one tap, a pause, then a steady stream. No acceleration.
const REPEAT_DELAY = 400;
const REPEAT_EVERY = 70;
const LATCH_MS = 500;   // long-press to latch a modifier
const DOUBLE_MS = 300;  // double-tap shift to latch it

// A keycap commits on release, not on pointerdown, because .osk is a horizontal
// scroller (`overflow-x:auto; touch-action:pan-x`) whose rows are wider than the
// screen, and dragging across live keycaps is the documented way to reach the
// off-screen keys. preventDefault() on a pointerdown does NOT suppress a
// touch-action pan, so firing there made the scroll type a line of garbage.
const TAP_SLOP = 10;    // px of travel that turns a press into a scroll
const TAP_TIME = 500;   // ms after which a press is a hold, not a tap
// ... but a key that has stayed still this long is clearly a press and not a
// pan, so it commits early. Auto-repeat needs that: a key that only emitted on
// release could never repeat while held.
const HOLD_CONFIRM = 120;
// A click arriving later than this after the last pointerdown was synthesised
// (VoiceOver's double-tap, TalkBack, Tab+Enter), not produced by that pointer.
const SYNTHETIC_AFTER = 700;

const MOD_ORDER = [MOD.GUI, MOD.CTRL, MOD.ALT, MOD.SHIFT];

function modPrefix(bits) {
  const parts = MOD_ORDER.filter((bit) => bits & bit).map((bit) => modLabel(bit).toLowerCase());
  return parts.length ? parts.join('+') + '+' : '';
}

// ------------------------------------------------------------ preset adapter
// One function, the only place that knows both vocabularies. A preset entry
// becomes the `def` shape buildKey() already eats.
function toDef(entry) {
  const w = Number(entry.w) || 1;
  switch (entry.type) {
    case 'char': {
      const def = { ch: entry.ch, label: entry.legend ?? entry.ch, w };
      if (entry.chShift != null) def.sh = entry.chShift;
      if (entry.legendShift != null) def.shLabel = entry.legendShift;
      if (entry.repeat) def.rep = true;
      return def;
    }
    case 'key':
      return {
        key: entry.key, label: entry.legend ?? entry.key, w,
        rep: !!entry.repeat, mods: entry.mods ?? 0,
      };
    case 'mod':
      return { mod: entry.mod, label: modLabel(entry.mod) || entry.legend || '', cls: 'mod', w };
    case 'layer':
      return {
        act: 'layer:' + entry.layer, label: entry.legend ?? '',
        cls: 'ghost', w, hold: !!entry.hold,
      };
    case 'act':
      return { act: 'app:' + entry.act, label: entry.legend ?? entry.act, cls: 'ghost', w };
    case 'consumer':
      return { cons: entry.usage, label: entry.legend ?? '', w, rep: !!entry.repeat };
    case 'gap':
      return { gap: true, w };
    default:
      return null;
  }
}

export function createKeyboard(options = {}) {
  const {
    mount,
    onKeys = () => {},
    onConsumer = () => {},
    getLayout = () => DEFAULT_LAYOUT,
    getMods = null,
    takeMods = null,
    bindMod = null,
    onAction = null,
    log = () => {},
    isConnected = null,
    haptics = true,
  } = options;

  const host = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!host) throw new Error('osk: no mount element');

  // Render into the mount if it is already the container, otherwise make one.
  const el = host.classList?.contains('osk')
    ? host
    : host.appendChild(Object.assign(document.createElement('div'), { className: 'osk' }));

  // The shell, not the inner .osk, carries the sizing numbers: the stylesheet
  // sizes the whole panel from them, and index.html seeds them there.
  const shell = host;

  let hapticsOn = haptics !== false;

  // -------------------------------------------------------- modifier state
  // Ownership is all or nothing, decided by bindMod: reading the app's state
  // while pressing keys that only change a local copy would leave the two UIs
  // disagreeing about what is held. With bindMod the app owns the pair and
  // must supply getMods and takeMods too; without it the keyboard keeps its own
  // with identical semantics, so it still works standalone.
  const appOwnsMods = typeof bindMod === 'function';
  let sticky = 0;
  let latched = 0;
  let lastShiftTap = 0;

  const readMods = () => {
    if (appOwnsMods) return (getMods ? getMods() : 0) & 0xff;
    return (sticky | latched) & 0xff;
  };

  const readLatched = () => (appOwnsMods ? (options.getLatched?.() ?? 0) : latched) & 0xff;

  const consumeMods = () => {
    if (appOwnsMods) return (takeMods ? takeMods() : readMods()) & 0xff;
    const m = (sticky | latched) & 0xff;
    sticky = 0;
    paint();
    return m;
  };

  const shiftOn = () => !!(readMods() & MOD.SHIFT);

  function bindModLocal(btn, bit) {
    let timer = null;
    let lastPointerAt = -Infinity;
    const clear = () => { clearTimeout(timer); timer = null; };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      lastPointerAt = performance.now();
      // Without capture a pointerup outside the chip goes to whatever is under
      // the finger, the latch timer survives, and the modifier silently latches.
      try { btn.setPointerCapture(e.pointerId); } catch { /* fine */ }
      timer = setTimeout(() => {
        timer = null;
        latched ^= bit;
        sticky &= ~bit;
        paint();
      }, LATCH_MS);
    });
    const toggle = () => {
      const now = Date.now();
      if (latched & bit) {
        // A tap must be able to undo a latch, or the only way out is a
        // second long-press, which nobody discovers.
        latched &= ~bit;
        sticky &= ~bit;
      } else if (bit === MOD.SHIFT && now - lastShiftTap < DOUBLE_MS) {
        // The gesture a phone user tries first: double-tap shift to latch.
        latched |= bit;
        sticky &= ~bit;
      } else {
        sticky ^= bit;
      }
      if (bit === MOD.SHIFT) lastShiftTap = now;
      paint();
    };
    btn.addEventListener('pointerup', () => {
      if (!timer) return;
      clear();
      toggle();
    });
    btn.addEventListener('pointercancel', clear);
    btn.addEventListener('pointerleave', clear);
    btn.addEventListener('lostpointercapture', clear);
    // AT activation and Tab+Enter dispatch click, never pointerdown.
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (performance.now() - lastPointerAt > SYNTHETIC_AFTER) toggle();
    });
  }

  // --------------------------------------------------------- write pacing
  // onKeys may return a promise. While one is unsettled a repeat tick is
  // skipped, so a slow link cannot build a queue that fires after release.
  let inFlight = 0;

  function deliver(keys) {
    let result;
    try {
      result = onKeys(keys);
    } catch {
      return;
    }
    if (result && typeof result.then === 'function') {
      inFlight++;
      const done = () => { inFlight = Math.max(0, inFlight - 1); };
      result.then(done, done);
    }
  }

  function buzz() {
    if (!hapticsOn) return;
    haptic(8);
  }

  let warnedOffline = false;

  function narrate(name) {
    const live = isConnected ? !!isConnected() : true;
    if (live) { warnedOffline = false; log(name); return; }
    // Writes vanish silently when there is no dongle, so say so once.
    if (warnedOffline) { log(name); return; }
    warnedOffline = true;
    log('not connected');
  }

  // ------------------------------------------------------------- variants
  // Each key resolves to two descriptors, unshifted and shifted, built once per
  // render against the active layout.
  function charVariant(table, ch) {
    if (typeof ch !== 'string' || ch === '') return null;
    const steps = table.get(ch) ?? table.get(ch.normalize('NFC'));
    if (!steps || !steps.length) return null;

    if (steps.length === 1) {
      return { kind: 'char', step: steps[0], text: ch === ' ' ? 'space' : ch };
    }

    // More than one step means this character is not on a key: it is composed.
    // If the FIRST step is a dead step, then this position IS that dead key on
    // this layout, and sending just that step arms it on the host - the user
    // then presses the base letter, exactly as on real hardware. Anything else
    // composed is not a single key and has no business on a keycap.
    const d = steps.length === 2 ? deadFor(steps[0]) : null;
    if (!d) return null;
    return { kind: 'char', step: d.step, text: `dead ${d.mark}`, dead: true, legend: d.mark };
  }

  function variant(def, table, shifted) {
    if (def.mod) return { kind: 'mod', bit: def.mod };
    if (def.act) return { kind: 'act', act: def.act };
    if (def.cons) return { kind: 'consumer', usage: def.cons, text: def.label };
    if (def.key) {
      const usage = KEY[def.key];
      if (usage === undefined) return null;
      return {
        kind: 'named', usage, mods: def.mods ?? 0, text: def.key.toLowerCase(),
      };
    }
    // Shift picks a different character, it is never OR-ed onto a printable
    // key - the table supplies that bit.
    if (shifted && def.sh != null) return charVariant(table, def.sh);
    return charVariant(table, def.ch);
  }

  function emit(v, mods) {
    if (v.kind === 'consumer') {
      // Media and remote keys (volume, play, Home, Back) travel on the
      // dongle's consumer-control interface, not as keyboard keys.
      try { onConsumer(v.usage); } catch { /* offline */ }
      narrate(v.text);
      return;
    }
    if (v.kind === 'named') {
      // Named keys take Cmd/Ctrl/Opt/Shift as bits: shift+tab, shift+left.
      const bits = (mods | (v.mods ?? 0)) & 0xff;
      deliver([[bits, v.usage]]);
      narrate(modPrefix(bits) + v.text);
      return;
    }
    const extra = mods & ~MOD.SHIFT;
    deliver([[(v.step[0] | extra) & 0xff, v.step[1]]]);
    narrate(modPrefix(extra) + v.text);
  }

  // --------------------------------------------------------------- repeat
  const repeating = new Set();

  function stopRepeat() {
    for (const stop of Array.from(repeating)) stop();
  }

  function hold(btn, shot) {
    let delay = null;
    let every = null;

    const stop = () => {
      clearTimeout(delay);
      clearInterval(every);
      delay = every = null;
      repeating.delete(stop);
    };

    delay = setTimeout(() => {
      delay = null;
      every = setInterval(() => {
        if (inFlight > 0) return;   // let the link catch up
        shot();
      }, REPEAT_EVERY);
    }, REPEAT_DELAY);

    repeating.add(stop);
    return stop;
  }

  // ------------------------------------------------------------- building
  function buildGap(def) {
    const span = document.createElement('div');
    span.className = 'osk-gap';
    span.setAttribute('aria-hidden', 'true');
    span.style.flexGrow = String(Number(def.w) || 1);
    return { el: span, def, gap: true, plain: null, shift: null, bit: 0, label: '' };
  }

  function buildKey(def, table) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'osk-key';

    const w = Number(def.w) || 1;
    if (w >= 4) btn.classList.add('xwide');
    else if (w > 1) btn.classList.add('wide');
    btn.style.flexGrow = String(w);

    if (def.cls) {
      for (const cls of String(def.cls).split(/\s+/)) if (cls) btn.classList.add(cls);
    }

    const rec = {
      el: btn,
      def,
      plain: variant(def, table, false),
      shift: null,
      label: def.label ?? def.ch ?? '',
      shLabel: def.shLabel ?? def.sh ?? def.label ?? def.ch ?? '',
      bit: def.mod ?? 0,
    };
    rec.shift = variant(def, table, true) ?? rec.plain;

    // A position the layout only reaches through a dead key draws the mark,
    // not the character the preset asked for: pressing it produces nothing
    // until the next keystroke, and the legend has to say so.
    if (rec.plain?.dead) rec.label = rec.plain.legend;
    if (rec.shift?.dead) rec.shLabel = rec.shift.legend;

    btn.textContent = rec.label;
    if (rec.plain?.dead) btn.classList.add('dead');
    // Word legends (Home, PgUp, Bksp) set smaller than single glyphs, so they
    // fit a one-unit cap instead of spilling past its edges.
    if (/[A-Za-z]{2,}/.test(rec.label)) btn.classList.add('word');

    if (rec.bit) {
      btn.dataset.mod = String(rec.bit);
      // preventDefault keeps focus off the key, which is what stops the
      // phone's own soft keyboard from opening over this one.
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); buzz(); });
      if (appOwnsMods) bindMod(btn, rec.bit); else bindModLocal(btn, rec.bit);
      return rec;
    }

    if (!rec.plain) {
      // The layout has no key for this character. Inert and quiet rather than
      // sending something wrong.
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('ghost');
      return rec;
    }

    let release = null;      // stops the auto-repeat interval
    let repeatShot = null;   // armed only once an emit has actually committed
    let press = null;        // { x, y, t, id }
    let confirmTimer = null;
    let lastPointerAt = -Infinity;

    /** One keystroke. Returns the shot function so a repeat can reuse it. */
    function fire() {
      const v = shiftOn() ? rec.shift : rec.plain;
      if (!v) return null;
      if (v.kind === 'act') { applyAct(v.act); return null; }
      // Modifiers are captured once, so a repeat keeps Cmd+Shift+Left intact
      // and the sticky bits clear on the first emission only.
      const mods = consumeMods();
      paint();
      const shot = () => emit(v, mods);
      shot();
      repaintLegends();
      return shot;
    }

    let committed = false;

    function commit() {
      if (committed) return;                  // once per press, never twice
      committed = true;
      const shot = fire();
      if (shot && def.rep) repeatShot = shot;
    }

    function endPress() {
      // Same reason as the mode button: the synthetic-click guard compares
      // against the last pointer activity, and a press that outlasts
      // SYNTHETIC_AFTER would otherwise be mistaken for a screen reader.
      lastPointerAt = performance.now();
      clearTimeout(confirmTimer);
      confirmTimer = null;
      press = null;
      committed = false;
      repeatShot = null;
      btn.style.transform = '';
      release?.();
      release = null;
    }

    btn.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      lastPointerAt = performance.now();
      // preventDefault keeps focus off the key, which is what stops the phone's
      // own soft keyboard from opening over this one. It does NOT stop the pan.
      e.preventDefault();
      if (press) endPress();
      try { btn.setPointerCapture(e.pointerId); } catch { /* fine */ }
      press = { x: e.clientX, y: e.clientY, t: lastPointerAt, id: e.pointerId };

      // Instant feedback, so committing on release still feels immediate.
      buzz();
      btn.style.transform = 'scale(0.94)';

      // The repeat timer starts counting from the press, but its shot is a
      // no-op until an emit has committed.
      if (def.rep) {
        release?.();
        release = hold(btn, () => { repeatShot?.(); });
      }
      if (def.rep) {
        confirmTimer = setTimeout(() => {
          confirmTimer = null;
          if (press) commit();
        }, HOLD_CONFIRM);
      }
    });

    btn.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= TAP_SLOP) return;
      endPress();                               // it was a scroll, not a key
    });

    btn.addEventListener('pointerup', (e) => {
      if (!press || (e.pointerId != null && e.pointerId !== press.id)) { endPress(); return; }
      const travel = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      const held = performance.now() - press.t;
      if (travel <= TAP_SLOP && held <= TAP_TIME) commit();
      endPress();
    });

    // A pointercancel is exactly what the browser sends when it takes the
    // contact over for a touch-action pan, so it must never type anything.
    btn.addEventListener('pointercancel', endPress);
    btn.addEventListener('pointerleave', () => { if (press) endPress(); });
    btn.addEventListener('lostpointercapture', () => { if (press) endPress(); });

    // The path VoiceOver's double-tap, TalkBack's activation and Tab+Enter all
    // use. Without it the whole on-screen keyboard was unreachable for them.
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (performance.now() - lastPointerAt > SYNTHETIC_AFTER) fire();
    });

    return rec;
  }

  // The presets are drawn in Mac order (Ctrl, Opt, Cmd). On Windows and Linux
  // the Win key sits inside Alt, so an adjacent Alt/GUI pair swaps places.
  function platformOrder(entries) {
    if (isApple()) return entries;
    const out = entries.slice();
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i], b = out[i + 1];
      if (a?.type === 'mod' && b?.type === 'mod'
          && ((a.mod === 4 && b.mod === 8) || (a.mod === 8 && b.mod === 4))) {
        out[i] = b; out[i + 1] = a; i++;
      }
    }
    return out;
  }

  function buildRow(entries, table) {
    entries = platformOrder(entries);
    const row = document.createElement('div');
    row.className = 'osk-row';
    const keys = [];
    for (const entry of entries) {
      const def = toDef(entry);
      if (!def) continue;
      const rec = def.gap ? buildGap(def) : buildKey(def, table);
      row.append(rec.el);
      keys.push(rec);
    }
    return { el: row, keys };
  }

  // ---------------------------------------------------------------- state
  const hostLayout = () => {
    const id = getLayout();
    return LAYOUTS[id] ? id : null;
  };

  let layoutId = hostLayout() ?? DEFAULT_LAYOUT;
  let seenLayout = layoutId;   // the last value read from the host
  let presetId = OSK_PRESET_ORDER.includes(options.preset)
    ? options.preset
    : OSK_DEFAULT_PRESET;
  let layer = getPreset(presetId).defaultLayer;
  let built = [];              // the rows currently in the DOM

  function currentKeys() {
    const out = [];
    for (const row of built) out.push(...row.keys);
    return out;
  }

  // Shift changes the legend rather than showing two glyphs: at this key size
  // there is no room for both, and it is what a phone user expects.
  function repaintLegends() {
    const shifted = shiftOn();
    for (const rec of currentKeys()) {
      if (rec.gap || rec.bit) continue;
      const text = shifted ? rec.shLabel : rec.label;
      if (rec.el.textContent !== text) rec.el.textContent = text;
      const v = shifted ? rec.shift : rec.plain;
      rec.el.classList.toggle('dead', !!v?.dead);
    }
  }

  function paintModKeys() {
    const bits = readMods();
    const stuck = readLatched();
    for (const rec of currentKeys()) {
      if (rec.gap || !rec.bit) continue;
      rec.el.classList.toggle('on', !!(bits & rec.bit));
      rec.el.classList.toggle('latched', !!(stuck & rec.bit));
    }
  }

  function paint() {
    paintModKeys();
    repaintLegends();
  }

  function applyAct(act) {
    const raw = String(act);
    const at = raw.indexOf(':');
    const kind = at < 0 ? raw : raw.slice(0, at);
    const name = at < 0 ? '' : raw.slice(at + 1);

    if (kind === 'layer') {
      // A layer key toggles: pressing Fn while on Fn goes home, which is the
      // only exit a preset that has no second Fn key would otherwise have.
      setLayer(name === layer ? getPreset(presetId).defaultLayer : name);
      return;
    }
    if (kind !== 'app') return;
    if (name === OSK_ACTIONS.NEXT_PRESET) {
      const at2 = OSK_PRESET_ORDER.indexOf(presetId);
      setPreset(OSK_PRESET_ORDER[(at2 + 1) % OSK_PRESET_ORDER.length]);
      return;
    }
    if (typeof onAction === 'function') {
      try { onAction(name); } catch { /* the app's problem, not ours */ }
    }
  }

  function writeMetrics() {
    const m = OSK_METRICS[presetId];
    if (!m || !shell?.style) return;
    // The widest-in-rows layer, not the active one, so a layer switch never
    // resizes the shell under the user's thumbs.
    shell.style.setProperty('--osk-rows', String(m.rows));
    shell.style.setProperty('--osk-units', String(m.units));
    shell.dataset.oskPreset = presetId;
  }

  function render() {
    // A render picks up a layout the drawer changed under us, but only when the
    // host's value actually moved, so an explicit setLayout() is not undone.
    const from = hostLayout();
    if (from && from !== seenLayout) {
      seenLayout = from;
      layoutId = from;
    }

    const preset = getPreset(presetId);
    if (!preset.layers[layer]) layer = preset.defaultLayer;

    stopRepeat();
    const table = LAYOUTS[layoutId].table;
    const rows = getLayer(presetId, layer);

    // Rebuilt wholesale rather than diffed: modifier state lives in the app
    // (or in this closure), never in the DOM, so there is nothing to preserve
    // and nothing to get out of step.
    const frag = document.createDocumentFragment();
    built = rows.map((entries) => {
      const row = buildRow(entries, table);
      frag.append(row.el);
      return row;
    });
    el.textContent = '';
    el.append(frag);

    writeMetrics();
    paint();
    return el;
  }

  function setLayer(name) {
    const preset = getPreset(presetId);
    if (!preset.layers[name] || name === layer) return;
    layer = name;
    render();
  }

  function setPreset(id) {
    if (!OSK_PRESET_ORDER.includes(id) || id === presetId) return;
    presetId = id;
    layer = getPreset(presetId).defaultLayer;
    render();
  }

  function setLayout(id) {
    if (!LAYOUTS[id] || id === layoutId) return;
    layoutId = id;
    seenLayout = hostLayout() ?? id;
    render();
  }

  // A key must not stay repeating if the page is hidden or put away.
  const onHide = () => stopRepeat();
  const onVisibility = () => { if (document.hidden) stopRepeat(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('blur', onHide);

  render();

  return {
    el,
    render,
    refresh: paint,          // call from the app's paintMods()
    setLayout,
    setLayer,
    setPreset,
    getPreset: () => presetId,
    getLayer: () => layer,
    getLayoutId: () => layoutId,
    setHaptics(on) { hapticsOn = !!on; },
    stopRepeat,
    // Any key the active layout cannot produce, for a quick sanity check.
    unresolved: () => currentKeys()
      .filter((rec) => !rec.gap && !rec.bit && !rec.plain)
      .map((rec) => rec.label || rec.def.ch || rec.def.key || '?'),
    destroy() {
      stopRepeat();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('blur', onHide);
      built = [];
      el.textContent = '';
      if (el !== host) el.remove();
    },
  };
}

export default createKeyboard;
