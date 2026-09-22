// Full-screen control surfaces for the layouts that are not keyboards: a TV
// remote, a slide clicker and a media deck. They replace the key grid inside
// #stage-keys, fill it edge to edge with no keyboard shell around them, and
// are built from the Nacre UI vocabulary: warm-black buttons with a hairline
// edge and a top sheen, one pearl primary per surface, a round D-pad and
// rockers.
//
//   const pads = createPads({ mount: '#stage-keys', onKeys, onConsumer });
//   pads.has('tv')  -> true
//   pads.show('tv') / pads.hide()

import { KEY } from './keymap.js?v=12';
import { tap as haptic } from './haptics.js?v=12';

// Consumer-control usages (USB HID page 0x0C).
const C = {
  PLAY: 0xCD, NEXT: 0xB5, PREV: 0xB6, STOP: 0xB7, REW: 0xB4, FF: 0xB3,
  MUTE: 0xE2, VOL_UP: 0xE9, VOL_DOWN: 0xEA, BRIGHT_UP: 0x6F, BRIGHT_DOWN: 0x70,
  HOME: 0x223, BACK: 0x224, FWD: 0x225, REFRESH: 0x227, MENU: 0x40, SEARCH: 0x221,
  BROWSER: 0x196, MAIL: 0x18A, CALC: 0x192, EJECT: 0xB8,
};
// Letter positions are the same on US and ABNT2, which is all these need.
const LETTER = { b: 0x05, w: 0x1a };

// An action is one of: { key: 'NAME', mods }, { letter: 'b' }, { cons: usage }.
// `rep` makes it repeat while held.
const k = (key, mods = 0) => ({ key, mods });
const cn = (cons) => ({ cons });

const ICON = {
  up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', left: 'M15 6l-6 6 6 6', right: 'M9 6l6 6-6 6',
  back: 'M10 7l-5 5 5 5M5 12h9a5 5 0 0 1 0 10h-2',
  home: 'M4 11l8-7 8 7M6 10v10h12V10',
  menu: 'M5 7h14M5 12h14M5 17h14',
  play: 'M8 5l11 7-11 7z', stop: 'M7 7h10v10H7z',
  prev: 'M7 6v12M18 6l-8 6 8 6z', next: 'M17 6v12M6 6l8 6-8 6z',
  rew: 'M11 6l-8 6 8 6zM21 6l-8 6 8 6z', ff: 'M3 6l8 6-8 6zM13 6l8 6-8 6z',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4 4',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('pad-ico');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON[name]);
  svg.append(p);
  return svg;
}

// Gamepad buttons, in the firmware's (Linux) order; the face buttons are
// named by where they sit, drawn with Xbox letters.
const GP = { SOUTH: 0, EAST: 1, NORTH: 3, WEST: 4, LB: 6, RB: 7, LT: 8, RT: 9,
             SELECT: 10, START: 11, HOME: 12, L3: 13, R3: 14 };

