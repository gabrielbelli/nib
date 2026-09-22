const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Gamepad over the fake dongle: A sets bit 0, a stick drag moves lx/ly, and
// letting go returns everything to rest. Also checks tap-target size.
import { webkit, devices } from 'playwright';
const STATUS = '{"name":"N.I.B.","pk":"000000","show":1,"mode":0,"screen":1,"usb":0,"hid":0,"pad":1,"ss":{"on":1,"idx":0,"idle":60,"custom":0,"imp":0,"got":0,"n":14}}';
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14 landscape'], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
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
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.evaluate(() => localStorage.setItem('nib.osk.preset', '"gamepad"'));
await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
await page.evaluate(() => document.querySelector('#connect').click()); await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('#nib-mode').click()); await page.waitForTimeout(700);
const pads = (w) => w.filter((x) => x[0] === 0x15);
const last = () => page.evaluate(() => window.__writes.filter((x) => x[0] === 0x15).slice(-1)[0] || null);
const fails = [];
const sizes = await page.evaluate(() => [...document.querySelectorAll('.pad-face .pad-btn, .pad-cross .pad-btn')].map((b) => Math.round(b.getBoundingClientRect().width)));
if (sizes.some((s) => s < 44)) fails.push('buttons under 44px: ' + sizes);
await page.evaluate(() => { window.__writes.length = 0; });
const a = await page.locator('.pad-face .pad-f-bottom').boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.waitForTimeout(80);
let w = await last();
if (!w || (w[8] & 1) !== 1) fails.push('A not sent: ' + JSON.stringify(w));
await page.mouse.up(); await page.waitForTimeout(80);
w = await last();
if (!w || (w[8] & 1) !== 0) fails.push('A not released: ' + JSON.stringify(w));
const st = await page.locator('.pad-side-l .pad-stick').boundingBox();
const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
await page.mouse.move(cx, cy); await page.mouse.down();
await page.mouse.move(cx + st.width, cy, { steps: 5 }); await page.waitForTimeout(80);
w = await last();
const lx = w ? (w[1] << 24 >> 24) : 0;
if (lx < 100) fails.push('stick right not near +127: ' + lx);
await page.mouse.up(); await page.waitForTimeout(80);
w = await last();
if (!w || w[1] !== 0 || w[2] !== 0) fails.push('stick did not recentre: ' + JSON.stringify(w));
await browser.close();
for (const e of errors) fails.push('pageerror ' + e);
console.log('sizes', sizes.join(','));
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS gamepad');
