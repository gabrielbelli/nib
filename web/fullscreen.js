import { tap as haptic } from './haptics.js?v=12';
// web/fullscreen.js — the immersive surface shell.
//
// One job: own the full-screen overlay, and swap whatever surface is showing
// inside it. It does not recognise a gesture, does not draw a key and does not
// know that Bluetooth exists. The caller injects a pad surface and a keyboard
// surface; this file decides which one is mounted, where the corner control
// sits, whether the screen is allowed to sleep, and how you get out.
//
// Deliberate non-dependencies:
//   · imports nothing — not ./ble.js, not ./pad.js, not ./osk.js;
//   · never queries the document for app ids, so it cannot break when the
//     markup around it changes;
//   · mutates the DOM only at runtime and injects its own stylesheet, built
//     from theme.css tokens through var(--token, fallback), so it still looks
//     deliberate if the theme is missing;
//   · every new class name is under .fs-, and it reuses .osk / .seg from the
//     sibling workflow rather than restyling them.
//
// Layout contract, for whoever integrates it:
//
//   .fs-root                     fixed, inset 0, z-index 90, background --bg
//     .fs-stage
//       .fs-slot.fs-slot-pad     the trackpad surface is moved in here
//       .fs-slot.fs-slot-keys    the keyboard surface is mounted here
//     .fs-notice                 transient line, lands in the dead black area
//     button.fs-corner           bottom-right in pad mode, top-right in keys
//
// Leaving is on purpose hard to do by accident: long-press the corner (a ring
// fills while you hold), or Escape, or the Android back gesture, or leaving
// native full screen. A tap on the corner only swaps the panel.

/* ========================================================================== *
 * defaults
 * ========================================================================== */

export const FS_DEFAULTS = Object.freeze({
  corner: 'right',      // which side the corner control lives on
  holdMs: 600,          // long-press on the corner to leave
  holdSlop: 24,         // px of finger travel that cancels the long-press
  noticeMs: 1800,       // transient line lifetime
  padAboveKeys: false,  // keep the pad mounted above the keyboard
  wakeLock: true,       // ask for a screen wake lock while open
  fullscreen: true,     // try native full screen as an enhancement
  escape: true,         // Escape leaves
  history: true,        // a pushState entry, so Android back leaves
  inert: true,          // mark the app behind the overlay inert
  haptics: true,        // short buzz on corner tap / hold fired
  coach: 3,             // show "hold to leave" for this many first entries
});

const STORE_KEY = 'nib.fs';
const STYLE_ID = 'nib-fs-styles';

// A store that always works, even when none was injected and localStorage
// throws (private mode). Nothing kept here is load-bearing.
const memoryStore = (() => {
  const mem = new Map();
  return {
    get: (k, fallback) => (mem.has(k) ? mem.get(k) : fallback),
    set: (k, v) => { mem.set(k, v); },
  };
})();

/* ========================================================================== *
 * stylesheet — idempotent, tokens with fallbacks
 * ========================================================================== */

