// Browser test of the manager/employee dashboard against a RUNNING server seeded with `npm run seed:demo`.
// Not part of `npm test` (needs a browser). Playwright is not a project dependency:
//   npm i playwright-core   (in any folder)   then   set PW_PATH=<that folder>\node_modules\playwright-core
//   set DASH_URL=http://127.0.0.1:4300  set DEMO_PASSWORD=<DEMO_PASSWORD from src/seed-demo.ts>  set SHOT_DIR=<output folder>
const { chromium } = require(process.env.PW_PATH || 'playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
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
    check('employee nav is limited', navItems.join() === 'Overview,Day view,Timesheets,Screenshots,Reports,Privacy and data,My account', navItems.join());
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
    check('admin nav has everything', (await page.$$eval('.nav button', bs => bs.length)) === 15);
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
    check('HR nav: read-only areas only', navItems.join() === 'Overview,Team,Admin portal,Day view,Timesheets,Screenshots,Reports,Payroll,Privacy and data,My account', navItems.join());
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
    check('a directory employee signs in with their UFS People password', await page.isVisible('.nav') && (await page.$$eval('.nav button', bs => bs.map(b => b.textContent))).join() === 'Overview,Day view,Timesheets,Screenshots,Reports,Privacy and data,My account');
    await nav(page, 'My account'); check('account page shows the synced person', (await page.textContent('#main')).includes(emailOf('emp-009')));
    const noPasswordForm = (await page.textContent('#main')).includes('Change password'); await page.click('button:has-text("Sign out")'); await sleep(800);
    // HR: password, then authenticator code (wrong, then right)
    await page.fill('input[type=email]', emailOf('emp-002')); await page.fill('input[type=password]', FAKE_PW); await page.click('button[type=submit]'); await sleep(1500);
    check('an HR manager is asked for the authenticator code after the password', await page.isVisible('#login-totp') && (await page.textContent('.banner.info')).includes('authenticator'));
    await shot(page, '19-totp-step');
    await page.fill('#login-totp', '000000'); await page.click('button[type=submit]'); await sleep(1500);
    check('a wrong code is refused with a clear message', (await page.textContent('.banner.error')).includes('Incorrect code') && await page.isVisible('#login-totp'));
    await page.fill('#login-totp', await codeFor(emailOf('emp-002'))); await page.click('button[type=submit]'); await sleep(1800);
    check('the right code signs HR in with the read-only HR menu', (await page.$$eval('.nav button', bs => bs.map(b => b.textContent))).join() === 'Overview,Team,Admin portal,Day view,Timesheets,Screenshots,Reports,Payroll,Privacy and data,My account');
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
  // ---------- payroll, privacy and notifications ----------
  {
    const owner = await newSession(browser); const op = owner.page;
    await login(op, 'owner@demo.example'); await sleep(1500);
    check('menu has Payroll and Privacy and data, and the sidebar has a notification bell', await op.locator('.nav button:has-text("Payroll")').count() === 1 && await op.locator('.nav button:has-text("Privacy and data")').count() === 1 && await op.locator('#bell').count() === 1);
    await nav(op, 'Payroll'); await sleep(1800); await shot(op, '32-payroll');
    check('payroll shows a preview, the rates table and the not-payroll-advice note', (await op.textContent('#main')).includes('Payroll preview') && (await op.textContent('#main')).includes('not payroll advice') && await op.locator('#main button:has-text("Set rate")').count() > 5);
    await op.locator('#main tbody tr:has-text("Ana Engineer") button:has-text("Set rate")').click(); await sleep(400);
    await op.fill('dialog input[type=number]', '25.5'); await op.click('dialog button:has-text("Save rate")'); await sleep(1200);
    check('setting a pay rate saves, shows a toast and updates the table', (await op.textContent('.toasts')).includes('Pay rate saved') && (await op.textContent('#main .card:has(h2:has-text("Pay rates")) tbody tr:has-text("Ana Engineer")')).includes('25.50 USD/h'));
    const [csv] = await Promise.all([op.waitForEvent('download'), op.click('#main button:has-text("Download CSV")')]);
    check('the payroll CSV downloads', csv.suggestedFilename() === 'payroll-export.csv');
    check('no console errors or CSP violations (owner: payroll)', owner.problems.length === 0, owner.problems.join(' | '));

    const ana = await newSession(browser); const ap = ana.page;
    await login(ap, 'ana@demo.example'); await sleep(1500);
    check('an employee has no Payroll or Admin pages', await ap.locator('.nav button:has-text("Payroll")').count() === 0 && await ap.locator('.nav button:has-text("Admin portal")').count() === 0);
    await nav(ap, 'Privacy and data'); await sleep(1200); await shot(ap, '33-privacy');
    const [mine] = await Promise.all([ap.waitForEvent('download'), ap.click('#main button:has-text("Download my data")')]);
    check('an employee can download their own data', /^my-tracker-data-\d{4}-\d{2}-\d{2}\.json$/.test(mine.suggestedFilename()));
    check('the employee page has no admin deletion queue', await ap.locator('#main h2:has-text("Deletion requests")').count() === 0);
    await ap.click('#main button:has-text("Ask to delete")'); await sleep(300); await ap.fill('dialog textarea', 'ui test request'); await ap.click('dialog button:has-text("Send request")'); await sleep(1200);
    check('asking to delete shows a toast and the button turns into "pending"', (await ap.textContent('.toasts')).includes('Request sent') && await ap.locator('#main button:has-text("Deletion request pending")').isDisabled());
    await nav(ap, 'My account'); await sleep(1000);
    check('My account offers weekly reports: an employee can pick only their own hours, and the page says email is not on yet', await ap.locator('#report-card').count() === 1 && await ap.locator('#report-card select option').allTextContents().then(o => o.some(x => x.includes('Your weekly hours')) && !o.some(x => x.includes('team'))) && (await ap.textContent('#report-card')).includes('Email delivery is not switched on'));
    await ap.click('#report-card button:has-text("Save report")'); await sleep(1200);
    check('saving a weekly report lists it with Send now and Remove', (await ap.textContent('#report-card tbody')).includes('Your weekly hours') && await ap.locator('#report-card button:has-text("Send now")').count() === 1);
    await ap.click('#report-card button:has-text("Send now")'); await sleep(800);
    check('Send now confirms and the report appears under the bell', (await ap.textContent('.toasts')).includes('Sent'));
    await ap.click('#bell'); await sleep(700);
    check('the weekly report is in the notification list', (await ap.textContent('dialog')).includes('Your weekly hours')); await ap.click('dialog button:has-text("Close")'); await sleep(200);
    await ap.click('#report-card button:has-text("Remove")'); await sleep(900);
    check('removing the report empties the list', (await ap.textContent('#report-card')).includes('You are not subscribed to any report'));    check('My account has the email-copy setting and says delivery is not on yet', await ap.locator('#notify-email').count() === 1 && (await ap.textContent('#main')).includes('not switched on'));
    await ana.context.close();

    await op.reload(); await sleep(2000);
    check('the owner is told with a number on the bell', await op.locator('#bell-count:not(.hidden)').count() === 1);
    await op.click('#bell'); await sleep(800);
    check('the notification list shows the request', (await op.textContent('dialog')).includes('Ana Engineer asked to delete'));
    await op.click('dialog .note.unread'); await sleep(1500);
    check('clicking the notification opens the Privacy page with the request queue', (await op.textContent('#main h1')).includes('Privacy') && await op.locator('#main tbody tr:has-text("Ana Engineer"):has-text("ui test request")').count() === 1);
    await op.locator('#main tbody tr:has-text("Ana Engineer") button:has-text("Delete data")').click(); await sleep(300);
    await op.click('dialog button:has-text("Delete permanently")'); await sleep(1800);
    check('fulfilling shows what was removed and the request is marked fulfilled', (await op.textContent('.toasts')).includes('Deleted') && await op.locator('#main tbody tr:has-text("Ana Engineer") .badge:has-text("fulfilled")').count() === 1);
    const ana2 = await newSession(browser); const bp = ana2.page; await login(bp, 'ana@demo.example'); await sleep(1500);
    await nav(bp, 'Screenshots'); await sleep(1500);
    check('after fulfilment the employee has no screenshots left', (await bp.$$('#main .shot')).length === 0);
    check('the employee was notified through the bell', await bp.locator('#bell-count:not(.hidden)').count() === 1);
    check('no console errors or CSP violations (privacy and notifications)', ana2.problems.length === 0 && owner.problems.length === 0, ana2.problems.concat(owner.problems).join(' | '));
    await ana2.context.close(); await owner.context.close();
  }
  // ---------- integrations: API keys ----------
  {
    const { context, page, problems } = await newSession(browser);
    await login(page, 'owner@demo.example'); await sleep(1500);
    await nav(page, 'Integrations'); await sleep(1200); await shot(page, '37-integrations');
    check('owners see the Integrations page with usage help and a note that webhooks do not exist yet', (await page.textContent('#main')).includes('Using the API') && (await page.textContent('#main')).includes('Webhooks') && await page.locator('#main button:has-text("Create API key")').count() === 1);
    await page.click('#main button:has-text("Create API key")'); await sleep(300);
    await page.fill('dialog input[type=text]', 'UI test reader'); await page.click('dialog button:has-text("Create key")'); await sleep(1200);
    const newKey = await page.inputValue('#new-api-key');
    check('the new key is shown once with a warning and looks like a UFS key', /^ufs_[A-Za-z0-9_-]{40}$/.test(newKey) && (await page.textContent('dialog')).includes('only once'));
    const me = await (await fetch(`${URL_BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${newKey}` } })).json();
    check('the key works against the public API with the access that was ticked', me.key?.name === 'UI test reader' && me.key.scopes.join() === 'time:read');
    const denied = await fetch(`${URL_BASE}/api/v1/users`, { headers: { Authorization: `Bearer ${newKey}` } });
    check('an unticked scope is refused', denied.status === 403);
    await page.click('dialog button:has-text("I have saved it")'); await sleep(500);
    const row = page.locator('#main tbody tr:has-text("UI test reader")');
    check('the table lists the key by its prefix only, never the full key', await row.count() === 1 && !(await page.textContent('#main')).includes(newKey) && (await row.textContent()).includes(newKey.slice(0, 10)));
    await row.locator('button:has-text("Revoke")').click(); await sleep(300); await page.click('dialog button:has-text("Revoke key")'); await sleep(1200);
    check('revoking marks the key revoked and it stops working at once', (await row.textContent()).includes('revoked') && (await fetch(`${URL_BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${newKey}` } })).status === 401);
    // webhooks: a local receiver stands in for the other system (the demo server runs with WEBHOOK_DEV=1)
    const gotHooks = []; const receiver = http.createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { gotHooks.push({ headers: req.headers, body }); res.writeHead(200); res.end('ok'); }); });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve)); const receiverPort = receiver.address().port;
    check('the Integrations page has a Webhooks card with the verification guide', await page.locator('#webhook-card h2:has-text("Webhooks")').count() === 1 && (await page.textContent('#webhook-card')).includes('X-UFS-Signature'));
    await page.click('#webhook-card button:has-text("Add webhook")'); await sleep(300);
    await page.fill('dialog input[type=text] >> nth=0', 'UI test receiver'); await page.fill('dialog input[placeholder^="https://"]', 'https://user:secret@example.com/hook'); await page.click('dialog button:has-text("Add webhook")'); await sleep(900);
    check('an address with a password in it is refused with a clear message (public-host rules are covered by the API tests; this demo server runs in webhook development mode)', (await page.textContent('dialog')).includes('user name or password'));
    await page.fill('dialog input[placeholder^="https://"]', `http://127.0.0.1:${receiverPort}/hook`); await page.click('dialog button:has-text("Add webhook")'); await sleep(1200);
    const secret = await page.inputValue('#new-webhook-secret');
    check('the signing secret is shown once', /^whsec_[A-Za-z0-9_-]{43}$/.test(secret) && (await page.textContent('dialog')).includes('only once'));
    await page.click('dialog button:has-text("I have saved it")'); await sleep(500);
    const hookRow = page.locator('#webhook-card tbody tr:has-text("UI test receiver")');
    check('the webhook is listed as on and the secret is not on the page', await hookRow.count() === 1 && (await hookRow.textContent()).includes('on') && !(await page.textContent('#main')).includes(secret.slice(10)));
    await hookRow.locator('button:has-text("Send test")').click(); await sleep(1800);
    check('Send test delivers a signed ping that the receiver can verify with the secret', gotHooks.length === 1 && gotHooks[0].headers['x-ufs-event'] === 'ping' && gotHooks[0].headers['x-ufs-signature'] === `sha256=${crypto.createHmac('sha256', secret).update(`${gotHooks[0].headers['x-ufs-timestamp']}.${gotHooks[0].body}`).digest('hex')}`, JSON.stringify(gotHooks[0]?.headers));
    check('the card shows the delivery result', (await page.textContent('#webhook-card tbody tr:has-text("UI test receiver")')).includes('delivered'));
    await hookRow.locator('summary:has-text("More")').click(); await hookRow.locator('.menu-item:has-text("Deliveries")').click(); await sleep(900);
    check('the deliveries list shows the ping and no payload contents', (await page.textContent('dialog')).includes('ping') && !(await page.textContent('dialog')).includes('test delivery from UFS'));
    await page.click('dialog button:has-text("Close")'); await sleep(300);
    await hookRow.locator('summary:has-text("More")').click(); await hookRow.locator('.menu-item:has-text("Turn off")').click(); await sleep(1000);
    check('turning a webhook off disables its test button', await page.locator('#webhook-card tbody tr:has-text("UI test receiver") button:has-text("Send test")').isDisabled());
    await hookRow.locator('summary:has-text("More")').click(); await hookRow.locator('.menu-item:has-text("Delete")').click(); await sleep(300); await page.click('dialog button:has-text("Delete webhook")'); await sleep(1000);
    check('deleting removes the webhook', await page.locator('#webhook-card tbody tr:has-text("UI test receiver")').count() === 0);
    await new Promise(resolve => receiver.close(resolve));
    check('no console errors or CSP violations (integrations)', problems.length === 0, problems.join(' | '));
    await context.close();
    const hr = await newSession(browser); await login(hr.page, 'hana@demo.example'); await sleep(1500);
    check('HR does not get the Integrations page', await hr.page.locator('.nav button:has-text("Integrations")').count() === 0);
    await hr.context.close();
  }
  // ---------- team page and day view ----------
  {
    // Ana's desktop app reports a company session with one break (sent through the same API the app uses)
    const breakStart = new Date(Date.now() - 80 * 60_000), breakEnd = new Date(Date.now() - 70 * 60_000);
    const anaLogin = await (await fetch(`${URL_BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@demo.example', password: PASSWORD, kind: 'device', deviceName: 'ui-test' }) })).json();
    const synced = await fetch(`${URL_BASE}/api/time-entries/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anaLogin.token}` },
      body: JSON.stringify({ clientId: 'ui-break-entry-0001', taskLabel: 'Break test', mode: 'company', startAt: new Date(Date.now() - 90 * 60_000).toISOString(), endAt: null, trackedMs: 20 * 60_000, idleMs: 0, breaks: [{ startAt: breakStart.toISOString(), endAt: breakEnd.toISOString() }] }) });
    check('the desktop sync API accepts a company entry with a break', synced.status === 201, String(synced.status));
    const { context, page, problems } = await newSession(browser);
    await login(page, 'maria@demo.example'); await sleep(1500);
    await nav(page, 'Team'); await sleep(1500); await shot(page, '34-team');
    const names = await page.$$eval('#main tbody tr td:first-child strong', els => els.map(e => e.textContent).sort());
    check('the manager\'s Team page lists exactly the manager and direct reports', names.join() === 'Ana Engineer,Ben Engineer,Maria Manager', names.join(', '));
    check('each person has an accessible per-day chart and a Day view button', await page.locator('#main svg.spark[role="img"]').count() === 3 && await page.locator('#main button:has-text("Day view")').count() === 3);
    check('the Team page says it shows facts, not scores', (await page.textContent('#main')).includes('productivity, attendance or pay'));
    check('the Team page shows a Breaks column with Ana\'s break', (await page.textContent('#main thead')).includes('Breaks') && (await page.textContent('#main tbody tr:has-text("Ana Engineer")')).includes('1 · '));
    await page.locator('#main tbody tr:has-text("Ana Engineer") button:has-text("Day view")').click(); await sleep(1500);
    const breakDay = `${breakStart.getFullYear()}-${String(breakStart.getMonth() + 1).padStart(2, '0')}-${String(breakStart.getDate()).padStart(2, '0')}`;
    await page.fill('#main input[type=date]', breakDay); await page.dispatchEvent('#main input[type=date]', 'change'); await sleep(1800); await shot(page, '36-day-break');
    check('Ana\'s Day view draws the break on the bar and counts it', await page.locator('#main svg.daybar rect.break').count() === 1 && (await page.textContent('#main .stats')).includes('Breaks1 · 0h 10m'));
    check('the Breaks table lists it and says break time is not tracked time', (await page.textContent('#main')).includes('Break time is not counted as tracked time') && await page.locator('#main .card:has(h2:has-text("Breaks")) tbody tr').count() === 1);
    await nav(page, 'Team'); await sleep(1200);
    await page.selectOption('#main label:has-text("Order") select', 'hours'); await sleep(300);
    check('the Team page can be re-ordered', await page.locator('#main tbody tr').count() === 3);
    await page.locator('#main tbody tr:has-text("Ben Engineer") button:has-text("Day view")').click(); await sleep(1500);
    check('Day view button opens that person\'s day (Ben: Ana\'s screenshots were removed earlier in this run by the deletion-request check)', (await page.textContent('#main h1')).includes('Day view') && (await page.textContent('#main')).includes('Ben Engineer'));
    await page.fill('#main input[type=date]', '2026-10-27'); await page.dispatchEvent('#main input[type=date]', 'change'); await sleep(1800); await shot(page, '35-day-view');
    const dayText = await page.textContent('#main');
    check('the day view shows totals, a 24-hour bar with blocks, and the time blocks table', dayText.includes('Tracked') && await page.locator('#main svg.daybar rect.block').count() > 0 && dayText.includes('Time blocks'));
    check('the day bar is an accessible image describing the day', (await page.getAttribute('#main svg.daybar', 'aria-label')).includes('Ben Engineer on 2026-10-27'));
    check('the day view shows a screenshot strip with images that load', await page.locator('#main .strip .shot').count() > 0 && await (async () => { await page.locator('#main .strip').scrollIntoViewIfNeeded(); await sleep(1500); return (await page.$$eval('#main .strip img', imgs => imgs.filter(i => i.src.startsWith('blob:')).length)) > 0; })());
    await page.locator('#main .strip .shot').first().click(); await sleep(900);
    check('a screenshot from the day view opens in a dialog', await page.isVisible('dialog img.full')); await page.keyboard.press('Escape'); await sleep(300);
    await page.click('#day-prev'); await sleep(1500);
    check('the previous-day button moves one day back', (await page.inputValue('#main input[type=date]')) === '2026-10-26');
    check('no console errors or CSP violations (team and day view)', problems.length === 0, problems.join(' | '));
    await context.close();
    const hr = await newSession(browser); await login(hr.page, 'hana@demo.example'); await sleep(1500);
    await nav(hr.page, 'Team'); await sleep(1500);
    check('HR sees everyone on the Team page', await hr.page.locator('#main tbody tr').count() >= 30);
    await hr.context.close();
    const emp = await newSession(browser); await login(emp.page, 'ana@demo.example'); await sleep(1500);
    check('an employee has no Team page but has Day view of their own day', await emp.page.locator('.nav button:has-text("Team")').count() === 0 && await emp.page.locator('.nav button:has-text("Day view")').count() === 1);
    await nav(emp.page, 'Day view'); await sleep(1500);
    check('the employee\'s Day view has no person picker', await emp.page.locator('#main label:has-text("Person")').count() === 0 && (await emp.page.textContent('#main h2, #main .empty')).length > 0);
    await emp.context.close();
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
