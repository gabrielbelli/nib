const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Bluefy landscape: the web view is already 118px narrower than the screen,
// and env() still says 59px per side. The page must zero its insets, drop
// viewport-fit=cover, and put the hamburger at the plain gutter. Also: on a
// misrouted press the phantom target must not show :active.
import { webkit, devices } from 'playwright';
const browser = await webkit.launch();
const run = async (hostInset) => {
  const ctx = await browser.newContext({ ...devices['iPhone 14 landscape'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((hostInset) => {
    const s = document.createElement('style'); s.textContent = ':root{--safe-l:59px;--safe-r:59px;--safe-b:0px}';
    document.addEventListener('DOMContentLoaded', () => document.head.append(s));
    if (hostInset) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + 118 });
    else Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
  }, hostInset);
  await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({
    menuLeft: Math.round(document.getElementById('nib-menu').getBoundingClientRect().left),
    safeL: getComputedStyle(document.documentElement).getPropertyValue('--safe-l').trim(),
    meta: document.querySelector('meta[name="viewport"]').content,
    flag: document.documentElement.dataset.hostInset || null,
  }));
  await ctx.close();
  return { errors, ...r };
};
const fails = [];
const a = await run(true);
if (a.menuLeft !== 16) fails.push(`host-inset: menu at ${a.menuLeft} (expected 16)`);
if (a.safeL !== '0px') fails.push(`host-inset: --safe-l ${a.safeL}`);
if (/viewport-fit=cover/.test(a.meta)) fails.push(`host-inset: meta still has viewport-fit=cover: ${a.meta}`);
if (a.flag !== '1') fails.push('host-inset: flag missing');
const b = await run(false);
if (b.menuLeft !== 75) fails.push(`safari-like: menu at ${b.menuLeft} (expected 75, insets honoured)`);
if (!/viewport-fit=cover/.test(b.meta)) fails.push('safari-like: meta lost viewport-fit=cover');
if (b.flag) fails.push('safari-like: flag set');
for (const e of [...a.errors, ...b.errors]) fails.push('pageerror ' + e);

// phantom press: misrouted pointerdown must not leave the engine's target :active-styled
{
  const ctx = await browser.newContext({ ...devices['iPhone 14 landscape'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const f = document.getElementById('nib-menu').getBoundingClientRect();
    const x = f.left + f.width / 2, y = f.top + f.height / 2;
    const t = document.getElementById('nib-mode');
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
    const down = { phantom: t.classList.contains('is-phantom'), pressed: document.getElementById('nib-menu').classList.contains('is-pressed'), menuTf: getComputedStyle(document.getElementById('nib-menu')).transform };
    t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 0 }));
    const up = { phantom: t.classList.contains('is-phantom'), pressed: document.getElementById('nib-menu').classList.contains('is-pressed') };
    return { down, up };
  });
  await page.waitForTimeout(900);
  const drawer = await page.evaluate(() => document.body.dataset.drawer);
  if (!r.down.phantom) fails.push('phantom class not applied on misrouted down');
  if (!r.down.pressed) fails.push('is-pressed not applied to the real button');
  if (r.down.menuTf === 'none') fails.push('real button shows no press transform');
  if (r.up.phantom || r.up.pressed) fails.push('classes not cleared on up');
  if (drawer !== 'open') fails.push(`drawer=${drawer} after routed tap`);
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ a, b }, null, 0));
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS hostinset');
process.exit(fails.length ? 1 : 0);
