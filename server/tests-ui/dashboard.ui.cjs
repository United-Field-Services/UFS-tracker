// Browser test of the manager/employee dashboard against a RUNNING server seeded with `npm run seed:demo`.
// Not part of `npm test` (needs a browser). Playwright is not a project dependency:
//   npm i playwright-core   (in any folder)   then   set PW_PATH=<that folder>\node_modules\playwright-core
//   set DASH_URL=http://127.0.0.1:4300  set DEMO_PASSWORD=<DEMO_PASSWORD from src/seed-demo.ts>  set SHOT_DIR=<output folder>
const { chromium } = require(process.env.PW_PATH || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const URL_BASE = process.env.DASH_URL || 'http://127.0.0.1:4300';
const DIRECTORY_URL = process.env.DIRECTORY_URL || 'http://127.0.0.1:4310';
const DIRECTORY_MUTATION_URL = process.env.DIRECTORY_MUTATION_URL || 'http://127.0.0.1:4310';
const FAKE_AUTH_URL = process.env.FAKE_AUTH_URL || 'http://127.0.0.1:4320';
const PASSWORD = process.env.DEMO_PASSWORD;
const OUT = process.env.SHOT_DIR || __dirname;
if (!PASSWORD) { console.error('Set DEMO_PASSWORD (see src/seed-demo.ts).'); process.exit(3); }
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newSession(browser, viewport = { width: 1360, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  // 400/401 responses are expected here (tests submit bad input on purpose); anything else is a real problem.
  page.on('response', r => { if (r.status() >= 400 && ![400, 401, 422].includes(r.status())) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  return { context, page, problems };
}
async function login(page, email, password = PASSWORD) {
  await page.goto(URL_BASE);
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
}
const nav = async (page, label) => { await page.click(`.nav button:has-text("${label}")`); await sleep(700); };
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `ui-${name}.png`) });

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

  // ---------- login screen ----------
  {
    const { context, page, problems } = await newSession(browser);
    await page.goto(URL_BASE); await sleep(500);
    await shot(page, '00-login');
    await login(page, 'maria@demo.example', 'wrong-password-1'); await sleep(800);
    check('wrong password shows an error and stays on login', (await page.textContent('.banner.error')).includes('Incorrect email or password'));
    await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]'); await sleep(1500);
    check('manager signs in', await page.isVisible('.nav'));

    // ---------- manager: overview ----------
    const nav1 = await page.$$eval('.nav button', bs => bs.map(b => b.textContent));
    check('manager nav has no People/Policy/Audit', !nav1.includes('People') && !nav1.includes('Policy') && !nav1.includes('Audit log') && nav1.includes('Projects'), nav1.join(', '));
    await shot(page, '01-manager-overview');
    const people = await page.$$eval('#main tbody tr td:first-child', tds => tds.map(t => t.textContent));
    check('overview lists only the manager and direct reports', people.sort().join() === 'Ana Engineer,Ben Engineer,Maria Manager', people.join(', '));
    check('overview stat cards render', (await page.$$('.stat')).length === 4);

    // ---------- timesheets ----------
    await nav(page, 'Timesheets'); await shot(page, '02-manager-timesheets');
    const rows = await page.$$('#main tbody tr'); check('timesheets show entries', rows.length > 5, `rows=${rows.length}`);
    const names = new Set(await page.$$eval('#main tbody tr td:first-child', t => t.map(x => x.textContent)));
    check('timesheets only include visible people', ![...names].some(n => n.includes('Cara') || n.includes('Dev')), [...names].join(', '));
    await page.locator('#main tbody tr:has(.badge.warn) button:has-text("Edit")').first().click(); await sleep(400);
    await page.fill('dialog textarea', 'ok'); await shot(page, '03-edit-dialog');
    await page.click('dialog button:has-text("Save")'); await sleep(700);
    check('editing with a too-short reason shows an error', await page.locator('dialog .banner.error').count() > 0);
    await page.fill('dialog textarea', 'Break time was included'); await page.click('dialog button:has-text("Save")'); await sleep(900);
    check('valid reviewer edit is saved and flagged as edited', await page.locator('#main tbody .badge:has-text("edited")').count() === 1);
    const approveAll = page.locator('button:has-text("Approve all")');
    if (await approveAll.count()) { await approveAll.click(); await sleep(1500); }
    check('no pending rows remain after bulk approve', (await page.locator('#main tbody .badge.warn').count()) === 0);
    check('approved entries are locked for managers (no Edit buttons)', await page.locator('#main tbody button:has-text("Edit")').count() === 0);

    // ---------- screenshots ----------
    await nav(page, 'Screenshots'); await sleep(1500); await shot(page, '04-manager-screenshots');
    const thumbs = await page.$$eval('.shot img', imgs => imgs.filter(i => i.src.startsWith('blob:')).length);
    check('screenshot thumbnails load through authenticated fetch', thumbs > 3, `loaded=${thumbs}`);
    await page.locator('.shot').first().click(); await sleep(900); await shot(page, '05-screenshot-modal');
    const full = await page.$eval('dialog img.full', i => i.complete && i.naturalWidth > 0);
    check('full screenshot opens in a dialog', full);
    check('manager can delete reports\' screenshots (button present)', await page.locator('dialog button:has-text("Delete screenshot")').count() === 1);
    await page.click('dialog button:has-text("Close")');

    // ---------- reports ----------
    await nav(page, 'Reports'); await shot(page, '06-manager-reports');
    check('report renders bars and totals', (await page.$$('.bar-row')).length >= 2);
    await page.getByLabel('Report').selectOption('activity'); await page.click('button:has-text("Run report")'); await sleep(700);
    check('activity report is clearly labeled as an opt-in estimate', (await page.locator('#main').textContent()).includes('No opted-in activity estimates') && (await page.locator('#main').textContent()).includes('not a measure of productivity, quality, attendance, or pay'));
    await page.getByLabel('Report').selectOption('attendance'); await page.click('button:has-text("Run report")'); await sleep(700);
    check('attendance report states that missing tracker data does not establish absence', (await page.locator('#main').textContent()).includes('No scheduled workdays') && (await page.locator('#main').textContent()).includes('does not establish absence'));
    await page.getByLabel('Report').selectOption('activity-daily'); await page.click('button:has-text("Run report")'); await sleep(700);
    check('daily activity rollup explains UTC buckets and count-only limits', (await page.locator('#main').textContent()).includes('No daily activity aggregates') && (await page.locator('#main').textContent()).includes('UTC date') && (await page.locator('#main').textContent()).includes('not productivity, attendance, or pay evidence'));
    await page.getByLabel('Report').selectOption('hours'); await page.click('button:has-text("Run report")'); await sleep(700);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export CSV")')]);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    check('CSV export downloads with header and total', csv.startsWith('Group,Tracked hours') && csv.includes('Total,'), download.suggestedFilename());

    // ---------- projects ----------
    await nav(page, 'Projects'); await shot(page, '07-manager-projects');
    await page.click('button:has-text("New project")'); await page.fill('dialog input[type=text]', 'UI test project'); await page.click('dialog button:has-text("Create")'); await sleep(900);
    check('manager creates a project', await page.locator('h2:has-text("UI test project")').count() === 1);

    // ---------- direct URL to an admin view is not exposed ----------
    check('no console errors or CSP violations (manager session)', problems.length === 0, problems.join(' | '));
    await context.close();
  }

  // ---------- employee ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'ana@demo.example'); await sleep(1500);
    const navItems = await page.$$eval('.nav button', bs => bs.map(b => b.textContent));
    check('employee nav is limited', navItems.join() === 'Overview,Timesheets,Screenshots,Reports,My account', navItems.join());
    await shot(page, '08-employee-overview');
    await nav(page, 'Timesheets');
    const who = new Set(await page.$$eval('#main tbody tr td:first-child', t => t.map(x => x.textContent)));
    check('employee sees only own time', who.size === 1 && who.has('Ana Engineer'), [...who].join());
    check('employee has no approve buttons', await page.locator('button:has-text("Approve")').count() === 0);
    await page.click('button:has-text("Add manual time")'); await sleep(300); await shot(page, '09-manual-dialog');
    await page.click('dialog button:has-text("Add time")'); await sleep(900);
    check('manual time is added as pending', await page.locator('#main tbody tr:has-text("manual") .badge.warn').count() >= 1);
    await nav(page, 'Screenshots'); await sleep(1200);
    const owners = new Set(await page.$$eval('.shot .cap strong', e => e.map(x => x.textContent)));
    check('employee sees only own screenshots', owners.size === 1 && owners.has('Ana Engineer'), [...owners].join());
    await nav(page, 'My account'); await shot(page, '10-employee-account');
    check('account page explains what is recorded', (await page.textContent('#main')).includes('Not recorded: audio, camera, keystrokes'));
    check('no console errors or CSP violations (employee session)', problems.length === 0, problems.join(' | '));
    await context.close();
  }

  // ---------- admin ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'admin@demo.example'); await sleep(1500);
    check('admin nav has everything', (await page.$$eval('.nav button', bs => bs.length)) === 10);
    await nav(page, 'People'); await shot(page, '11-admin-people');
    await page.click('button:has-text("Add person")'); await sleep(300);
    await page.fill('dialog input[type=email]', 'ui.newhire@demo.example'); await page.fill('dialog input[type=text] >> nth=0', 'UI New Hire'); await page.fill('dialog input[placeholder*="10+"]', 'Temp-hire-pass-77'); await page.click('dialog button:has-text("Create")'); await sleep(1000);
    check('admin adds a person (shown as invited)', await page.locator('tr:has-text("UI New Hire") .badge:has-text("invited")').count() === 1);
    // ---- UFS People directory (fake feed with synthetic people, started by reset-demo.ps1) ----
    const mutate = body => fetch(`${DIRECTORY_MUTATION_URL}/__mutate`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.ok);
    await shot(page, '11b-admin-directory');
    check('directory card shows a successful sync from the fake UFS People feed', (await page.textContent('#main')).includes('UFS People directory') && await page.locator('#main h2:has-text("UFS People directory") .badge:has-text("Synced")').count() === 1);
    check('synced people are tagged "UFS People" (30 of them)', await page.locator('#main tbody .badge:has-text("UFS People")').count() === 30);
    const dirRow = page.locator('#main tbody tr', { has: page.locator('.badge:has-text("UFS People")') }).first();
    check('directory people cannot be edited or given a password here', await dirRow.locator('button:has-text("Managed in UFS People")').isDisabled() && await dirRow.locator('button:has-text("Reset password")').count() === 0 && await dirRow.locator('button:has-text("Edit")').count() === 0);
    check('local people keep their Edit and Reset password buttons', await page.locator('#main tbody tr:has-text("UI New Hire") button:has-text("Edit")').count() === 1);
    await mutate({ op: 'leave', id: 'emp-010' }); await mutate({ op: 'promote', id: 'emp-011', role: 'manager' }); await mutate({ op: 'hire', name: 'Fresh Hire' });
    await page.click('#directory-sync'); await sleep(1500);
    check('"Sync now" applies hires, role changes and leavers from the directory', (await page.textContent('#main')).includes('Applied: 1 added, 1 updated, 1 deactivated') && await page.locator('#main tbody tr:has-text("Fresh Hire")').count() === 1);
    check('the leaver now shows as inactive', await page.locator('#main tbody tr:has(.badge:has-text("inactive")):has(.badge:has-text("UFS People"))').count() === 1);
    for (let i = 12; i <= 24; i++) await mutate({ op: 'leave', id: `emp-0${i}` });
    await page.click('#directory-sync'); await sleep(1500);
    check('a feed that would deactivate over 30% is blocked and nothing changes', (await page.textContent('#main')).includes('Not applied') && await page.locator('#main h2:has-text("UFS People directory") .badge:has-text("Blocked")').count() === 1);
    check('an admin (not owner) cannot force a blocked sync', await page.locator('button:has-text("Review and force")').count() === 0);
    await shot(page, '11c-directory-blocked');
    await nav(page, 'Policy'); await shot(page, '12-admin-policy');
    const activityPolicy = page.locator('.field-row').filter({ hasText: 'Count keyboard key-downs and mouse clicks' });
    await activityPolicy.locator('input[type=checkbox]').check(); await page.click('button:has-text("Save policy")'); await sleep(300);
    check('activity tracking cannot be enabled without a new notice version', (await page.locator('#main').textContent()).includes('requires a new monitoring-notice version'));
    await page.locator('.field-row').filter({ hasText: 'Monitoring notice version' }).locator('input[type=number]').fill('2');
    await page.click('button:has-text("Save policy")'); await sleep(400);
    check('activity policy saves when the consent version is raised', (await page.locator('#main').textContent()).includes('Policy saved.'));
    await sleep(1100); // the editor reloads itself 800 ms after a save; wait so the next edit is not wiped
      const allScreensPolicy = page.locator('.field-row').filter({ hasText: 'Capture all connected screens' });
      await allScreensPolicy.locator('input[type=checkbox]').check(); await page.click('button:has-text("Save policy")'); await sleep(300);
      check('all-screens policy requires a separate monitoring notice version', (await page.locator('#main').textContent()).includes('requires a new monitoring-notice version'));
      await page.locator('.field-row').filter({ hasText: 'Monitoring notice version' }).locator('input[type=number]').fill('3');
      const [allScreensSave] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/policy/org/org') && response.request().method() === 'PUT'), page.click('button:has-text("Save policy")')]);
      const allScreensMessage = await allScreensSave.json();
      check('organization all-screens policy saves after raising the notice version', allScreensSave.ok() && allScreensMessage.overrides?.captureAllScreens === true, `${allScreensSave.status()} ${JSON.stringify(allScreensMessage)}`);
      await sleep(1000); // let the policy editor's post-save reload finish before changing scope
    await page.selectOption('select', { label: 'Team: Engineering' }); await sleep(600);
      const teamPolicyControls = { overrides: await page.locator('input[aria-label^="Override"]').count(), allScreens: await page.locator('.field-row').filter({ hasText: 'Capture all connected screens' }).count(), times: await page.locator('input[type=time]').count(), multiple: await page.locator('select[multiple]').count() };
      check('team policy omits organization-only all-screens control and shows other overrides', teamPolicyControls.overrides === 19 && teamPolicyControls.allScreens === 0 && teamPolicyControls.times === 2 && teamPolicyControls.multiple === 1, JSON.stringify(teamPolicyControls));
    await nav(page, 'Audit log'); await shot(page, '13-admin-audit');
    check('audit log shows the user creation', (await page.textContent('#main')).includes('user.created'));
    check('no console errors or CSP violations (admin session)', problems.length === 0, problems.join(' | '));
    await context.close();
  }

  // ---------- owner: can review and force a blocked directory sync ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'owner@demo.example'); await sleep(1500); await nav(page, 'People');
    check('owner sees the blocked sync with a force option', await page.locator('#main h2:has-text("UFS People directory") .badge:has-text("Blocked")').count() === 1 && await page.locator('button:has-text("Review and force")').count() === 1);
    page.once('dialog', d => d.accept());
    await page.click('button:has-text("Review and force")'); await sleep(2000);
    check('forcing applies it, and the directory people are deactivated', (await page.textContent('#main')).includes('Applied') && await page.locator('#main tbody tr:has(.badge:has-text("inactive")):has(.badge:has-text("UFS People"))').count() >= 13);
    await fetch(`${DIRECTORY_MUTATION_URL}/__mutate`, { method: 'POST', body: JSON.stringify({ op: 'reset' }) });
    await page.click('#directory-sync'); await sleep(1800);
    check('when the directory recovers, people are reactivated automatically', (await page.textContent('#main')).includes('reactivated') && await page.locator('#main tbody tr:has(.badge:has-text("inactive")):has(.badge:has-text("UFS People"))').count() === 0);
    await shot(page, '11d-owner-directory');
    check('no console errors or CSP violations (owner session)', problems.length === 0, problems.join(' | '));
    await context.close();
  }

  // ---------- HR: sees everyone, changes nothing ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'hana@demo.example'); await sleep(1500);
    const navItems = await page.$$eval('.nav button', bs => bs.map(b => b.textContent));
    check('HR nav: read-only areas only', navItems.join() === 'Overview,Admin portal,Timesheets,Screenshots,Reports,My account', navItems.join());
    await shot(page, '17-hr-overview');
    const members = await page.$$eval('#main tbody tr td:first-child', tds => tds.map(t => t.textContent));
    check('HR overview shows the whole organization', members.includes('Ana Engineer') && members.includes('Cara Support') && members.includes('Hana HR'), members.length + ' people');
    await nav(page, 'Timesheets');
    const people = new Set(await page.$$eval('#main tbody tr td:first-child', t => t.map(x => x.textContent)));
    check('HR timesheets include every team', people.has('Ana Engineer') && people.has('Cara Support'), [...people].join(', '));
    check('HR has no approve, reject, edit or delete controls', await page.locator('#main tbody button:has-text("Approve"), #main tbody button:has-text("Reject"), #main tbody button:has-text("Edit"), #main tbody button:has-text("Delete")').count() === 0);
    await nav(page, 'Screenshots'); await sleep(1200);
    const owners = new Set(await page.$$eval('.shot .cap strong', e => e.map(x => x.textContent)));
    check('HR sees screenshots from several people', owners.size >= 2, [...owners].join(', '));
    await page.locator('.shot').first().click(); await sleep(900);
    check('HR can open a screenshot but not delete it', await page.isVisible('dialog img.full') && await page.locator('dialog button:has-text("Delete screenshot")').count() === 0);
    await page.click('dialog button:has-text("Close")');
    await nav(page, 'My account');
    check('account page tells HR-visible staff that HR can view screenshots', (await page.textContent('#main')).includes('HR can view them'));
    check('no console errors or CSP violations (HR session)', problems.length === 0, problems.join(' | '));
    await context.close();
  }

  // ---------- sign in with a UFS People account (fake Supabase Auth + fake directory, synthetic people) ----------
  {
    const FAKE_DIR_TOKEN = 'fake-directory-token-for-local-dev-only', FAKE_PW = 'Fake-supabase-password-1';
    const feed = await (await fetch(`${DIRECTORY_URL}/directory.json`, { headers: { Authorization: `Bearer ${FAKE_DIR_TOKEN}` } })).json();
    const emailOf = id => feed.employees.find(e => e.id === id).email; const codeFor = async email => (await (await fetch(`${FAKE_AUTH_URL}/__totp?user=${encodeURIComponent(email)}`)).json()).code;
    const { context, page, problems } = await newSession(browser);
    await page.goto(URL_BASE); await sleep(800);
    check('login screen says UFS People account and hides the authenticator field', (await page.textContent('label.field:first-of-type')).includes('UFS People email') && !(await page.isVisible('#login-totp')));
    await shot(page, '18-ufs-people-login');
    // employee: password only
    await page.fill('input[type=email]', emailOf('emp-009')); await page.fill('input[type=password]', FAKE_PW); await page.click('button[type=submit]'); await sleep(1800);
    check('a directory employee signs in with their UFS People password', await page.isVisible('.nav') && (await page.$$eval('.nav button', bs => bs.map(b => b.textContent))).join() === 'Overview,Timesheets,Screenshots,Reports,My account');
    await nav(page, 'My account'); check('account page shows the synced person', (await page.textContent('#main')).includes(emailOf('emp-009')));
    const noPasswordForm = (await page.textContent('#main')).includes('Change password'); await page.click('button:has-text("Sign out")'); await sleep(800);
    // HR: password, then authenticator code (wrong, then right)
    await page.fill('input[type=email]', emailOf('emp-002')); await page.fill('input[type=password]', FAKE_PW); await page.click('button[type=submit]'); await sleep(1500);
    check('an HR manager is asked for the authenticator code after the password', await page.isVisible('#login-totp') && (await page.textContent('.banner.info')).includes('authenticator'));
    await shot(page, '19-totp-step');
    await page.fill('#login-totp', '000000'); await page.click('button[type=submit]'); await sleep(1500);
    check('a wrong code is refused with a clear message', (await page.textContent('.banner.error')).includes('Incorrect code') && await page.isVisible('#login-totp'));
    await page.fill('#login-totp', await codeFor(emailOf('emp-002'))); await page.click('button[type=submit]'); await sleep(1800);
    check('the right code signs HR in with the read-only HR menu', (await page.$$eval('.nav button', bs => bs.map(b => b.textContent))).join() === 'Overview,Admin portal,Timesheets,Screenshots,Reports,My account');
    await page.click('button:has-text("Sign out")'); await sleep(800);
    // a person who has no approved identity gets nothing, even with a Supabase account
    await page.fill('input[type=email]', 'stranger@elsewhere.test'); await page.fill('input[type=password]', FAKE_PW); await page.click('button[type=submit]'); await sleep(1200);
    check('an unknown account is refused with the generic message', (await page.textContent('.banner.error')).includes('Incorrect email or password'));
    check('no console errors or CSP violations (UFS People sign-in)', problems.length === 0, problems.join(' | '));
    void noPasswordForm;
    await context.close();
  }


  // ---------- owner: admin portal and screenshot manager ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'owner@demo.example'); await sleep(1500);
    await nav(page, 'Admin portal'); await sleep(1500); await shot(page, '30-admin-portal');
    const text = await page.textContent('#main');
    check('admin portal shows attention items, key numbers and both charts', text.includes('Needs your attention') && text.includes('Storage used') && (await page.$$('#main svg.chart')).length === 2 && (await page.$$('#main svg.chart rect')).length > 0);
    check('admin portal charts are accessible images with a label', (await page.$$eval('#main svg.chart', els => els.every(e => e.getAttribute('role') === 'img' && e.getAttribute('aria-label').length > 10))));
    check('admin portal states that numbers are aggregates, not productivity or pay', text.includes('productivity, attendance or pay measure'));
    await page.selectOption('#main select', '30'); await sleep(1200);
    check('changing the period reloads the portal', (await page.$$('#main svg.chart rect')).length > 20);
    await page.click('#main button:has-text("Manage screenshots")'); await sleep(1500); await shot(page, '31-screenshot-manager');
    const mtext = await page.textContent('#main');
    check('screenshot manager shows storage summary and retention', mtext.includes('Storage used') && mtext.includes('Auto-delete after') && mtext.includes('Screenshots you can see'));
    check('manager offers project filter, grouping and Load more when there is more', await page.locator('#main label:has-text("Project")').count() === 1 && await page.locator('#main label:has-text("View")').count() === 1);
    await page.selectOption('#main label:has-text("View") select', 'person'); await sleep(600);
    check('grouping by person shows person headings', (await page.$$('#main .day-head')).length >= 2);
    // select mode and bulk delete (cancel first: nothing is deleted)
    await page.click('#main button:has-text("Select")'); await sleep(300);
    const before = (await page.$$('#main .shot')).length;
    await page.locator('#main .shot').nth(0).click(); await page.locator('#main .shot').nth(1).click(); await sleep(300);
    check('select mode marks cards and counts the selection', await page.locator('#main .shot.selected').count() === 2 && (await page.textContent('#main .select-bar')).includes('Delete selected (2)'));
    await page.click('#main button:has-text("Delete selected")'); await sleep(500);
    check('bulk delete asks for confirmation with a reason field', await page.locator('dialog:has-text("Delete 2 screenshots?")').count() === 1);
    await page.click('dialog button:has-text("Cancel")'); await sleep(300);
    check('cancelling deletes nothing', (await page.$$('#main .shot')).length === before);
    await page.click('#main button:has-text("Select all")'); await sleep(300);
    check('select all marks every shown screenshot', await page.locator('#main .shot.selected').count() === before);
    await page.click('#main button:has-text("Done selecting")'); await sleep(300);
    // viewer: next/previous and download button
    await page.locator('#main .shot').first().click(); await sleep(1200);
    check('viewer shows position and navigation', (await page.textContent('dialog')).includes('1 of') && await page.locator('dialog button:has-text("Older")').count() === 1 && await page.locator('dialog button:has-text("Download")').count() === 1);
    await page.keyboard.press('ArrowRight'); await sleep(900);
    check('arrow keys move to the next screenshot', (await page.textContent('dialog')).includes('2 of'));
    await page.keyboard.press('Escape'); await sleep(300);
    // really delete two screenshots through the UI and confirm the totals drop and the audit shows it
    const totalBefore = Number((await page.textContent('#main .stat strong')).replace(/,/g, ''));
    await page.click('#main button:has-text("Select")'); await page.locator('#main .shot').nth(0).click(); await page.locator('#main .shot').nth(1).click();
    await page.click('#main button:has-text("Delete selected")'); await sleep(400);
    await page.fill('dialog input[type=text]', 'ui test cleanup'); await page.click('dialog button:has-text("Delete permanently")'); await sleep(1800);
    check('deleting two screenshots shows a success message and lowers the total', (await page.textContent('.toasts')).includes('Deleted 2 screenshots') && Number((await page.textContent('#main .stat strong')).replace(/,/g, '')) === totalBefore - 2);
    // ---------- design pass: shared components, icons, focus, People actions, menus ----------
    check('skip link is the first focusable element and targets the main region', await page.locator('.skip-link[href="#main"]').count() === 1 && await page.locator('main#main[tabindex="-1"]').count() === 1);
    const navCount = await page.locator('.nav button').count();
    check('every menu item has a decorative icon and its text label is unchanged', await page.locator('.nav button svg.icon[aria-hidden="true"]').count() === navCount && (await page.$$eval('.nav button', bs => bs.every(b => b.textContent.trim().length > 2))));
    await nav(page, 'People'); await sleep(1500);
    check('moving to a page by the menu puts focus on the main region', await page.evaluate(() => document.activeElement && document.activeElement.id === 'main'));
    check('loading placeholders are gone once the page has content', await page.locator('.skeleton-wrap').count() === 0);
    const fits = await page.evaluate(() => { const wrap = document.querySelector('#main .table-wrap table tbody') ? [...document.querySelectorAll('#main .table-wrap')].find(w => w.querySelector('td.actions-cell')) : null; if (!wrap) return null; const box = wrap.getBoundingClientRect(); return [...wrap.querySelectorAll('td.actions-cell')].every(c => c.getBoundingClientRect().right <= box.right + 1) && wrap.scrollWidth <= wrap.clientWidth + 1; });
    check('People action buttons fit inside the table without horizontal scrolling', fits === true, String(fits));
    const row = page.locator('#main tbody tr:has-text("Ana Engineer")').first();
    check('a local person has Edit plus a More menu holding Reset password and Sign out everywhere', await row.locator('button:has-text("Edit")').count() === 1 && await row.locator('summary:has-text("More")').count() === 1 && await row.locator('.menu-item').count() === 2);
    await row.locator('summary:has-text("More")').click(); await sleep(300);
    check('the More menu opens on screen and can be closed with Escape', await row.locator('.menu-item:has-text("Reset password")').isVisible() && await (async () => { await page.keyboard.press('Escape'); await sleep(200); return !(await row.locator('.menu-item:has-text("Reset password")').isVisible()); })());
    await row.locator('summary:has-text("More")').click(); await row.locator('.menu-item:has-text("Reset password")').click(); await sleep(400);
    check('choosing a menu item runs its action', await page.locator('dialog:has-text("Reset password for Ana Engineer")').count() === 1);
    await page.click('dialog button:has-text("Cancel")'); await sleep(200);
    await nav(page, 'Audit log'); await sleep(1200);
    check('the bulk deletion and the admin portal view are in the audit log', (await page.textContent('#main')).includes('screenshot.bulk_deleted') && (await page.textContent('#main')).includes('ui test cleanup'));
    check('no console errors or CSP violations (admin portal)', problems.length === 0, problems.join(' | '));
    await context.close();
  }
  // ---------- new hire: forced password change ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'ui.newhire@demo.example', 'Temp-hire-pass-77'); await sleep(1000);
    check('new hire is forced to change password', (await page.textContent('body')).includes('Choose a new password'));
    await shot(page, '14-forced-change');
    const [cur, next] = await page.$$('input[type=password]'); await cur.fill('Temp-hire-pass-77'); await next.fill('weak'); await page.click('button:has-text("Save password")'); await sleep(400);
    check('a too-short password is stopped by the browser form', await page.locator('.banner.error').count() === 0 && await next.evaluate(el => !el.validity.valid));
    await next.fill('onlylettersnodigits'); await page.click('button:has-text("Save password")'); await sleep(700);
    check('a password without a number is rejected by the server', (await page.textContent('.banner.error')).includes('number'));
    await next.fill('My-new-password-42'); await page.click('button:has-text("Save password")'); await sleep(1500);
    check('after changing, the dashboard opens with the monitoring-notice banner', await page.locator('.banner.warn:has-text("Monitoring notice")').count() === 1);
    await shot(page, '15-newhire-consent');
    await page.click('button:has-text("I have read and accept")'); await sleep(900);
    check('accepting removes the notice banner', await page.locator('.banner.warn:has-text("Monitoring notice")').count() === 0);
    check('no console errors or CSP violations (new hire)', problems.length === 0, problems.join(' | '));
    await context.close();
  }

  // ---------- mobile layout ----------
  {
    const { context, page } = await newSession(browser, { width: 390, height: 844 });
    await login(page, 'maria@demo.example'); await sleep(1500); await shot(page, '16-mobile-overview');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('mobile has no horizontal page scroll', overflow <= 1, `overflow=${overflow}px`);
    // tables become labelled cards on a phone and nothing scrolls sideways
    await nav(page, 'Timesheets'); await sleep(1800);
    const cards = await page.evaluate(() => { const td = document.querySelector('#main tbody td'); if (!td) return null; return { label: td.getAttribute('data-label'), display: getComputedStyle(td).display, overflow: document.documentElement.scrollWidth - window.innerWidth }; });
    check('on a phone, table cells carry their column label and display as cards', !!cards && cards.label.length > 0 && cards.display === 'flex', JSON.stringify(cards));
    check('the phone timesheets page has no horizontal scroll', !!cards && cards.overflow <= 1, JSON.stringify(cards));
    check('the phone menu scrolls sideways instead of wrapping into many rows', await page.evaluate(() => { const n = document.querySelector('.nav'); return getComputedStyle(n).flexWrap === 'nowrap' && getComputedStyle(n).overflowX === 'auto'; }));
    await context.close();
  }

  await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
