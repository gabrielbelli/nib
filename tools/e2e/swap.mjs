const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Mac controlling Windows: physical Cmd+C must arrive as Ctrl+C; physical
// Ctrl+Alt (let go alone) must still release; with no swap Cmd stays GUI.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto(BASE + '/?shell=desktop', { waitUntil: 'load' });
await page.waitForTimeout(800);
const run = (swap) => page.evaluate(async (swap) => {
  const v = document.querySelector('meta[name="nib-v"]').content.split('=')[1];
  const mod = await import('./capture.js?v=' + v);
  const log = [];
  const t = { isConnected: () => true, keyDown: (u, m) => log.push(`down ${u} ${m}`), keyUp: (u, m) => log.push(`up ${u} ${m}`), tapOne: () => {}, releaseAll: () => log.push('releaseAll'), move: () => {}, button: () => {} };
  const surf = document.createElement('div'); document.body.append(surf);
  const tgt = await import('./target.js?v=' + v);
  localStorage.setItem('nib.modmap', swap ? 'position' : 'labels');
  tgt.setMapChoice(swap ? 'position' : 'labels');
  const cap = mod.createCapture({ surface: surf, transport: t, indicator: true, modMap: tgt.modMap, targetIsMac: tgt.isApple });
  const stops = []; cap.events.addEventListener('capturestop', (e) => stops.push(e.detail.reason));
  await cap.start();
  window.__t = { log, stops, cap };
}, swap);
const fails = [];
for (const swap of [true, false]) {
  await run(swap);
  await page.keyboard.down('Meta'); await page.keyboard.press('KeyC'); await page.keyboard.up('Meta');
  const r = await page.evaluate(() => ({ log: [...__t.log], stops: [...__t.stops] }));
  // Modifiers travel as their own down(0, bits); C (usage 6) follows.
  const modDown = r.log.find((l) => /^down 0 /.test(l));
  const want = swap ? 4 : 8;                                  // by position Cmd lands on Alt; as labelled it stays GUI
  if (!modDown || Number(modDown.split(' ')[2]) !== want || !r.log.some((l) => /^down 6 /.test(l)))
    fails.push(`swap=${swap}: Cmd+C sent as ${JSON.stringify(r.log)} (want modifier ${want})`);
  // physical Ctrl+Alt let go alone still releases
  await page.evaluate(() => { __t.log.length = 0; });
  await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  const st = await page.evaluate(() => [...__t.stops]);
  if (!st.includes('chord')) fails.push(`swap=${swap}: physical Ctrl+Alt did not release: ${st}`);
  await page.waitForTimeout(1400);
}
await browser.close();
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS swap');
