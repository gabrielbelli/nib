const BASE = process.env.NIB_URL || 'https://localhost:9443';
// fuzz.mjs — state-machine fuzz of the sheet / top-row controls in real WebKit.
//
//   node fuzz.mjs <seed> [--n 150] [--safe 47,47] [--replay <json-array>] [--verbose]
//
// Seeded pseudo-random sequences of N actions; after EVERY action the five
// invariants are asserted. On failure: seed, action index, last 8 actions and
// the state trace are printed, then the sequence is minimised by re-running
// suffixes only (fresh page each time) and the shortest reproducing suffix is
// printed as a --replay argument. Exit 1 on failure, 0 otherwise.
//
// /probe is routed to 204 so this emulation never lands in the field log.
import { webkit, devices } from 'playwright';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEED = Number(argv.find((a) => /^\d+$/.test(a)) ?? 1);
const N = Number(opt('--n', 150));
const [SAFE_L, SAFE_R] = opt('--safe', '47,47').split(',').map(Number);
const REPLAY = opt('--replay', null) ? JSON.parse(opt('--replay')) : null;
const VERBOSE = argv.includes('--verbose');
// --reduce: the iPhone's Reduce Motion setting (prefers-reduced-motion: reduce).
// --stale:  a WKWebView-style cache that hands back a stale copy of the bare
//           URL; adds the 'reopen' action (bookmark tap in the same tab) and
//           invariant 6: the running document is the server's current build.
const REDUCE = argv.includes('--reduce');
const STALE = argv.includes('--stale');
let CURRENT = null, STALE_DOC = null;
const URL = opt('--origin', BASE + '') + '/?shell=phone';
// 390x664 is the device descriptor's own portrait box. A height-only resize
// (390x664 -> 390x844) leaves Playwright's WebKit with a stale layout viewport
// until the next touch (see vvlag.mjs), which is an emulation artefact, so the
// fuzz only ever rotates between the two boxes whose widths differ.
const PORTRAIT = { width: 390, height: 664 };
const LANDSCAPE = { width: 844, height: 390 };
const IDS = ['nib-menu', 'nib-mode', 'connect'];

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTIONS = [
  'tap:#nib-menu', 'tap:#nib-menu', 'tap:#nib-menu',      // weighted: the control under test
  'tap:#nib-done', 'tap:#nib-done',
  'tap:.nib-drawer-head button',
  'tap:#nib-mode', 'tap:#nib-mode',
  'tap:#connect',
  'tap:pad',
  'swipe:left:partial', 'swipe:left:full', 'swipe:right:partial', 'swipe:right:full',
  'rotate:portrait', 'rotate:landscape', 'rotate:landscape',
  'orientationchange',
  'focus:#pass', 'blur:#pass',
  'wait:50', 'wait:400', 'wait:1500',
  'visibility',
  ...(STALE ? ['reopen', 'reopen'] : []),
];

function sequence(seed, n) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(ACTIONS[Math.floor(r() * ACTIONS.length)]);
  return out;
}

// ------------------------------------------------------------------ page

