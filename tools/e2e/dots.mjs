const BASE = process.env.NIB_URL || 'https://localhost:9443';
// The trackpad's dot field (web/dots.js): black at rest, lit around a finger,
// lit only NEAR the finger, cleared after the lift, a ring on a tap, and no
// ring at all under reduced motion. Chromium drives real multi-point touch
// through CDP; WebKit checks the tap path the iPhone takes.
// SHOTS=dir also saves a mid-drag screenshot there.
import { chromium, webkit, devices } from 'playwright';

const fails = [];
const SHOTS = process.env.SHOTS || '';

// Lit pixels in the canvas, the farthest lit pixel from (fx, fy), and how many
// lit pixels sit within 40px of (nx, ny) - all in CSS px.
const LIT = ({ fx, fy, nx, ny } = {}) => {
  const c = document.querySelector('#stage-pad .pad-dots');
  if (!c) return { missing: true };
  const r = c.getBoundingClientRect();
  const k = c.width / r.width;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, far = 0, near = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 8) continue;
    n++;
    if (fx == null && nx == null) continue;
    const p = (i - 3) / 4;
    const x = (p % c.width) / k + r.left, y = Math.floor(p / c.width) / k + r.top;
    if (fx != null) far = Math.max(far, Math.hypot(x - fx, y - fy));
    if (nx != null && Math.hypot(x - nx, y - ny) < 40) near++;
  }
  return { n, far, near, w: c.width, h: c.height };
};

async function open(browser, device, opts = {}) {
  const ctx = await browser.newContext({ ...devices[device], ignoreHTTPSErrors: true, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const box = await page.locator('#stage-pad').boundingBox();
  return { ctx, page, errors, box };
}

// ---- Chromium: hold, drag, lift, tap ------------------------------------
{
  const browser = await chromium.launch();
  const { page, errors, box } = await open(browser, 'Pixel 7');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })),
  });
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.4;
  const sx = box.x + 60;

  const rest = await page.evaluate(LIT);
  if (rest.missing) fails.push('chromium: no canvas.pad-dots inside #stage-pad');
  else {
    if (!rest.w || !rest.h) fails.push('chromium: canvas has no size');
    if (rest.n) fails.push(`chromium: ${rest.n} lit pixels at rest, want 0 (pad must stay black)`);
  }

  // The FIRST gesture after load, and a long one: Chromium fires pointerdown
  // before touchstart, and a de-dup latch once let that finger in twice, which
  // parked a second halo at the touchdown point for the whole gesture.
  await touch('touchStart', [[sx, cy]]);
  for (let i = 1; i <= 20; i++) {
    await touch('touchMove', [[sx + i * 14, cy]]);
    await page.waitForTimeout(16);
  }
  const fx = sx + 280, fy = cy;
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dots-drag.png` });
  await page.waitForTimeout(1000);                  // let the wake die out
  const held = await page.evaluate(LIT, { fx, fy, nx: sx, ny: cy });
  if (!held.n) fails.push('chromium: nothing lit under a held finger');
  if (held.far > 260) fails.push(`chromium: lit pixel ${held.far.toFixed(0)}px from the finger, want local`);
  if (held.near) fails.push(`chromium: ${held.near} lit pixels left at the touchdown point, want 0`);

  await touch('touchEnd', []);
  await page.waitForTimeout(1100);
  const after = await page.evaluate(LIT);
  if (after.n) fails.push(`chromium: ${after.n} lit pixels 1.1s after lift, want 0`);

  // Two fingers down together: two halos.
  await touch('touchStart', [[cx - 120, cy], [cx + 120, cy]]);
  await page.waitForTimeout(120);
  const left = await page.evaluate(LIT, { fx: cx - 120, fy: cy });
  if (left.far < 180) fails.push('chromium: second finger drew no halo of its own');
  await touch('touchEnd', []);
  await page.waitForTimeout(1100);

  // A quick tap: the ring is out and travelling after the halo has gone.
  await touch('touchStart', [[cx, cy]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(330);
  const ring = await page.evaluate(LIT, { fx: cx, fy: cy });
  if (!ring.n) fails.push('chromium: no ring after a tap');
  else if (ring.far < 60) fails.push(`chromium: ring did not travel (farthest ${ring.far.toFixed(0)}px)`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dots-ring.png` });

  for (const e of errors) fails.push('chromium pageerror ' + e);
  await browser.close();
}

// ---- Chromium, reduced motion: halo only, no ring, no lingering fade ------
{
  const browser = await chromium.launch();
  const { page, errors, box } = await open(browser, 'Pixel 7', { reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.4;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 0 }] });
  await page.waitForTimeout(100);
  const held = await page.evaluate(LIT);
  if (!held.n) fails.push('reduced motion: halo should still show under the finger');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  const after = await page.evaluate(LIT);
  if (after.n) fails.push(`reduced motion: ${after.n} lit pixels after the lift, want 0 (no ring, no fade)`);
  for (const e of errors) fails.push('reduced pageerror ' + e);
  await browser.close();
}

// ---- WebKit: the iPhone tap path ----------------------------------------
{
  const browser = await webkit.launch();
  const { page, errors, box } = await open(browser, 'iPhone 14');
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.4;
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(200);
  const ring = await page.evaluate(LIT);
  if (!ring.n) fails.push('webkit: nothing lit after a tap');
  await page.waitForTimeout(1000);
  const after = await page.evaluate(LIT);
  if (after.n) fails.push(`webkit: ${after.n} lit pixels after the ring, want 0`);
  for (const e of errors) fails.push('webkit pageerror ' + e);
  await browser.close();
}

console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS dots');
process.exit(fails.length ? 1 : 0);
