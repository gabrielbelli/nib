import { tap as haptic } from './haptics.js?v=12';
// web/pad.js — minimal trackpad and gesture recogniser.
//
// Nothing is imported: `ble` is handed in, so every layer below is testable
// without a dongle and without a DOM.
//
//   layer 1  createRecogniser()   pure state machine. no DOM, no BLE, no clock
//   layer 2  attachRecogniser()   the only part that knows about touch events
//   layer 3  createTrackpad()     the only part that knows about BLE
//
// The full-screen shell lives in fullscreen.js, which adopts any surface and
// imports nothing. There is deliberately no second copy of it here.
//
// The recogniser emits named gestures; what they mean is the controller's
// business. Keep it that way — the same state machine drives the on-screen
// keyboard's swipes.

// ---------------------------------------------------------------- constants

/** Every threshold in one place. Mutable per instance through `rec.config`. */
export const DEFAULTS = Object.freeze({
  // recogniser: distances in px, times in ms
  tapSlop: 10,          // a contact that travels further than this is not a tap
  tapTime: 250,         // ... nor one that stays down longer than this
  settle: 80,           // wait for a late third finger before a 2-finger tap
  coalesce: 70,         // opening window where panSlop applies
  panSlop: 4,           // movement held back inside the coalesce window
  groupSpread: 28,      // how far apart two contacts must be to count as two
  doubleTapTime: 300,   // second touchdown within this arms drag-lock
  doubleTapSlop: 24,    // ... and within this distance of the first tap
  swipeMin: 48,         // swipe distance (only when `swipe` is on)
  swipeMaxTime: 400,
  maxContacts: 3,       // no 4-finger gesture exists
  swipe: false,         // off on the pad, on for the keyboard
  // (x, y) -> 'left' | 'middle' | 'right' | null, supplied by the controller.
  // Only `tap` reads it, and only from where the gesture STARTED.
  zoneAt: null,

  // controller
  sensitivity: 1.8,
  accelMax: 1.6,        // gain = sensitivity * (1 + min(v / accelKnee, accelMax))
  accelKnee: 12,
  scrollDivisor: 8,     // px of two-finger travel per wheel tick
  naturalScroll: true,
  haptics: true,
  corner: 'right',      // 'left' mirrors the affordances for left-handers
  padAboveKeys: false,  // deliberately off: a thumb above the keys moves the host pointer
  holdWatchdog: 5000,   // no event for this long releases a held button
  hudMs: 600,
  maxPacketsPerFrame: 3,
});

/** The gesture set, for a help sheet or a settings list. */
export const GESTURES = Object.freeze([
  { id: 'pan',        fingers: 1, action: 'move pointer',  help: 'one finger drags the pointer' },
  { id: 'click',      fingers: 1, action: 'left click',    help: 'one-finger tap' },
  { id: 'scroll',     fingers: 2, action: 'scroll',        help: 'two fingers drag to scroll' },
  { id: 'rightclick', fingers: 2, action: 'right click',   help: 'two-finger tap' },
  { id: 'middleclick',fingers: 3, action: 'middle click',  help: 'three-finger tap' },
  { id: 'draglock',   fingers: 1, action: 'hold left',     help: 'tap, then press and drag; hold still to lock, tap to release' },
  { id: 'zoneright',  fingers: 1, action: 'right click',   help: 'tap the right third of the button strip along the bottom' },
  { id: 'zonemiddle', fingers: 1, action: 'middle click',  help: 'tap the narrow middle of the button strip' },
].map(Object.freeze));

const COACH = [
  'two fingers scroll · two-finger tap right-clicks',
  'three-finger tap middle-clicks · tap then drag to select',
];

const COACH_SESSIONS = 3;
const LONG_PRESS_MS = 600;
const PAD_KEY = 'nib.pad';
const COACH_KEY = 'nib.pad.coached';

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const clamp8 = (v) => (v > 127 ? 127 : v < -127 ? -127 : v);

// Browser storage throws in private mode and comes back empty in previews, so
// nothing here may be load-bearing.
const memoryStore = (() => {
  const mem = new Map();
  return {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) return JSON.parse(raw);
      } catch { /* fall through to memory */ }
      return mem.has(key) ? mem.get(key) : fallback;
    },
    set(key, value) {
      mem.set(key, value);
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };
})();

// =========================================================================
// layer 1 — the recogniser. Pure: no DOM, no BLE, no Date.now.
// =========================================================================

/**
 * A touch gesture state machine.
 *
 * Feed it down/move/up/cancel with ids and coordinates; listen for
 * gesturestart, pan, scroll, tap, holdstart, holdmove, holdend, swipe and
 * gestureend. Inject `now`, `schedule` and `unschedule` and a test can drive
 * the whole thing on a virtual clock, calling `tick(t)` to fire due timers.
 */
