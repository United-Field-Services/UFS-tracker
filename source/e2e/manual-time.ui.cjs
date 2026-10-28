// Synthetic renderer-only regression for company manual time. Does not launch Electron,
// access a display, capture a screen, or read app data. Requires playwright-core outside the repo.
//   $env:PW_PATH='C:\pw\node_modules\playwright-core'; node e2e\manual-time.ui.cjs
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PW_PATH || 'playwright-core');

const APP = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const EDGE = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const base = () => ({
  phase: 'stopped', message: 'Ready.', permission: 'system-managed', platform: 'win32', version: '0.2.0', directory: 'synthetic-data',
  sync: {signedIn: true, status: 'online', serverHost: 'tracker.example.test', user: {id: 'synthetic-user', name: 'Synthetic Employee', role: 'employee'}, pending: {time: 0, manual: 0, screenshots: 0}, failed: 0, projects: [{id: 'p1', name: 'Synthetic Project', active: true, tasks: [{id: 't1', name: 'Synthetic Task'}]}], needsConsent: false,
    policy: {screenshotsEnabled: false, idleTimeoutSeconds: 60, retentionDays: 90, screenshotVisibility: 'employee_only', screenshotIntervalSeconds: 300, screenshotBlur: false, requireProject: false}}
});

(async () => {
  const browser = await chromium.launch({executablePath: EDGE, headless: true});
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.addInitScript(initial => {
      let current = initial;
      window.__manualCalls = []; window.__snapshot = current;
      window.__setSnapshot = next => {current = next; window.__snapshot = next; window.__renderState?.(next);};
      window.__renderState = null;
      window.tracker = {
        status: async () => current, manualEntries: async () => [{taskLabel: '<img src=x onerror=alert(1)>', status: 'pending', startAt: '2026-10-26T09:00:00.000Z', endAt: '2026-10-26T10:00:00.000Z', note: '<script>synthetic</script>'}],
        addManualEntry: async value => {window.__manualCalls.push(value); return {clientId: 'synthetic-manual-id', queued: true};},
        displays: async () => [], gallery: async () => ({captures: [], sessions: [], totalCaptureCount: 0}),
        onState: callback => {window.__renderState = callback;}, onCapture: () => () => {},
        idleReview: async () => ({result: {}, state: current}), pause: async () => current, stop: async () => current,
        prepare: async () => ({token: 'synthetic'}), confirm: async () => current, fail: async () => current,
        authorizeCapture: async () => ({allowed: false}), finalizeCapture: () => false, saveCapture: async () => ({saved: false}), captureFailed: async () => {},
        image: async () => '', reveal: async () => {}, openFolder: async () => {}, syncLogin: async () => current.sync, syncLogout: async () => current.sync,
        syncConsent: async () => current.sync, syncNow: async () => current.sync
      };
    }, base());
    await page.goto(APP);
    const button = page.locator('#manual-time-open');
    await button.waitFor({state: 'visible'});
    assert.equal(await button.isEnabled(), true);
    await button.click();
    await page.locator('#manual-task-label').fill('Synthetic closeout work');
    await page.locator('#manual-start').fill('2026-10-26T09:00');
    await page.locator('#manual-end').fill('2026-10-26T10:00');
    await page.locator('#manual-project').selectOption('p1');
    await page.locator('#manual-task').selectOption('t1');
    await page.locator('#manual-note').fill('Synthetic reviewer note');
    await page.getByRole('button', {name: 'Submit time'}).click();
    await page.waitForFunction(() => window.__manualCalls.length === 1);
    const call = await page.evaluate(() => window.__manualCalls[0]);
    assert.deepEqual({projectId: call.projectId, taskId: call.taskId, taskLabel: call.taskLabel, note: call.note}, {projectId: 'p1', taskId: 't1', taskLabel: 'Synthetic closeout work', note: 'Synthetic reviewer note'});
    assert.equal(Date.parse(call.endAt) - Date.parse(call.startAt), 60 * 60_000);
    await page.locator('#manual-time-status').getByText('Manual time is saved on this device and will upload when the server is reachable.').waitFor();
    await page.locator('[data-panel="sessions-panel"]').click();
    await page.locator('#manual-time-history').waitFor({state: 'visible'});
    await page.locator('#manual-time-list').getByText('<img src=x onerror=alert(1)>').waitFor();
    assert.equal(await page.locator('#manual-time-list img, #manual-time-list script').count(), 0, 'untrusted history fields render only as text');
    await page.locator('[data-panel="tracker-panel"]').click();
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, phase: 'tracking'}));
    assert.equal(await button.isEnabled(), false, 'manual entry is disabled while tracking');
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, phase: 'stopped', sync: {...window.__snapshot.sync, needsConsent: true}}));
    assert.equal(await button.isEnabled(), false, 'manual entry is disabled until the current notice is accepted');
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, sync: {...window.__snapshot.sync, needsConsent: false}}));
    assert.equal(await button.isEnabled(), true);
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, sync: {...window.__snapshot.sync, signedIn: false}}));
    assert.equal(await button.isVisible(), false, 'manual entry is hidden while signed out');
    await context.close();
  } finally { await browser.close(); }
  console.log('Manual time renderer: consent-gated company form, project/task, offline acknowledgement, and safe history passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
