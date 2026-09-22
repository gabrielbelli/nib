const BASE = process.env.NIB_URL || 'https://localhost:9443';
// capture.js with a fake transport, driven by real (trusted) key presses in
// Chromium. Checks: Esc is forwarded and does not stop capture; Ctrl+Alt
// pressed and let go alone releases; Ctrl+Alt+Del does not; losing pointer
// lock keeps the keyboard captured and forwards an Esc.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/?shell=desktop', { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.evaluate(async () => {
  const v = document.querySelector('meta[name="nib-v"]').content.split('=')[1];
  const mod = await import('./capture.js?v=' + v);
  window.__log = [];
  const t = {
    isConnected: () => true,
    keyDown: (u, m) => __log.push(`down ${u} ${m}`), keyUp: (u, m) => __log.push(`up ${u} ${m}`),
    tapOne: (u, m) => __log.push(`tap ${u} ${m}`), releaseAll: () => __log.push('releaseAll'),
    move: () => {}, button: (b, s) => __log.push(`btn ${b} ${s}`),
  };
  const surf = document.createElement('div'); surf.style.cssText = 'position:fixed;inset:0'; document.body.append(surf);
  window.__cap = mod.createCapture({ surface: surf, transport: t, indicator: false });
  window.__stops = [];
  __cap.events.addEventListener('capturestop', (e) => __stops.push(e.detail.reason));
});
const start = async () => { await page.mouse.click(10, 10); await page.evaluate(() => __cap.start()); await page.waitForTimeout(300); };
const state = () => page.evaluate(() => ({ active: __cap.isActive ? __cap.isActive() : __cap.active, stops: [...__stops], log: [...__log] }));
const clear = () => page.evaluate(() => { __log.length = 0; __stops.length = 0; });
const fails = [];

await start();
let s = await state();
if (!s.active) fails.push('capture did not start: ' + JSON.stringify(s));

// 1. Esc goes across, capture stays on
await clear();
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
s = await state();
if (!s.log.some((l) => /(tap|down) 41 /.test(l))) fails.push('Esc not forwarded: ' + JSON.stringify(s.log));
if (s.stops.length) fails.push('Esc stopped capture: ' + s.stops);

// 2. Ctrl+Alt+Del: forwarded, no release
await clear();
await page.keyboard.down('Control'); await page.keyboard.down('Alt');
await page.keyboard.press('Delete');
await page.keyboard.up('Alt'); await page.keyboard.up('Control');
await page.waitForTimeout(150);
s = await state();
if (s.stops.length) fails.push('Ctrl+Alt+Del released capture: ' + s.stops);
if (!s.log.some((l) => / 76 /.test(l) || /^down 76/.test(l))) fails.push('Delete not forwarded: ' + JSON.stringify(s.log));

// 3. Ctrl+Alt alone: releases
await clear();
await page.keyboard.down('Control'); await page.keyboard.down('Alt');
await page.keyboard.up('Alt'); await page.keyboard.up('Control');
await page.waitForTimeout(150);
s = await state();
if (!s.stops.includes('chord')) fails.push('Ctrl+Alt did not release: ' + JSON.stringify(s));

// 4. Ctrl+Shift+Alt: no release (Shift disarms)
await page.waitForTimeout(1400);   // the browser's re-lock cooldown
await start(); await clear();
if (!(await state()).active) fails.push('did not restart');
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.down('Alt');
await page.keyboard.up('Alt'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await page.waitForTimeout(150);
s = await state();
if (s.stops.length) fails.push('Ctrl+Shift+Alt released: ' + s.stops);

// 5. typing a letter still works
await clear();
await page.keyboard.press('KeyA');
s = await state();
if (!s.log.some((l) => /^down 4 /.test(l))) fails.push('A not forwarded: ' + JSON.stringify(s.log));

// 6. the browser drops pointer lock (Esc swallowed): keyboard stays, Esc forwarded
await page.waitForTimeout(500); await clear();
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(100);
s = await state();
if (s.stops.length) fails.push('pointer-lock loss stopped capture: ' + s.stops);
if (!s.log.some((l) => /(tap|down) 41 /.test(l))) fails.push('no Esc forwarded on lock loss: ' + JSON.stringify(s));
await clear();
await page.keyboard.press('KeyB');
s = await state();
if (!s.log.some((l) => /^down 5 /.test(l))) fails.push('keyboard not captured after lock loss');

await browser.close();
for (const e of errors) fails.push('pageerror ' + e);
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS capture');