export function createRecogniser(options = {}) {
  const config = Object.assign({}, DEFAULTS, options.config || {});

  const clock = options.now || (typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now());
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const unschedule = options.unschedule || ((h) => clearTimeout(h));

  const listeners = new Map();

  function emit(type, detail) {
    const set = listeners.get(type);
    if (!set) return;
    // A throwing listener must not be able to strand a held button.
    for (const fn of Array.from(set)) { try { fn(detail); } catch { /* ignore */ } }
  }

  // ---- timers -----------------------------------------------------------
  // Kept in a list as well as handed to `schedule`, so a virtual clock can
  // flush them through tick() while real timers fire themselves.
  const timers = new Map();   // name -> { due, fn, handle }

  function setTimer(name, ms, fn) {
    clearTimer(name);
    const entry = { due: lastT + ms, fn, handle: null };
    timers.set(name, entry);
    entry.handle = schedule(() => { if (timers.get(name) === entry) { timers.delete(name); fn(entry.due); } }, ms);
  }

  function clearTimer(name) {
    const entry = timers.get(name);
    if (!entry) return;
    timers.delete(name);
    try { unschedule(entry.handle); } catch { /* ignore */ }
  }

  function runDue(t) {
    // Sorted, because a watchdog and a settle can come due in the same step.
    const due = Array.from(timers.entries())
      .filter(([, e]) => e.due <= t)
      .sort((a, b) => a[1].due - b[1].due);
    for (const [name, entry] of due) {
      if (timers.get(name) !== entry) continue;
      timers.delete(name);
      try { unschedule(entry.handle); } catch { /* ignore */ }
      entry.fn(t);
    }
  }

  // ---- state ------------------------------------------------------------
  let lastT = clock();
  let phase = 'idle';           // idle | active | settling | holding
  const contacts = new Map();   // id -> contact, keyed by pointerId/identifier
  let lifted = [];              // contacts released recently, for group()
  let seq = 0;                  // down order inside the gesture
  let gestureT = 0;
  let peak = 0;
  let anyFar = false;           // a contact travelled past tapSlop
  let anyLong = false;          // a contact stayed down past tapTime
  let base = null;              // centroid baseline, re-seeded on every add/remove
  let originCentroid = null;    // gesture start, for swipe
  let lastCentroid = null;
  let held = { dx: 0, dy: 0 };  // pan held back by panSlop
  let panOpen = false;          // panSlop already satisfied
  let holding = false;          // left button down on the host
  let locked = false;           // ... and latched, i.e. no finger needed
  let holdT0 = 0;
  let holdTravel = 0;
  let touchT0 = 0;              // this gesture's first contact, for the latch test
  let touchTravel = 0;
  let armUntil = -Infinity;     // drag-lock arming window after a 1-finger tap
  let armPos = null;

  const live = () => Array.from(contacts.values());
  const all = () => live().concat(lifted);

  function newest() {
    let best = null;
    for (const c of all()) if (!best || c.seq > best.seq) best = c;
    return best;
  }

  function centroid() {
    const cs = live();
    if (!cs.length) return null;
    let x = 0, y = 0;
    for (const c of cs) { x += c.x; y += c.y; }
    return { x: x / cs.length, y: y / cs.length };
  }

  /**
   * Fingers involved at time t: the ones down now, plus the ones lifted less
   * than `settle` ago that landed at least `groupSpread` from the newest
   * contact. Distance and time must both agree, which is what stops a fast
   * double-tap in one spot from reading as a two-finger tap.
   */
  function groupAt(t) {
    const ref = newest();
    if (!ref) return 0;
    let n = contacts.size;
    if (!contacts.has(ref.id)) n += 1;            // the anchor itself is a finger
    for (const l of lifted) {
      if (l === ref) continue;
      if (t - l.tUp >= config.settle) continue;
      if (dist(l.x0, l.y0, ref.x0, ref.y0) >= config.groupSpread) n += 1;
    }
    return n;
  }

  // Returns the running peak, not the instantaneous group: a tap is classified
  // by the most fingers it ever had, so a late lander can raise it and a lift
  // can never lower it.
  function notePeak(t) {
    const g = groupAt(t);
    if (g > peak) peak = g;
    return peak;
  }

  function armWatchdog() {
    if (contacts.size || holding) setTimer('watchdog', config.holdWatchdog, (t) => cancelAll(t));
    else clearTimer('watchdog');
  }

  function resetGesture() {
    contacts.clear();
    lifted = [];
    seq = 0;
    peak = 0;
    anyFar = anyLong = false;
    base = originCentroid = lastCentroid = null;
    held = { dx: 0, dy: 0 };
    panOpen = false;
    touchTravel = 0;
    phase = holding ? 'holding' : 'idle';
    clearTimer('settle');
  }

  function endHold(t) {
    if (!holding) return;
    holding = false;
    locked = false;
    holdTravel = 0;
    emit('holdend', { t });
    if (phase === 'holding') phase = contacts.size ? 'active' : 'idle';
  }

  // ---- input ------------------------------------------------------------

  function down(id, x, y, t = clock()) {
    lastT = t;
    runDue(t);

    if (contacts.has(id)) contacts.delete(id);

    const resuming = phase === 'settling';
    if (resuming) clearTimer('settle');          // a late finger resumes, never restarts

    const fresh = !contacts.size && !resuming;
    if (fresh) {
      // A brand-new gesture. Keep `holding` across it: that is drag-lock.
      lifted = [];
      seq = 0;
      peak = 0;
      anyFar = anyLong = false;
      held = { dx: 0, dy: 0 };
      panOpen = false;
      gestureT = t;
      touchT0 = t;
      touchTravel = 0;
      originCentroid = { x, y };
    }

    const c = { id, x0: x, y0: y, x, y, t0: t, travel: 0, seq: seq++ };
    contacts.set(id, c);

    phase = holding ? 'holding' : 'active';
    base = centroid();                            // re-seed: a count change must inject no delta
    lastCentroid = base;
    notePeak(t);

    if (fresh) {
      emit('gesturestart', { x, y, t });

      // Drag-lock arms on the *second* touchdown, so a plain double-tap is a
      // double click for free and the same gesture continued into motion
      // selects text or moves a window.
      if (!holding && t <= armUntil && armPos && dist(x, y, armPos.x, armPos.y) <= config.doubleTapSlop) {
        holding = true;
        locked = false;
        holdT0 = t;
        holdTravel = 0;
        phase = 'holding';
        emit('holdstart', { x, y, t });
      }
      armUntil = -Infinity;
      armPos = null;
    }

    armWatchdog();
  }

  function move(id, x, y, t = clock()) {
    lastT = t;
    runDue(t);

    const c = contacts.get(id);
    if (!c) return;
    c.x = x; c.y = y;
    c.travel = Math.max(c.travel, dist(x, y, c.x0, c.y0));
    if (c.travel > config.tapSlop) anyFar = true;
    if (t - c.t0 > config.tapTime) anyLong = true;

    const cen = centroid();
    if (!cen || !base) { armWatchdog(); return; }

    const dx = cen.x - base.x;
    const dy = cen.y - base.y;
    base = cen;
    lastCentroid = cen;
    touchTravel += Math.abs(dx) + Math.abs(dy);
    if (holding) holdTravel += Math.abs(dx) + Math.abs(dy);

    const n = contacts.size;

    if (holding) {
      if (n === 1 && (dx || dy)) emit('holdmove', { dx, dy, x: cen.x, y: cen.y, t });
      armWatchdog();
      return;
    }

    if (n >= 3) { armWatchdog(); return; }        // nothing is sent on three fingers

    if (n === 2) {
      // One wheel axis exists, so dx of a two-finger drag is discarded.
      if (dy) emit('scroll', { dy, x: cen.x, y: cen.y, t });
      armWatchdog();
      return;
    }

    // One finger: pan. Inside the opening window, hold back the first few
    // pixels so a would-be scroll does not move the pointer while the second
    // finger is still in the air. After that, pan is slop-free.
    if (!panOpen) {
      held.dx += dx;
      held.dy += dy;
      const far = Math.hypot(held.dx, held.dy) >= config.panSlop;
      const late = t - gestureT >= config.coalesce;
      if (!far && !late) { armWatchdog(); return; }
      panOpen = true;
      const hx = held.dx, hy = held.dy;
      held = { dx: 0, dy: 0 };
      emit('pan', { dx: hx, dy: hy, x: cen.x, y: cen.y, speed: Math.hypot(hx, hy), t });
      armWatchdog();
      return;
    }

    if (dx || dy) emit('pan', { dx, dy, x: cen.x, y: cen.y, speed: Math.hypot(dx, dy), t });
    armWatchdog();
  }

  function up(id, t = clock()) {
    lastT = t;
    runDue(t);
    release(id, t, false);
  }

  function cancel(id, t = clock()) {
    lastT = t;
    runDue(t);
    release(id, t, true);
  }

  function release(id, t, cancelled) {
    const c = contacts.get(id);
    if (!c) return;
    contacts.delete(id);
    if (t - c.t0 > config.tapTime) anyLong = true;

    if (!cancelled) {
      lifted.push(Object.assign({}, c, { tUp: t }));
      notePeak(t);
    }

    if (contacts.size) {
      base = centroid();                          // re-seed so the lift injects no jump
      lastCentroid = base;
      armWatchdog();
      return;
    }

    if (cancelled) { abort(t); return; }
    allUp(t);
  }

  function allUp(t) {
    const p = Math.min(notePeak(t), config.maxContacts);
    const dur = t - touchT0;
    const quiet = touchTravel <= config.tapSlop && !anyFar;

    if (holding) {
      // How the finger leaves decides whether the button stays down.
      if (locked) {
        // A latched hold: a quick still tap releases, anything else keeps
        // dragging where it left off.
        if (quiet && dur < config.tapTime) endHold(t);
      } else if (holdTravel > config.tapSlop) {
        endHold(t);                               // a drag finished
      } else if (t - holdT0 < config.tapTime) {
        endHold(t);                               // the second half of a double click
      } else {
        locked = true;                            // deliberate hold: latch it
      }
      finish(t, p);
      return;
    }

    const isTap = !anyFar && !anyLong && quiet && dur <= config.tapTime + config.settle;

    if (!isTap) {
      if (config.swipe) trySwipe(t, p, dur);
      finish(t, p);
      return;
    }

    // Commit is asymmetric, because a late finger can only raise the count:
    // one finger commits now, three commit now (there is no 4-finger gesture),
    // only two wait out `settle`. 80 ms before a context menu is not felt;
    // 80 ms on a left click is.
    if (p === 2) {
      phase = 'settling';
      setTimer('settle', config.settle, (tt) => {
        const fp = Math.min(notePeak(tt), config.maxContacts);
        commitTap(fp, tt);
        finish(tt, fp);
      });
      return;
    }

    commitTap(p, t);
    finish(t, p);
  }

  function commitTap(fingers, t) {
    const pos = lastCentroid || originCentroid || { x: 0, y: 0 };
    if (fingers < 1) return;
    // Where the gesture STARTED decides the zone, exactly like hardware: a
    // finger that slid a few pixels out of the strip still clicked the strip.
    const from = originCentroid || pos;
    let zone = null;
    if (typeof config.zoneAt === 'function') {
      try { zone = config.zoneAt(from.x, from.y) || null; } catch { zone = null; }
    }
    emit('tap', { fingers, x: pos.x, y: pos.y, zone, t });
    if (fingers === 1) {
      armUntil = t + config.doubleTapTime;        // next touchdown arms drag-lock
      armPos = { x: pos.x, y: pos.y };
    }
  }

  function trySwipe(t, fingers, dur) {
    if (!originCentroid || !lastCentroid) return;
    if (dur > config.swipeMaxTime) return;
    const dx = lastCentroid.x - originCentroid.x;
    const dy = lastCentroid.y - originCentroid.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const distance = horizontal ? Math.abs(dx) : Math.abs(dy);
    if (distance < config.swipeMin) return;
    const dir = horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    emit('swipe', { fingers: Math.max(1, fingers), dir, distance, t });
  }

  function finish(t, contactsPeak) {
    emit('gestureend', { contacts: contactsPeak, t });
    resetGesture();
    armWatchdog();
  }

  function abort(t) {
    // A cancelled gesture never produces a tap, and never leaves a hold on.
    clearTimer('settle');
    endHold(t);
    emit('gestureend', { contacts: 0, t, cancelled: true });
    resetGesture();
    armWatchdog();
  }

  function cancelAll(t = clock()) {
    lastT = t;
    const had = contacts.size || holding || phase !== 'idle';
    contacts.clear();
    clearTimer('settle');
    endHold(t);
    if (had) emit('gestureend', { contacts: 0, t, cancelled: true });
    resetGesture();
    armWatchdog();
  }

  function reset() {
    // Silent, except that a holdstart is always answered by a holdend.
    clearTimer('settle');
    clearTimer('watchdog');
    endHold(lastT);
    contacts.clear();
    resetGesture();
    armUntil = -Infinity;
    armPos = null;
  }

  const rec = {
    down, move, up, cancel, cancelAll, reset,
    tick(t = clock()) { lastT = t; runDue(t); },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => rec.off(type, fn);
    },
    off(type, fn) { listeners.get(type)?.delete(fn); },
    snapshot() {
      return {
        phase,
        contacts: contacts.size,
        group: groupAt(lastT),
        peak,
        holding,
        locked,
      };
    },
    config,
  };

  return rec;
}