const CSS = [
  /* the overlay itself. It is the mode; native full screen is a bonus on top */
  // Every fallback literal below is the same value theme.css :root declares. A
  // fallback that disagrees with the sheet is a bug waiting for a CSS-variable
  // failure: the overlay would paint one page colour and the app another.
  '.fs-root{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;',
  'background:var(--bg,#0b0b0a);color:var(--text,#f2f1ed);',
  'font:var(--text-ui,14px)/var(--leading-normal,1.45) var(--font-sans,-apple-system,BlinkMacSystemFont,system-ui,sans-serif);',
  'overscroll-behavior:contain;touch-action:manipulation;',
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;',
  '--fs-gap:var(--gutter,16px);',
  '--fs-hold:600ms;',
  'animation:fs-in var(--dur-3,260ms) var(--ease-out,cubic-bezier(.2,.8,.3,1)) both}',
  '@keyframes fs-in{from{opacity:0}to{opacity:1}}',

  /* html gets this while the overlay is up, so the page behind cannot scroll */
  ':root.fs-open,:root.fs-open>body{overflow:hidden!important;height:100%}',

  /* stage and slots ------------------------------------------------------- */
  '.fs-stage{flex:1;min-height:0;display:flex;flex-direction:column}',
  '.fs-slot{min-height:0;display:flex;flex-direction:column}',
  '.fs-slot-pad{flex:1}',

  /* The pad surface is the app's own element, borrowed. Inside the overlay it
     is the whole screen, so its panel chrome is dropped for the duration. */
  '.fs-slot-pad>*{flex:1;min-height:0!important;margin:0!important;',
  'border:0!important;border-radius:0!important;background:var(--bg,#0b0b0a)}',

  /* On a desktop the pad is a card in the middle, here too: dragging a real
     pointer across a simulated full-screen pad is worse than using the mouse. */
  'body[data-shell="desktop"] .fs-slot-pad{display:grid;place-items:center}',
  'body[data-shell="desktop"] .fs-slot-pad>*{flex:0 0 auto;',
  'width:min(640px,60vw);aspect-ratio:16/10;height:auto!important;',
  'border-radius:var(--radius-xl,20px)!important;',
  'border:1px solid var(--line-control,rgb(255 255 255/38%))!important}',

  /* The real structure is .fs-slot-keys > #stage-keys > .osk. .osk has no
     negative margins in theme.css §10, so the slot pays nothing back: the old
     padding cost 32px of key width on a phone and double-counted the home
     indicator against .osk's own max(--kbd-pad, --safe-b). */
  '.fs-slot-keys{justify-content:flex-end}',
  '.fs-slot-keys .osk{box-shadow:none;border-radius:0}',
  'body[data-shell="desktop"] .fs-slot-keys>*{width:100%;max-width:760px;',
  'margin-inline:auto}',

  /* #stage-keys keeps .glass.glass-m, whose blur(32px) over .fs-root's flat
     --bg returns exactly that flat colour — a 32px blur that buys nothing and
     costs a compositor pass. Give it a real surface instead. */
  '.fs-root #stage-keys{background:var(--surface-2,#1c1b1a);',
  'backdrop-filter:none;-webkit-backdrop-filter:none}',

  /* only the active panel is displayed */
  '.fs-root[data-panel="pad"] .fs-slot-keys{display:none}',
  '.fs-root[data-panel="keys"]:not([data-pad-above="on"]) .fs-slot-pad{display:none}',
  '.fs-root[data-panel="keys"][data-pad-above="on"] .fs-slot-pad{flex:1;',
  'border-bottom:1px solid var(--line,rgb(255 255 255/8%))}',

  /* corner control -------------------------------------------------------- */
  /* Sits clear of a notch, a home indicator and a rounded corner: safe-area
     inset plus a full gutter, on both axes. */
  '.fs-corner{position:absolute;box-sizing:border-box;',
  'width:var(--tap,44px);height:var(--tap,44px);display:grid;place-items:center;',
  'padding:0;background:var(--surface,#141413);',
  'border:1px solid var(--line-control,rgb(255 255 255/38%));',
  'border-radius:var(--radius-full,999px);color:var(--text,#f2f1ed);',
  'opacity:.35;cursor:pointer;-webkit-tap-highlight-color:transparent;',
  'touch-action:manipulation;',
  'transition:opacity var(--dur-2,160ms) var(--ease-out,ease),',
  'background-color var(--dur-2,160ms) var(--ease-out,ease)}',
  '.fs-corner:hover,.fs-corner:focus-visible{opacity:.9}',
  '.fs-corner:focus-visible{outline:var(--focus-width,2px) solid var(--focus,#edb872);',
  'outline-offset:var(--focus-offset,2px)}',
  '.fs-corner:active{opacity:1;background:var(--surface-3,#262523)}',
  '.fs-corner.fs-holding{opacity:1;background:var(--surface-3,#262523);',
  'border-color:var(--accent,#edb872)}',
  '.fs-root[data-panel="pad"]>.fs-corner{bottom:calc(var(--fs-gap) + env(safe-area-inset-bottom,0px))}',
  '.fs-root[data-panel="keys"]>.fs-corner{top:calc(var(--fs-gap) + env(safe-area-inset-top,0px))}',
  '.fs-root[data-corner="right"]>.fs-corner{right:calc(var(--fs-gap) + env(safe-area-inset-right,0px))}',
  '.fs-root[data-corner="left"]>.fs-corner{left:calc(var(--fs-gap) + env(safe-area-inset-left,0px))}',

  '.fs-glyph{width:22px;height:22px;display:block;pointer-events:none}',

  /* the filling ring: the only feedback that a long press is being counted */
  '.fs-ring{position:absolute;inset:-1px;width:auto;height:auto;',
  'pointer-events:none;transform:rotate(-90deg)}',
  '.fs-ring circle{fill:none;stroke:var(--accent,#edb872);stroke-width:2;',
  'stroke-linecap:round;stroke-dasharray:101;stroke-dashoffset:101;',
  'transition:stroke-dashoffset var(--dur-2,160ms) var(--ease-out,ease)}',
  '.fs-corner.fs-holding .fs-ring circle{stroke-dashoffset:0;',
  'transition:stroke-dashoffset var(--fs-hold) linear}',

  /* transient notice ------------------------------------------------------ */
  '.fs-notice{position:absolute;left:50%;transform:translateX(-50%);',
  'top:calc(var(--space-3,12px) + env(safe-area-inset-top,0px));',
  'max-width:min(78%,420px);padding:var(--space-2,8px) var(--space-4,16px);',
  'background:var(--surface-2,#1c1b1a);',
  'border:1px solid var(--line,rgb(255 255 255/8%));',
  'border-radius:var(--radius-full,999px);',
  'color:var(--text-2,#cdcbc4);font-size:var(--text-micro,12px);',
  'text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
  'opacity:0;pointer-events:none;',
  'transition:opacity var(--dur-2,160ms) var(--ease-out,ease)}',
  '.fs-notice.fs-on{opacity:1}',
  /* in keys mode the corner owns the top-right, so the notice steps aside */
  '.fs-root[data-panel="keys"][data-corner="right"]>.fs-notice{left:var(--space-4,16px);',
  'right:calc(var(--tap,44px) + var(--fs-gap) * 2);transform:none;max-width:none}',
  '.fs-root[data-panel="keys"][data-corner="left"]>.fs-notice{right:var(--space-4,16px);',
  'left:calc(var(--tap,44px) + var(--fs-gap) * 2);transform:none;max-width:none}',

  '@media (prefers-reduced-motion:reduce){.fs-root{animation-duration:1ms}}',
].join('');

