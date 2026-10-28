'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {Tracker, ONE_HOUR_MS} = require('../src/tracker.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function mediaStream() {
  const track = {
    stops: 0, readyState: 'live', listeners: new Map(),
    stop() { this.stops++; this.readyState = 'ended'; },
    addEventListener(event, listener) { this.listeners.set(event, listener); }
  };
  return {track, getTracks: () => [track], getVideoTracks: () => [track]};
}

async function fixture({getDisplayMedia = () => Promise.resolve(mediaStream()), play = () => Promise.resolve(), mode = 'manual', authorize, thumbnail = false, allScreens = false, sessionExpired = false, pending = {time: 0, manual: 0, screenshots: 0, activity: 0}, screenCount = 1, screenSizes = [[1920,1080]], clock = {mono: 0, wall: Date.parse('2026-10-18T12:00:00Z')}} = {}) {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', checked: false, hidden: false, disabled: false,
      parentElement: {hidden: false},
      dataset: {},
      listeners: new Map(), classList: {toggle() {}},
      addEventListener(event, listener) { this.listeners.set(event, listener); },
      replaceChildren() {}, append() {}, add() {}
    });
    return nodes.get(id);
  }
  element('display').value = '1';
  element('mode').value = mode;
  element('interval').value = mode === 'one-hour' ? '300' : '10';
  element('consent').checked = true;
  element('capture-video').play = play;
  Object.assign(element('capture-video'), {videoWidth: 1920, videoHeight: 1080, readyState: 2});
  const counts = {draw: 0, drawArgs: [], encode: 0, saveRequests: 0, saved: 0, authorize: 0, finalize: 0, encodeArgs: [], saves: []};
  const drawing = {};   // the 2D context the renderer draws with (records e.g. the blur filter)
  element('capture-canvas').getContext = () => Object.assign(drawing, {drawImage(...args) {counts.draw++; counts.drawArgs.push(args);}});
  element('capture-canvas').toDataURL = (...args) => {counts.encode++; counts.encodeArgs.push(args); return args[0] === 'image/webp' ? 'data:image/webp;base64,test-only' : 'data:image/png;base64,test-only';};
  if (thumbnail) { element('thumb-canvas').getContext = () => ({drawImage() {}}); element('thumb-canvas').toDataURL = () => 'data:image/jpeg;base64,thumb-test'; }
  const tracker = new Tracker({now: () => clock.mono, wall: () => new Date(clock.wall).toISOString()});
  let notify = () => {}, captureListener;
  const policy = {screenshotsEnabled: true, captureAllScreens: allScreens, screenshotIntervalSeconds: 10, idleTimeoutSeconds: 60, activityTrackingEnabled: false};
  const sync = allScreens || sessionExpired ? {signedIn: allScreens && !sessionExpired, sessionExpired, needsConsent: false, policy, projects: [], pending, user: {name: 'Synthetic Employee', email: 'synthetic@example.test', role: 'employee'}, serverHost: 'synthetic.test', status: sessionExpired ? 'signed-out' : 'online'} : undefined;
  const state = () => ({...tracker.snapshot(), ...(sync ? {sync} : {}), directory: '/tmp/local-test-data', platform: 'linux'});
  const expire = () => {if (tracker.expireIfNeeded()) notify(state());};
  const api = {
    status: async () => state(),
    displays: async () => [{id: 1, label: 'Test screen', width: 1920, height: 1080}],
    gallery: async () => ({captures: [], sessions: [], totalCaptureCount: 0}),
    prepare: async value => { const token = tracker.prepare(allScreens ? {...value, mode: 'company', allScreens: true, screenshots: true, idleTimeoutSeconds: 60, activityTrackingEnabled: false} : value); notify(state()); return {token, screenCount}; },
    confirm: async token => { tracker.confirm(token); notify(state()); return state(); },
    fail: async value => { tracker.fail(value.token); notify(state()); },
    pause: async () => { tracker.pause(); notify(state()); return state(); },
    stop: async () => { tracker.stop(); notify(state()); return state(); },
    authorizeCapture: async request => {counts.authorize++; expire(); const decision = {allowed: tracker.canSave(request), remainingMs: tracker.remainingMs()}; return authorize ? authorize(request, decision) : decision;},
    finalizeCapture: request => {counts.finalize++; expire(); return tracker.canSave(request);},
    saveCapture: async request => {counts.saveRequests++; counts.saves.push(request); expire(); if (!tracker.canSave(request)) return {saved: false}; tracker.saved(request); counts.saved++; notify(state()); return {saved: true};},
    captureFailed: async request => {expire(); tracker.captureFailed(request); notify(state());},
    onState: listener => { notify = listener; }, onCapture(listener) {captureListener = listener;}
  };
  class ClockDate extends Date {constructor(...args) {super(...(args.length ? args : [clock.wall]));} static now() {return clock.wall;}}
  let createdVideo = 0;
  const context = vm.createContext({
    document: {getElementById: element, createElement: tag => {if (tag === 'p') return {className: '', textContent: '', append(){}}; assert.equal(tag, 'video'); const video = {muted: false, playsInline: false, readyState: 2, play, srcObject: null}; [video.videoWidth,video.videoHeight] = screenSizes[createdVideo++] || screenSizes.at(-1); return video;}, querySelectorAll: () => []},
    window: {tracker: api, addEventListener() {}},
    navigator: {mediaDevices: {getDisplayMedia}},
    Option: function Option() {},
    // Timeouts are not the behavior under test; do not keep the test process alive.
    setTimeout() {}, clearTimeout() {}, console, Date: ClockDate, performance: {now: () => (clock.renderMono ?? clock.mono) + 1000000}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8'), context);
  await flush();
  return {
    tracker, element, counts, clock, drawing,
    advance(ms, wallMs = ms) {clock.mono += ms; clock.wall += wallMs;},
    broadcast(overrides = {}) {notify({...state(), ...overrides});},
    capture(request = tracker.captureDue()) {return captureListener(request);},
    start() { element('display').value = '1'; return element('start').listeners.get('click')(); },
    pause() { return element('pause').listeners.get('click')(); },
    stop() { return element('stop').listeners.get('click')(); }
  };
}

test('late permission rejection from a stopped start cannot end a newer stream', async () => {
  const firstPermission = deferred(); const second = mediaStream(); let requests = 0;
  const f = await fixture({getDisplayMedia: () => ++requests === 1 ? firstPermission.promise : Promise.resolve(second)});
  const oldStart = f.start(); await flush();
  await f.stop(); await f.start();
  assert.equal(f.tracker.phase, 'tracking');
  assert.equal(f.element('capture-video').srcObject, second);
  firstPermission.reject(new Error('Old permission request was cancelled'));
  await oldStart;
  assert.equal(second.track.stops, 0, 'stale error must not stop the newer stream');
  assert.equal(f.element('capture-video').srcObject, second);
  assert.equal(f.tracker.phase, 'tracking');
  assert.equal(f.element('error').textContent, '', 'stale error must not replace the newer session UI');
});

test('late video playback completion from a stopped start cannot end a newer stream', async () => {
  const firstPlay = deferred(); const first = mediaStream(); const second = mediaStream(); let requests = 0; let plays = 0;
  const f = await fixture({
    getDisplayMedia: () => Promise.resolve(++requests === 1 ? first : second),
    play: () => ++plays === 1 ? firstPlay.promise : Promise.resolve()
  });
  const oldStart = f.start(); await flush();
  await f.stop(); await f.start();
  assert.equal(f.tracker.phase, 'tracking');
  assert.equal(f.element('capture-video').srcObject, second);
  firstPlay.resolve(); await oldStart;
  assert.equal(second.track.stops, 0, 'stale playback completion must not stop the newer stream');
  assert.equal(f.element('capture-video').srcObject, second);
  assert.equal(f.tracker.phase, 'tracking');
});

test('sharing that ends while video playback starts is not confirmed as tracking', async () => {
  const playback = deferred(); const selected = mediaStream();
  const f = await fixture({getDisplayMedia: () => Promise.resolve(selected), play: () => playback.promise});
  const pendingStart = f.start(); await flush();
  selected.track.readyState = 'ended';
  selected.track.listeners.get('ended')?.();
  playback.resolve(); await pendingStart;
  assert.notEqual(f.tracker.phase, 'tracking', 'an already ended stream must not be confirmed');
  assert.equal(f.element('capture-video').srcObject, null);
});

test('renderer does not draw a queued capture delivered after the one-hour cutoff', async () => {
  const selected = mediaStream(); const f = await fixture({mode: 'one-hour', getDisplayMedia: () => Promise.resolve(selected)});
  await f.start(); const request = f.tracker.captureDue(); f.advance(ONE_HOUR_MS); await f.capture(request);
  assert.equal(f.counts.draw, 0); assert.equal(f.counts.encode, 0); assert.equal(f.counts.saveRequests, 0);
  assert.equal(f.tracker.phase, 'stopped'); assert.equal(selected.track.readyState, 'ended');
});

test('renderer rejects an allowed authorization reply delayed past cutoff despite backward wall time', async () => {
  const response = deferred(); let decision;
  const f = await fixture({mode: 'one-hour', authorize: (_request, value) => {decision = value; return response.promise;}});
  await f.start(); f.advance(ONE_HOUR_MS - 2); const request = f.tracker.captureDue();
  const pending = f.capture(request); await flush(); assert.equal(decision.allowed, true); assert.equal(decision.remainingMs, 2);
  f.advance(2, -60000); response.resolve(decision); await pending;
  assert.equal(f.counts.draw, 0); assert.equal(f.counts.encode, 0); assert.equal(f.counts.saveRequests, 0);
});

test('renderer rejects an old allowed reply after Pause and explicit Resume', async () => {
  const response = deferred(); let decision;
  const f = await fixture({mode: 'one-hour', authorize: (_request, value) => {decision = value; return response.promise;}});
  await f.start(); const deadline = f.tracker.current.deadlineAt;
  const pending = f.capture(); await flush(); await f.pause(); f.advance(1000); await f.start();
  response.resolve(decision); await pending;
  assert.equal(f.counts.draw, 0); assert.equal(f.counts.encode, 0); assert.equal(f.counts.saveRequests, 0);
  assert.equal(f.tracker.phase, 'tracking'); assert.equal(f.tracker.current.deadlineAt, deadline);
});

test('renderer stops its stream on automatic expiry and does not restart it', async () => {
  const selected = mediaStream(); let requests = 0;
  const f = await fixture({mode: 'one-hour', getDisplayMedia: () => {requests++; return Promise.resolve(selected);}});
  await f.start(); f.advance(ONE_HOUR_MS); f.tracker.expireIfNeeded(); f.broadcast(); await flush();
  assert.equal(selected.track.readyState, 'ended'); assert.equal(f.element('capture-video').srcObject, null);
  f.advance(ONE_HOUR_MS); f.broadcast(); await flush(); assert.equal(requests, 1); assert.equal(f.tracker.phase, 'stopped');
});

test('renderer requires fresh main authorization before drawing an otherwise valid frame', async () => {
  const f = await fixture({mode: 'one-hour', authorize: () => ({allowed: false, remainingMs: ONE_HOUR_MS})});
  await f.start(); await f.capture();
  assert.equal(f.counts.authorize, 1); assert.equal(f.counts.draw, 0); assert.equal(f.counts.encode, 0); assert.equal(f.counts.saveRequests, 0);
});

test('renderer rechecks track state when sharing ends during capture authorization', async () => {
  const selected = mediaStream(); const response = deferred(); let decision;
  const f = await fixture({mode: 'one-hour', getDisplayMedia: () => Promise.resolve(selected), authorize: (_request, value) => {decision = value; return response.promise;}});
  await f.start(); const pending = f.capture(); await flush();
  // The OS has ended the track but its queued ended event has not reached JS yet.
  selected.track.readyState = 'ended'; response.resolve(decision); await pending;
  assert.equal(f.counts.draw, 0); assert.equal(f.counts.encode, 0); assert.equal(f.counts.saveRequests, 0);
});
test('final gate rejects delayed permission after suspend with frozen renderer time and backward wall', async () => {
  const response = deferred(); let decision;
  const clock = {mono: 0, renderMono: 0, wall: Date.parse('2026-10-18T12:00:00Z')};
  const f = await fixture({mode: 'one-hour', clock, authorize: (_request, value) => {decision = value; return response.promise;}});
  await f.start(); f.advance(ONE_HOUR_MS - 2); clock.renderMono = clock.mono;
  const request = f.tracker.captureDue(); const pending = f.capture(request); await flush();
  assert.equal(decision.allowed, true); assert.equal(decision.remainingMs, 2);
  f.tracker.pause('Sleep; state event queued'); f.advance(1000, -60000);
  response.resolve(decision); await pending;
  assert.equal(f.counts.finalize, 1); assert.equal(f.counts.draw, 0); assert.equal(f.counts.encode, 0); assert.equal(f.counts.saveRequests, 0);
});
test('valid frame passes both authorization gates and saves once', async () => {
  const f = await fixture({mode: 'one-hour'}); await f.start(); await f.capture();
  assert.equal(f.counts.authorize, 1); assert.equal(f.counts.finalize, 1);
  assert.equal(f.counts.draw, 1); assert.equal(f.counts.encode, 1); assert.equal(f.counts.saved, 1);
});

test('organization all-screens policy hides the picker, requests every screen and joins them left-to-right once', async () => {
  const screens = [mediaStream(), mediaStream()]; let request = 0;
  const f = await fixture({allScreens: true, screenCount: 2, screenSizes: [[1600,900],[1280,1024]], getDisplayMedia: () => Promise.resolve(screens[request++])});
  await f.start();
  assert.equal(request, 2); assert.equal(f.tracker.current.allScreens, true);
  assert.match(f.element('consent-text').textContent, /all connected screens, joined in one image/);
  assert.equal(f.element('display').parentElement.hidden, true);
  await f.capture();
  assert.equal(f.counts.draw, 2); assert.equal(f.counts.encode, 1); assert.equal(f.counts.saved, 1);
  assert.deepEqual(f.counts.drawArgs.map(args => args.slice(1)), [[0,0,1600,900],[1600,0,1280,1024]]);
});

test('ending any shared screen pauses tracking and stops every screen stream', async () => {
  const screens = [mediaStream(), mediaStream()]; let request = 0;
  const f = await fixture({allScreens: true, screenCount: 2, getDisplayMedia: () => Promise.resolve(screens[request++])});
  await f.start(); screens[1].track.readyState = 'ended'; screens[1].track.listeners.get('ended')?.(); await flush();
  assert.equal(f.tracker.phase, 'paused');
  assert.equal(screens[0].track.readyState, 'ended'); assert.equal(screens[1].track.readyState, 'ended');
});

test('ending a screen while another screen is still being authorized cancels the pending start', async () => {
  const secondPermission = deferred(); const first = mediaStream(); const second = mediaStream(); let request = 0;
  const f = await fixture({allScreens: true, screenCount: 2, getDisplayMedia: () => ++request === 1 ? Promise.resolve(first) : secondPermission.promise});
  const starting = f.start(); await flush(); assert.equal(request, 2); assert.equal(f.tracker.phase, 'starting');
  first.track.readyState = 'ended'; first.track.listeners.get('ended')?.(); await flush();
  secondPermission.resolve(second); await starting;
  assert.equal(f.tracker.phase, 'paused'); assert.equal(first.track.readyState, 'ended'); assert.equal(second.track.stops, 1);
});

test('expired company session clearly explains local capture and the same-account upload recovery', async () => {
  const f = await fixture({sessionExpired: true, pending: {time: 1, manual: 0, screenshots: 2, activity: 1}});
  const info = f.element('account-info');
  assert.equal(info.hidden, false);
  assert.match(info.textContent, /sign-in expired/i); assert.match(info.textContent, /4 queued item\(s\)/);
  assert.match(info.textContent, /Stop tracking, then sign in again as synthetic@example.test/);
  assert.match(info.textContent, /different account discards this account's queue/);
  assert.match(f.element('local-pill').textContent, /sign-in expired/i);
});

test('expired all-screens company policy remains visible and keeps display selection hidden', async () => {
  const f = await fixture({allScreens: true, sessionExpired: true});
  assert.match(f.element('consent-text').textContent, /all connected screens, joined in one image/);
  assert.match(f.element('consent-text').textContent, /stays queued on this device/);
  assert.doesNotMatch(f.element('consent-text').textContent, /screen I select/);
  assert.equal(f.element('display').parentElement.hidden, true);
});

// ---------- company capture settings: image format, quality, blur, thumbnail ----------
test('company WebP capture: encodes WebP at the policy quality and sends a JPEG thumbnail with it', async () => {
  const f = await fixture({mode: 'one-hour', thumbnail: true}); await f.start();
  const request = {...f.tracker.captureDue(), format: 'webp', quality: 70};
  await f.capture(request);
  assert.deepEqual(f.counts.encodeArgs, [['image/webp', 0.7]]);
  const saved = f.counts.saves[0]; assert.equal(saved.dataUrl, 'data:image/webp;base64,test-only'); assert.equal(saved.thumbUrl, 'data:image/jpeg;base64,thumb-test');
  assert.equal(f.counts.saved, 1);
});

test('PNG capture (local sessions and the PNG policy) stays lossless PNG', async () => {
  const f = await fixture({mode: 'one-hour', thumbnail: true}); await f.start();
  await f.capture(f.tracker.captureDue());
  assert.deepEqual(f.counts.encodeArgs, [['image/png']]); assert.equal(f.counts.saves[0].dataUrl, 'data:image/png;base64,test-only');
  const g = await fixture({mode: 'one-hour'}); await g.start(); await g.capture({...g.tracker.captureDue(), format: 'bmp'});
  assert.deepEqual(g.counts.encodeArgs, [['image/png']], 'an unknown format falls back to PNG');
});

test('WebP quality is clamped to 40-95 and defaults to 80', async () => {
  for (const [quality, expected] of [[5, 0.4], [200, 0.95], [undefined, 0.8], ['abc', 0.8], [95, 0.95], [40, 0.4]]) {
    const f = await fixture({mode: 'one-hour'}); await f.start(); await f.capture({...f.tracker.captureDue(), format: 'webp', quality});
    assert.equal(f.counts.encodeArgs[0][1], expected, String(quality));
  }
});

test('a thumbnail failure never blocks saving the screenshot', async () => {
  const f = await fixture({mode: 'one-hour'}); await f.start();      // no thumbnail canvas support in this fixture
  await f.capture({...f.tracker.captureDue(), format: 'webp', quality: 80});
  assert.equal(f.counts.saved, 1); assert.equal(f.counts.saves[0].thumbUrl, null);
});

test('the blur policy is applied to the pixels before anything is encoded or saved', async () => {
  const f = await fixture({mode: 'one-hour', thumbnail: true}); await f.start();
  await f.capture({...f.tracker.captureDue(), blur: true, format: 'webp', quality: 80});
  assert.equal(f.drawing.filter, 'blur(12px)'); assert.equal(f.counts.draw, 1); assert.equal(f.counts.saved, 1);
  const g = await fixture({mode: 'one-hour'}); await g.start(); await g.capture(g.tracker.captureDue());
  assert.equal(g.drawing.filter, undefined);
});
