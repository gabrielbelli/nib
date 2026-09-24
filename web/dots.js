// The trackpad's dot field. A grid of dots under the pad that is invisible at
// rest and lights up around each finger, leaves a short wake behind a moving
// finger, and throws a ring out from every click.
//
// One canvas, no library, and no frame is drawn while nothing is moving.
//
// Why invisible at rest: the pad is meant to be true black when untouched (see
// #stage-pad in theme.css). The grid is revealed by touch, never shown.
//
// Coordinates in are CLIENT pixels, the same ones pad.js hands its recogniser,
// so a tap event's x/y can be fed straight to ripple().

import { prefersReducedMotion } from './motion.js?v=12';

// ---- look -----------------------------------------------------------------
const SPACING = 18;            // px between dots on a phone
const SPACING_WIDE = 22;       // ... and from 760px wide
const BASE_SIZE = 1.25;        // dot radius, px
const GROW = 4.2;              // extra radius at full influence
const PEAK_ALPHA = 0.8;        // opacity at full influence
const MIN_DRAW = 0.012;        // below this a dot is not drawn at all

// ---- the halo under each finger -------------------------------------------
const HALO_MIN = 120;          // radius, px; scales with the pad up to HALO_MAX
const HALO_MAX = 220;
const HALO_IN = 0.06;          // s
const HALO_OUT = 0.28;         // s after the finger lifts

// ---- the wake behind a moving finger --------------------------------------
const WAKE_EVERY = 1 / 30;     // s between samples ...
const WAKE_STEP = 12;          // ... unless the finger moved this far, px
const WAKE_MAX = 28;           // samples kept
const WAKE_LIFE = 0.7;         // s
const WAKE_RADIUS = 100;       // px
const WAVE_SPEED = 165;        // px/s
const WAVE_WIDTH = 30;         // px
const WAVE_PUSH = 3;           // px a passing wave shoves a dot

// ---- the click ring -------------------------------------------------------
const RING_SPEED = 340;        // px/s
const RING_WIDTH = 22;         // px
const RING_LIFE = 0.55;        // s
const RING_GAP = 0.09;         // s between the rings of a 2- or 3-finger tap
const RING_PUSH = 4;           // px

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const now = () => performance.now() / 1000;

/** The accent as a canvas colour. `--accent-rgb` is "r g b". */
function readColour(el) {
  const raw = getComputedStyle(el).getPropertyValue('--accent-rgb').trim();
  const parts = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  return parts.length === 3 ? `rgb(${parts.join(',')})` : 'rgb(237,184,114)';
}

/**
 * Mount a dot field inside `host`, under everything else in it. Returns
 * { down, move, up, ripple, clear, invalidate, destroy }.
 */