/** Inject the shell stylesheet. Idempotent; createImmersive calls it. */
export function fsStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  // Appended last so it wins over style.css / theme.css at equal specificity.
  (document.head || document.documentElement).append(el);
}

/* ========================================================================== *
 * glyphs — inline SVG, currentColor, no font dependency
 * ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(viewBox, paths, cls) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

// a keycap grid: "switch to the keyboard"
const keysGlyph = () => svg('0 0 24 24', [
  'M3 7.5h18v9H3z',
  'M6.5 10.5h0M9.5 10.5h0M12.5 10.5h0M15.5 10.5h0M18 10.5h0',
  'M7.5 13.5h9',
], 'fs-glyph');

// a pad with a pointer in it: "switch back to the trackpad"
const padGlyph = () => svg('0 0 24 24', [
  'M3.5 5h17v14h-17z',
  'M10 9.5l4.5 7 .8-2.4 2.4-.8z',
], 'fs-glyph');

function ring() {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 40 40');
  s.setAttribute('class', 'fs-ring');
  s.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', '20');
  c.setAttribute('cy', '20');
  c.setAttribute('r', '16');
  s.append(c);
  return s;
}

/* ========================================================================== *
 * surface adapters
 * ========================================================================== *
 * Two shapes are accepted, because the two surfaces arrive differently:
 *
 *   { element }              an element that already exists (#pad, a Trackpad,
 *                            an .osk built earlier) — it is *moved* into the
 *                            slot and put back exactly where it came from.
 *   { mount(host), unmount } a factory (osk.js: mount => createKeyboard({mount}))
 *
 * A factory with no unmount is never torn down, only hidden by CSS, so it can
 * never be built twice.
 */