async function makePage(browser) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true, ...(REDUCE ? { reducedMotion: 'reduce' } : {}) });
  if (STALE) {
    if (!STALE_DOC) {
      const live = await (await ctx.request.get(URL.replace(/\/\?shell=phone$/, '/'))).text();
      CURRENT = (live.match(/name="nib-v" content="\?v=(\d+)"/) || [])[1];
      STALE_DOC = live.replace(/\?v=\d+/g, '?v=' + String(Number(CURRENT) - 1000));
    }
    await ctx.route((u) => u.origin === new globalThis.URL(URL).origin && u.pathname === '/' && !u.searchParams.has('v'),
      (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: STALE_DOC }));
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  // A 503 from the proxy or a dropped TLS handshake leaves the page half
  // loaded (no stylesheet, or a module missing so app.js never runs). That is
  // a finding in its own right, never a silent pass.
  // 'cancelled' is a navigation (the self-updater reloading) cutting off
  // in-flight requests, not a server failure.
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'cancelled' && errors.push(`REQUEST FAILED ${r.url().replace(/^https?:\/\/[^/]+/, '')} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  await page.route('**/probe', (r) => r.fulfill({ status: 204 }));
  // Safe areas the way the phone reports them, per orientation. Playwright's
  // WebKit leaves env() at 0, so the fuzz writes what an iPhone 14 would.
  await page.addInitScript(({ l, r }) => {
    const s = document.createElement('style');
    s.id = 'fuzz-safe';
    const land = innerWidth > innerHeight;
    s.textContent = land
      ? `:root{--safe-t:0px;--safe-r:${r}px;--safe-b:21px;--safe-l:${l}px}`
      : ':root{--safe-t:47px;--safe-r:0px;--safe-b:34px;--safe-l:0px}';
    document.addEventListener('DOMContentLoaded', () => document.head.append(s));
  }, { l: SAFE_L, r: SAFE_R });
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(900);
      // Ready means the stylesheet applied (a 44px control) AND app.js ran
      // (pad.js built its layer): data-shell alone is static markup.
      await page.waitForFunction(() => document.getElementById('nib-menu') && getComputedStyle(document.getElementById('nib-menu')).width === '44px' && document.querySelector('#stage-pad .pad-layer'), null, { timeout: 8000 });
      if (errors.length) throw new Error('load errors: ' + errors.join(' | '));
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`   (page load retry ${attempt + 1}: ${e.message.split('\n')[0]})`);
    }
  }
  errors.length = 0;
  return { ctx, page, errors };
}

const setSafe = (page, land) => page.evaluate(({ land, l, r }) => {
  const s = document.getElementById('fuzz-safe');
  if (s) s.textContent = land
    ? `:root{--safe-t:0px;--safe-r:${r}px;--safe-b:21px;--safe-l:${l}px}`
    : ':root{--safe-t:47px;--safe-r:0px;--safe-b:34px;--safe-l:0px}';
}, { land, l: SAFE_L, r: SAFE_R });

// ------------------------------------------------------------------ invariants

const snapshot = (page) => page.evaluate(({ IDS, CURRENT }) => {
  const bad = [];
  const W = innerWidth, H = innerHeight;
  const drawer = document.getElementById('nib-drawer');
  const chrome = document.getElementById('nib-chrome');
  const stage = document.getElementById('nib-stage');
  const state = document.body.dataset.drawer;
  const p = parseFloat(document.documentElement.style.getPropertyValue('--p') || '0');
  const chromeOp = parseFloat(getComputedStyle(chrome).opacity);
  const stageTr = getComputedStyle(stage).transform;
  const who = (n) => (n ? (n.closest?.('button')?.id || n.id || n.className || n.tagName) : 'null');
  // 1
  if (state === 'closed') {
    if (chromeOp < 0.99) bad.push(`chrome opacity ${chromeOp} while closed`);
    if (stageTr !== 'none' && stageTr !== 'matrix(1, 0, 0, 1, 0, 0)') bad.push(`stage transform ${stageTr} while closed`);
    if (p >= 0.01) bad.push(`--p ${p} while closed`);
    if (!drawer.hidden) bad.push('drawer not hidden while closed');
  }
  // 2
  const ctl = {};
  for (const id of IDS) {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    ctl[id] = [r.left, r.top, r.width, r.height].map(Math.round);
    if (r.width < 44 || r.height < 44) bad.push(`${id} small ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) bad.push(`${id} off-screen ${ctl[id]} win ${W}x${H}`);
    if (state === 'closed') {
      const pts = [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]];
      for (const [fx, fy] of pts) {
        const h = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        const o = h && h.closest('button');
        if (!o || o.id !== id) { bad.push(`${id} @${fx},${fy} hits ${who(h)} (rect ${ctl[id]}, chromeOp ${chromeOp}, p ${p})`); break; }
      }
    }
  }
  // 3
  const vv = visualViewport;
  if (vv && Math.abs(vv.scale - 1) > 0.01) bad.push(`zoomed scale ${vv.scale}`);
  // 6 (--stale only)
  const baked = ((document.querySelector('meta[name="nib-v"]') || {}).content || '').replace(/^\?v=/, '');
  if (CURRENT && baked !== CURRENT) bad.push(`stale build running: baked ${baked}, server ${CURRENT}, url ${location.search}`);
  return {
    bad, state, p, hidden: drawer.hidden, mode: document.body.dataset.mode, win: [W, H],
    chromeOp, stageTr: stageTr === 'none' ? 'none' : stageTr.slice(0, 24), ctl,
    inert: [...document.querySelectorAll('[inert]')].map((n) => n.id || n.className).join(','),
    active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
    vv: vv ? [vv.width, vv.height, vv.offsetLeft, vv.offsetTop, vv.scale].map((n) => Math.round(n * 100) / 100) : null,
    aria: document.getElementById('nib-menu').getAttribute('aria-expanded'),
    menuTransform: document.getElementById('nib-menu').style.transform,
  };
}, { IDS, CURRENT });