// =========================================================================
// layer 2 — the DOM adapter. The only part that knows about touch events.
// =========================================================================

/**
 * Feed a recogniser from an element. Returns a detach function.
 *
 * Contacts are keyed by pointerId / Touch.identifier, never touches[0]:
 * reading touches[0] is why lifting the first finger of a two-finger scroll
 * makes the pointer jump to the other finger.
 */
export function attachRecogniser(el, rec, opts = {}) {
  const ignore = typeof opts.ignore === 'function' ? opts.ignore : null;
  const mouse = opts.mouse !== false;
  const off = [];

  const bind = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    off.push(() => target.removeEventListener(type, fn, options));
  };

  const notOurs = new Set();    // touch path: identifiers that began on an ignored target
  const ours = new Set();       // pointer path: pointerIds we took
  const ignored = (target) => {
    if (!ignore) return false;
    try { return !!ignore(target); } catch { return false; }
  };

  // `'ontouchstart' in window` is a CAPABILITY probe, not a statement about the
  // device in front of you: every Chromebook, most Windows laptops, a Surface,
  // an iPad with a Magic Keyboard and any Chrome that has had device emulation
  // toggled all report it. Binding only touch there meant the mouse could not
  // drive the pad at all, and opts.mouse could never take effect. So bind BOTH
  // whenever both exist, and de-duplicate per event instead.
  const useTouch = typeof window !== 'undefined' && 'ontouchstart' in window;
  const usePointer = typeof window !== 'undefined' && !!window.PointerEvent;

  let touchLive = 0;            // contacts the touch path currently owns

  if (useTouch) {
    bind(el, 'touchstart', (e) => {
      let took = false;
      for (const t of e.changedTouches) {
        if (ignored(t.target)) { notOurs.add(t.identifier); continue; }
        took = true;
        touchLive++;
        rec.down(t.identifier, t.clientX, t.clientY);
      }
      if (took) e.preventDefault();               // never on an ignored target, or its click dies
    }, { passive: false });

    bind(el, 'touchmove', (e) => {
      let took = false;
      for (const t of e.changedTouches) {
        if (notOurs.has(t.identifier)) continue;
        took = true;
        rec.move(t.identifier, t.clientX, t.clientY);
      }
      if (took) e.preventDefault();
    }, { passive: false });

    const end = (cancelled) => (e) => {
      for (const t of e.changedTouches) {
        if (notOurs.delete(t.identifier)) continue;
        touchLive = Math.max(0, touchLive - 1);
        if (cancelled) rec.cancel(t.identifier); else rec.up(t.identifier);
      }
    };
    bind(el, 'touchend', end(false), { passive: false });
    bind(el, 'touchcancel', end(true), { passive: false });
  }

  if (usePointer) {
    // The de-duplication rule: when the touch path is bound it owns every
    // finger. A mouse is never a finger, so it always comes through here. A pen
    // normally produces touch events too, so it comes through only when the
    // touch path did not already take a contact for it.
    const duplicate = (e) => {
      if (!useTouch) return false;
      if (e.pointerType === 'mouse') return false;
      if (e.pointerType === 'pen' && touchLive === 0) return false;
      return true;
    };

    bind(el, 'pointerdown', (e) => {
      if (duplicate(e)) return;
      if (e.pointerType === 'mouse' && !mouse) return;
      if (e.pointerType === 'mouse' && e.button > 0) return;   // right-click is the host's
      if (ignored(e.target)) return;
      ours.add(e.pointerId);
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      rec.down(e.pointerId, e.clientX, e.clientY);
    });
    bind(el, 'pointermove', (e) => {
      if (!ours.has(e.pointerId)) return;
      rec.move(e.pointerId, e.clientX, e.clientY);
    });
    bind(el, 'pointerup', (e) => {
      if (!ours.delete(e.pointerId)) return;
      rec.up(e.pointerId);
    });
    bind(el, 'pointercancel', (e) => {
      if (!ours.delete(e.pointerId)) return;
      rec.cancel(e.pointerId);
    });
    bind(el, 'lostpointercapture', (e) => {
      if (!ours.delete(e.pointerId)) return;
      rec.cancel(e.pointerId);
    });
  } else if (!useTouch && mouse) {
    // Very old desktop browser: plain mouse, one contact.
    let down = false;
    bind(el, 'mousedown', (e) => {
      if (ignored(e.target)) return;
      down = true;
      e.preventDefault();
      rec.down('mouse', e.clientX, e.clientY);
    });
    bind(window, 'mousemove', (e) => { if (down) rec.move('mouse', e.clientX, e.clientY); });
    bind(window, 'mouseup', () => { if (down) { down = false; rec.up('mouse'); } });
  }

  // Every path that can start a gesture needs a matching cancel path, or a
  // stuck drag outlives the gesture.
  bind(el, 'contextmenu', (e) => e.preventDefault());
  bind(el, 'dragstart', (e) => e.preventDefault());
  const forget = () => { notOurs.clear(); ours.clear(); touchLive = 0; rec.cancelAll(); };
  bind(document, 'visibilitychange', () => { if (document.hidden) forget(); });
  bind(window, 'pagehide', forget);
  bind(window, 'blur', forget);

  return () => {
    for (const undo of off.splice(0)) { try { undo(); } catch { /* ignore */ } }
    notOurs.clear();
    ours.clear();
    touchLive = 0;
  };
}

