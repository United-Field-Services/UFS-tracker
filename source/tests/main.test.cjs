'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {pathToFileURL} = require('node:url');
const {Tracker, ONE_HOUR_MS} = require('../src/tracker.cjs');

// This exercises the real main-process code and Tracker through simulated Electron
// APIs. It does not prove that OS permissions or native screen capture work.
async function fixture({clock = {mono: 0, wall: Date.parse('2026-10-18T12:00:00Z')}, persisted = {sessions: [], recoveries: 0}, clockFault = {after: Infinity, reads: 0}, galleryCaptures = 0, gallery = null, thumbFiles = new Map()} = {}) {
  const decoded = [], saveArgs = [];
  const handlers = new Map(); const syncHandlers = new Map(); const permissions = {}; const sourceRequests = []; const sent = [];
  let win, loop, saveCalls = 0, timerId = 0;
  const timers = new Map();
  class ClockTracker extends Tracker {constructor(options) {super({...options, wall: () => new Date(clock.wall).toISOString()});}}
  const dirname = path.join(__dirname, '..', 'src');
  const url = pathToFileURL(path.join(dirname, '..', 'renderer', 'index.html')).href;
  const displays = [{id: 1, label: 'Selected', size: {width: 1920, height: 1080}}, {id: 2, label: 'Other', size: {width: 1920, height: 1080}}];
  class Window extends EventEmitter {
    constructor() {
      super(); win = this; this.visible = true; this.minimized = false;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (name, value) => sent.push({name, value}), setWindowOpenHandler() {}
      });
    }
    setTitle() {} isDestroyed() { return false; }
    isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    loadFile() { return Promise.resolve(); }
  }
  class Store {
    constructor() { this.root = '/tmp/ufs-main-test-data'; }
    recoverInterrupted() {persisted.recoveries++;}
    list() { const captures = gallery ?? Array.from({length: galleryCaptures}, (_, i) => ({id: `c${i}`})); return {sessions: [], captures, totalCaptureCount: captures.length, directory: this.root}; }
    fileFor(id) { return `/tmp/${id}.png`; }
    thumbFor(id) { return thumbFiles.get(id) ?? null; }
    typeFor(id) { return id.endsWith('webp') ? 'image/webp' : 'image/png'; }
    saveSession(session) {if (session) persisted.sessions.push(structuredClone(session));}
    saveCapture(_session, data, canCommit, thumb) {assert.equal(canCommit(), true); saveCalls++; saveArgs.push({data, thumb}); return {id: 'saved-test-capture'};}
  }
  let syncInstance;
  // Company sync is tested separately (tests/sync.test.cjs); here it is a recording stub the tests can configure.
  class SyncStub {
    constructor(options) {
      syncInstance = this; this.options = options; this.signedIn = false; this.flushImpl = async () => {}; this.stopCalls = 0; this.calls = {entries: [], shots: [], heartbeats: [], logins: [], flushes: []};
      this.snap = {status: 'signed-out', policy: null, projects: [], needsConsent: false, pending: {time: 0, screenshots: 0, activity: 0, manual: 0}, failed: 0};
    }
    init() {} start() {} stop() {this.stopCalls++;} shutdown() {this.shuttingDown = true; this.stop();}
    snapshot() { return {...this.snap, signedIn: this.signedIn}; }
    enqueueEntry(session) { this.calls.entries.push(structuredClone(session)); }
    enqueueScreenshot(item) { this.calls.shots.push(item); }
    heartbeat(item) { this.calls.heartbeats.push(item); }
    async login(value) { this.calls.logins.push(value); this.signedIn = true; return this.snapshot(); }
    async logout() { this.signedIn = false; return this.snapshot(); }
    async acceptConsent() { this.snap.needsConsent = false; return this.snapshot(); }
    async refresh() {} async flush(options) {this.calls.flushes.push(options); return this.flushImpl(options);}
    async addManualEntry(value) { if (!this.signedIn) throw new Error('Sign in first.'); this.calls.manualEntry = structuredClone(value); return {clientId: 'synthetic-manual-id', queued: false}; }
    async getMyManualEntries() { if (!this.signedIn) throw new Error('Sign in first.'); this.calls.manualEntries = true; return []; }
    /** Pretend the user signed in with this policy. */
    signIn({policy = {}, projects = [], needsConsent = false} = {}) {
      this.signedIn = true; this.snap.needsConsent = needsConsent; this.snap.projects = projects;
      this.snap.policy = {screenshotsEnabled: true, screenshotIntervalSeconds: 600, screenshotBlur: false, idleTimeoutSeconds: 300, activityTrackingEnabled: false, requireProject: false, consentVersion: 1, ...policy};
    }
  }
  let quitCalls = 0;
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), setAppUserModelId() {},
    getPath: () => '/tmp', getVersion: () => '0.1.0', quit() {quitCalls++;}
  });
  const screen = Object.assign(new EventEmitter(), {getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0]});
  const powerMonitor = Object.assign(new EventEmitter(), {getSystemIdleTime: () => 0});
  const uiohook = new EventEmitter(); let hookStarts = 0, hookStops = 0;
  uiohook.start = () => { hookStarts++; }; uiohook.stop = () => { hookStops++; };
  const electron = {
    app, BrowserWindow: Window, ipcMain: {handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => syncHandlers.set(name, fn)},
    desktopCapturer: {getSources: options => new Promise(resolve => sourceRequests.push({options, resolve}))},
    screen, powerMonitor,
    session: {defaultSession: {
      webRequest: {onBeforeRequest: fn => { permissions.network = fn; }},
      setPermissionRequestHandler: fn => { permissions.request = fn; },
      setPermissionCheckHandler: fn => { permissions.check = fn; },
      setDisplayMediaRequestHandler: fn => { permissions.display = fn; }
    }},
    systemPreferences: {getMediaAccessStatus: () => 'granted'}, shell: {}, nativeImage: {createFromPath: file => { decoded.push(file); return {resize: () => ({toDataURL: () => `data:${file}`})}; }},
    Menu: {buildFromTemplate: () => [], setApplicationMenu() {}},
    dialog: {showErrorBox(_title, message) { throw new Error(message); }}
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './tracker.cjs' ? {Tracker: ClockTracker} : name === './activity.cjs' ? require('../src/activity.cjs') : name === 'uiohook-napi' ? {uIOhook: uiohook} : name === './storage.cjs' ? {LocalStore: Store} : name === './sync.cjs' ? {SyncClient: SyncStub} : name === './clock.cjs' ? {createCaptureClock: options => require('../src/clock.cjs').createCaptureClock({...options, platform: 'linux', read: () => {if (++clockFault.reads >= clockFault.after) throw new Error('Simulated uptime failure'); return `${clock.mono / 1000} 0`;}})} : require(name),
    __dirname: dirname, process, console, URL, setInterval: fn => { loop = fn; }, clearInterval() {},
    setTimeout(fn, delay) {const id = ++timerId; timers.set(id, {fn, at: clock.mono + delay}); return id;},
    clearTimeout(id) {timers.delete(id);}
  });
  vm.runInContext(fs.readFileSync(path.join(dirname, 'main.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  const event = {sender: win.webContents, senderFrame: {url}};
  const invoke = (name, value, sender = event) => handlers.get(`tracker:${name}`)(sender, value);
  return {
    app, get quitCalls() {return quitCalls;}, win, screen, displays, powerMonitor, permissions, sourceRequests, sent, url, event, invoke, clock, timers, persisted, decoded, saveArgs, uiohook, get activityHookCounts() {return {starts: hookStarts, stops: hookStops};},
    get saveCalls() {return saveCalls;}, get sync() {return syncInstance;},
    finalize(value, sender = event) {
      const e = {...sender}; let reply, replies = 0;
      Object.defineProperty(e, 'returnValue', {set(value) {assert.equal(replies++, 0, 'Electron sync IPC must reply exactly once'); reply = value;}});
      syncHandlers.get('tracker:finalize-capture')(e, value); assert.equal(replies, 1); return reply;
    },
    tick: () => loop(),
    advance(ms, wallMs = ms) {clock.mono += ms; clock.wall += wallMs;},
    runTimers() {for (const [id, timer] of [...timers]) if (timer.at <= clock.mono) {timers.delete(id); timer.fn();}},
    prepare: (extra = {}) => invoke('prepare', {displayId: 1, intervalSeconds: 10, consent: true, ...extra}),
    request: overrides => ({frame: {url}, videoRequested: true, audioRequested: false, ...overrides})
  };
}

test('main IPC rejects another webContents or frame URL', async () => {
  const f = await fixture();
  assert.throws(() => f.invoke('status', null, {...f.event, sender: {}}), /Untrusted/);
  assert.throws(() => f.invoke('status', null, {...f.event, senderFrame: {url: 'file:///tmp/untrusted.html'}}), /Untrusted/);
  assert.equal(f.invoke('status').phase, 'stopped');
});

test('main start requires explicit consent and an available display', async () => {
  const f = await fixture();
  assert.throws(() => f.invoke('prepare', {displayId: 1, intervalSeconds: 10, consent: false}), /agree/);
  assert.throws(() => f.invoke('prepare', {displayId: 999, intervalSeconds: 10, consent: true}), /available screen/);
  assert.equal(f.invoke('status').phase, 'stopped');
});

test('quitting stops and persists the active session, then attempts a bounded sync before app exit', async () => {
  const f = await fixture(); f.sync.signIn();
  const {token} = f.prepare({mode: 'company'}); f.invoke('confirm', token);
  let finishFlush;
  f.sync.flushImpl = () => new Promise(resolve => {finishFlush = resolve;});
  let prevented = false;
  f.app.emit('before-quit', {preventDefault() {prevented = true;}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(f.invoke('status').phase, 'stopped');
  assert.ok(f.sync.calls.entries.at(-1).endedAt, 'final tracked time is saved and queued before the flush');
  assert.equal(f.sync.calls.flushes.length, 1);
  assert.ok(f.sync.calls.flushes[0].deadlineAt > Date.now());
  assert.ok(f.sync.calls.flushes[0].deadlineAt <= Date.now() + 10_000);
  assert.equal(f.sync.stopCalls, 1);
  assert.equal(f.quitCalls, 0, 'the app waits for the final best-effort sync');
  finishFlush({progressed: true});
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sync.stopCalls, 2, 'shutdown clears any retry timer created by an in-flight flush');
  assert.equal(f.quitCalls, 1);
  let preventedAgain = false;
  f.app.emit('before-quit', {preventDefault() {preventedAgain = true;}});
  assert.equal(preventedAgain, false, 'the final quit is allowed through');
});

test('main permissions allow only trusted display capture during starting', async () => {
  const f = await fixture(); const details = {requestingUrl: f.url};
  const check = (permission = 'display-capture', wc = f.win.webContents, data = details) => f.permissions.check(wc, permission, '', data);
  assert.equal(check(), false); const {token} = f.prepare(); assert.equal(check(), true);
  for (const permission of ['media', 'clipboard-read', 'geolocation', 'notifications']) assert.equal(check(permission), false);
  assert.equal(check('display-capture', {}), false);
  assert.equal(check('display-capture', f.win.webContents, {requestingUrl: 'https://example.com'}), false);
  let granted;
  f.permissions.request(f.win.webContents, 'display-capture', value => { granted = value; }, details);
  assert.equal(granted, true);
  f.permissions.request(f.win.webContents, 'media', value => { granted = value; }, details);
  assert.equal(granted, false); // plain 'media' without the display-capture signature
  // Electron 44 on Windows reports getDisplayMedia() as 'media' with an empty mediaTypes list.
  f.permissions.request(f.win.webContents, 'media', value => { granted = value; }, {...details, mediaTypes: []});
  assert.equal(granted, true);
  // Camera/microphone requests list their media types and must stay denied.
  for (const mediaTypes of [['video'], ['audio'], ['video', 'audio']]) {
    f.permissions.request(f.win.webContents, 'media', value => { granted = value; }, {...details, mediaTypes});
    assert.equal(granted, false);
  }
  f.permissions.request(f.win.webContents, 'media', value => { granted = value; }, {requestingUrl: 'https://example.com', mediaTypes: []});
  assert.equal(granted, false);
  f.invoke('confirm', token); assert.equal(check(), false);
  f.permissions.request(f.win.webContents, 'media', value => { granted = value; }, {...details, mediaTypes: []});
  assert.equal(granted, false); // only during the 'starting' phase
});

test('main capture enumeration selects only requested display without thumbnails', async () => {
  const f = await fixture(); f.prepare(); let result;
  const pending = f.permissions.display(f.request(), value => { result = value; });
  const chosen = {display_id: '1', id: 'chosen'};
  f.sourceRequests[0].resolve([{display_id: '2', id: 'other'}, chosen]); await pending;
  assert.equal(result.video, chosen);
  assert.deepEqual(Array.from(f.sourceRequests[0].options.types), ['screen']);
  assert.equal(f.sourceRequests[0].options.thumbnailSize.width, 0);
  assert.equal(f.sourceRequests[0].options.thumbnailSize.height, 0);
  assert.equal(f.sourceRequests[0].options.fetchWindowIcons, false);
});

test('main rejects audio and stale display-enumeration completion', async () => {
  const f = await fixture(); f.prepare(); let result;
  await f.permissions.display(f.request({audioRequested: true}), value => { result = value; });
  assert.equal(result, null); assert.equal(f.sourceRequests.length, 0);
  const pending = f.permissions.display(f.request(), value => { result = value; });
  f.invoke('stop'); f.prepare();
  f.sourceRequests[0].resolve([{display_id: '1', id: 'chosen'}]); await pending;
  assert.equal(result, null);
  assert.equal(f.invoke('status').phase, 'starting');
});

test('main pause conditions invalidate captures that are already in flight', async () => {
  for (const [target, event] of [['win', 'hide'], ['win', 'minimize'], ['powerMonitor', 'suspend'], ['powerMonitor', 'lock-screen']]) {
    const f = await fixture(); const {token} = f.prepare(); f.invoke('confirm', token); f.tick();
    const request = f.sent.find(message => message.name === 'tracker:capture').value;
    f[target].emit(event);
    assert.equal(f.invoke('status').phase, 'paused', event);
    assert.equal(f.invoke('save-capture', {...request, dataUrl: 'must not be read'}).saved, false, event);
  }
});

test('main network interception rejects remote requests', async () => {
  const f = await fixture();
  for (const url of ['https://example.com/upload', 'http://example.com', 'wss://example.com']) {
    let result; f.permissions.network({url}, value => { result = value; }); assert.equal(result.cancel, true);
  }
  let local; f.permissions.network({url: f.url}, value => { local = value; }); assert.equal(local.cancel, false);
});

const oneHour = {mode: 'one-hour', intervalSeconds: 300};
test('independent main deadline timer stops a paused test without the regular loop', async () => {
  const f = await fixture(); const {token} = f.prepare(oneHour); f.invoke('confirm', token);
  assert.equal(f.timers.size, 1); f.invoke('pause');
  f.advance(ONE_HOUR_MS); f.runTimers();
  const stopped = f.sent.at(-1).value;
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.lastCompleted.stopReason, 'time-limit');
  assert.equal(f.timers.size, 0); assert.equal(f.persisted.sessions.at(-1).stopReason, 'time-limit');
});

test('main rejects authorization and storage exactly at cutoff without timer delivery', async () => {
  const f = await fixture(); const {token} = f.prepare(oneHour); f.invoke('confirm', token); f.tick();
  const request = f.sent.find(message => message.name === 'tracker:capture').value;
  f.advance(ONE_HOUR_MS, -ONE_HOUR_MS);
  assert.equal(f.invoke('authorize-capture', request).allowed, false);
  assert.equal(f.invoke('save-capture', {...request, dataUrl: 'not read'}).saved, false);
  assert.equal(f.saveCalls, 0); assert.equal(f.invoke('status').lastCompleted.stopReason, 'time-limit');
});

test('main sleep pauses immediately and wake does not resume or extend a test', async () => {
  const f = await fixture(); const {token} = f.prepare(oneHour); f.invoke('confirm', token);
  const deadline = f.invoke('status').current.deadlineAt;
  f.powerMonitor.emit('suspend'); f.advance(30 * 60 * 1000); f.powerMonitor.emit('resume');
  assert.equal(f.invoke('status').phase, 'paused'); assert.equal(f.invoke('status').current.deadlineAt, deadline);
  f.advance(30 * 60 * 1000); f.powerMonitor.emit('resume');
  assert.equal(f.invoke('status').phase, 'stopped'); assert.equal(f.invoke('status').lastCompleted.stopReason, 'time-limit');
  assert.equal(f.sourceRequests.length, 0);
});

test('main resume cannot silently create a new test after the old cutoff', async () => {
  const f = await fixture(); const {token} = f.prepare(oneHour); f.invoke('confirm', token); f.invoke('pause');
  f.advance(ONE_HOUR_MS);
  assert.throws(() => f.prepare(oneHour), /has ended/);
  assert.equal(f.invoke('status').phase, 'stopped'); assert.equal(f.invoke('status').current, null);
});

test('main rejects resumed permission enumeration and confirmation finishing after cutoff', async () => {
  const f = await fixture(); let {token} = f.prepare(oneHour); f.invoke('confirm', token); f.invoke('pause');
  f.advance(ONE_HOUR_MS - 1); ({token} = f.prepare(oneHour)); let result;
  const pending = f.permissions.display(f.request(), value => {result = value;});
  f.advance(1); f.sourceRequests[0].resolve([{display_id: '1', id: 'chosen'}]); await pending;
  assert.equal(result, null); assert.throws(() => f.invoke('confirm', token), /cancelled|ended/);
  assert.equal(f.invoke('status').phase, 'stopped');
});

test('main relaunch never restores capture authorization from saved sessions', async () => {
  const persisted = {sessions: [], recoveries: 0}; const first = await fixture({persisted});
  const {token} = first.prepare(oneHour); first.invoke('confirm', token); first.tick();
  const request = first.sent.find(message => message.name === 'tracker:capture').value;
  const restarted = await fixture({persisted}); restarted.tick();
  assert.equal(persisted.recoveries, 2); assert.equal(restarted.invoke('status').phase, 'stopped');
  assert.equal(restarted.invoke('status').current, null); assert.equal(restarted.timers.size, 0);
  assert.equal(restarted.invoke('authorize-capture', request).allowed, false);
  assert.equal(restarted.sent.some(message => message.name === 'tracker:capture'), false);
});
test('main clock failure during permission callback stops capture and denies the request', async () => {
  const fault = {after: Infinity, reads: 0};
  const f = await fixture({clockFault: fault}); let {token} = f.prepare(oneHour); f.invoke('confirm', token);
  f.invoke('pause'); f.prepare(oneHour); fault.after = fault.reads + 1;
  let calls = 0, result;
  await f.permissions.display(f.request(), value => {calls++; result = value;});
  assert.equal(calls, 1); assert.equal(result, null);
  assert.equal(f.invoke('status').phase, 'stopped');
  assert.equal(f.invoke('status').lastCompleted.stopReason, 'clock-unavailable');
  assert.throws(() => f.prepare(oneHour), /timing is unavailable/);
});
test('main catches clock failures on later capture authorization reads without saving', async () => {
  for (const offset of [1, 2, 3, 4, 5, 6]) {
    const fault = {after: Infinity, reads: 0}; const f = await fixture({clockFault: fault});
    const {token} = f.prepare(oneHour); f.invoke('confirm', token); f.tick();
    const request = f.sent.find(message => message.name === 'tracker:capture').value;
    fault.after = fault.reads + offset;
    try {f.invoke('authorize-capture', request);} catch (error) {assert.match(error.message, /timing is unavailable/);}
    // Ensure the fault has occurred before trying to commit a screenshot.
    while (fault.reads < fault.after) {try {f.invoke('status');} catch (error) {assert.match(error.message, /timing is unavailable/);}}
    assert.equal(f.invoke('save-capture', {...request, dataUrl: 'must not be read'}).saved, false);
    assert.equal(f.invoke('status').phase, 'stopped'); assert.equal(f.saveCalls, 0);
  }
});
test('permission request and check callbacks deny cleanly when the clock fails', async () => {
  for (const handler of ['request', 'check']) {
    const fault = {after: Infinity, reads: 0}; const f = await fixture({clockFault: fault});
    const {token} = f.prepare(oneHour); f.invoke('confirm', token); f.invoke('pause'); f.prepare(oneHour);
    fault.after = fault.reads + 1; let allowed, calls = 0;
    if (handler === 'request') f.permissions.request(f.win.webContents, 'display-capture', result => {allowed = result; calls++;}, {requestingUrl: f.url});
    else allowed = f.permissions.check(f.win.webContents, 'display-capture', '', {requestingUrl: f.url});
    assert.equal(allowed, false); if (handler === 'request') assert.equal(calls, 1);
    assert.equal(f.invoke('status').phase, 'stopped');
    assert.equal(f.invoke('status').lastCompleted.stopReason, 'clock-unavailable');
  }
});
test('synchronous final capture gate checks trusted sender, live token and exact cutoff', async () => {
  const f = await fixture(); const {token} = f.prepare(oneHour); f.invoke('confirm', token); f.tick();
  const request = f.sent.find(message => message.name === 'tracker:capture').value;
  assert.equal(f.finalize(request), true);
  assert.equal(f.finalize(request, {...f.event, sender: {}}), false);
  assert.equal(f.finalize(request, {...f.event, senderFrame: {url: 'file:///untrusted'}}), false);
  assert.equal(f.finalize({...request, token: 'old-token'}), false);
  f.advance(ONE_HOUR_MS, -ONE_HOUR_MS); assert.equal(f.finalize(request), false);
  assert.equal(f.invoke('status').phase, 'stopped');
});
test('synchronous final capture gate denies clock errors without uncaught exceptions', async () => {
  const fault = {after: Infinity, reads: 0}; const f = await fixture({clockFault: fault});
  const {token} = f.prepare(oneHour); f.invoke('confirm', token); f.tick();
  const request = f.sent.find(message => message.name === 'tracker:capture').value;
  fault.after = fault.reads + 1; assert.equal(f.finalize(request), false);
  assert.equal(f.invoke('status').lastCompleted.stopReason, 'clock-unavailable');
});

// ---------- company account: policy is applied by the main process, not trusted from the renderer ----------
const projects = [{id: 'p1', name: 'Website', client: null, tasks: [{id: 't1', name: 'Build'}]}];
const startCompany = async (f, extra = {}) => { const {token} = f.prepare(extra); f.invoke('confirm', token); return token; };
const captureRequests = f => f.sent.filter(m => m.name === 'tracker:capture');

test('company: a company session cannot be started while signed out, and local modes still work', async () => {
  const f = await fixture();
  assert.throws(() => f.prepare({mode: 'company'}), /Sign in to your company account/);
  const {token} = f.prepare({mode: 'manual'}); assert.ok(token);
  assert.equal(f.invoke('status').current.mode, 'manual');
  assert.equal(f.invoke('status').sync.signedIn, false);
});

test('company: signed-in sessions are always company sessions at the policy interval; the renderer cannot override mode or interval', async () => {
  const f = await fixture(); f.sync.signIn({policy: {screenshotIntervalSeconds: 900}, projects});
  f.prepare({mode: 'manual', intervalSeconds: 10});
  const current = f.invoke('status').current;
  assert.equal(current.mode, 'company'); assert.equal(current.intervalSeconds, 900); assert.equal(current.screenshots, true); assert.equal(current.displayId, 1);
  assert.equal(f.invoke('status').sync.signedIn, true);
});

test('company all-screens policy overrides the selected display and assigns each request left-to-right', async () => {
  const f = await fixture(); f.displays[0].bounds = {x: 1000, y: 0}; f.displays[1].bounds = {x: -1000, y: 0}; f.sync.signIn({policy: {captureAllScreens: true}});
  const prepared = f.prepare({displayId: 2});
  assert.equal(prepared.screenCount, 2); assert.equal(f.invoke('status').current.allScreens, true); assert.equal(f.invoke('status').current.displayId, 1);
  let firstResult, secondResult;
  const first = f.permissions.display(f.request(), value => {firstResult = value;});
  f.sourceRequests[0].resolve([{display_id: '1', id: 'left'}, {display_id: '2', id: 'right'}]); await first;
  const second = f.permissions.display(f.request(), value => {secondResult = value;});
  f.sourceRequests[1].resolve([{display_id: '1', id: 'left'}, {display_id: '2', id: 'right'}]); await second;
  assert.equal(firstResult.video.id, 'right'); assert.equal(secondResult.video.id, 'left');
  f.invoke('confirm', prepared.token);
  f.screen.emit('display-added'); assert.equal(f.invoke('status').phase, 'paused');
  assert.match(f.invoke('status').message, /new screen was connected/i);
});

test('disconnecting one of the organization capture screens pauses tracking', async () => {
  const f = await fixture(); f.sync.signIn({policy: {captureAllScreens: true}});
  const prepared = f.prepare(); f.invoke('confirm', prepared.token);
  f.screen.emit('display-removed', {}, {id: 2});
  assert.equal(f.invoke('status').phase, 'paused');
  assert.match(f.invoke('status').message, /screen was disconnected/i);
});

test('company: the monitoring notice must be accepted, projects must exist, and requireProject is enforced', async () => {
  let f = await fixture(); f.sync.signIn({needsConsent: true, projects});
  assert.throws(() => f.prepare(), /monitoring notice/);
  f = await fixture(); f.sync.signIn({projects});
  assert.throws(() => f.prepare({projectId: 'nope'}), /Choose a project from the list/);
  assert.throws(() => f.prepare({projectId: 'p1', taskId: 'nope'}), /task that belongs/);
  assert.throws(() => f.prepare({taskId: 't1'}), /task that belongs/);
  f.prepare({projectId: 'p1', taskId: 't1'}); assert.equal(f.invoke('status').current.projectId, 'p1'); assert.equal(f.invoke('status').current.taskId, 't1');
  f = await fixture(); f.sync.signIn({projects, policy: {requireProject: true}});
  assert.throws(() => f.prepare(), /requires choosing a project/);
  f = await fixture(); f.sync.signIn({projects: []}); f.sync.snap.policy = null;
  assert.throws(() => f.prepare(), /not available yet/);
});

test('company: with screenshots off no screen is chosen, shared or captured, and time is still tracked', async () => {
  const f = await fixture(); f.sync.signIn({policy: {screenshotsEnabled: false}});
  const token = await startCompany(f, {displayId: 999});          // display is irrelevant when nothing is captured
  assert.equal(f.invoke('status').current.displayId, null);
  for (let i = 0; i < 5; i++) { f.advance(1000); f.tick(); }
  assert.equal(captureRequests(f).length, 0);
  assert.equal(f.invoke('authorize-capture', {token, id: 'x'}).allowed, false);
  assert.ok(f.invoke('status').current.trackedMs >= 4000);
});

test('company: with screenshots on the display must still exist', async () => {
  const f = await fixture(); f.sync.signIn();
  assert.throws(() => f.prepare({displayId: 999}), /Choose an available screen/);
});

test('company: saved screenshots and session state are queued for upload; local sessions are not', async () => {
  const f = await fixture(); f.sync.signIn({projects});
  await startCompany(f, {projectId: 'p1'}); f.tick();
  const [request] = captureRequests(f).map(m => m.value); assert.ok(request); assert.equal(request.blur, false);
  assert.equal(f.invoke('authorize-capture', request).allowed, true);
  const saved = f.invoke('save-capture', {...request, dataUrl: 'data:image/png;base64,AAAA'});
  assert.equal(saved.saved, true);
  assert.deepEqual(f.sync.calls.shots.map(s => ({captureId: s.captureId, entryClientId: s.entryClientId})), [{captureId: 'saved-test-capture', entryClientId: f.invoke('status').current.id}]);
  const queued = f.sync.calls.entries.at(-1); assert.equal(queued.mode, 'company'); assert.equal(queued.projectId, 'p1');
  const local = await fixture(); const t2 = local.prepare().token; local.invoke('confirm', t2); local.tick();
  const r2 = captureRequests(local)[0].value; local.invoke('save-capture', {...r2, dataUrl: 'data:image/png;base64,AAAA'});
  assert.equal(local.sync.calls.shots.length, 0); assert.equal(local.sync.calls.entries.length, 0);
});

test('company: the blur policy is attached to each capture request', async () => {
  const f = await fixture(); f.sync.signIn({policy: {screenshotBlur: true}});
  await startCompany(f); f.tick();
  assert.equal(captureRequests(f)[0].value.blur, true);
});

test('company: policy idle timeout is passed to the local tracker and stored with the session', async () => {
  const f = await fixture(); f.sync.signIn({policy: {idleTimeoutSeconds: 240, screenshotsEnabled: false}});
  await startCompany(f);
  assert.equal(f.invoke('status').current.idleTimeoutSeconds, 240);
});

test('company: count-only input hook starts only under enabled policy and stops on pause/stop', async () => {
  const f = await fixture(); f.sync.signIn({policy: {screenshotsEnabled: false, activityTrackingEnabled: true}});
  const token = await startCompany(f);
  assert.deepEqual(f.activityHookCounts, {starts: 1, stops: 0});
  f.uiohook.emit('keydown', {keycode: 30, text: 'synthetic only'});
  f.uiohook.emit('click', {x: 900, y: 900, button: 1});
  f.advance(1000); f.tick();
  f.invoke('pause');
  assert.deepEqual(f.activityHookCounts, {starts: 1, stops: 1});
  const paused = f.invoke('status').current;
  assert.equal(paused.activitySlices.length, 1);
  assert.deepEqual(Object.keys(paused.activitySlices[0]).sort(), ['activeSeconds', 'durationSeconds', 'keyboardCount', 'mouseCount', 'startedAt']);
  assert.equal(paused.activitySlices[0].keyboardCount, 1); assert.equal(paused.activitySlices[0].mouseCount, 1);
  assert.equal(JSON.stringify(paused.activitySlices).includes('synthetic only'), false);
  const resumed = f.prepare(); f.invoke('confirm', resumed.token);
  assert.deepEqual(f.activityHookCounts, {starts: 2, stops: 1});
  f.invoke('stop');
  assert.deepEqual(f.activityHookCounts, {starts: 2, stops: 2});
  assert.ok(f.sync.calls.entries.at(-1).activitySlices.length >= 1);
  assert.equal(f.invoke('status').phase, 'stopped');
});

test('company: idle review IPC resolves policy idle time and refuses stale requests', async () => {
  const f = await fixture(); f.sync.signIn({policy: {idleTimeoutSeconds: 60, screenshotsEnabled: false}});
  await startCompany(f);
  f.powerMonitor.getSystemIdleTime = () => 60;
  f.advance(1000); f.tick();
  assert.ok(f.invoke('status').current.idleReview);
  await assert.rejects(Promise.resolve().then(() => f.invoke('idle-review', {keep: 'yes'})), /Choose whether/);
  const result = f.invoke('idle-review', {keep: false});
  assert.equal(result.result.kept, false); assert.equal(result.result.idleMs, 1000);
  assert.equal(result.state.current.idleReview, undefined); assert.equal(result.state.current.trackedMs, 0);
  assert.equal(f.persisted.sessions.at(-1).events.at(-1).type, 'idle-review-discarded');
});

test('company: stopping queues the finished session once, and heartbeats report status and project', async () => {
  const f = await fixture(); f.sync.signIn({projects, policy: {screenshotsEnabled: false}});
  await startCompany(f, {projectId: 'p1'}); f.advance(1000); f.tick();
  const beat = f.sync.calls.heartbeats.at(-1);
  assert.equal(beat.status, 'tracking'); assert.equal(beat.projectId, 'p1');
  f.invoke('stop');
  const last = f.sync.calls.entries.at(-1); assert.ok(last.endedAt); assert.equal(last.mode, 'company'); assert.equal(last.stopReason, 'manual');
  f.tick(); assert.equal(f.sync.calls.heartbeats.at(-1).status, 'stopped');
});

test('company: account changes are blocked while tracking and work when stopped; sign-out can be forced', async () => {
  const f = await fixture(); f.sync.signIn({policy: {screenshotsEnabled: false}});
  await startCompany(f);
  await assert.rejects(Promise.resolve().then(() => f.invoke('sync-login', {})), /Stop tracking/);
  await assert.rejects(Promise.resolve().then(() => f.invoke('sync-logout', {})), /Stop tracking/);
  f.invoke('stop');
  const out = await f.invoke('sync-logout', {force: true}); assert.equal(out.signedIn, false);
  const back = await f.invoke('sync-login', {serverUrl: 'http://localhost:4300', email: 'a@b.co', password: 'x'}); assert.equal(back.signedIn, true);
  assert.deepEqual(f.sync.calls.logins[0].serverUrl, 'http://localhost:4300');
});

test('company: manual time IPC requires stopped tracking and a signed-in account; entry calls are trusted', async () => {
  const f = await fixture();
  await assert.rejects(f.invoke('sync-manual-entry', {}), /Sign in first/);
  await assert.rejects(f.invoke('sync-manual-entries'), /Sign in first/);
  f.sync.signIn({policy: {screenshotsEnabled: false}});
  await startCompany(f);
  await assert.rejects(f.invoke('sync-manual-entry', {}), /Stop tracking/);
  await assert.rejects(f.invoke('sync-manual-entries'), /Stop tracking/);
  f.invoke('stop');
  const input = {taskLabel: 'Synthetic report', startAt: '2026-10-18T09:00:00.000Z', endAt: '2026-10-18T10:00:00.000Z'};
  const submitted = await f.invoke('sync-manual-entry', input);
  assert.equal(submitted.queued, false); assert.deepEqual(f.sync.calls.manualEntry, input);
  assert.deepEqual(await f.invoke('sync-manual-entries'), []); assert.equal(f.sync.calls.manualEntries, true);
});

test('company: untrusted senders cannot use the account IPC', async () => {
  const f = await fixture();
  for (const name of ['sync-login', 'sync-logout', 'sync-consent', 'sync-now', 'sync-manual-entry', 'sync-manual-entries']) assert.throws(() => f.invoke(name, {}, {...f.event, sender: {}}), /Untrusted/, name);
});

test('gallery refreshes never decode more than a couple of screenshots at once, and each is decoded only once', async () => {
  const f = await fixture({galleryCaptures: 60});
  const first = f.invoke('gallery');
  assert.equal(f.decoded.length, 2, 'a refresh must not decode all 60 (that froze the app and tripped the 5 s timing-gap pause)');
  assert.equal(first.captures.filter(c => c.thumbnail).length, 2); assert.equal(first.captures.filter(c => c.thumbnailPending).length, 58);
  for (let i = 0; i < 40; i++) f.invoke('gallery');            // the renderer keeps asking until nothing is pending
  assert.equal(f.decoded.length, 60); assert.equal(new Set(f.decoded).size, 60, 'each screenshot decoded exactly once');
  const done = f.invoke('gallery'); assert.equal(done.captures.every(c => c.thumbnail && !c.thumbnailPending), true);
  assert.equal(f.decoded.length, 60, 'cached: no further decoding');
});

// ---------- image format policy, thumbnails and the gallery ----------
test('company captures carry the image format and quality set by policy; PNG policy and local sessions stay PNG', async () => {
  let f = await fixture(); f.sync.signIn({policy: {imageFormat: 'webp', imageQuality: 65}}); await startCompany(f); f.tick();
  assert.deepEqual([captureRequests(f)[0].value.format, captureRequests(f)[0].value.quality], ['webp', 65]);
  f = await fixture(); f.sync.signIn({policy: {imageFormat: 'png', imageQuality: 65}}); await startCompany(f); f.tick();
  assert.equal(captureRequests(f)[0].value.format, 'png');
  f = await fixture(); f.sync.signIn({policy: {imageFormat: 'gif', imageQuality: 'high'}}); await startCompany(f); f.tick();
  assert.deepEqual([captureRequests(f)[0].value.format, captureRequests(f)[0].value.quality], ['png', 80], 'garbage policy values fall back safely');
  f = await fixture(); const t = f.prepare().token; f.invoke('confirm', t); f.tick();
  assert.deepEqual([captureRequests(f)[0].value.format, captureRequests(f)[0].value.blur], ['png', false], 'local sessions are never converted');
});

test('the thumbnail made by the renderer is passed to storage together with the screenshot', async () => {
  const f = await fixture(); f.sync.signIn(); await startCompany(f); f.tick();
  const request = captureRequests(f)[0].value;
  f.invoke('save-capture', {...request, dataUrl: 'data:image/webp;base64,AAAA', thumbUrl: 'data:image/jpeg;base64,BBBB'});
  assert.deepEqual(f.saveArgs, [{data: 'data:image/webp;base64,AAAA', thumb: 'data:image/jpeg;base64,BBBB'}]);
});

test('gallery uses the saved JPEG thumbnail and never decodes those screenshots', async () => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufs-gallery-')); const thumbFiles = new Map();
  try {
    const gallery = [{id: 'a-webp', fileName: 'a.webp'}, {id: 'b-webp', fileName: 'b.webp'}, {id: 'c-png', fileName: 'c.png'}, {id: 'd-webp-nothumb', fileName: 'd.webp'}];
    for (const id of ['a-webp', 'b-webp']) { const file = path.join(dir, `${id}.thumb.jpg`); fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])); thumbFiles.set(id, file); }
    const f = await fixture({gallery, thumbFiles});
    const result = f.invoke('gallery'); const byId = Object.fromEntries(result.captures.map(c => [c.id, c]));
    assert.match(byId['a-webp'].thumbnail, /^data:image\/jpeg;base64,/); assert.match(byId['b-webp'].thumbnail, /^data:image\/jpeg;base64,/);
    assert.deepEqual(f.decoded, ['/tmp/c-png.png'], 'only the old PNG without a saved thumbnail is decoded');
    assert.equal(byId['d-webp-nothumb'].thumbnail, null); assert.equal(byId['d-webp-nothumb'].thumbnailPending, false, 'a WebP cannot be decoded by Electron, so it is not left pending forever');
    assert.equal(byId['c-png'].thumbnailPending, false);
    f.invoke('gallery'); assert.equal(f.decoded.length, 1, 'cached');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('company sign-in: a code prompt from the server is returned to the UI, not thrown; the code is passed through', async () => {
  const f = await fixture();
  f.sync.login = async value => { f.sync.calls.logins.push(value); if (!value.totp) { const e = new Error('Enter the 6-digit code from your authenticator app.'); e.mfaRequired = true; throw e; } f.sync.signedIn = true; return f.sync.snapshot(); };
  const first = await f.invoke('sync-login', {serverUrl: 'http://localhost:4300', email: 'hr@example.test', password: 'pw-for-test-1'});
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {mfaRequired: true, message: 'Enter the 6-digit code from your authenticator app.'});
  const second = await f.invoke('sync-login', {serverUrl: 'http://localhost:4300', email: 'hr@example.test', password: 'pw-for-test-1', totp: '123456'});
  assert.equal(second.signedIn, true); assert.equal(f.sync.calls.logins[1].totp, '123456');
  f.sync.login = async () => { throw new Error('Incorrect code. Check your authenticator app and try again.'); }; f.invoke('stop');
  await assert.rejects(Promise.resolve().then(() => f.invoke('sync-login', {totp: '000000'})), /Incorrect code/, 'real failures are still errors');
});