// Invariant 5: a tap on #nib-menu opens, a tap on #nib-done closes (state changes).
async function liveness(page) {
  const bad = [];
  const before = await page.evaluate(() => document.body.dataset.drawer);
  if (before !== 'closed') {
    // bring it to closed first, via Done; if that fails, that is the finding
    const n0 = await tapEl(page, '#nib-done');
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() => document.body.dataset.drawer);
    if (s !== 'closed') bad.push(`liveness: #nib-done (${n0}) from '${before}' -> '${s}' (expected closed)`);
  }
  const n1 = await tapEl(page, '#nib-menu');
  await page.waitForTimeout(1200);
  const s1 = await page.evaluate(() => ({ d: document.body.dataset.drawer, hidden: document.getElementById('nib-drawer').hidden, p: document.documentElement.style.getPropertyValue('--p') }));
  if (s1.d !== 'open' || s1.hidden) bad.push(`liveness: #nib-menu (${n1}) did not open: ${JSON.stringify(s1)}`);
  const n2 = await tapEl(page, '#nib-done');
  await page.waitForTimeout(1200);
  const s2 = await page.evaluate(() => ({ d: document.body.dataset.drawer, hidden: document.getElementById('nib-drawer').hidden, p: document.documentElement.style.getPropertyValue('--p') }));
  if (s2.d !== 'closed' || !s2.hidden) bad.push(`liveness: #nib-done (${n2}) did not close: ${JSON.stringify(s2)}`);
  return bad;
}

// ------------------------------------------------------------------ actions

// A real touch at the centre of wherever the element currently paints. If the
// element has no box (drawer hidden), the tap is skipped: nothing to aim at.
async function tapEl(page, sel) {
  const c = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: h ? (h.closest('button')?.id || h.id || h.className || h.tagName) : 'null', W: innerWidth, H: innerHeight };
  }, sel);
  if (!c) return 'skipped (no box)';
  if (c.x < 0 || c.y < 0 || c.x > c.W || c.y > c.H) return `skipped (off-screen ${Math.round(c.x)},${Math.round(c.y)} in ${c.W}x${c.H})`;
  await page.touchscreen.tap(c.x, c.y);
  return `tap ${Math.round(c.x)},${Math.round(c.y)} on ${c.hit}`;
}

