// One spring integrator for the whole app. No library, no npm, no keyframes.
//
// Why a spring and not a transition: a fixed-duration animation cannot be
// grabbed and reversed halfway. A spring can, because new input only changes
// the target and the motion stays continuous. So every gesture in app.js
// re-targets the SAME spring object through retarget(), which means an
// interrupt continues from the live value AND the live velocity - no jump, and
// no velocity brick wall at a reversal.
//
// Parameters are Apple's two, not the physics triplet:
//   bounce    0 = critically damped, no overshoot. Higher overshoots.
//   duration  the "response" in seconds: how fast it reaches the target. It is
//             not a duration - a spring has none; settling emerges.
//
// Units: run every spring in px-like units (pixels, or 0..100 for a progress)
// so the settle thresholds below mean the same thing everywhere.

const query = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

/** Checked live, because a phone can flip the setting under a running page. */
export const prefersReducedMotion = () => !!query?.matches;

const FRAME = 1 / 60;
// A dropped frame must not slow the spring down. dt used to be capped at one
// frame, so at 30fps the spring ran at half speed and a 360ms sheet took well
// over a second to be called done - and until it was done, data-drawer stayed
// at "drag". Four frames of catch-up is still stable for a critically damped
// spring at this stiffness (omega * dt stays under 2).
const MAX_DT = 4 / 60;
// And whatever the frame rate, a spring is over after three durations.
const DEADLINE = 3;

export function spring({
  from = 0, to = 0, velocity = 0, bounce = 0, duration = 0.36,
  onframe = () => {}, ondone = () => {},
} = {}) {
  let x = from;
  let v = velocity;
  let target = to;
  let zeta = 1 - bounce;                       // bounce 0 -> critically damped
  let omega = (2 * Math.PI) / Math.max(0.05, duration);
  let raf = null;
  let last = 0;
  let began = 0;
  let dead = false;

  const finish = () => {
    raf = null;
    x = target;
    v = 0;
    onframe(x);
    ondone(x);
  };

  const step = (now) => {
    raf = null;
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    const a = -omega * omega * (x - target) - 2 * zeta * omega * v;
    v += a * dt;
    x += v * dt;
    const settled = Math.abs(x - target) < 0.5 && Math.abs(v) < 30;
    const overdue = (now - began) / 1000 > duration * DEADLINE;
    if (settled || overdue) { finish(); return; }
    onframe(x);
    raf = requestAnimationFrame(step);
  };

  const start = () => {
    if (dead) return;
    // Reduced motion: no springs at all. One frame at the target, then done.
    //
    // ondone is deferred a microtask on purpose. Called synchronously it runs
    // *inside* this factory, before spring() has returned, so a caller writing
    // `handle = spring({ ondone: () => { handle = null; } })` has its null
    // immediately overwritten by the assignment of the already-finished object.
    // Every caller in app.js is shaped that way, so a synchronous callback left
    // dead spring handles behind under reduced motion.
    if (prefersReducedMotion()) {
      x = target;
      v = 0;
      onframe(x);
      Promise.resolve().then(() => ondone(x));
      return;
    }
    if (raf != null) return;
    last = performance.now();
    began = last;
    raf = requestAnimationFrame(step);
  };

  start();

  return {
    get value() { return x; },
    get velocity() { return v; },
    get settled() { return raf == null; },
    /** Aim somewhere else without losing the live value or velocity. */
    retarget(next, opts = {}) {
      began = performance.now();   // the deadline counts from the new target
      target = next;
      if (opts.velocity != null) v = opts.velocity;
      if (opts.bounce != null) zeta = 1 - opts.bounce;
      if (opts.duration != null) omega = (2 * Math.PI) / Math.max(0.05, opts.duration);
      start();
      return this;
    },
    /**
     * Freeze where it is. The caller reads .value to seed the next gesture.
     *
     * ondone is deliberately NOT called: callers rely on the freeze, because a
     * cancel is always a gesture taking the motion over mid-flight and the
     * settled state must not be published for a position the spring never
     * reached. The consequence is that **every caller owns re-settling**: if a
     * cancel is not followed by a new spring or retarget, whatever `ondone`
     * would have done (clearing the handle, writing data-drawer, un-inerting)
     * never happens and the UI freezes. See endDrag() in app.js.
     */
    cancel() {
      dead = true;
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
    },
    /** Take it over again after a cancel, from wherever it stopped. */
    revive() { dead = false; return this; },
  };
}

/**
 * Where a flick is going. Apple's exponential decay, not the textbook
 * v^2/2a: the snap target is chosen from this point, never from the release
 * point, which is what makes a small flick throw a panel all the way.
 */
export const project = (v, d = 0.998) => (v / 1000) * d / (1 - d);

/** Progressive resistance past an edge. A hard stop reads as frozen. */
export function rubberband(over, dim, c = 0.55) {
  return (over * dim * c) / (dim + c * Math.abs(over));
}

export default { spring, project, rubberband, prefersReducedMotion };
