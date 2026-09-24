// Runs every test against NIB_URL (default https://localhost:9443, which is
// what `python3 serve.py` serves). Each test prints PASS or FAIL last.
import { spawnSync } from 'node:child_process';
const tests = ['fakebt', 'saver2', 'target', 'swap', 'capture', 'gamepad', 'migrate',
               'updlink', 'haptics', 'misroute', 'hostinset', 'sweep', 'keys', 'dots', 'fuzz'];
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [new URL(`./${t}.mjs`, import.meta.url).pathname],
                      { encoding: 'utf8', env: process.env });
  const last = (r.stdout + r.stderr).trim().split('\n').pop();
  const ok = r.status === 0 && !/FAIL|fails=[1-9]|errors=[1-9]|Error/.test(r.stdout + r.stderr);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.padEnd(10)} ${last}`);
}
process.exit(failed ? 1 : 0);
