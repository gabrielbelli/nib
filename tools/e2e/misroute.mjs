const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Reproduce the device bug in WebKit: dispatch pointer/touch/click events whose
// clientX/Y sit on one control but whose TARGET is the neighbour 59px right,
// exactly as the iPhone did. The router must activate the control under the
// finger and suppress the neighbour.
import { webkit, devices } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 landscape'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => { const s = document.createElement('style'); s.textContent = ':root{--safe-l:59px;--safe-r:59px;--safe-b:0px}'; document.addEventListener('DOMContentLoaded', () => document.head.append(s)); });
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.waitForTimeout(900);

const fire = (fingerOn, targetId) => page.evaluate(([fingerOn, targetId]) => {
  const f = document.getElementById(fingerOn).getBoundingClientRect();
  const x = f.left + f.width / 2, y = f.top + f.height / 2;
  const t = document.getElementById(targetId);
  const pe = (type, extra = {}) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, ...extra }));
  pe('pointerdown', { button: 0, buttons: 1 });
  pe('pointerup', { button: 0, buttons: 0 });
  t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
  return [Math.round(x), Math.round(y)];
}, [fingerOn, targetId]);

const state = () => page.evaluate(() => ({ drawer: document.body.dataset.drawer, mode: document.body.dataset.mode }));
const fails = [];

// finger on the hamburger, engine says target = keyboard button (as on the phone)
await fire('nib-menu', 'nib-mode'); await page.waitForTimeout(700);
let s = await state();
if (s.drawer !== 'open') fails.push(`finger on menu, target mode: drawer=${s.drawer} (expected open)`);
if (s.mode !== 'pad') fails.push(`finger on menu, target mode: mode toggled to ${s.mode}`);
await page.evaluate(() => document.getElementById('nib-done').click()); await page.waitForTimeout(700);

// finger on the keyboard button, engine says target = connect dot
await fire('nib-mode', 'connect'); await page.waitForTimeout(700);
s = await state();
if (s.mode !== 'keys') fails.push(`finger on mode, target connect: mode=${s.mode} (expected keys)`);
await fire('nib-mode', 'connect'); await page.waitForTimeout(700);
s = await state();
if (s.mode !== 'pad') fails.push(`second misrouted tap did not toggle back: mode=${s.mode}`);

// correctly routed taps must still work exactly once
await fire('nib-menu', 'nib-menu'); await page.waitForTimeout(700);
s = await state();
if (s.drawer !== 'open') fails.push(`correct routing broke: drawer=${s.drawer}`);
await page.evaluate(() => document.getElementById('nib-done').click()); await page.waitForTimeout(500);

console.log(`misroute: errors=${errors.length} fails=${fails.length}`);
for (const e of errors) console.log('  ERR ' + e);
for (const f of fails) console.log('  ' + f);
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
