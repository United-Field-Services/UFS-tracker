// Real end-to-end test: the Electron desktop app + a real tracker server + real screen capture.
// NOT part of `npm test`. It takes REAL screenshots of your display for a few minutes and DELETES the app's
// "Local Tracker Data" folder first, so it refuses to run without E2E_WIPE_DATA=1.
// Needs playwright-core installed somewhere (not a project dependency): set PW_PATH to its folder.
//   set E2E_WIPE_DATA=1 && set PW_PATH=C:\some\folder\node_modules\playwright-core && node e2e\company.e2e.cjs
if (process.env.E2E_WIPE_DATA !== '1') { console.error('Refusing to run: set E2E_WIPE_DATA=1 (this test deletes the local tracker data folder).'); process.exit(3); }
const { _electron: electron } = require(process.env.PW_PATH || 'playwright-core');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SRC = process.env.TRACKER_SRC || path.join(__dirname, '..');
const SERVER_ENTRY = path.join(SRC, '..', 'server', 'src', 'server.ts');
const EXE = process.env.PACKAGED_EXE || path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARGS = process.env.PACKAGED_EXE ? [] : [SRC];
const OUT = process.env.SHOT_DIR || __dirname;
const PORT = 4390, BASE = `http://127.0.0.1:${PORT}`;
const APP_DATA = path.join(process.env.APPDATA, 'UFS Desktop Tracker', 'Local Tracker Data');
const SERVER_DATA = path.join(os.tmpdir(), 'ufs-company-e2e-server');
const rand = () => crypto.randomBytes(9).toString('base64url') + '7a';   // test-only passwords, never printed
const OWNER = { email: 'owner@e2e.test', password: rand() }, ED = { email: 'ed@e2e.test', temp: rand(), password: rand() }, MIA = { email: 'mia@e2e.test', temp: rand(), password: rand() }, HANA = { email: 'hana@e2e.test', temp: rand(), password: rand() };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const webpSizes = [];
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? ' — ' + extra : ''}`); };
const until = async (fn, ms = 30000, step = 400) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) return false; await sleep(step); } };

// ---------- server control ----------
let serverProc = null; let EXTRA_ENV = {};
async function startServer() {
  serverProc = spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, PORT: String(PORT), TRACKER_DATA_DIR: SERVER_DATA, TRACKER_OWNER_EMAIL: OWNER.email, TRACKER_OWNER_PASSWORD: OWNER.password, TRACKER_OWNER_NAME: 'E2E Owner', ...EXTRA_ENV }, stdio: 'ignore' });
  if (!await until(async () => (await fetch(`${BASE}/api/health`)).ok, 15000, 200)) throw new Error('server did not start');
}
async function stopServer() { if (!serverProc) return; const p = serverProc; serverProc = null; p.kill(); await new Promise(r => p.once('exit', r)); }
async function api(token, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async c => (await api(null, 'POST', '/api/auth/login', { email: c.email, password: c.password })).json.token;

(async () => {
  fs.rmSync(SERVER_DATA, { recursive: true, force: true }); fs.rmSync(APP_DATA, { recursive: true, force: true }); // test-only data
  // UFS People sign-in is exercised through a fake Supabase Auth and a fake directory (synthetic people, started in-process).
  const { pathToFileURL } = require('node:url');
  const FS = await import(pathToFileURL(path.join(SRC, '..', 'server', 'src', 'fake-supabase.ts')).href), FD = await import(pathToFileURL(path.join(SRC, '..', 'server', 'src', 'fake-directory.ts')).href);
  const fakeAuth = await FS.startFakeSupabase({ synthetic: true }), fakeDir = await FD.startFakeDirectory({});
  EXTRA_ENV = { SUPABASE_URL: fakeAuth.url, SUPABASE_PUBLISHABLE_KEY: FS.FAKE_PUBLISHABLE_KEY, DIRECTORY_URL: fakeDir.url, DIRECTORY_TOKEN: FD.FAKE_TOKEN };
  await startServer();

  // ---------- server-side setup (as the owner) ----------
  const owner = await login(OWNER);
  const team = (await api(owner, 'POST', '/api/teams', { name: 'E2E Team' })).json.team.id;
  const miaId = (await api(owner, 'POST', '/api/users', { email: MIA.email, name: 'Mia Manager', role: 'manager', teamId: team, temporaryPassword: MIA.temp })).json.user.id;
  await api(owner, 'POST', '/api/users', { email: ED.email, name: 'Ed Employee', role: 'employee', managerId: miaId, teamId: team, temporaryPassword: ED.temp });
  await api(owner, 'POST', '/api/users', { email: HANA.email, name: 'Hana HR', role: 'hr', temporaryPassword: HANA.temp });
  for (const c of [ED, MIA, HANA]) { const t = (await api(null, 'POST', '/api/auth/login', { email: c.email, password: c.temp })).json.token; await api(t, 'POST', '/api/auth/change-password', { currentPassword: c.temp, newPassword: c.password }); }
  const project = (await api(owner, 'POST', '/api/projects', { name: 'Website', client: 'Acme' })).json.project.id;
  await api(owner, 'POST', `/api/projects/${project}/tasks`, { name: 'Build' });
  await api(owner, 'PUT', '/api/policy/org/org', { screenshotIntervalSeconds: 10 });   // retention and image format stay at the defaults (90 days, WebP)
  const mia = await login(MIA); const hana = await login(HANA);
  const edUserId = (await api(owner, 'GET', '/api/users')).json.users.find(u => u.email === ED.email).id;
  const serverShots = async () => (await api(mia, 'GET', `/api/screenshots?userId=${edUserId}&limit=200`)).json.screenshots ?? [];
  const serverEntries = async () => (await api(mia, 'GET', `/api/time-entries?userId=${edUserId}`)).json.entries ?? [];
  const live = async () => (await api(mia, 'GET', '/api/team/live')).json.members.find(m => m.name === 'Ed Employee');

  // ---------- A: launch signed out, sign in, consent ----------
  console.log('\n== A: sign-in and consent ==');
  let app = await electron.launch({ executablePath: EXE, args: ARGS }); let page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded'); await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'co-01-signed-out.png') });
  check('signed out: local-only wording and sign-in form visible', (await page.textContent('#local-pill')).includes('Local only') && await page.isVisible('#account-out') && !(await page.isVisible('#account-in')));
  check('signed out: the project picker is hidden', !(await page.isVisible('#project-row')));
  await page.fill('#sync-server', `127.0.0.1:${PORT}`); await page.fill('#sync-email', ED.email); await page.fill('#sync-password', 'definitely-wrong-1'); await page.click('#sync-signin'); await sleep(1500);
  check('wrong password is reported clearly', (await page.textContent('#account-error')).includes('Incorrect email or password'), await page.textContent('#account-error'));
  await page.fill('#sync-server', 'http://not-local.example'); await page.fill('#sync-password', ED.password); await page.click('#sync-signin'); await sleep(600);
  check('plain-http remote servers are refused', (await page.textContent('#account-error')).includes('https'), await page.textContent('#account-error'));
  await page.fill('#sync-server', `127.0.0.1:${PORT}`); await page.click('#sync-signin'); await sleep(2500);
  check('sign-in succeeds: account card shows name and server', (await page.textContent('#account-who')).includes('Ed Employee') && (await page.textContent('#account-server')).includes(`127.0.0.1:${PORT}`));
  check('wording changes to "synced" so the user knows data leaves the computer', (await page.textContent('#local-pill')).includes('Synced to') && (await page.textContent('#privacy-line')).includes('uploaded to'));
  check('password field is cleared after sign-in', (await page.inputValue('#sync-password')) === '');
  const policyText = await page.textContent('#policy-summary');
  check('policy summary shows the 10 s interval, retention and who can view', policyText.includes('every 10 s') && policyText.includes('90 days') && policyText.includes('direct manager and HR'), policyText);
  check('monitoring notice is shown and Start is blocked until accepted', await page.isVisible('#consent-notice') && await page.isDisabled('#start'));
  await page.screenshot({ path: path.join(OUT, 'co-02-notice.png') });
  await page.click('#accept-consent'); await sleep(1500);
  check('accepting the notice enables Start', !(await page.isVisible('#consent-notice')) && !(await page.isDisabled('#start')));
  const projectOptions = await page.$$eval('#project option', os => os.map(o => o.textContent));
  check('projects from the server are offered', projectOptions.includes('Website (Acme)'), projectOptions.join(' | '));
  check('mode is fixed to company session and the interval picker is hidden', (await page.inputValue('#mode')) === 'company' && await page.isDisabled('#mode') && !(await page.isVisible('#interval')));

  // ---------- B: a tracked company session ----------
  console.log('\n== B: tracked session ==');
  await page.selectOption('#project', { label: 'Website (Acme)' }); await sleep(300);
  check('tasks for the chosen project appear', (await page.$$eval('#task-pick option', os => os.map(o => o.textContent))).includes('Build'));
  await page.selectOption('#task-pick', { label: 'Build' });
  const displays = await page.$$eval('#display option', os => os.map(o => o.value)); await page.selectOption('#display', displays[1]);
  await page.fill('#task', 'E2E company work'); await page.check('#consent');
  await page.click('#start'); await until(async () => (await page.textContent('#status-badge')).includes('Tracking'), 15000);
  check('tracking starts', (await page.textContent('#status-badge')).includes('Tracking is on'));
  check('status message says data is sent to the organization', (await page.textContent('#status-message')).includes('sent to your organization'), await page.textContent('#status-message'));
  check('sign-out is disabled while tracking', await page.isDisabled('#sync-signout'));
  await sleep(30000);
  await page.screenshot({ path: path.join(OUT, 'co-03-tracking.png') });
  const shotsB = await until(async () => { const s = await serverShots(); return s.length >= 3 ? s : false; }, 20000);
  check('screenshots reach the server at the policy interval (>=3 in ~30 s)', !!shotsB, `server has ${(await serverShots()).length}`);
  const times = (await serverShots()).map(s => Date.parse(s.takenAt)).sort((a, b) => a - b); const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / 1000));
  check('capture spacing follows the 10 s policy', gaps.length > 0 && gaps.every(g => g >= 8 && g <= 14), `gaps=${gaps.join(',')}s`);
  check('thumbnails were uploaded for the manager\'s grid', (await serverShots()).every(s => s.hasThumb));
  const listB = await serverShots();
  const imgRes = await fetch(`${BASE}/api/screenshots/${listB[0].id}/image`, { headers: { Authorization: `Bearer ${mia}` } });
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  webpSizes.push(...listB.map(s => s.bytes));
  check('screenshots arrive as real WebP (the policy default), served as image/webp', listB.every(s => s.format === 'webp') && imgRes.headers.get('content-type') === 'image/webp' && imgBytes.subarray(0, 4).toString() === 'RIFF' && imgBytes.subarray(8, 12).toString() === 'WEBP' && imgBytes.length > 5000, `${imgBytes.length} bytes`);
  check('WebP screenshots are well under 300 KB each (a 1080p PNG here is about 500 KB)', listB.every(s => s.bytes < 300_000), `avg ${Math.round(webpSizes.reduce((a, b) => a + b, 0) / webpSizes.length / 1000)} KB`);
  const thumbRes = await fetch(`${BASE}/api/screenshots/${listB[0].id}/thumb`, { headers: { Authorization: `Bearer ${mia}` } }); const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
  check('the thumbnail made by the app arrives as a small JPEG', thumbRes.headers.get('content-type') === 'image/jpeg' && thumbBytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && thumbBytes.length < 60_000, `${thumbBytes.length} bytes`);
  const hrList = await api(hana, 'GET', `/api/screenshots?userId=${edUserId}&limit=5`); const hrImg = await fetch(`${BASE}/api/screenshots/${listB[0].id}/image`, { headers: { Authorization: `Bearer ${hana}` } });
  check('HR can see the employee\'s screenshots too, but cannot delete them', hrList.status === 200 && hrList.json.screenshots.length > 0 && hrImg.status === 200 && (await api(hana, 'DELETE', `/api/screenshots/${listB[0].id}`)).status === 403);
  const entryB = (await serverEntries())[0];
  check('time entry exists with project, task label and company mode', !!entryB && entryB.projectName === 'Website' && entryB.taskLabel === 'E2E company work' && entryB.mode === 'company' && entryB.endAt === null, JSON.stringify(entryB && { p: entryB.projectName, m: entryB.mode, t: entryB.trackedMs }));
  const lv = await live(); check('manager\'s live view shows Ed tracking on Website', lv.state === 'tracking' && lv.projectName === 'Website', JSON.stringify(lv));

  // ---------- C: pause / resume ----------
  console.log('\n== C: pause and resume ==');
  await page.click('#pause'); await sleep(3000);
  check('live view shows paused', (await live()).state === 'paused');
  const nPaused = (await serverShots()).length; await sleep(14000);
  check('no screenshots while paused', (await serverShots()).length === nPaused);
  await page.click('#start'); await until(async () => (await page.textContent('#status-badge')).includes('Tracking'), 15000); await sleep(2500);
  check('resume continues the same session and live shows tracking again', (await live()).state === 'tracking' && (await serverEntries()).length === 1);

  // ---------- D: server outage, nothing lost ----------
  console.log('\n== D: offline and recovery ==');
  await stopServer(); await sleep(26000);
  await page.screenshot({ path: path.join(OUT, 'co-04-offline.png') });
  const detail = await page.textContent('#sync-detail');
  check('app shows offline and items waiting while the server is down', (await page.textContent('#sync-status')).includes('Offline') && /\d+ item\(s\) waiting/.test(detail), detail);
  check('tracking continues locally during the outage', (await page.textContent('#status-badge')).includes('Tracking is on'));
  await startServer(); const mia2 = await login(MIA); void mia2;
  const drained = await until(async () => /Everything is uploaded/.test(await page.textContent('#sync-detail')), 90000, 1000);
  check('after the server returns, the queue drains automatically', !!drained, await page.textContent('#sync-detail'));

  // ---------- E: stop; totals match, no duplicates ----------
  console.log('\n== E: stop and reconcile ==');
  console.log('  state before stop:', (await page.textContent('#status-badge')).trim(), '|', (await page.textContent('#status-message')).trim(), '| stop disabled:', await page.isDisabled('#stop'));
  if (!await page.isDisabled('#stop')) await page.click('#stop');
  await sleep(3500);
  const localCount = Number(((await page.textContent('#nav-count')) || '0'));
  const entriesE = await serverEntries(), shotsE = await serverShots();
  check('exactly one time entry on the server, and it is finished', entriesE.length === 1 && !!entriesE[0].endAt, JSON.stringify(entriesE.map(e => e.endAt)));
  check('tracked time is plausible (>=60 s) and idle never exceeds tracked', entriesE[0].trackedMs >= 60000 && entriesE[0].idleMs <= entriesE[0].trackedMs, `tracked=${Math.round(entriesE[0].trackedMs / 1000)}s`);
  check('every local screenshot is on the server exactly once', shotsE.length === localCount && new Set(shotsE.map(s => s.clientId)).size === shotsE.length, `local=${localCount} server=${shotsE.length}`);
  await page.click('[data-panel="gallery-panel"]'); await sleep(2500);
  const cards = await page.$$eval('.capture-card img', imgs => imgs.map(i => ({ src: i.src.slice(0, 23), ok: i.complete && i.naturalWidth > 0 })));
  check('the local gallery shows a saved thumbnail for every screenshot', cards.length === localCount && cards.every(c => c.src.startsWith('data:image/jpeg') && c.ok), `${cards.length} cards`);
  await page.locator('.capture-card').first().click(); await sleep(1200);
  check('opening a WebP screenshot locally displays the full image', await page.$eval('#full-image', i => i.complete && i.naturalWidth > 0 && i.src.startsWith('data:image/webp')));
  await page.click('#close-modal'); await page.click('[data-panel="tracker-panel"]'); await sleep(500);
  check('live view shows Ed offline/stopped', ['offline'].includes((await live()).state) || (await live()).state === 'tracking' === false);

  // ---------- F: policy off -> time only ----------
  console.log('\n== F: screenshots disabled by policy ==');
  await api(owner, 'PUT', '/api/policy/org/org', { screenshotIntervalSeconds: 10, screenshotsEnabled: false });
  await page.click('#sync-now'); await sleep(2500);
  check('policy change reaches the app and the display picker disappears', (await page.textContent('#policy-summary')).includes('does not take screenshots') && !(await page.isVisible('#display')), await page.textContent('#policy-summary'));
  const before = (await serverShots()).length;
  await page.check('#consent'); await page.click('#start'); await until(async () => (await page.textContent('#status-badge')).includes('Tracking'), 15000);
  check('tracking starts with no screen chosen or shared', (await page.textContent('#status-message')).includes('no screenshots are taken'), await page.textContent('#status-message'));
  await sleep(22000);
  check('no screenshots are taken or uploaded', (await serverShots()).length === before && (await page.textContent('#next-stat')) !== 'Saving…');
  await page.click('#stop'); await sleep(3500);
  const entriesF = await serverEntries();
  check('the time-only session still syncs as a second entry', entriesF.length === 2 && entriesF.some(e => e.trackedMs >= 15000 && e.endAt), JSON.stringify(entriesF.map(e => Math.round(e.trackedMs / 1000))));

  // ---------- G: requireProject ----------
  console.log('\n== G: required project ==');
  await api(owner, 'PUT', '/api/policy/org/org', { screenshotsEnabled: false, requireProject: true });
  await page.click('#sync-now'); await sleep(2000);
  await page.selectOption('#project', ''); await page.check('#consent'); await page.click('#start'); await sleep(1500);
  check('starting without a project is refused with a clear message', (await page.textContent('#error')).includes('requires choosing a project'), await page.textContent('#error'));
  await api(owner, 'PUT', '/api/policy/org/org', { screenshotsEnabled: true, screenshotIntervalSeconds: 10 });
  await page.click('#sync-now'); await sleep(1500);

  // ---------- I: PNG policy and blur ----------
  console.log('\n== I: PNG policy, then blur ==');
  const phaseI = async (policy, label) => {
    await api(owner, 'PUT', '/api/policy/org/org', { screenshotIntervalSeconds: 10, ...policy }); await page.click('#sync-now'); await sleep(2000);
    const before = new Set((await serverShots()).map(s => s.id));
    await page.selectOption('#display', displays[1]); await page.check('#consent'); await page.click('#start');
    await until(async () => (await page.textContent('#status-badge')).includes('Tracking'), 15000); await sleep(4000);
    await page.click('#stop'); await sleep(3500);
    const fresh = (await serverShots()).filter(s => !before.has(s.id)); check(`${label}: a screenshot was uploaded`, fresh.length >= 1, `n=${fresh.length}`); return fresh[0];
  };
  const avgWebp = () => webpSizes.reduce((a, b) => a + b, 0) / webpSizes.length;
  const fetchImage = async shot => Buffer.from(await (await fetch(`${BASE}/api/screenshots/${shot.id}/image`, { headers: { Authorization: `Bearer ${mia}` } })).arrayBuffer());
  const png1 = await phaseI({ imageFormat: 'png' }, 'PNG policy'); const raw1 = await fetchImage(png1);
  check('with the PNG policy the screenshot is a real, lossless PNG', png1.format === 'png' && raw1.subarray(1, 4).toString() === 'PNG', `${raw1.length} bytes`);
  check('PNG is several times larger than WebP (why WebP is the default)', raw1.length > 2.5 * avgWebp(), `PNG ${Math.round(raw1.length / 1000)} KB vs WebP avg ${Math.round(avgWebp() / 1000)} KB`);
  const png2 = await phaseI({ imageFormat: 'png', screenshotBlur: true }, 'blur policy'); const raw2 = await fetchImage(png2);
  // File size says nothing about blur (smooth gradients compress badly in PNG), so decode both images in the browser and
  // compare edge energy: the mean absolute difference between neighbouring pixels.
  const edgeEnergy = bytes => page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height; const ctx = canvas.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height); let sum = 0, n = 0;
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width - 1; x += 2) { const i = (y * width + x) * 4; sum += Math.abs(data[i] - data[i + 4]) + Math.abs(data[i + 1] - data[i + 5]) + Math.abs(data[i + 2] - data[i + 6]); n += 3; }
    return sum / n;
  }, bytes.toString('base64'));
  const sharpEdges = await edgeEnergy(raw1), blurEdges = await edgeEnergy(raw2);
  check('blur policy: the uploaded screenshot has far less edge detail than the unblurred one', blurEdges < 0.5 * sharpEdges, `edge energy ${blurEdges.toFixed(2)} (blurred) vs ${sharpEdges.toFixed(2)} (sharp)`);
  await api(owner, 'PUT', '/api/policy/org/org', { screenshotIntervalSeconds: 10 }); await page.click('#sync-now'); await sleep(1500);

  // ---------- H: restart stays signed in; sign out revokes the device ----------
  console.log('\n== H: restart and sign out ==');
  await app.close(); await sleep(1500);
  app = await electron.launch({ executablePath: EXE, args: ARGS }); page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await sleep(3500);
  check('after restart the app is still signed in (token stored encrypted)', await page.isVisible('#account-in') && (await page.textContent('#account-who')).includes('Ed Employee'));
  check('restart never starts tracking on its own', (await page.textContent('#status-badge')).includes('Ready'));
  const stored = fs.readFileSync(path.join(APP_DATA, 'sync-config.json'), 'utf8');
  check('the saved config holds no password and no plaintext token', !stored.includes(ED.password) && /"tokenEnc":"[A-Za-z0-9+/=]{20,}"/.test(stored));
  const edToken = await login(ED); const devicesBefore = (await api(edToken, 'GET', '/api/me/devices')).json.sessions.filter(s => s.kind === 'device').length;
  await page.click('#sync-signout'); await sleep(2500);
  check('sign-out returns to the local-only state', await page.isVisible('#account-out') && (await page.textContent('#local-pill')).includes('Local only'));
  const devicesAfter = (await api(edToken, 'GET', '/api/me/devices')).json.sessions.filter(s => s.kind === 'device').length;
  check('the device token was revoked on the server', devicesBefore >= 1 && devicesAfter === 0, `${devicesBefore} -> ${devicesAfter}`);
  check('signed out: the old local gallery is kept', Number(await page.textContent('#nav-count')) >= localCount);
  await page.screenshot({ path: path.join(OUT, 'co-05-signed-out-again.png') });

  // ---------- K: sign in to the desktop app with a UFS People account (fake Supabase + fake directory) ----------
  console.log('\n== K: UFS People sign-in on the desktop ==');
  const person = id => { const e = fakeDir.find(id); return { email: e.email, name: e.name, subject: fakeDir.feed.identities.find(i => i.employeeId === id).subject }; };
  const fillLogin = async (email, password = FS.FAKE_PASSWORD) => { await page.fill('#sync-server', `127.0.0.1:${PORT}`); await page.fill('#sync-email', email); await page.fill('#sync-password', password); };
  await sleep(1500);
  const hr = person('emp-002');
  await fillLogin(hr.email); await page.click('#sync-signin'); await sleep(2500);
  check('an HR manager is asked for the authenticator code, and the app is not signed in yet', await page.isVisible('#totp-row') && (await page.textContent('#account-info')).includes('6-digit code') && !(await page.isVisible('#account-in')));
  check('the password stays in the field for the second step', (await page.inputValue('#sync-password')) === FS.FAKE_PASSWORD);
  await page.screenshot({ path: path.join(OUT, 'co-06-totp.png') });
  await page.fill('#sync-totp', '000000'); await page.click('#sync-signin'); await sleep(2500);
  check('a wrong code is refused and the code field stays open', (await page.textContent('#account-error')).includes('Incorrect code') && await page.isVisible('#totp-row') && !(await page.isVisible('#account-in')));
  await page.fill('#sync-totp', fakeAuth.code(hr.subject)); await page.click('#sync-signin'); await sleep(3500);
  check('the right code signs HR in, with role and server shown', await page.isVisible('#account-in') && (await page.textContent('#account-who')).includes(hr.name) && (await page.textContent('#account-who')).includes('hr'), await page.textContent('#account-who'));
  check('the code and password fields are cleared and the code row hidden after sign-in', (await page.inputValue('#sync-password')) === '' && !(await page.isVisible('#totp-row')));
  check('a person who has not accepted the notice yet must accept it before tracking', await page.isVisible('#consent-notice') && await page.isDisabled('#start'));
  await page.screenshot({ path: path.join(OUT, 'co-07-hr-signed-in.png') });
  const cfgFile = fs.readFileSync(path.join(APP_DATA, 'sync-config.json'), 'utf8');
  check('the desktop config holds neither the password nor the code nor any Supabase token', ![FS.FAKE_PASSWORD, ...fakeAuth.issued].some(t => cfgFile.includes(t)) && /"tokenEnc":"[A-Za-z0-9+/=]{20,}"/.test(cfgFile));
  await page.click('#sync-signout'); await sleep(2500);
  check('HR signs out again', await page.isVisible('#account-out'));
  // an ordinary employee needs the password only
  const emp = person('emp-009'); await fillLogin(emp.email); await page.click('#sync-signin'); await sleep(3500);
  check('an ordinary employee signs in with the password only', await page.isVisible('#account-in') && (await page.textContent('#account-who')).includes(emp.name) && !(await page.isVisible('#totp-row')));
  await page.click('#sync-signout'); await sleep(2500);
  // somebody with a Supabase account but no approved identity gets nothing
  const stranger = fakeDir.find('emp-010'); fakeAuth.addUser({ email: stranger.email });
  await fillLogin(stranger.email); await page.click('#sync-signin'); await sleep(2500);
  check('a person without an approved identity is refused (not matched by email)', (await page.textContent('#account-error')).includes('not set up for the Time Tracker') && await page.isVisible('#account-out'));
  await fillLogin(emp.email, 'wrong-password-123'); await page.click('#sync-signin'); await sleep(2000);
  check('a wrong password gives the generic message', (await page.textContent('#account-error')).includes('Incorrect email or password'));
  const supabaseLogins = (await api(owner, 'GET', '/api/audit?limit=300')).json.entries.filter(e => e.action === 'auth.login' && e.detail?.via === 'supabase');
  check('the server recorded the UFS People sign-ins (aal2 for HR, aal1 for the employee)', supabaseLogins.some(e => e.detail.aal === 'aal2') && supabaseLogins.some(e => e.detail.aal === 'aal1'), supabaseLogins.map(e => e.detail.aal).join());
  check('every temporary Supabase session was closed again', [...fakeAuth.sessions.values()].every(x => x.revoked));

  // ---------- audit trail ----------
  const audit = (await api(owner, 'GET', '/api/audit?limit=300')).json.entries.map(e => e.action);
  check('server audit log recorded logins, consent and the manager\'s image view', ['auth.login', 'consent.accepted', 'auth.logout'].every(a => audit.includes(a)), audit.filter((a, i, arr) => arr.indexOf(a) === i).join(','));

  await app.close(); await stopServer(); await fakeAuth.close(); await fakeDir.close();
  fs.rmSync(SERVER_DATA, { recursive: true, force: true }); fs.rmSync(APP_DATA, { recursive: true, force: true });   // delete every real screenshot taken by this test
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(async e => { console.error('SCRIPT ERROR', e); await stopServer().catch(() => {}); process.exit(2); });