// =========================================================================
// styles — injected once, built only from theme.css tokens with fallbacks
// =========================================================================

const CSS = `
[data-nib-pad]{position:relative;overflow:hidden;touch-action:none;user-select:none;
  -webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
[data-nib-pad] .pad-layer{position:absolute;inset:0;pointer-events:none;
  font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,system-ui,sans-serif);z-index:2}
[data-nib-pad] .pad-layer [hidden]{display:none!important}
.pad-note,.pad-coach,.pad-hud,.pad-hold{position:absolute;left:50%;transform:translateX(-50%);
  text-align:center;white-space:nowrap;max-width:92%}
.pad-note{display:none}
.pad-note-unused{top:calc(var(--space-3,12px));font-size:var(--text-micro,12px);
  letter-spacing:var(--tracking-wide,.02em);color:var(--alert,#ff8f85)}
.pad-coach{display:none}
.pad-coach-unused{top:50%;transform:translate(-50%,-50%);white-space:normal;max-width:84%;
  font-size:var(--text-caption,13px);line-height:var(--leading-normal,1.45);
  color:var(--muted,#9c9b95);transition:opacity var(--dur-3,260ms) var(--ease-out,ease)}
.pad-coach.out{opacity:0}
.pad-hud{top:50%;transform:translate(-50%,-50%);font-size:var(--text-lead,18px);
  font-weight:var(--weight-medium,550);letter-spacing:var(--tracking-tight,-.01em);
  color:var(--text,#f2f1ed);opacity:0;transition:opacity var(--dur-2,160ms) var(--ease-out,ease)}
.pad-hud.on{opacity:1}
.pad-hold{bottom:calc(var(--space-3,12px) + var(--safe-b,0px));font-size:var(--text-micro,12px);
  color:var(--accent,#edb872);background:var(--accent-quiet,rgba(237,184,114,.14));
  border:1px solid var(--accent-line,rgba(237,184,114,.45));
  border-radius:var(--radius-full,999px);padding:4px 10px}
.pad-corner{position:absolute;display:grid;place-items:center;
  width:var(--tap,44px);height:var(--tap,44px);padding:0;background:none;border:0;
  border-radius:var(--radius-full,999px);color:var(--text-2,#cdcbc4);font-size:18px;
  line-height:1;pointer-events:auto;cursor:pointer;opacity:.35;
  transition:opacity var(--dur-2,160ms) var(--ease-out,ease)}
.pad-corner:active{opacity:1}
.pad-corner:focus-visible{opacity:1;outline:var(--focus-width,2px) solid
  var(--focus,#edb872);outline-offset:var(--focus-offset,2px)}
.pad-corner.at-right{right:var(--space-2,8px);bottom:calc(var(--space-2,8px) + var(--safe-b,0px))}
.pad-corner.at-left{left:var(--space-2,8px);bottom:calc(var(--space-2,8px) + var(--safe-b,0px))}

/* The click division. Hairlines only: a real trackpad has no silkscreen either,
   and the wording lives in the drawer's gesture list. It is pointer-events:none
   and first in the layer, so it draws under the coach text, over the finger
   glow, and needs no entry in attachRecogniser's ignore() — which is exactly
   why .pad-corner does need one. 5fr 2fr 5fr is symmetric on purpose, so a
   left-handed corner needs no mirroring. */
.pad-buttons{position:absolute;left:0;right:0;bottom:0;
  height:calc(clamp(56px,20%,96px) + var(--safe-b,0px));padding-bottom:var(--safe-b,0px);
  display:grid;grid-template-columns:5fr 2fr 5fr;
  pointer-events:none;z-index:0;
  border-top:1px solid var(--line,rgb(255 255 255/8%))}
.pad-buttons > i{display:block;min-width:0;
  transition:background-color var(--dur-2,160ms) var(--ease-out,ease)}
.pad-buttons > i + i{border-left:1px solid var(--line,rgb(255 255 255/8%))}
.pad-buttons > i.is-armed{background:var(--accent-quiet,rgba(237,184,114,.14))}

`;

