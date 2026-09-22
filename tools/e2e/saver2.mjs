const BASE = process.env.NIB_URL || 'https://localhost:9443';
import { webkit, devices } from 'playwright';
const browser = await webkit.launch();
const fails = [];
for (const connected of [false, true]) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/?shell=phone&menu=open', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const emit = (ss) => page.evaluate(async (ss) => {
    const v = document.querySelector('meta[name="nib-v"]').content.split('=')[1];
    const ble = await import('./ble.js?v=' + v);
    ble.events.dispatchEvent(new CustomEvent('settings', { detail: { name: 'N.I.B.', pk: 424242, show: 1, mode: 0, screen: 1, usb: 0, hid: 0, ss } }));
  }, ss);
  if (connected) await emit({ on: 1, idx: 0, idle: 60, custom: 1, imp: 0, got: 0, n: 15, cn: 'Cat' });
  await page.evaluate(() => document.querySelector('#sect-dongle').open = true);
  await page.waitForTimeout(400);
  for (const name of ['Mystify', 'Life', 'Shuffle', 'Bounce']) {
    const btn = page.locator('#ss-pick button', { hasText: new RegExp('^' + name + '$') });
    await btn.scrollIntoViewIfNeeded();
    const box = await btn.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    const on = await page.evaluate(() => [...document.querySelectorAll('#ss-pick button.is-on')].map((b) => b.textContent));
    if (on.length !== 1 || on[0] !== name) fails.push(`${connected ? 'connected' : 'offline'}: tapped ${name}, selected ${JSON.stringify(on)}`);
  }
  const names = await page.evaluate(() => [...document.querySelectorAll('#ss-pick button')].map((b) => b.textContent));
  if (connected && names.join() !== 'Bounce,Plasma,Stars,Mystify,Life,Matrix,Pipes,Toasters,Maze,Fire,Cube,Fireworks,Swarm,Spirograph,Cat,Shuffle') fails.push('names ' + names.join());
  if (!connected) {
    // pick offline, then the dongle answers: the pick must survive
    const btn = page.locator('#ss-pick button', { hasText: /^Life$/ });
    await btn.scrollIntoViewIfNeeded();   // the picker is a horizontal strip
    const box = await btn.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await emit({ on: 1, idx: 0, idle: 60, custom: 0, imp: 0, got: 0, n: 6 });
    await page.waitForTimeout(250);
    const on = await page.evaluate(() => [...document.querySelectorAll('#ss-pick button.is-on')].map((b) => b.textContent));
    if (on.join() !== 'Life') fails.push('offline pick lost after connect: ' + on.join());
  }
  for (const e of errors) fails.push('pageerror ' + e);
  await page.screenshot({ path: `out/saver-${connected}.png` });
  await ctx.close();
}
await browser.close();
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS saver2');
