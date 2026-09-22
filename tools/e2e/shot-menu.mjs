const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Screenshots of the whole menu, connected to a fake dongle, every section open.
import { webkit, chromium, devices } from 'playwright';
const OUT = process.argv[2] || 'out/menu';
const STATUS = '{"name":"N.I.B.","pk":"424242","show":1,"mode":0,"screen":1,"usb":0,"hid":0,"host":"mac","pm":1,"po":0,"pw":0,"btn":1,"led":0,"pad":1,"ss":{"on":1,"idx":0,"idle":60,"custom":0,"imp":0,"got":0,"n":14}}';
for (const [name, engine, ctxOpts, q] of [
  ['phone', webkit, { ...devices['iPhone 14'], viewport: { width: 390, height: 3600 } }, 'shell=phone'],
  ['desktop', chromium, { viewport: { width: 1440, height: 1800 } }, 'shell=desktop'],
]) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ ...ctxOpts, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
await page.addInitScript((STATUS) => {
  window.__writes = [];
  const bytes = new TextEncoder().encode(STATUS);
  const statusChar = {
    listeners: [],
    fails: Number(new URLSearchParams(location.search).get('fails') || 0),
    async startNotifications() { if (this.fails-- > 0) throw new Error('GATT operation failed: insufficient authentication'); return this; },
    addEventListener(t, f) { this.listeners.push(f); },
    readfail: new URLSearchParams(location.search).get('readfail') === '1',
    async readValue() { if (this.readfail) throw new Error('2'); if (this.fails-- > 0) throw new Error('GATT operation failed: insufficient authentication'); return new DataView(bytes.buffer.slice(0)); },
  };
  const rx = {
    async writeValueWithoutResponse(b) { this.writeValue(b); },
    async writeValue(b) {
      const a = [...new Uint8Array(b.buffer || b)];
      window.__writes.push(a);
      // STATUS_REQ: the dongle pushes its status over the subscription
      if (a[0] === 0x45) setTimeout(() => statusChar.listeners.forEach((f) => f({ target: { value: new DataView(bytes.buffer.slice(0)) } })), 20);
    },
  };
  const service = { async getCharacteristic(u) { return u.startsWith('6e7d0003') ? statusChar : rx; } };
  const device = { name: 'N.I.B.', addEventListener() {}, gatt: { connected: true, async connect() { return { async getPrimaryService() { return service; } }; } } };
  Object.defineProperty(navigator, 'bluetooth', { value: { async requestDevice() { return device; }, async getAvailability() { return true; } } });
}, STATUS);
  await page.goto(BASE + '/?' + q + '&menu=open', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('#connect').click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelectorAll('#nib-drawer details').forEach((d) => { d.open = true; }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}-${name}.png` });
  await page.evaluate(() => { const b = document.querySelector('#nib-drawer-body'); b.scrollTop = b.scrollHeight; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}-${name}-end.png` });
  await browser.close();
}
console.log('ok');