function adopt(spec) {
  if (!spec) return null;

  const el = spec.nodeType === 1
    ? spec
    : (spec.element || spec.surface || null);

  if (el && el.nodeType === 1) {
    let mark = null;          // where to put it back
    let home = null;
    let live = false;
    return {
      element: el,
      get mounted() { return live; },
      mount(host) {
        if (live && el.parentNode === host) return;
        if (el.parentNode && el.parentNode !== host) {
          home = el.parentNode;
          if (!mark) {
            mark = document.createComment('fs:surface');
            home.insertBefore(mark, el);
          }
        }
        host.append(el);
        live = true;
      },
      unmount() {
        if (!live) return;
        if (mark && mark.parentNode) {
          mark.parentNode.insertBefore(el, mark);
          mark.remove();
        } else if (home) {
          home.append(el);
        } else {
          el.remove();
        }
        mark = null;
        live = false;
      },
    };
  }

  if (typeof spec.mount === 'function') {
    const canUnmount = typeof spec.unmount === 'function';
    let live = false;
    return {
      element: null,
      get mounted() { return live; },
      mount(host) {
        if (live) return;
        spec.mount(host);
        live = true;
      },
      unmount() {
        if (!live || !canUnmount) return;   // no unmount: stays, CSS hides it
        try { spec.unmount(); } catch { /* a surface must not block an exit */ }
        live = false;
      },
    };
  }

  return null;
}

/* ========================================================================== *
 * small helpers
 * ========================================================================== */

const isFn = (f) => typeof f === 'function';

function buzz(ms, on) {
  if (!on) return;
  haptic(ms);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function requestFullscreen(el) {
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!isFn(req)) return false;
  try {
    await req.call(el, { navigationUI: 'hide' });
    return true;
  } catch {
    return false;         // Bluefy, iOS Safari, a denied gesture: not fatal
  }
}

async function dropFullscreen(el) {
  if (fullscreenElement() !== el) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!isFn(exit)) return;
  try { await exit.call(document); } catch { /* already gone */ }
}

/* ========================================================================== *
 * createImmersive
 * ========================================================================== */

/**
 * @param {object} opts
 * @param {object} [opts.trackpad]  Trackpad, or {element}, or {mount,unmount}
 * @param {object} [opts.keyboard]  {element}, or {mount,unmount}
 * @param {(msg:string)=>void} [opts.log]
 * @param {{get:Function,set:Function}} [opts.store]
 * @param {'left'|'right'} [opts.corner]
 * @param {(s:object)=>void} [opts.onchange]
 * @param {object} [opts.options]   any FS_DEFAULTS override
 */
