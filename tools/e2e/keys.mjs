const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Keys mode in landscape: every keycap must be on screen and must own its own centre.
import { webkit, devices } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 landscape'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
// Emulation, not the phone: keep this run out of the field log (probe.log).
await page.route('**/probe', (r) => r.fulfill({ status: 204 }));
await page.addInitScript(() => { const s = document.createElement('style'); s.textContent = ':root{--safe-l:47px;--safe-r:47px;--safe-b:21px}'; document.addEventListener('DOMContentLoaded', () => document.head.append(s)); });
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.tap('#nib-mode'); await page.waitForTimeout(900);
const r = await page.evaluate(() => {
  const W = innerWidth, H = innerHeight, bad = [];
  const keys = [...document.querySelectorAll('.osk-key')];
  for (const k of keys) {
    const b = k.getBoundingClientRect();
    if (b.width === 0) continue;
    if (b.left < -1 || b.right > W + 1 || b.top < -1 || b.bottom > H + 1) bad.push(`${k.textContent.trim() || k.className} off-screen`);
    if (b.height < 40) bad.push(`${k.textContent.trim()} height ${Math.round(b.height)}`);
    const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!h || (h !== k && !k.contains(h))) bad.push(`${k.textContent.trim()} centre hits ${h ? (h.className || h.tagName) : 'null'}`);
  }
  const top = document.getElementById('nib-menu').getBoundingClientRect();
  const kb = document.querySelector('.osk')?.getBoundingClientRect();
  if (kb && kb.top < top.bottom) bad.push(`keyboard top ${Math.round(kb.top)} overlaps the top row (bottom ${Math.round(top.bottom)})`);
  return { keys: keys.length, bad, kbTop: kb && Math.round(kb.top), H };
});
console.log(JSON.stringify(r));
await browser.close();
