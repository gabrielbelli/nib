const BASE = process.env.NIB_URL || 'https://localhost:9443';
// Old bluehid.* keys move to nib.* once; existing nib.* keys are kept and
// never touched; unrelated keys survive.
import { webkit } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto(BASE + '/version.txt');
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('bluehid.layout', '"abnt2"');
  localStorage.setItem('bluehid.snippets', '[{"name":"x","text":"y"}]');
  localStorage.setItem('bluehid.osk.preset', '"60"');
  localStorage.setItem('nib.osk.preset', '"full"');     // newer value must win
  localStorage.setItem('nib.target', 'mac');
  localStorage.setItem('other', '1');
});
await page.goto(BASE + '/?shell=phone', { waitUntil: 'load' });
await page.waitForTimeout(1200);
const r = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
const layoutSel = await page.evaluate(() => document.querySelector('#layout')?.value);
await browser.close();
const fails = [];
if (Object.keys(r).some((k) => k.startsWith('bluehid.'))) fails.push('old keys left: ' + JSON.stringify(r));
if (r['nib.layout'] !== '"abnt2"') fails.push('layout not moved: ' + r['nib.layout']);
if (!r['nib.snippets']?.includes('"x"')) fails.push('snippets not moved');
if (r['nib.osk.preset'] !== '"full"') fails.push('existing nib value overwritten: ' + r['nib.osk.preset']);
if (r['nib.target'] !== 'mac' || r.other !== '1') fails.push('unrelated keys damaged');
if (layoutSel !== 'abnt2') fails.push('app did not read the moved layout: ' + layoutSel);
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS migrate');
