const BASE = process.env.NIB_URL || 'https://localhost:9443';
// A fake navigator.bluetooth that serves the exact status bytes the iPhone
// received (from telemetry), so the whole transport path runs in WebKit:
// requestDevice -> connect -> readValue -> parse -> the Dongle section unlocks.
import { webkit, devices } from 'playwright';
const STATUS = process.argv[2] || '{"name":"N.I.B.","pk":000000,"show":1,"mode":0,"screen":1,"usb":0,"hid":0,"ss":{"on":1,"idx":0,"idle":60,"custom":0,"imp":0,"got":0,"n":6}}';
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], ignoreHTTPSErrors: true });
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
await page.goto(BASE + '/?shell=phone' + (process.env.FAILS ? '&fails=' + process.env.FAILS : '') + (process.env.READFAIL ? '&readfail=1' : ''), { waitUntil: 'load' });
await page.waitForTimeout(900);
// Offline first: the settings must be usable, preview and import must wait.
const offline = await page.evaluate(() => {
  document.querySelector('#sect-dongle').open = true;
  const dis = (sel) => document.querySelector(sel).disabled;
  const r = { enable: dis('#ss-enable'), idle: dis('#ss-idle'), pick: [...document.querySelectorAll('#ss-pick button')].some((b) => b.disabled), preview: dis('#ss-preview'), import: dis('#ss-file-btn'), note: document.querySelector('#ss-note').textContent };
  // change everything while offline: Field, 5 minutes
  [...document.querySelectorAll('#ss-pick button')].find((b) => b.textContent === 'Life').click();
  const idle = document.querySelector('#ss-idle'); idle.value = '300'; idle.dispatchEvent(new Event('change'));
  return r;
});
await page.evaluate(() => document.querySelector('#connect').click());
await page.waitForTimeout(process.env.FAILS ? 4000 : 1200);
const r = await page.evaluate(() => ({
  disabled: [...document.querySelectorAll('#sect-dongle input, #sect-dongle select, #sect-dongle button')].filter((e) => e.disabled).map((e) => e.id || e.textContent.trim()),
  note: document.querySelector('#ss-note').textContent,
  pk: document.querySelector('#set-pk').value,
  saverNames: [...document.querySelectorAll('#ss-pick button')].map((b) => b.textContent).join(),
}));
const connectWrites = await page.evaluate(() => window.__writes.map((w) => w.map((x) => x.toString(16)).join(' ')));
// tap a saver, and check SS_SET (0x50) and SS_PREVIEW (0x51) went out
await page.evaluate(() => { window.__writes.length = 0; document.querySelector('#sect-dongle').open = true; [...document.querySelectorAll('#ss-pick button')].find((b) => b.textContent === 'Mystify').click(); });
await page.waitForTimeout(300);
const writes = await page.evaluate(() => window.__writes.map((w) => w.map((x) => x.toString(16)).join(' ')));
await browser.close();
const fails = [];
if (offline.enable || offline.idle || offline.pick) fails.push('offline: settings disabled ' + JSON.stringify(offline));
if (!offline.preview || !offline.import) fails.push('offline: preview/import should wait for a link');
const onConnect = await Promise.resolve(connectWrites);
if (!onConnect.some((w) => w.startsWith('50 1 4 2c 1'))) fails.push('offline changes (Field, 300 s) not sent on connect: ' + JSON.stringify(onConnect));
if (r.disabled.length) fails.push('disabled: ' + r.disabled.join(', '));
if (r.pk !== '000000') fails.push('pk field ' + r.pk);
if (!writes.some((w) => w.startsWith('50 1 3'))) fails.push('no SS_SET idx 3: ' + JSON.stringify(writes));
if (!writes.some((w) => w.startsWith('51 3'))) fails.push('no SS_PREVIEW 3: ' + JSON.stringify(writes));
for (const e of errors) fails.push('pageerror ' + e);
console.log(JSON.stringify(r)); console.log('writes', JSON.stringify(writes));
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS fakebt');
