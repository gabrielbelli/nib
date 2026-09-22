import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chromium' });
const p = await (await b.newContext({ deviceScaleFactor: 2 })).newPage();
await p.goto('file://' + process.cwd() + '/flipper-screens.html', { waitUntil: 'load' });
await p.waitForTimeout(300);
for (const id of ['ready', 'pairing', 'connected', 'settings']) {
  const el = await p.$('#' + id);
  await el.screenshot({ path: `out/flipper-${id}.png` });
}
await b.close();
console.log('ok');