export function createImmersive(opts = {}) {
  fsStyles();

  const log = isFn(opts.log) ? opts.log : () => {};
  const store = opts.store && isFn(opts.store.get) ? opts.store : memoryStore;
  const saved = store.get(STORE_KEY, {}) || {};

  const cfg = {
    ...FS_DEFAULTS,
    ...(typeof saved === 'object' ? saved : {}),
    ...(opts.options || {}),
    ...(opts.corner ? { corner: opts.corner } : {}),
  };
  if (cfg.corner !== 'left') cfg.corner = 'right';

  const trackpad = opts.trackpad || null;
  let padSurface = adopt(trackpad);
  let keySurface = adopt(opts.keyboard);

  // ------------------------------------------------------------------ DOM
  const root = document.createElement('div');
  root.className = 'fs-root';
  root.tabIndex = -1;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Full screen control');
  root.dataset.corner = cfg.corner;
  root.dataset.panel = 'pad';
  root.dataset.padAbove = cfg.padAboveKeys ? 'on' : 'off';
  root.style.setProperty('--fs-hold', cfg.holdMs + 'ms');

  const stage = document.createElement('div');
  stage.className = 'fs-stage';

  const padSlot = document.createElement('div');
  padSlot.className = 'fs-slot fs-slot-pad';

  const keySlot = document.createElement('div');
  keySlot.className = 'fs-slot fs-slot-keys';

  stage.append(padSlot, keySlot);

  const notice = document.createElement('div');
  notice.className = 'fs-notice';
  notice.setAttribute('aria-live', 'polite');

  const corner = document.createElement('button');
  corner.type = 'button';
  corner.className = 'fs-corner';
  corner.append(ring(), keysGlyph());

  root.append(stage, notice, corner);

  // ---------------------------------------------------------------- state
  const state = { open: false, panel: 'pad', fullscreen: false, wakeLock: false };
  let entering = false;         // suppresses the fullscreenchange bounce
  let destroyed = false;
  let sentinel = null;          // WakeLockSentinel
  let pushed = false;           // we own a history entry
  let noticeTimer = null;
  let inerted = [];

  // Anyone who wants more than one listener can use this instead of onchange.
  const events = new EventTarget();

  function emit() {
    const snap = { ...state };
    if (isFn(opts.onchange)) { try { opts.onchange(snap); } catch { /* caller */ } }
    try { events.dispatchEvent(new CustomEvent('change', { detail: snap })); } catch { /* old engine */ }
  }

  function persist() {
    store.set(STORE_KEY, {
      corner: cfg.corner,
      padAboveKeys: cfg.padAboveKeys,
      coached: cfg.coached || 0,
    });
  }

  // ------------------------------------------------------------- notices
  function say(msg, ms) {
    if (!msg) return;
    log(msg);
    notice.textContent = msg;
    notice.classList.add('fs-on');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.classList.remove('fs-on'), ms || cfg.noticeMs);
  }

  // --------------------------------------------------------------- panels
  function paintCorner() {
    const toKeys = state.panel === 'pad';
    corner.querySelector('.fs-glyph')?.remove();
    corner.append(toKeys ? keysGlyph() : padGlyph());
    corner.setAttribute(
      'aria-label',
      (toKeys ? 'Show the keyboard' : 'Show the trackpad') + ' — hold to leave full screen',
    );
    corner.title = corner.getAttribute('aria-label');
  }

  function mountPanel(panel) {
    if (panel === 'keys') {
      if (keySurface) keySurface.mount(keySlot);
      if (padSurface) {
        if (cfg.padAboveKeys) padSurface.mount(padSlot);
        else padSurface.unmount();
      }
    } else {
      if (padSurface) padSurface.mount(padSlot);
      if (keySurface) keySurface.unmount();
    }
  }

  function show(panel) {
    const next = panel === 'keys' ? 'keys' : 'pad';
    if (destroyed) return;
    if (next === 'keys' && !keySurface) {
      say('no keyboard to show');
      return;
    }
    const changed = next !== state.panel;
    // A left button held by drag-lock must never survive losing the surface.
    if (changed && next === 'keys') release();
    state.panel = next;
    root.dataset.panel = next;
    if (state.open) mountPanel(next);
    paintCorner();
    if (changed) emit();
  }

  function release() {
    if (trackpad && isFn(trackpad.release)) {
      try { trackpad.release(); } catch { /* never block */ }
    }
  }

  // ------------------------------------------------------------ wake lock
  async function takeWakeLock() {
    if (!cfg.wakeLock || sentinel || !state.open) return;
    const wl = navigator.wakeLock;
    if (!wl || !isFn(wl.request)) {
      if (!cfg.warnedWake) { cfg.warnedWake = true; say('screen may sleep'); }
      return;
    }
    try {
      sentinel = await wl.request('screen');
      state.wakeLock = true;
      sentinel.addEventListener('release', () => {
        sentinel = null;
        state.wakeLock = false;
        emit();
      });
      emit();
    } catch {
      sentinel = null;
      state.wakeLock = false;
      if (!cfg.warnedWake) { cfg.warnedWake = true; say('screen may sleep'); }
    }
  }

  async function dropWakeLock() {
    const s = sentinel;
    sentinel = null;
    state.wakeLock = false;
    if (!s) return;
    try { await s.release(); } catch { /* already released */ }
  }

  // ------------------------------------------------------------ inertness
  function setInert(on) {
    if (!cfg.inert || !('inert' in HTMLElement.prototype)) return;
    if (on) {
      inerted = [];
      for (const node of Array.from(document.body.children)) {
        if (node === root || node.inert) continue;
        node.inert = true;
        inerted.push(node);
      }
    } else {
      for (const node of inerted) node.inert = false;
      inerted = [];
    }
  }

  // ----------------------------------------------------------- the corner
  // pointerdown → a hold counts up with a filling ring; a short press swaps the
  // panel. Because the button is a sibling *above* the surface, a touch that
  // starts here never reaches the pad, and pad.js also gets an ignore() for it.
  let holdTimer = null;
  let holdFired = false;
  let sawPointer = false;
  let hx = 0;
  let hy = 0;

  function holdStart(x, y) {
    hx = x; hy = y;
    holdFired = false;
    corner.classList.add('fs-holding');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holdFired = true;
      corner.classList.remove('fs-holding');
      buzz(20, cfg.haptics);
      exit();
    }, cfg.holdMs);
  }

  function holdStop() {
    clearTimeout(holdTimer);
    holdTimer = null;
    corner.classList.remove('fs-holding');
  }

  function cornerTap() {
    buzz(8, cfg.haptics);
    show(state.panel === 'pad' ? 'keys' : 'pad');
  }

  corner.addEventListener('pointerdown', (e) => {
    sawPointer = true;
    if (e.button > 0) return;
    try { corner.setPointerCapture(e.pointerId); } catch { /* fine */ }
    holdStart(e.clientX, e.clientY);
  });
  corner.addEventListener('pointermove', (e) => {
    if (!holdTimer) return;
    if (Math.abs(e.clientX - hx) > cfg.holdSlop || Math.abs(e.clientY - hy) > cfg.holdSlop) {
      holdStop();
      holdFired = true;         // slid off: neither swap nor exit
    }
  });
  corner.addEventListener('pointerup', () => {
    const fired = holdFired || holdTimer === null;
    holdStop();
    if (!fired) cornerTap();
    holdFired = false;
  });
  corner.addEventListener('pointercancel', () => { holdStop(); holdFired = false; });
  corner.addEventListener('contextmenu', (e) => e.preventDefault());
  corner.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sawPointer) cornerTap();     // keyboard Enter/Space, or no pointer events
  });

  // ------------------------------------------------------- window listeners
  function onKeyDown(e) {
    if (!state.open || !cfg.escape) return;
    if (e.key === 'Escape') { e.preventDefault(); exit(); }
  }

  function onFullscreenChange() {
    const now = fullscreenElement() === root;
    const was = state.fullscreen;
    state.fullscreen = now;
    if (was === now) return;
    emit();
    // Losing native full screen we actually had is a leave request (the OS
    // gesture, or the browser's own exit). Never having had it is not.
    if (!now && was && state.open && !entering) exit();
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') {
      if (state.open) takeWakeLock();     // the lock is dropped when hidden
    } else {
      release();                          // no held button across a background
    }
  }

  function onPopState() {
    // Only act on a pop while we actually own an entry. A popstate carries the
    // state of the entry being RETURNED TO, never the one we pushed, so there is
    // no tag to check — `pushed` is the tag. Without this guard any back
    // gesture anywhere in the app closed full screen and orphaned our entry.
    //
    // Better still: pass `history: false` and let the host app hold one lease
    // for the whole overlay stack. app.js does exactly that, so this path only
    // runs for a standalone embed.
    if (!cfg.history || !pushed) return;
    pushed = false;
    if (state.open) exit();
  }

  function onPageHide() {
    release();
    dropWakeLock();
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('popstate', onPopState);
  window.addEventListener('pagehide', onPageHide);

  // ---------------------------------------------------------------- enter
  async function enter(panel) {
    if (destroyed || state.open) return;
    entering = true;
    state.open = true;

    document.documentElement.classList.add('fs-open');
    if (!root.isConnected) document.body.append(root);

    state.panel = panel === 'keys' && keySurface ? 'keys' : 'pad';
    root.dataset.panel = state.panel;
    root.dataset.corner = cfg.corner;
    root.dataset.padAbove = cfg.padAboveKeys ? 'on' : 'off';
    paintCorner();
    mountPanel(state.panel);
    setInert(true);

    // Move focus off whatever was focused, or a phone keeps its own keyboard up.
    try { document.activeElement?.blur?.(); } catch { /* ignore */ }
    try { root.focus({ preventScroll: true }); } catch { /* ignore */ }

    if (cfg.history) {
      try { history.pushState({ nibImmersive: true }, ''); pushed = true; } catch { pushed = false; }
    }

    emit();

    // Both of these are enhancements: the overlay is already the mode.
    if (cfg.fullscreen) {
      const got = await requestFullscreen(root);
      state.fullscreen = got && fullscreenElement() === root;
    }
    entering = false;
    await takeWakeLock();
    emit();

    // First few entries only: the exit gesture is the one thing nothing else
    // on screen can hint at.
    const seen = Number(cfg.coached) || 0;
    if (seen < cfg.coach) {
      cfg.coached = seen + 1;
      persist();
      say('hold the corner button to leave', 2600);
    }
    log('full screen');
  }

  // ----------------------------------------------------------------- exit
  async function exit() {
    if (destroyed || !state.open) return;
    state.open = false;

    release();                            // first, always: no button left down
    holdStop();

    if (cfg.history && pushed) {
      pushed = false;
      try { history.back(); } catch { /* ignore */ }
    }

    await dropFullscreen(root);
    state.fullscreen = false;
    await dropWakeLock();

    setInert(false);
    if (padSurface) padSurface.unmount();
    if (keySurface) keySurface.unmount();
    root.remove();
    document.documentElement.classList.remove('fs-open');
    notice.classList.remove('fs-on');
    clearTimeout(noticeTimer);

    emit();
    log('left full screen');
  }

  async function toggle() { return state.open ? exit() : enter(); }

  // -------------------------------------------------------------- options
  function setOptions(patch = {}) {
    Object.assign(cfg, patch);
    if (cfg.corner !== 'left') cfg.corner = 'right';
    root.dataset.corner = cfg.corner;
    root.dataset.padAbove = cfg.padAboveKeys ? 'on' : 'off';
    root.style.setProperty('--fs-hold', cfg.holdMs + 'ms');
    if (state.open) mountPanel(state.panel);
    persist();
  }

  // Lets the orchestrator build the keyboard after the shell exists.
  function setKeyboard(spec) {
    const wasKeys = state.panel === 'keys';
    if (keySurface) keySurface.unmount();
    keySurface = adopt(spec);
    if (state.open) mountPanel(wasKeys && keySurface ? 'keys' : 'pad');
    if (wasKeys && !keySurface) show('pad');
  }

  function setTrackpad(spec) {
    if (padSurface) padSurface.unmount();
    padSurface = adopt(spec);
    if (state.open) mountPanel(state.panel);
  }

  function destroy() {
    if (destroyed) return;
    exit();
    destroyed = true;
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('pagehide', onPageHide);
  }

  return {
    enter,
    exit,
    toggle,
    show,
    setOptions,
    getOptions: () => ({ ...cfg }),
    setKeyboard,
    setTrackpad,
    notice: say,
    destroy,
    events,
    get open() { return state.open; },
    get panel() { return state.panel; },
    get fullscreen() { return state.fullscreen; },
    get wakeLock() { return state.wakeLock; },
    get element() { return root; },
    get stage() { return stage; },
    get corner() { return corner; },
    state: () => ({ ...state }),
  };
}

export default createImmersive;
