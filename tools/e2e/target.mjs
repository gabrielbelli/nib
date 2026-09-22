const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Windows is the default target: Win/Alt labels and Win-inside-Alt order on
// the on-screen keyboard; switching to Mac gives Cmd/Opt in Mac order; the
// dongle's "host":"mac" guess flips Auto to Mac.
import { webkit, devices } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.waitForTimeout(1000);
const bottom = () => page.evaluate(() => [...document.querySelectorAll('.osk-key.mod')].map((k) => k.textContent.trim()).join(' '));
const chips = () => page.evaluate(() => [...document.querySelectorAll('#mods [data-mod]')].map((b) => b.textContent).join(' '));
const fails = [];
let b = await bottom(), c = await chips();
if (!/Win/.test(b) || /Cmd|Opt/.test(b)) fails.push('default keyboard not Windows: ' + b);
if (!/Ctrl Win Alt|Ctrl, Win, Alt/.test(b.replace(/Shift /g, '')) && !/Ctrl Win Alt/.test(b)) fails.push('Windows order wrong: ' + b);
if (!/Win/.test(c) || !/Alt/.test(c)) fails.push('chips not Windows: ' + c);
await page.evaluate(() => { const s = document.querySelector('#target'); s.value = 'mac'; s.dispatchEvent(new Event('change')); });
await page.waitForTimeout(200);
b = await bottom(); c = await chips();
if (!/Cmd/.test(b) || !/Opt/.test(b)) fails.push('Mac keyboard not Cmd/Opt: ' + b);
if (!/Ctrl Opt Cmd/.test(b)) fails.push('Mac order wrong: ' + b);
// back to auto, then the dongle says mac
await page.evaluate(async () => {
  const s = document.querySelector('#target'); s.value = 'auto'; s.dispatchEvent(new Event('change'));
  const v = document.querySelector('meta[name="nib-v"]').content.split('=')[1];
  const ble = await import('./ble.js?v=' + v);
  ble.events.dispatchEvent(new CustomEvent('settings', { detail: { name: 'N.I.B.', pk: '424242', show: 1, mode: 0, screen: 1, usb: 0, hid: 0, host: 'mac', pm: 1, po: 0, pw: 0, btn: 0, ss: { on: 1, idx: 0, idle: 60, custom: 0, imp: 0, got: 0, n: 14 } } }));
});
await page.waitForTimeout(200);
b = await bottom();
const auto = await page.evaluate(() => document.querySelector('#target option[value="auto"]').textContent);
if (!/Cmd/.test(b) || auto !== 'Auto (Mac)') fails.push(`dongle guess not followed: ${auto} / ${b}`);
const pairBtn = await page.evaluate(() => !document.querySelector('#set-pair-open').hidden && document.querySelector('#set-pair').value);
if (pairBtn !== '1') fails.push('pairing window controls not shown for pm=1: ' + pairBtn);
const nb = await page.evaluate(() => ({ usbOff: document.querySelector('#set-usb option[value="2"]').disabled, note: document.querySelector('#set-pair-note').textContent }));
if (!nb.usbOff || !/replug/.test(nb.note)) fails.push('button-less dongle not reflected: ' + JSON.stringify(nb));
await browser.close();
for (const e of errors) fails.push('pageerror ' + e);
console.log('last keyboard:', b);
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS target');
