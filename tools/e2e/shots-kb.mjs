const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Every on-screen keyboard preset, on desktop and on a phone in both
// orientations, with the keyboard showing.
import { chromium, webkit, devices } from 'playwright';
const out = process.argv[2] || 'out/kb';
const presets = (process.env.PRESETS || 'compact,60,65,full,numpad,nav,slides,tv').split(',');
const runs = [
  { name: 'desktop', engine: chromium, ctx: { viewport: { width: 1440, height: 900 } }, q: 'shell=desktop' },
  { name: 'phone-portrait', engine: webkit, ctx: { ...devices['iPhone 14'] }, q: 'shell=phone' },
  { name: 'phone-landscape', engine: webkit, ctx: { ...devices['iPhone 14 landscape'] }, q: 'shell=phone' },
];
for (const r of runs) {
  const b = await r.engine.launch(r.engine === chromium ? { channel: 'chromium' } : {});
  const ctx = await b.newContext({ ...r.ctx, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  for (const p of presets) {
    await page.goto(`${BASE}/?${r.q}`, { waitUntil: 'load' });
    await page.evaluate((p) => { localStorage.setItem('nib.osk.preset', JSON.stringify(p)); }, p);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    // switch to keys mode
    await page.evaluate(() => { const m = document.querySelector('#nib-mode'); if (document.body.dataset.mode !== 'keys') m?.click(); });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}-${r.name}-${p}.png` });
  }
  await b.close();
}
console.log('ok');
