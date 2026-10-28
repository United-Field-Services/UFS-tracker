// Synthetic renderer-only regression for the company idle review modal. It does not launch Electron,
// access the display, capture a screen, or read app data. Requires playwright-core outside the repo.
//   $env:PW_PATH='C:\pw\node_modules\playwright-core'; node e2e\idle-review.ui.cjs
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PW_PATH || 'playwright-core');

const APP = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const EDGE = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const snapshot = () => ({
  phase: 'tracking', message: 'Idle time needs your review.', permission: 'system-managed', platform: 'win32', version: '0.2.0', directory: 'synthetic-data',
  current: {id: 'synthetic-session', mode: 'company', task: 'Synthetic work', startedAt: '2026-10-26T09:00:00.000Z', trackedMs: 65_000, idleMs: 6_000, captureCount: 0, idleReview: {baselineIdleMs: 1_000, thresholdSeconds: 60}},
  sync: {signedIn: true, status: 'online', serverHost: 'tracker.example.test', user: {name: 'Synthetic Employee', role: 'employee'}, pending: {time: 0, screenshots: 0}, failed: 0, projects: [], needsConsent: false,
    policy: {screenshotsEnabled: false, idleTimeoutSeconds: 60, retentionDays: 90, screenshotVisibility: 'employee_only', screenshotIntervalSeconds: 300, screenshotBlur: false, requireProject: false}}
});

(async () => {
  const browser = await chromium.launch({executablePath: EDGE, headless: true});
  try {
    for (const keep of [false, true]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(initial => {
        let current = initial;
        window.__idleChoices = [];
        window.__renderState = null;
        window.tracker = {
          status: async () => current,
          manualEntries: async () => [], addManualEntry: async () => ({queued: false}),
          displays: async () => [],
          gallery: async () => ({captures: [], sessions: [], totalCaptureCount: 0}),
          onState: callback => { window.__renderState = callback; },
          onCapture: () => () => {},
          idleReview: async value => {
            window.__idleChoices.push(value.keep);
            current = {...current, current: {...current.current, idleReview: undefined}};
            window.__renderState(current);
            return {result: {kept: value.keep, idleMs: 5000}, state: current};
          },
          pause: async () => current, stop: async () => current, prepare: async () => ({token: 'synthetic'}), confirm: async () => current,
          fail: async () => current, authorizeCapture: async () => ({allowed: false}), finalizeCapture: () => false,
          saveCapture: async () => ({saved: false}), captureFailed: async () => {}, image: async () => '', reveal: async () => {}, openFolder: async () => {},
          syncLogin: async () => current.sync, syncLogout: async () => current.sync, syncConsent: async () => current.sync, syncNow: async () => current.sync
        };
      }, snapshot());
      await page.goto(APP);
      const dialog = page.locator('#idle-review');
      await dialog.waitFor({state: 'visible'});
      assert.match(await dialog.innerText(), /Were you working\?/);
      assert.match(await dialog.innerText(), /does not record keystrokes/);
      await page.getByRole('button', {name: keep ? 'Keep time' : 'Discard idle time'}).click();
      await page.waitForFunction(() => window.__idleChoices.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__idleChoices), [keep]);
      assert.equal(await dialog.evaluate(element => element.open), false);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log('Idle review renderer: keep and discard choices passed with synthetic state.');
})().catch(error => { console.error(error); process.exitCode = 1; });
