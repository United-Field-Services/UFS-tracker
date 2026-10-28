// Synthetic renderer-only regression for schedule and break reminders.
// Does not launch Electron, access a display, capture a screen, or read app data.
//   $env:PW_PATH='C:\pw\node_modules\playwright-core'; node e2e\work-reminders.ui.cjs
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PW_PATH || 'playwright-core');

const APP = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const EDGE = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const base = () => {
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-US', {timeZone:'UTC',weekday:'short'}).format(now);
    const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day);
  return {phase: 'stopped', message: 'Ready.', permission: 'system-managed', platform: 'win32', version: '0.2.0', directory: 'synthetic-data',
    sync: {signedIn: true, status: 'online', serverHost: 'tracker.example.test', user: {id: 'synthetic-user', name: 'Synthetic Employee', role: 'employee'}, pending: {time: 0, manual: 0, screenshots: 0}, failed: 0, projects: [], needsConsent: false,
      policy: {screenshotsEnabled: false, idleTimeoutSeconds: 60, retentionDays: 90, screenshotVisibility: 'employee_only', screenshotIntervalSeconds: 300, screenshotBlur: false, requireProject: false,
        breakReminderMinutes: 60, workScheduleEnabled: true, workDays: [weekday], workTimeZone: 'UTC', lateGraceMinutes: 0, workStartLocal: '00:00', workEndLocal: '23:59'}}};
};

(async () => {
  const browser = await chromium.launch({executablePath: EDGE, headless: true});
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.addInitScript(initial => {
      let current = initial; window.__pauseCalls = 0; window.__renderState = null; window.__snapshot = current;
      window.__setSnapshot = next => {current = next; window.__snapshot = next; window.__renderState?.(next);};
      window.tracker = {
        status: async () => current, manualEntries: async () => [], addManualEntry: async () => ({queued: false}),
        displays: async () => [], gallery: async () => ({captures: [], sessions: [], totalCaptureCount: 0}),
        onState: callback => {window.__renderState = callback;}, onCapture: () => () => {},
        idleReview: async () => ({result: {}, state: current}), pause: async () => {window.__pauseCalls++; return current;}, stop: async () => current,
        prepare: async () => ({token: 'synthetic'}), confirm: async () => current, fail: async () => current,
        authorizeCapture: async () => ({allowed: false}), finalizeCapture: () => false, saveCapture: async () => ({saved: false}), captureFailed: async () => {},
        image: async () => '', reveal: async () => {}, openFolder: async () => {}, syncLogin: async () => current.sync, syncLogout: async () => current.sync,
        syncConsent: async () => current.sync, syncNow: async () => current.sync
      };
    }, base());
    await page.goto(APP);
    const reminder = page.locator('#work-reminder');
    await reminder.waitFor({state: 'visible'});
    assert.match(await reminder.innerText(), /scheduled work hours/);
    await page.getByRole('button', {name: 'Remind me later'}).click();
    assert.equal(await reminder.isHidden(), true, 'scheduled reminder stays dismissed for the current local day');
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, sync: {...window.__snapshot.sync, policy: {...window.__snapshot.sync.policy, workScheduleEnabled: false}}}));
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, phase: 'tracking', current: {id: 'session-1', mode: 'company', trackedMs: 60 * 60_000}}));
    await reminder.waitFor({state: 'visible'});
    assert.match(await reminder.innerText(), /Consider taking a short break/);
    await page.getByRole('button', {name: 'Pause for a break'}).click();
    assert.equal(await page.evaluate(() => window.__pauseCalls), 1);
    await page.evaluate(() => window.__setSnapshot({...window.__snapshot, sync: {...window.__snapshot.sync, signedIn: false}}));
    assert.equal(await reminder.isHidden(), true, 'work reminders are hidden while signed out');
    await context.close();
  } finally { await browser.close(); }
  console.log('Schedule and break reminders: local schedule, same-day dismissal, tracked-time break prompt and sign-out gate passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