export function createPads({ mount, onKeys = () => {}, onConsumer = () => {}, onGamepad = () => {}, haptics = true } = {}) {
  const host = typeof mount === 'string' ? document.querySelector(mount) : mount;
  const root = document.createElement('div');
  root.className = 'pad-root';
  root.hidden = true;
  host.append(root);
  let hapticsOn = haptics;

  function send(a) {
    if (a.cons) { try { onConsumer(a.cons); } catch { /* offline */ } return; }
    const usage = a.letter ? LETTER[a.letter] : KEY[a.key];
    if (usage == null) return;
    try { onKeys([[a.mods & 0xff, usage]]); } catch { /* offline */ }
  }

  // Press on pointerdown (instant), repeat while held when asked, and never
  // let the phone's own keyboard or a scroll steal the gesture.
  function bind(el, action, { rep = false } = {}) {
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; el.classList.remove('is-down'); };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('is-down');
      if (hapticsOn) haptic(8);
      send(action);
      if (rep) timer = setTimeout(() => { timer = setInterval(() => send(action), 90); }, 380);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, stop);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keyboard and screen readers: a click with no pointer behind it.
    el.addEventListener('click', (e) => { if (e.detail === 0) send(action); });
  }

  function btn(label, action, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad-btn' + (opts.cls ? ' ' + opts.cls : '');
    if (opts.icon) b.append(icon(opts.icon));
    if (label) {
      const s = document.createElement('span');
      s.className = opts.icon ? 'pad-cap' : 'pad-lbl';
      s.textContent = label;
      b.append(s);
    }
    b.setAttribute('aria-label', opts.aria || label || opts.icon);
    if (opts.area) b.style.gridArea = opts.area;
    bind(b, action, opts);
    return b;
  }

  function dpad(okAction) {
    const d = document.createElement('div');
    d.className = 'pad-dpad';
    for (const [dir, key] of [['up', 'UP'], ['right', 'RIGHT'], ['down', 'DOWN'], ['left', 'LEFT']]) {
      const w = btn('', k(key), { cls: 'pad-wedge pad-' + dir, icon: dir, rep: true, aria: dir });
      d.append(w);
    }
    d.append(btn('OK', okAction, { cls: 'pad-ok' }));
    return d;
  }

  function rocker(label, up, down) {
    const r = document.createElement('div');
    r.className = 'pad-rocker';
    r.append(
      btn('+', up, { cls: 'pad-rock-up', rep: true, aria: label + ' up' }),
      Object.assign(document.createElement('span'), { className: 'pad-rock-lbl', textContent: label }),
      btn('−', down, { cls: 'pad-rock-down', rep: true, aria: label + ' down' }),
    );
    return r;
  }

  // ---- gamepad state: always sent whole, at most once per frame ------------
  const gp = { lx: 0, ly: 0, rx: 0, ry: 0, lt: -127, rt: -127, hat: 0, buttons: 0 };
  const hatDirs = new Set();
  let gpFrame = 0;
  function gpSend() {
    if (gpFrame) return;
    gpFrame = requestAnimationFrame(() => { gpFrame = 0; try { onGamepad({ ...gp }); } catch { /* offline */ } });
  }
  function gpHat() {
    const u = hatDirs.has('up'), d = hatDirs.has('down'), l = hatDirs.has('left'), r = hatDirs.has('right');
    gp.hat = u && r ? 2 : d && r ? 4 : d && l ? 6 : u && l ? 8 : u ? 1 : r ? 3 : d ? 5 : l ? 7 : 0;
  }
  function gpReset() {
    Object.assign(gp, { lx: 0, ly: 0, rx: 0, ry: 0, lt: -127, rt: -127, hat: 0, buttons: 0 });
    hatDirs.clear();
    gpSend();
  }

  // A held gamepad button: sets its bit while down, clears it on release.
  function gpBtn(label, bit, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad-btn ' + (opts.cls || '');
    if (opts.icon) b.append(icon(opts.icon)); else b.textContent = label;
    b.setAttribute('aria-label', opts.aria || label);
    const down = (e) => {
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      b.classList.add('is-down');
      if (hapticsOn) haptic(6);
      if (opts.hat) { hatDirs.add(opts.hat); gpHat(); } else gp.buttons |= 1 << bit;
      if (opts.trigger) gp[opts.trigger] = 127;
      gpSend();
    };
    const up = () => {
      if (!b.classList.contains('is-down')) return;
      b.classList.remove('is-down');
      if (opts.hat) { hatDirs.delete(opts.hat); gpHat(); } else gp.buttons &= ~(1 << bit);
      if (opts.trigger) gp[opts.trigger] = -127;
      gpSend();
    };
    b.addEventListener('pointerdown', down);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }

  // An analog stick: drag the knob inside its well; it springs back to centre.
  function stick(xKey, yKey, clickBit, label) {
    const well = document.createElement('div');
    well.className = 'pad-stick';
    well.setAttribute('aria-label', label);
    const knob = document.createElement('div');
    knob.className = 'pad-knob';
    well.append(knob);
    let id = null, cx = 0, cy = 0, r = 1, moved = false, t0 = 0;
    const set = (dx, dy) => {
      const len = Math.hypot(dx, dy);
      if (len > r) { dx *= r / len; dy *= r / len; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      gp[xKey] = (dx / r) * 127;
      gp[yKey] = (dy / r) * 127;
      gpSend();
    };
    well.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id != null) return;
      id = e.pointerId;
      well.setPointerCapture?.(id);
      const box = well.getBoundingClientRect();
      cx = box.left + box.width / 2; cy = box.top + box.height / 2;
      r = box.width / 2 - knob.offsetWidth / 2;
      moved = false; t0 = performance.now();
      well.classList.add('is-down');
      set(e.clientX - cx, e.clientY - cy);
    });
    well.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      if (Math.hypot(e.clientX - cx, e.clientY - cy) > 8) moved = true;
      set(e.clientX - cx, e.clientY - cy);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      well.classList.remove('is-down');
      knob.style.transform = '';
      gp[xKey] = 0; gp[yKey] = 0;
      // A quick tap without travel is the stick's click (L3 / R3).
      if (!moved && performance.now() - t0 < 250) {
        gp.buttons |= 1 << clickBit; gpSend();
        setTimeout(() => { gp.buttons &= ~(1 << clickBit); gpSend(); }, 60);
      } else gpSend();
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) well.addEventListener(t, end);
    return well;
  }

  function cluster(cls, kids) {
    const c = document.createElement('div');
    c.className = 'pad-cluster ' + cls;
    c.append(...kids);
    return c;
  }

  function classicPad(withStick) {
    const shoulders = row('pad-row-shoulders',
      gpBtn('L', GP.LB, { cls: 'pad-bump' }),
      gpBtn('R', GP.RB, { cls: 'pad-bump' }));
    const move = withStick
      ? stick('lx', 'ly', GP.L3, 'Stick')
      : cluster('pad-cross', [
        gpBtn('', 0, { icon: 'up', hat: 'up', cls: 'pad-c-up', aria: 'up' }),
        gpBtn('', 0, { icon: 'left', hat: 'left', cls: 'pad-c-left', aria: 'left' }),
        gpBtn('', 0, { icon: 'right', hat: 'right', cls: 'pad-c-right', aria: 'right' }),
        gpBtn('', 0, { icon: 'down', hat: 'down', cls: 'pad-c-down', aria: 'down' }),
      ]);
    const face = cluster('pad-face', [
      gpBtn('Y', GP.NORTH, { cls: 'pad-f-top' }),
      gpBtn('X', GP.WEST, { cls: 'pad-f-left' }),
      gpBtn('B', GP.EAST, { cls: 'pad-f-right' }),
      gpBtn('A', GP.SOUTH, { cls: 'pad-f-bottom pad-primary' }),
    ]);
    const meta = row('pad-row-meta',
      gpBtn('Select', GP.SELECT, { cls: 'pad-meta' }),
      gpBtn('Start', GP.START, { cls: 'pad-meta' }));
    const main = row('pad-row-play',
      cluster('pad-side pad-side-l', [move]), meta, cluster('pad-side pad-side-r', [face]));
    return [shoulders, main];
  }

  function row(cls, ...kids) {
    const r = document.createElement('div');
    r.className = 'pad-row ' + (cls || '');
    r.append(...kids);
    return r;
  }

  const BUILD = {
    gamepad() {
      const shoulders = row('pad-row-shoulders',
        gpBtn('LT', GP.LT, { trigger: 'lt', cls: 'pad-trig' }),
        gpBtn('LB', GP.LB, { cls: 'pad-bump' }),
        gpBtn('RB', GP.RB, { cls: 'pad-bump' }),
        gpBtn('RT', GP.RT, { trigger: 'rt', cls: 'pad-trig' }));
      const dpadC = cluster('pad-cross', [
        gpBtn('', 0, { icon: 'up', hat: 'up', cls: 'pad-c-up', aria: 'up' }),
        gpBtn('', 0, { icon: 'left', hat: 'left', cls: 'pad-c-left', aria: 'left' }),
        gpBtn('', 0, { icon: 'right', hat: 'right', cls: 'pad-c-right', aria: 'right' }),
        gpBtn('', 0, { icon: 'down', hat: 'down', cls: 'pad-c-down', aria: 'down' }),
      ]);
      const face = cluster('pad-face', [
        gpBtn('Y', GP.NORTH, { cls: 'pad-f-top' }),
        gpBtn('X', GP.WEST, { cls: 'pad-f-left' }),
        gpBtn('B', GP.EAST, { cls: 'pad-f-right' }),
        gpBtn('A', GP.SOUTH, { cls: 'pad-f-bottom pad-primary' }),
      ]);
      const mid = row('pad-row-meta',
        gpBtn('Select', GP.SELECT, { cls: 'pad-meta' }),
        gpBtn('', GP.HOME, { icon: 'home', cls: 'pad-meta pad-meta-home', aria: 'Home' }),
        gpBtn('Start', GP.START, { cls: 'pad-meta' }));
      const main = row('pad-row-play',
        cluster('pad-side pad-side-l', [stick('lx', 'ly', GP.L3, 'Left stick'), dpadC]),
        mid,
        cluster('pad-side pad-side-r', [face, stick('rx', 'ry', GP.R3, 'Right stick')]));
      return [shoulders, main];
    },

    // The simple pads: one movement control, four face buttons, two shoulders.
    // What party and platform games (TowerFall and the like) actually use.
    gpclassic() { return classicPad(false); },
    gpstick() { return classicPad(true); },

    tv() {
      const top = row('pad-row-top',
        btn('Back', cn(C.BACK), { icon: 'back', cls: 'pad-round' }),
        btn('Home', cn(C.HOME), { icon: 'home', cls: 'pad-round' }),
        btn('Menu', cn(C.MENU), { icon: 'menu', cls: 'pad-round' }));
      const mid = row('pad-row-mid',
        rocker('VOL', cn(C.VOL_UP), cn(C.VOL_DOWN)),
        dpad(k('ENTER')),
        (() => {
          const col = document.createElement('div');
          col.className = 'pad-col';
          col.append(btn('Mute', cn(C.MUTE), { icon: 'mute', cls: 'pad-round' }),
                     btn('Search', cn(C.SEARCH), { icon: 'search', cls: 'pad-round' }));
          return col;
        })());
      const trans = row('pad-row-trans',
        btn('', cn(C.PREV), { icon: 'prev', aria: 'Previous' }),
        btn('', cn(C.REW), { icon: 'rew', rep: true, aria: 'Rewind' }),
        btn('', cn(C.PLAY), { icon: 'play', aria: 'Play or pause' }),
        btn('', cn(C.FF), { icon: 'ff', rep: true, aria: 'Fast forward' }),
        btn('', cn(C.NEXT), { icon: 'next', aria: 'Next' }));
      return [top, mid, trans];
    },

    slides() {
      const top = row('pad-row-small',
        btn('Start', k('F5')), btn('From here', k('F5', 2)), btn('End show', k('ESC')));
      const main = row('pad-row-main',
        btn('Previous', k('LEFT'), { icon: 'left', cls: 'pad-prev', rep: true }),
        btn('Next', k('RIGHT'), { icon: 'right', cls: 'pad-next pad-primary', rep: true }));
      const bottom = row('pad-row-small',
        btn('First', k('HOME')), btn('Black', { letter: 'b' }),
        btn('White', { letter: 'w' }), btn('Last', k('END')));
      return [top, main, bottom];
    },

    media() {
      const trans = row('pad-row-trans pad-row-big',
        btn('', cn(C.PREV), { icon: 'prev', cls: 'pad-round', aria: 'Previous' }),
        btn('', cn(C.PLAY), { icon: 'play', cls: 'pad-round pad-primary pad-hero', aria: 'Play or pause' }),
        btn('', cn(C.NEXT), { icon: 'next', cls: 'pad-round', aria: 'Next' }));
      const seek = row('pad-row-trans',
        btn('', cn(C.REW), { icon: 'rew', rep: true, aria: 'Rewind' }),
        btn('', cn(C.STOP), { icon: 'stop', aria: 'Stop' }),
        btn('', cn(C.FF), { icon: 'ff', rep: true, aria: 'Fast forward' }),
        btn('', cn(C.MUTE), { icon: 'mute', aria: 'Mute' }));
      const rockers = row('pad-row-rockers',
        rocker('VOL', cn(C.VOL_UP), cn(C.VOL_DOWN)),
        rocker('LIGHT', cn(C.BRIGHT_UP), cn(C.BRIGHT_DOWN)));
      const apps = row('pad-row-apps',
        btn('Back', cn(C.BACK)), btn('Forward', cn(C.FWD)), btn('Reload', cn(C.REFRESH)),
        btn('Home', cn(C.HOME)), btn('Search', cn(C.SEARCH)), btn('Browser', cn(C.BROWSER)),
        btn('Mail', cn(C.MAIL)), btn('Calc', cn(C.CALC)));
      return [trans, seek, rockers, apps];
    },
  };

  return {
    root,
    has: (id) => id in BUILD,
    show(id) {
      if (!(id in BUILD)) return false;
      root.replaceChildren(...BUILD[id]());
      root.dataset.pad = id;
      root.hidden = false;
      host.dataset.pad = id;
      return true;
    },
    hide() {
      if (/^(gamepad|gpclassic|gpstick)$/.test(root.dataset.pad || '')) gpReset();   // never leave a button held
      root.hidden = true;
      root.replaceChildren();
      delete host.dataset.pad;
    },
    setHaptics(on) { hapticsOn = !!on; },
  };
}

export default createPads;
