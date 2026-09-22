const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Broad WebKit sweep: realistic sequences on an emulated iPhone, asserting the
// invariants that matter after every step. Prints only violations.
import { webkit, devices } from 'playwright';
const URL = BASE + '/?shell=phone';
const SAFE = process.argv[2] || '47,47';            // "left,right"
const [sl, sr] = SAFE.split(',').map(Number);
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
// Emulation, not the phone: keep this run out of the field log (probe.log).
await page.route('**/probe', (r) => r.fulfill({ status: 204 }));
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
await page.addInitScript(({ sl, sr }) => {
  const s = document.createElement('style');
  s.textContent = `:root{--safe-l:${sl}px;--safe-r:${sr}px;--safe-t:0px;--safe-b:21px}`;
  document.addEventListener('DOMContentLoaded', () => document.head.append(s));
}, { sl, sr });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(900);

const fails = [];
const invariants = async (label) => {
  const r = await page.evaluate(() => {
    const out = { bad: [] };
    const W = innerWidth, H = innerHeight;
    const drawer = document.body.dataset.drawer;
    const chrome = document.getElementById('nib-chrome');
    const stage = document.getElementById('nib-stage');
    const cs = getComputedStyle(chrome);
    if (drawer === 'closed') {
      if (parseFloat(cs.opacity) < 0.99) out.bad.push(`chrome opacity ${cs.opacity} while closed`);
      const tr = getComputedStyle(stage).transform;
      if (tr !== 'none' && tr !== 'matrix(1, 0, 0, 1, 0, 0)') out.bad.push(`stage transform ${tr} while closed`);
      const p = parseFloat(document.documentElement.style.getPropertyValue('--p') || '0');
      if (p > 0.01) out.bad.push(`--p ${p} while closed`);
    }
    for (const id of ['connect', 'nib-menu', 'nib-mode']) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) out.bad.push(`${id} off-screen ${[r.left, r.top, r.right, r.bottom].map(Math.round)} win ${W}x${H}`);
      if (r.width < 44 || r.height < 44) out.bad.push(`${id} small ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (drawer === 'closed') {
        const vis = [...el.querySelectorAll('svg, .nib-burger, .nib-dot')].find((n) => n.getBoundingClientRect().width > 0);
        const g = (vis || el).getBoundingClientRect();
        const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
        const owner = hit && hit.closest('button');
        if (!owner || owner.id !== id) out.bad.push(`${id} centre hits ${hit ? (hit.id || hit.className || hit.tagName) : 'null'}`);
        // the whole 44px box must belong to the button, not just its centre
        for (const [fx, fy] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]]) {
          const h2 = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          const o2 = h2 && h2.closest('button');
          if (!o2 || o2.id !== id) { out.bad.push(`${id} corner ${fx},${fy} hits ${h2 ? (h2.id || h2.className || h2.tagName) : 'null'}`); break; }
        }
      }
    }
    const vv = visualViewport;
    if (vv && Math.abs(vv.scale - 1) > 0.01) out.bad.push(`zoomed scale ${vv.scale}`);
    out.drawer = drawer; out.mode = document.body.dataset.mode;
    return out;
  });
  for (const b of r.bad) fails.push(`[${label}] ${b}`);
  return r;
};

const rotate = async (land) => {
  await page.setViewportSize(land ? { width: 844, height: 390 } : { width: 390, height: 844 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await page.waitForTimeout(1200);
};
const tap = async (sel) => {
  try { await page.tap(sel, { timeout: 2500 }); }
  catch (e) {
    const who = await page.evaluate((sel) => {
      const el = document.querySelector(sel); if (!el) return 'missing';
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return `${h ? (h.id || h.className || h.tagName) : 'null'} opacity=${getComputedStyle(el).opacity} drawer=${document.body.dataset.drawer}`;
    }, sel);
    fails.push(`[tap ${sel}] not tappable: ${who}`);
  }
  await page.waitForTimeout(650);
  const st = await page.evaluate(() => ({ d: document.body.dataset.drawer, hidden: document.getElementById('nib-drawer').hidden, p: document.documentElement.style.getPropertyValue('--p'), tr: getComputedStyle(document.getElementById('nib-stage')).transform }));
  trace.push(`${sel} -> ${JSON.stringify(st)}`);
};
const trace = [];

await invariants('fresh portrait');
await rotate(true);            await invariants('landscape');
await tap('#nib-menu');        await invariants('menu open (land)');
await tap('#nib-done');        await invariants('menu closed via done (land)');
await tap('#nib-menu');        await tap('.nib-drawer-head button'); await invariants('menu closed via its X (land)');
await tap('#nib-mode');        await invariants('keys mode (land)');
await tap('#nib-mode');        await invariants('back to pad (land)');
await tap('#nib-menu'); await rotate(false); await invariants('open then rotate to portrait');
await tap('#nib-done');        await invariants('closed in portrait');
await rotate(true);            await invariants('landscape again');
// drag the sheet closed with a swipe from its grab handle
await tap('#nib-menu');
// Real pointer-event swipe on the grab handle: down, eight moves leftward, up.
await page.evaluate(async () => {
  const el = document.getElementById('nib-drawer-grab');
  const r = el.getBoundingClientRect();
  const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
  const ev = (type, x, opts = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y0, ...opts }));
  ev('pointerdown', x0, { button: 0, buttons: 1 });
  for (let i = 1; i <= 8; i++) { ev('pointermove', x0 - i * 60, { buttons: 1 }); await new Promise((r) => setTimeout(r, 16)); }
  ev('pointerup', x0 - 480, { button: 0, buttons: 0 });
});
await page.waitForTimeout(1000);
await invariants('after swipe close (land)');
// soft keyboard: focus the password field inside the sheet, then blur, close
await tap('#nib-menu');
const pw = await page.$('#pass');
if (pw) { await pw.focus(); await page.waitForTimeout(500); await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(300); }
await tap('#nib-done');        await invariants('after input focus/blur (land)');
await rotate(false); await rotate(true); await invariants('double rotate');
await page.screenshot({ path: `/tmp/sweep-${SAFE.replace(',', '-')}.png` });

console.log(`safe=${SAFE} errors=${errors.length} fails=${fails.length}`);
for (const e of errors) console.log('  ' + e);
for (const f of fails) console.log('  ' + f);
if (fails.length) for (const t of trace) console.log('   trace ' + t);
await browser.close();