async function swipe(page, dir, extent) {
  return page.evaluate(async ({ dir, extent }) => {
    const el = document.getElementById('nib-drawer-grab');
    if (document.getElementById('nib-drawer').hidden) return 'skipped (drawer hidden)';
    const r = el.getBoundingClientRect();
    if (!r.width) return 'skipped (no box)';
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const dist = (extent === 'full' ? innerWidth * 0.7 : innerWidth * 0.18) * (dir === 'left' ? -1 : 1);
    const steps = 8;
    const ev = (type, x, opts = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y0, ...opts }));
    ev('pointerdown', x0, { button: 0, buttons: 1 });
    for (let i = 1; i <= steps; i++) { ev('pointermove', x0 + (dist * i) / steps, { buttons: 1 }); await new Promise((r) => setTimeout(r, 16)); }
    ev('pointerup', x0 + dist, { button: 0, buttons: 0 });
    return `swipe ${Math.round(dist)}px from ${Math.round(x0)},${Math.round(y0)}`;
  }, { dir, extent });
}

async function perform(page, action, st) {
  const [kind, a, b] = action.split(':');
  switch (kind) {
    case 'tap': {
      if (a === 'pad') {
        const c = await page.evaluate(() => { const r = document.getElementById('nib-stage').getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: h ? (h.id || h.className || h.tagName) : 'null', onStage: !!(h && h.closest('#nib-stage')) }; });
        // Covered by the sheet: the point is some random sheet control (the
        // Reload button navigates away, a <select> opens a picker). Not the
        // trackpad, so not this action.
        if (!c.onStage) return `skipped (sheet covers the pad: ${c.hit})`;
        await page.touchscreen.tap(c.x, c.y);
        await page.waitForTimeout(120);
        return `tap ${Math.round(c.x)},${Math.round(c.y)} on ${c.hit}`;
      }
      const note = await tapEl(page, a);
      // the spring is 360ms; the watchdog is 1200ms; give the state a chance to
      // land, but not always: 400ms leaves the tail of the spring exposed.
      await page.waitForTimeout(st.r() < 0.5 ? 450 : 1300);
      return note;
    }
    case 'swipe': {
      const note = await swipe(page, a, b);
      await page.waitForTimeout(st.r() < 0.5 ? 450 : 1300);
      return note;
    }
    case 'rotate': {
      const land = a === 'landscape';
      await page.setViewportSize(land ? LANDSCAPE : PORTRAIT);
      await setSafe(page, land);
      await page.evaluate(() => { window.dispatchEvent(new Event('orientationchange')); });
      await page.waitForTimeout(st.r() < 0.3 ? 200 : 1100);
      st.land = land;
      return land ? 'landscape' : 'portrait';
    }
    case 'orientationchange': {
      await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
      await page.waitForTimeout(st.r() < 0.5 ? 100 : 800);
      return 'dispatched';
    }
    case 'focus': {
      const ok = await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.focus({ preventScroll: false }); return document.activeElement === el; }, a);
      await page.waitForTimeout(300);
      return ok ? 'focused' : 'not focusable now';
    }
    case 'blur': {
      await page.evaluate(() => { document.activeElement?.blur?.(); });
      await page.waitForTimeout(300);
      return 'blurred';
    }
    case 'wait': {
      await page.waitForTimeout(Number(a));
      return `${a}ms`;
    }
    case 'reopen': {
      // bookmark tap: the same tab navigates to the bare URL again
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForTimeout(3000);
      await page.waitForFunction(() => document.getElementById('nib-menu') && getComputedStyle(document.getElementById('nib-menu')).width === '44px' && document.querySelector('#stage-pad .pad-layer'), null, { timeout: 8000 });
      await setSafe(page, st.land);
      return 'navigated to bare URL';
    }
    case 'visibility': {
      await page.evaluate(async () => {
        const set = (hidden) => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        set(true);
        await new Promise((r) => setTimeout(r, 80));
        set(false);
      });
      await page.waitForTimeout(400);
      return 'hidden->visible';
    }
    default: return 'unknown action';
  }
}

// ------------------------------------------------------------------ run