/** Inject the stylesheet. Idempotent; createTrackpad() calls it. */
export function padStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('nib-pad-css')) return;
  const style = document.createElement('style');
  style.id = 'nib-pad-css';
  style.textContent = CSS;
  document.head.append(style);
}

// =========================================================================
// layer 3a — the minimal trackpad. Knows about BLE, nothing else does.
// =========================================================================

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function buzz(on, pattern) {
  if (!on) return;
  haptic(Array.isArray(pattern) ? pattern[0] : pattern);
}

/**
 * The trackpad: surface, gestures, BLE writes, and the little chrome that
 * cannot be removed (connection warning, hold pill, gesture HUD, corner).
 */
export function createTrackpad(opts) {
  padStyles();

  const ble = opts.ble;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const store = opts.store || memoryStore;

  const stored = store.get(PAD_KEY, null);
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const rec = createRecogniser({ config: Object.assign({}, saved, opts.options || {}) });
  const cfg = rec.config;                          // one live object for both layers

  // ---- surface ----------------------------------------------------------
  const adopted = opts.surface || null;
  const surface = adopted || el('div', 'pad-surface');
  surface.setAttribute('data-nib-pad', '');
  surface.style.touchAction = 'none';
  surface.style.userSelect = 'none';
  surface.style.webkitUserSelect = 'none';
  surface.style.webkitTouchCallout = 'none';

  // The hint text in the owned markup is replaced by the coach and the HUD.
  const hidden = [];
  if (adopted) {
    for (const child of Array.from(adopted.children)) {
      if (child.tagName === 'SPAN') {
        hidden.push([child, child.style.display || '']);
        child.style.display = 'none';
      }
    }
  }

  const layer = el('div', 'pad-layer');
  const note = el('div', 'pad-note', 'not connected');
  note.setAttribute('role', 'status');
  const hold = el('div', 'pad-hold', 'holding · tap to release');
  // A latched left button is a mode the user cannot see if they cannot see the
  // screen, so it is announced the same way .pad-note is.
  hold.setAttribute('role', 'status');
  const hud = el('div', 'pad-hud');
  hud.setAttribute('aria-hidden', 'true');
  const coach = el('div', 'pad-coach');
  coach.append(document.createTextNode(COACH[0]), el('br'), document.createTextNode(COACH[1]));

  const corner = el('button', 'pad-corner', '⤢');
  corner.type = 'button';
  corner.hidden = true;                            // shown only once it does something
  corner.setAttribute('aria-label', 'Full screen');

  // The visible left / middle / right division, drawn rather than hit-tested.
  const buttons = el('div', 'pad-buttons');
  buttons.setAttribute('aria-hidden', 'true');
  const zoneEls = {
    left: el('i'),
    middle: el('i'),
    right: el('i'),
  };
  buttons.append(zoneEls.left, zoneEls.middle, zoneEls.right);

  note.hidden = true;
  hold.hidden = true;
  // .pad-buttons goes first: positioned siblings paint in tree order, so this
  // keeps the hairlines under the coach, the HUD and the hold pill.
  layer.append(buttons, note, coach, hud, hold, corner);
  surface.append(layer);
  placeCorner();

  // ---- the click zones --------------------------------------------------
  // Measured once per gesture, never per frame, and invalidated from outside
  // (rotation, the URL bar, a full-screen mount) through invalidateGeometry().
  let zoneRects = null;

  function readZones() {
    const out = [];
    for (const name of ['left', 'middle', 'right']) {
      const r = zoneEls[name].getBoundingClientRect();
      if (!r.width || !r.height) { zoneRects = null; return null; }
      out.push([name, r]);
    }
    zoneRects = out;
    return zoneRects;
  }

  /** 'left' | 'middle' | 'right' above the strip -> null. */
  function zoneAt(x, y) {
    const zs = zoneRects || readZones();
    if (!zs) return null;
    for (const [name, r] of zs) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return name;
    }
    return null;
  }

  const ZONE_BUTTON = { left: 1, middle: 4, right: 2 };
  const ZONE_LABEL = { left: 'click', middle: 'middle click', right: 'right click' };
  const ZONE_BUZZ = { left: 8, middle: [6, 40, 6, 40, 6], right: [6, 40, 6] };
  let armTimer = null;

  function flashZone(name) {
    const node = zoneEls[name];
    if (!node) return;
    clearTimeout(armTimer);
    for (const n of Object.values(zoneEls)) n.classList.remove('is-armed');
    node.classList.add('is-armed');
    armTimer = setTimeout(() => node.classList.remove('is-armed'), 120);
  }

  cfg.zoneAt = zoneAt;

  // First-run coach: three sessions, then never again.
  const coached = Number(store.get(COACH_KEY, 0)) || 0;
  if (coached >= COACH_SESSIONS) coach.hidden = true;
  else store.set(COACH_KEY, coached + 1);

  function placeCorner() {
    corner.classList.toggle('at-left', cfg.corner === 'left');
    corner.classList.toggle('at-right', cfg.corner !== 'left');
  }

  // ---- write shaping ----------------------------------------------------
  // One ble.move() per frame, sub-pixel remainder kept, and a frame bigger
  // than one packet split rather than clipped.
  let acc = { dx: 0, dy: 0, w: 0 };
  let frame = null;

  function queue(dx, dy, w = 0) {
    acc.dx += dx; acc.dy += dy; acc.w += w;
    if (frame != null) return;
    frame = requestAnimationFrame(flush);
  }

  function flush() {
    frame = null;
    let dx = Math.trunc(acc.dx), dy = Math.trunc(acc.dy), w = Math.trunc(acc.w);
    acc = { dx: acc.dx - dx, dy: acc.dy - dy, w: acc.w - w };
    let packets = 0;
    const max = Math.max(1, cfg.maxPacketsPerFrame | 0);
    while ((dx || dy || w) && packets < max) {
      const px = clamp8(dx), py = clamp8(dy), pw = clamp8(w);
      ble.move(px, py, pw);
      dx -= px; dy -= py; w -= pw;
      packets++;
    }
    // Anything still left moved further in one frame than the host can use;
    // queueing it would drift the pointer after the finger has stopped.
  }

  const gain = (speed) => cfg.sensitivity * (1 + Math.min(speed / cfg.accelKnee, cfg.accelMax));

  // ---- chrome -----------------------------------------------------------
  let hudTimer = null;

  function showHud(msg) {
    hud.textContent = msg;
    hud.classList.add('on');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('on'), cfg.hudMs);
  }

  function paintConnection() {
    const on = safeConnected();
    note.hidden = on;
    if (!on) hold.hidden = true;
  }

  function safeConnected() {
    try { return !!ble.isConnected(); } catch { return false; }
  }

  function dropCoach() {
    if (coach.hidden || coach.classList.contains('out')) return;
    coach.classList.add('out');
    setTimeout(() => { coach.hidden = true; }, 400);
  }

  // ---- gesture -> BLE ---------------------------------------------------
  let heldOnDisconnect = false;

  rec.on('gesturestart', () => {
    dropCoach();
    paintConnection();
    readZones();                 // one measurement per gesture, never per frame
    surface.classList.add('active');
  });

  rec.on('gestureend', () => {
    surface.classList.remove('active');
    // A hold that survives the lift is latched, and must say so.
    const snap = rec.snapshot();
    hold.hidden = !snap.holding;
    hold.textContent = snap.contacts ? 'holding' : 'holding · tap to release';
  });

  rec.on('pan', ({ dx, dy, speed }) => {
    const k = gain(speed);
    queue(dx * k, dy * k);
  });

  rec.on('holdmove', ({ dx, dy }) => {
    const k = gain(Math.hypot(dx, dy));
    queue(dx * k, dy * k);
  });

  // Scroll gets the same acceleration curve pan and holdmove have. A flat
  // divide is why a long page needed a dozen full-length swipes.
  rec.on('scroll', ({ dy }) => {
    const k = 1 + Math.min(Math.abs(dy) / cfg.accelKnee, cfg.accelMax);
    queue(0, 0, ((cfg.naturalScroll ? -dy : dy) * k) / cfg.scrollDivisor);
  });

  // Finger count is tested FIRST, so the zones and the multi-finger taps can
  // never contend: a two-finger tap in the right third already means right
  // click, which is what the zone would have said anyway.
  rec.on('tap', ({ fingers, zone }) => {
    if (fingers >= 3) {
      ble.button(4, 2);
      buzz(cfg.haptics, [6, 40, 6, 40, 6]);
      showHud('middle click');
      log('middle click');
      return;
    }
    if (fingers === 2) {
      ble.button(2, 2);
      buzz(cfg.haptics, [6, 40, 6]);
      showHud('right click');
      log('right click');
      return;
    }
    const name = ZONE_BUTTON[zone] ? zone : 'left';
    ble.button(ZONE_BUTTON[name], 2);
    buzz(cfg.haptics, ZONE_BUZZ[name]);
    if (zone) flashZone(name);
    showHud(ZONE_LABEL[name]);
    log(ZONE_LABEL[name]);
  });

  rec.on('holdstart', () => {
    ble.button(1, 1);
    buzz(cfg.haptics, 20);
    hold.hidden = false;
    hold.textContent = 'holding';
    showHud('holding');
    log('left button held');
  });

  rec.on('holdend', () => {
    ble.button(1, 0);
    hold.hidden = true;
    showHud('released');
    log('left button released');
  });

  const detach = attachRecogniser(surface, rec, {
    ignore: (t) => !!(t && t.closest && t.closest('.pad-corner,.pad-ignore,button,a,input,select,textarea')),
  });

  // ---- a real scroll wheel ----------------------------------------------
  // There was no wheel handler at all, so on a desktop the wheel did nothing.
  // One notch (100px in every engine that reports pixels) becomes one HID tick
  // at the default scroll speed, and the slider scales it from there.
  const WHEEL_PER_NOTCH = 100;
  const WHEEL_LINE_PX = 16;
  let wheelAcc = 0;

  function onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX
      : e.deltaMode === 2 ? WHEEL_PER_NOTCH * 3
        : 1;
    const notches = (e.deltaY * unit) / WHEEL_PER_NOTCH;
    // 24 / scrollDivisor is exactly the slider's 1..10; /3 makes the default
    // (divisor 8, slider 3) one tick per notch.
    wheelAcc += (-notches * (24 / cfg.scrollDivisor)) / 3;
    const ticks = Math.trunc(wheelAcc);
    if (!ticks) return;
    wheelAcc -= ticks;
    queue(0, 0, ticks);
  }
  surface.addEventListener('wheel', onWheel, { passive: false });

  // ---- keyboard access ---------------------------------------------------
  // A pointer surface with no keyboard path is simply unreachable for anyone who
  // cannot make a drag gesture. Arrows nudge, Shift nudges further, Enter and
  // Space click, PageUp/PageDown scroll.
  const NUDGE = 12;
  const NUDGE_FAST = 48;
  const ARROWS = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  };

  function onKeyDown(e) {
    // Only the surface itself. Anything the host has put inside it - the
    // desktop Capture button, the corner control - owns its own keys, and a
    // bubbled Enter must not also click the host's mouse.
    if (e.target !== surface) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const arrow = ARROWS[e.key];
    if (arrow) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE_FAST : NUDGE;
      queue(arrow[0] * step, arrow[1] * step);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      ble.button(1, 2);
      buzz(cfg.haptics, 8);
      showHud('click');
      log('click');
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      queue(0, 0, e.key === 'PageUp' ? 3 : -3);
    }
  }
  surface.addEventListener('keydown', onKeyDown);

  // ---- connection -------------------------------------------------------
  const bleEvents = ble.events instanceof EventTarget ? ble.events : null;

  const onStatus = (e) => {
    const state = e.detail;
    if (state !== 'connected') {
      // A held button on a link that is gone cannot be released; remember it.
      if (rec.snapshot().holding) heldOnDisconnect = true;
      rec.cancelAll();
    } else if (heldOnDisconnect) {
      // Fire-and-forget writes mean the host may still think it is held.
      heldOnDisconnect = false;
      try { ble.button(1, 0); } catch { /* ignore */ }
      log('re-sent button release after reconnect');
    }
    paintConnection();
  };
  bleEvents?.addEventListener('status', onStatus);

  const poll = setInterval(paintConnection, 2000);   // covers a transport with no events
  paintConnection();

  // ---- public -----------------------------------------------------------
  let cornerAction = null;

  const trackpad = {
    get element() { return surface; },
    get recogniser() { return rec; },

    getOptions() { return Object.assign({}, cfg); },

    setOptions(patch = {}) {
      let touched = false;
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS)) continue;
        cfg[k] = v;
        saved[k] = v;
        touched = true;
      }
      if (!touched) return;
      placeCorner();
      zoneRects = null;                // the strip may have moved with the corner
      cfg.zoneAt = zoneAt;             // never let a stored value replace it
      store.set(PAD_KEY, saved);
      delete saved.zoneAt;             // a function is not a setting
    },

    release() {
      rec.cancelAll();                 // guarantees holdend, which sends button(1,0)
      acc = { dx: 0, dy: 0, w: 0 };
      if (frame != null) { cancelAnimationFrame(frame); frame = null; }
      hold.hidden = true;
      surface.classList.remove('active');
    },

    hud: showHud,

    /**
     * Forget every cached rectangle. The app calls this from its one viewport
     * re-measure (rotation, the URL bar, the soft keyboard) and whenever the
     * surface is moved into or out of the full-screen shell. A stale rect is
     * what makes a control stop hitting where it looks.
     */
    invalidateGeometry() { zoneRects = null; },

    // Not in the minimum API: how the immersive shell borrows the corner.
    setCornerAction(fn, label) {
      cornerAction = typeof fn === 'function' ? fn : null;
      corner.hidden = !cornerAction;
      if (label) corner.setAttribute('aria-label', label);
    },
    setCornerVisible(on) { corner.hidden = !on || !cornerAction; },

    destroy() {
      trackpad.release();
      detach();
      surface.removeEventListener('wheel', onWheel);
      surface.removeEventListener('keydown', onKeyDown);
      clearInterval(poll);
      clearTimeout(hudTimer);
      clearTimeout(armTimer);
      bleEvents?.removeEventListener('status', onStatus);
      rec.reset();
      layer.remove();
      surface.classList.remove('active');
      surface.removeAttribute('data-nib-pad');
      for (const [node, display] of hidden) node.style.display = display;
      if (!adopted) surface.remove();
    },
  };

  corner.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cornerAction?.();
  });

  return trackpad;
}

export default {
  DEFAULTS, GESTURES, createRecogniser, attachRecogniser, createTrackpad, padStyles,
};
