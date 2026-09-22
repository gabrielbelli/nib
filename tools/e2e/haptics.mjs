const BASE = process.env.NIB_URL || 'https://localhost:9443';
// iOS has no navigator.vibrate; the helper flips a hidden switch checkbox
// instead, which iOS 18+ answers with the system haptic. WebKit here has no
// vibrate either, so a key tap must flip that switch.
import { webkit, devices } from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.evaluate(() => { localStorage.setItem('nib.osk.preset', '"compact"'); });
await page.evaluate(() => document.querySelector('#nib-mode').click());
await page.waitForTimeout(700);
const before = await page.evaluate(() => ({ vib: typeof navigator.vibrate, sw: document.querySelector('input[switch]')?.checked ?? null }));
const k = await page.locator('.osk-key', { hasText: /^q$/ }).first().boundingBox();
await page.touchscreen.tap(k.x + k.width / 2, k.y + k.height / 2);
await page.waitForTimeout(200);
const after = await page.evaluate(() => document.querySelector('input[switch]')?.checked ?? null);
await b.close();
const fails = [];
if (before.vib === 'function') fails.push('this WebKit has vibrate; test does not model iOS');
if (after === null) fails.push('no hidden switch was created');
if (after === before.sw) fails.push('switch did not flip on a key tap');
for (const e of errors) fails.push('pageerror ' + e);
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS haptics');