async function run(browser, actions, { probeEvery = 15, label = '' } = {}) {
  const { ctx, page, errors } = await makePage(browser);
  const st = { r: rng(SEED ^ 0x9e3779b9), land: false };
  const trace = [];
  let failure = null;
  const base = await snapshot(page);
  trace.push({ i: -1, action: 'fresh', note: '', snap: base });
  if (base.bad.length) failure = { i: -1, action: 'fresh', bad: base.bad };
  for (let i = 0; i < actions.length && !failure; i++) {
    const action = actions[i];
    let note;
    try { note = await perform(page, action, st); }
    catch (e) { note = 'THREW ' + e.message.split('\n')[0]; }
    const snap = await snapshot(page);
    const bad = [...snap.bad];
    if (errors.length) { bad.push(...errors.map((e) => 'console: ' + e)); errors.length = 0; }
    trace.push({ i, action, note, snap });
    if (VERBOSE) console.log(`  ${label}#${i} ${action} (${note}) -> ${fmt(snap)}`);
    if (bad.length) { failure = { i, action, bad }; break; }
    if ((i + 1) % probeEvery === 0 || i === actions.length - 1) {
      const lb = await liveness(page);
      const s2 = await snapshot(page);
      trace.push({ i: i + 0.5, action: 'liveness-probe', note: '', snap: s2 });
      if (lb.length || s2.bad.length) { failure = { i, action: action + ' (then liveness probe)', bad: [...lb, ...s2.bad] }; break; }
    }
  }
  await ctx.close();
  return { failure, trace };
}

const fmt = (s) => `${s.state} p=${s.p} hidden=${s.hidden} mode=${s.mode} win=${s.win.join('x')} chromeOp=${s.chromeOp} stage=${s.stageTr} menu=${s.ctl['nib-menu']} vv=${s.vv} active=${s.active} inert=[${s.inert}]`;

const browser = await webkit.launch();
const actions = REPLAY || sequence(SEED, N);
console.log(`seed=${SEED} n=${actions.length} safe=${SAFE_L},${SAFE_R}${REDUCE ? ' reduce-motion' : ''}${STALE ? ' stale-cache' : ''}`);
const { failure, trace } = await run(browser, actions);

if (!failure) {
  console.log(`PASS seed=${SEED}: ${actions.length} actions, all invariants held`);
  await browser.close();
  process.exit(0);
}

console.log(`FAIL seed=${SEED} at action #${failure.i} (${failure.action})`);
for (const b of failure.bad) console.log('   ' + b);
console.log('last 8 actions:');
const idx = Math.max(0, failure.i - 7);
for (const t of trace.filter((t) => t.i >= idx && t.i <= failure.i + 0.5)) console.log(`   #${t.i} ${t.action} (${t.note})`);
console.log('state trace:');
for (const t of trace.filter((t) => t.i >= idx)) console.log(`   #${t.i} ${t.action.padEnd(28)} ${fmt(t.snap)}`);

// ---- minimise: suffixes only, fresh page each time --------------------------
if (!REPLAY && failure.i >= 0) {
  const end = failure.i + 1;
  let best = actions.slice(0, end);
  let bestFail = failure;
  console.log('minimising...');
  const lens = [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 13, 17, 22, 30, 40, 55, 75, 100, 130].filter((l) => l < end))];
  for (const len of lens) {
    const suffix = actions.slice(end - len, end);
    const r = await run(browser, suffix, { probeEvery: suffix.length });
    if (r.failure) { best = suffix; bestFail = r.failure; console.log(`   suffix of ${len} reproduces: ${r.failure.bad[0]}`); break; }
    console.log(`   suffix of ${len}: no failure`);
  }
  console.log(`shortest reproducing sequence (${best.length}):`);
  console.log('   --replay ' + JSON.stringify(best).replace(/"/g, '\\"'));
  console.log('   fails with: ' + bestFail.bad.join(' | '));
}
await browser.close();
process.exit(1);