export function createDotField(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pad-dots';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;
  let dots = new Float32Array(0);     // x, y pairs
  let halo = HALO_MIN;
  let ratio = 1;                      // the devicePixelRatio the buffer was built for
  let colour = readColour(host);

  // Client -> local. Read once per contact, never per frame: the stage scales
  // the pad with a transform, and a rect read in the rAF after inline style
  // writes forces a layout every frame (the same reason app.js cached it).
  let map = null;

  const contacts = new Map();         // id -> { x, y, from, until }
  let wake = [];                      // { x, y, t, k }
  let rings = [];                     // { x, y, t, k }
  let raf = null;

  function build() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return false;
    width = w;
    height = h;
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const gap = w < 760 ? SPACING : SPACING_WIDE;
    const cols = Math.ceil(w / gap) + 1;
    const rows = Math.ceil(h / gap) + 1;
    const ox = (w - (cols - 1) * gap) / 2;
    const oy = (h - (rows - 1) * gap) / 2;
    dots = new Float32Array(cols * rows * 2);
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots[i++] = ox + c * gap;
        dots[i++] = oy + r * gap;
      }
    }
    halo = Math.min(HALO_MAX, Math.max(HALO_MIN, w * 0.16));
    colour = readColour(host);
    return true;
  }

  function measure() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) { map = null; return null; }
    map = {
      left: r.left,
      top: r.top,
      sx: host.clientWidth / r.width,
      sy: host.clientHeight / r.height,
    };
    return map;
  }

  function local(cx, cy) {
    const m = map || measure();
    if (!m) return null;
    return { x: (cx - m.left) * m.sx, y: (cy - m.top) * m.sy };
  }

  function kick() {
    if (raf == null && !document.hidden) raf = requestAnimationFrame(draw);
  }

  // Each contact keeps its own last sample, so two fingers scrolling do not
  // read each other as one finger jumping back and forth.
  function sampleWake(c, t) {
    if (prefersReducedMotion()) return;
    const { x, y } = c;
    const last = c.wake;
    const moved = last ? Math.hypot(x - last.x, y - last.y) : Infinity;
    if (last && t - last.t < WAKE_EVERY && moved < WAKE_STEP) return;
    // A first touch hits hardest; a finger resting in place barely stirs.
    const k = !last ? 1 : moved < 8 ? 0.35 : 0.55;
    wake.push({ x, y, t, k });
    if (wake.length > WAKE_MAX) wake.splice(0, wake.length - WAKE_MAX);
    c.wake = { x, y, t };
  }

  function haloFade(c, t) {
    const up = prefersReducedMotion() ? 1 : clamp01((t - c.from) / HALO_IN);
    if (c.until == null) return up;
    if (prefersReducedMotion()) return 0;
    return up * clamp01(1 - (t - c.until) / HALO_OUT);
  }

  function draw() {
    raf = null;
    // A window dragged to a screen of another density keeps its CSS size, so no
    // resize fires; the buffer is re-checked here instead, once per frame.
    if (width && Math.min(window.devicePixelRatio || 1, 2) !== ratio) width = 0;
    if (!width && !build()) return;
    const t = now();

    // Prune first, so an empty scene stops the loop.
    for (const [id, c] of contacts) if (c.until != null && haloFade(c, t) <= 0) contacts.delete(id);
    wake = wake.filter((s) => t - s.t < WAKE_LIFE);
    rings = rings.filter((r) => t - r.t < RING_LIFE);

    ctx.clearRect(0, 0, width, height);
    if (!contacts.size && !wake.length && !rings.length) return;

    const live = [];
    let changing = wake.length > 0 || rings.length > 0;
    for (const c of contacts.values()) {
      const f = haloFade(c, t);
      if (f > 0) live.push(c.x, c.y, f);
      if (c.until != null || f < 1) changing = true;
    }

    ctx.fillStyle = colour;
    for (let i = 0; i < dots.length; i += 2) {
      const hx = dots[i];
      const hy = dots[i + 1];
      let inf = 0;
      let ox = 0;
      let oy = 0;

      for (let j = 0; j < live.length; j += 3) {
        const d = Math.hypot(hx - live[j], hy - live[j + 1]);
        if (d < halo) inf = Math.max(inf, (1 - d / halo) ** 1.34 * live[j + 2]);
      }

      for (const s of wake) {
        const dx = hx - s.x;
        const dy = hy - s.y;
        const d = Math.hypot(dx, dy);
        if (d >= WAKE_RADIUS) continue;
        const age = t - s.t;
        const fade = 1 - age / WAKE_LIFE;
        const reveal = (1 - d / WAKE_RADIUS) ** 1.8 * fade * s.k;
        const wave = clamp01(1 - Math.abs(d - age * WAVE_SPEED) / WAVE_WIDTH) ** 2.4 * fade * s.k * 0.45;
        inf = Math.max(inf, reveal, wave);
        if (d > 0.1) {
          ox += (dx / d) * wave * WAVE_PUSH;
          oy += (dy / d) * wave * WAVE_PUSH;
        }
      }

      for (const r of rings) {
        const age = t - r.t;
        if (age < 0) continue;                       // a staggered ring not out yet
        const dx = hx - r.x;
        const dy = hy - r.y;
        const d = Math.hypot(dx, dy);
        const band = clamp01(1 - Math.abs(d - age * RING_SPEED) / RING_WIDTH);
        if (!band) continue;
        const wave = band ** 2 * (1 - age / RING_LIFE) * r.k;
        inf = Math.max(inf, wave * 0.9);
        if (d > 0.1) {
          ox += (dx / d) * wave * RING_PUSH;
          oy += (dy / d) * wave * RING_PUSH;
        }
      }

      const eased = 1 - (1 - Math.min(1, inf)) ** 2;
      if (eased < MIN_DRAW) continue;
      ctx.globalAlpha = eased * PEAK_ALPHA;
      ctx.beginPath();
      ctx.arc(hx + ox, hy + oy, BASE_SIZE + GROW * eased, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // A finger resting still draws the same frame forever, so stop asking for
    // frames; move(), down(), up() and ripple() all kick the loop again.
    if (changing) kick();
  }

  // ---- input ------------------------------------------------------------
  function down(id, cx, cy) {
    measure();                                       // a contact starting is the one moment the rect is read
    const p = local(cx, cy);
    if (!p) return;
    const t = now();
    const was = contacts.get(id);
    const c = { x: p.x, y: p.y, from: was && was.until == null ? was.from : t, until: null, wake: null };
    contacts.set(id, c);
    sampleWake(c, t);
    kick();
  }

  function move(id, cx, cy) {
    const c = contacts.get(id);
    if (!c || c.until != null) return;
    const p = local(cx, cy);
    if (!p) return;
    c.x = p.x;
    c.y = p.y;
    sampleWake(c, now());
    kick();
  }

  function up(id) {
    const c = contacts.get(id);
    if (!c || c.until != null) return;
    c.until = now();
    kick();
  }

  /** A click: one ring per finger, staggered. `strength` 0..1. */
  function ripple(cx, cy, fingers = 1, strength = 1) {
    if (prefersReducedMotion()) return;
    const p = local(cx, cy);
    if (!p) return;
    const t = now();
    const n = Math.max(1, Math.min(3, fingers | 0));
    for (let i = 0; i < n; i++) rings.push({ x: p.x, y: p.y, t: t + i * RING_GAP, k: strength });
    kick();
  }

  /** Let every halo fade out, e.g. when the page loses focus mid-gesture. */
  function clear() {
    const t = now();
    for (const c of contacts.values()) if (c.until == null) c.until = t;
    kick();
  }

  /** Called on rotation, the URL bar, or a move to another container. */
  function invalidate() {
    map = null;
    width = 0;                                       // rebuilt on the next frame
    kick();
  }

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(invalidate) : null;
  resize?.observe(host);
  const onHidden = () => {
    if (!document.hidden) return;
    contacts.clear();
    wake = [];
    rings = [];
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    ctx.clearRect(0, 0, width, height);
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('blur', clear);

  build();

  return {
    down, move, up, ripple, clear, invalidate,
    destroy() {
      resize?.disconnect();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', clear);
      if (raf != null) cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}

export default { createDotField };
