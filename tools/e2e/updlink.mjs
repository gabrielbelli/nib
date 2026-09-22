const BASE = process.env.NIB_URL || 'https://localhost:9443';
// A new build lands while the dongle is connected: the page must not reload
// (that would drop Bluetooth). It marks Reload, and applies the update when
// the link goes.
import { webkit, devices } from 'playwright';
import { writeFileSync, unlinkSync } from 'fs';
const WEB = new URL('../../web/_updlink_probe.txt', import.meta.url).pathname;
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
let navs = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.waitForTimeout(1000);
const v0 = await page.evaluate(() => window.__nibUpd.baked);
await page.evaluate(async () => {
  const v = document.querySelector('meta[name="nib-v"]').content.split('=')[1];
  const ble = await import('./ble.js?v=' + v);
  ble.events.dispatchEvent(new CustomEvent('status', { detail: 'connected' }));
});
const navsBefore = navs;
writeFileSync(WEB, 'probe ' + Date.now());         // changes the served version
const fails = [];
try {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));   // triggers a check now
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({ pending: window.__nibUpd.pending || null, last: window.__nibUpd.last, mark: document.getElementById('reload').classList.contains('has-update') }));
  if (navs !== navsBefore) fails.push('page reloaded while connected');
  if (!st.pending) fails.push('no pending update recorded: ' + st.last);
  if (!st.mark) fails.push('Reload not marked');
  await page.evaluate(async () => {
    const v = document.querySelector('meta[name="nib-v"]').content.split('=')[1];
    const ble = await import('./ble.js?v=' + v);
    ble.events.dispatchEvent(new CustomEvent('status', { detail: 'disconnected' }));
  });
  await page.waitForTimeout(2500);
  const v1 = await page.evaluate(() => window.__nibUpd?.baked).catch(() => null);
  if (navs === navsBefore || v1 === v0) fails.push(`did not update after disconnect (baked ${v0} -> ${v1})`);
} finally { unlinkSync(WEB); }
await browser.close();
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS updlink');
