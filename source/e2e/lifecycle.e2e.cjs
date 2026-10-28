// Real-Electron lifecycle test (Windows). NOT part of `npm test`.
// Drives the actual app with Playwright and takes REAL screenshots of your displays for ~3 minutes.
// Setup (outside this project so the lockfile stays untouched): `npm i playwright-core` in any folder,
// then run with NODE_PATH pointing at that folder's node_modules and E2E_WIPE_DATA=1.
// Optional PACKAGED_EXE=<release/win-unpacked/UFS Desktop Tracker.exe> tests the packaged build instead.
// WARNING: it DELETES the app's "Local Tracker Data" folder first, so it refuses to run without E2E_WIPE_DATA=1.
if (process.env.E2E_WIPE_DATA !== '1') { console.error('Refusing to run: set E2E_WIPE_DATA=1 (this test deletes the local tracker data folder).'); process.exit(3); }
const { _electron: electron } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const SRC = process.env.TRACKER_SRC || path.join(__dirname, '..');
const PKG = process.env.PACKAGED_EXE;
const EXE = PKG || path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARGS = PKG ? [] : [SRC];
const DATA = path.join(process.env.APPDATA, 'UFS Desktop Tracker', 'Local Tracker Data');
const SHOTS = path.join(DATA, 'Screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + extra : ''}`); };
const shots = () => fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter(f => f.endsWith('.png')) : [];
const index = () => JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8'));
const launch = async () => { const app = await electron.launch({ executablePath: EXE, args: ARGS }); const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await sleep(1500); return { app, page }; };
const setup = async (page, { mode, interval, display = 1, task = 'E2E lifecycle' }) => {
  const opts = await page.$$eval('#display option', os => os.map(o => o.value));
  await page.selectOption('#mode', mode); if (interval) await page.selectOption('#interval', String(interval));
  await page.selectOption('#display', opts[display]); await page.fill('#task', task);
  if (!(await page.isChecked('#consent'))) await page.check('#consent');
};
const remaining = async page => { const [h, m, s] = (await page.textContent('#remaining-time')).split(':').map(Number); return h * 3600 + m * 60 + s; };
const badge = page => page.textContent('#status-badge');

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true }); // test-only data

  // ---------- A: one-hour mode ----------
  console.log('\n== A: one-hour mode ==');
  let { app, page } = await launch();
  const requests = []; page.on('request', r => requests.push(r.url()));
  await setup(page, { mode: 'one-hour', task: 'E2E one-hour' });
  await page.click('#start'); await sleep(4000);
  check('one-hour: tracking', (await badge(page)).includes('Tracking is on'), await badge(page));
  check('one-hour: initial screenshot', shots().length === 1, `n=${shots().length}`);
  const r0 = await remaining(page);
  check('one-hour: remaining ~ 59:5x', r0 >= 3590 && r0 < 3600, `${r0}s`);
  const nextStat = await page.textContent('#next-stat');
  check('one-hour: next shot ~5 min', /^(29\d|300)s$/.test(nextStat), nextStat);
  await page.click('#pause'); await sleep(7000);
  const r1 = await remaining(page);
  check('one-hour: countdown keeps running while paused', r0 - r1 >= 6, `${r0} -> ${r1}`);
  check('one-hour: no shot while paused', shots().length === 1);
  await page.click('#start'); await sleep(3000);
  check('one-hour: resume tracking', (await badge(page)).includes('Tracking is on'));
  check('one-hour: resume does not burst/catch-up', shots().length === 1, `n=${shots().length}`);
  const r2 = await remaining(page);
  check('one-hour: deadline not extended by resume', r2 <= r1, `${r1} -> ${r2}`);
  await page.click('#stop'); await sleep(1500);
  check('one-hour: stopped', (await badge(page)).includes('Ready'));
  const s1 = index().sessions.at(-1);
  check('one-hour: session saved with deadline + testElapsedMs', !!s1.deadlineAt && s1.testElapsedMs > 10000 && s1.durationLimitMs === 3600000, `elapsed=${Math.round(s1.testElapsedMs / 1000)}s`);

  // ---------- B: minimize pauses ----------
  console.log('\n== B: minimize ==');
  await page.selectOption('#mode', 'manual'); await page.selectOption('#interval', '10');
  await page.click('#start'); await sleep(3000);
  check('manual: tracking', (await badge(page)).includes('Tracking is on'));
  const nB = shots().length;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize()); await sleep(2000);
  check('minimize pauses tracking', (await badge(page)).includes('Paused'), await page.textContent('#status-message'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore()); await sleep(13000);
  check('restore does not auto-resume', (await badge(page)).includes('Paused'));
  check('no screenshots while minimized/paused', shots().length === nB, `${nB} -> ${shots().length}`);

  // ---------- network ----------
  const bad = requests.filter(u => !/^(file|data|blob|devtools):/.test(u));
  check('no non-local requests from renderer', bad.length === 0, bad.join(', ') || `${requests.length} local`);

  // ---------- C: quit while tracking, relaunch ----------
  console.log('\n== C: quit while tracking, relaunch ==');
  await page.click('#start'); await sleep(3000);
  check('resumed before quit', (await badge(page)).includes('Tracking is on'));
  await app.close(); await sleep(1000);
  const nQuit = shots().length;
  await sleep(12000);
  check('no shots after quit', shots().length === nQuit);
  const sess = index().sessions;
  check('quit finalizes session (endedAt set)', sess.every(s => s.endedAt), JSON.stringify(sess.map(s => s.stopReason)));
  ({ app, page } = await launch());
  check('relaunch opens stopped', (await badge(page)).includes('Ready'));
  await sleep(12000);
  check('relaunch captures nothing', shots().length === nQuit, `${nQuit} -> ${shots().length}`);

  // ---------- D: second instance ----------
  console.log('\n== D: second instance ==');
  const second = spawn(EXE, ARGS, { stdio: 'ignore' });
  const exit = await Promise.race([new Promise(r => second.on('exit', c => r(c))), sleep(8000).then(() => 'timeout')]);
  if (exit === 'timeout') second.kill();
  check('second instance exits quickly', exit !== 'timeout', `exit=${exit}`);
  check('first instance still alive', !!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)));

  // ---------- E: hard kill while tracking ----------
  console.log('\n== E: hard kill ==');
  await setup(page, { mode: 'manual', interval: 10, task: 'E2E killed' });
  await page.click('#start'); await sleep(3500);
  check('tracking before kill', (await badge(page)).includes('Tracking is on'));
  const pid = app.process().pid;
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(2500);
  const nKill = shots().length; await sleep(12000);
  check('no shots after hard kill', shots().length === nKill);
  ({ app, page } = await launch());
  check('relaunch after kill is stopped', (await badge(page)).includes('Ready'));
  await page.click('[data-panel="sessions-panel"]'); await sleep(1200);
  const sessionText = await page.textContent('#sessions');
  check('killed session marked interrupted', sessionText.includes('Interrupted on previous run'));

  // ---------- G: second display ----------
  console.log('\n== G: second display ==');
  const opts = await page.$$eval('#display option', os => os.map(o => o.textContent));
  if (opts.length > 2) {
    await page.click('[data-panel="tracker-panel"]');
    await setup(page, { mode: 'manual', interval: 10, display: 2, task: 'E2E display2' });
    const before = new Set(shots());
    await page.click('#start');
    for (let i = 0; i < 100 && !(await badge(page)).includes('Tracking'); i++) await sleep(100);
    console.log('  badge:', await badge(page), '| err:', await page.textContent('#error'), '| msg:', await page.textContent('#status-message'));
    await sleep(3500); await page.click('#stop'); await sleep(1200);
    const fresh = shots().filter(f => !before.has(f));
    check('display 2 produced a screenshot', fresh.length >= 1, `n=${fresh.length}`);
    if (fresh.length) { const b = fs.readFileSync(path.join(SHOTS, fresh[0])); console.log('  display2 PNG', b.readUInt32BE(16), 'x', b.readUInt32BE(20), '; listed as', opts[2]); }
  } else console.log('only one display; skipped');

  await app.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
