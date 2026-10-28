'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {SyncClient, normalizeServerUrl} = require('../src/sync.cjs');

const T0 = Date.parse('2026-10-22T09:00:00Z');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

// A scripted in-memory "server": records calls, lets each test decide how routes respond.
function fakeServer() {
  const calls = []; const routes = new Map(); let down = false; const clock = {now: T0};
  const state = {user: {id: 'u1', name: 'Ed Employee', email: 'ed@x.test', role: 'employee', mustChangePassword: false}, token: 'tok-aaaaaaaaaaaaaaaaaaaaaaaa'};
  const respond = (status, json) => ({status, json: async () => json});
  const defaults = {
    'POST /api/auth/login': ({body}) => body.password === 'right-pass-1' ? [200, {token: state.token, user: state.user}] : [401, {error: 'Incorrect email or password.'}],
    'POST /api/auth/logout': () => [200, {ok: true}],
    'GET /api/me': () => [200, {user: state.user, policy: {screenshotsEnabled: true, screenshotIntervalSeconds: 600, screenshotBlur: false, activityTrackingEnabled: false, retentionDays: 30, requireProject: false, screenshotVisibility: 'employee_manager', consentVersion: 1}, needsConsent: true}],
    'GET /api/projects': () => [200, {projects: [{id: 'p1', name: 'Website', client: 'Acme', active: true, tasks: [{id: 't1', name: 'Build', active: true}, {id: 't2', name: 'Old', active: false}]}, {id: 'p2', name: 'Retired', active: false, tasks: []}]}],
    'POST /api/me/consent': () => [200, {ok: true}],
    'POST /api/time-entries/sync': () => [200, {id: 'e1'}],
    'POST /api/time-entries': () => [201, {id: 'manual-e1'}],
    'GET /api/time-entries': () => [200, {entries: []}],
    'POST /api/activity-slices/sync': () => [201, {created: true}],
    'POST /api/screenshots': () => [201, {id: 's1'}],
    'PUT /api/screenshots/s1/thumb': () => [200, {ok: true}],
    'POST /api/heartbeat': () => [200, {ok: true, policy: null}],
  };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); const key = `${opts.method} ${u.pathname}`;
    let body; if (typeof opts.body === 'string') body = JSON.parse(opts.body); else if (opts.body) body = opts.body;
    calls.push({key, url, query: Object.fromEntries(u.searchParams), headers: opts.headers, body, opts});
    if (down) throw new TypeError('fetch failed');
    const handler = routes.get(key) ?? defaults[key] ?? (() => [404, {error: 'Not found.'}]);
    const [status, json] = await handler({body, query: Object.fromEntries(u.searchParams), headers: opts.headers});
    return respond(status, json);
  };
  return {fetchImpl, calls, state, clock, set: (k, fn) => routes.set(k, fn), reset: k => routes.delete(k), setDown: v => { down = v; }, of: key => calls.filter(c => c.key === key)};
}
function fakeTimers() {
  const pending = new Map(); let id = 0;
  return {
    setTimeout: (fn, ms) => { pending.set(++id, {fn, ms}); return id; }, clearTimeout: i => pending.delete(i),
    setInterval: fn => { pending.set(++id, {fn, ms: -1}); return id; }, clearInterval: i => pending.delete(i),
    pending, delays: () => [...pending.values()].map(p => p.ms),
    async runAll() { for (const [i, t] of [...pending]) if (t.ms >= 0) { pending.delete(i); await t.fn(); } for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r)); }, // let the flushes the timers started finish
  };
}
const secrets = {available: () => true, encrypt: s => `enc:${Buffer.from(s).toString('base64')}`, decrypt: s => Buffer.from(s.slice(4), 'base64').toString()};
function make({server = fakeServer(), files = new Map(), withSecrets = true, dir} = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ufs-sync-'));
  const timers = fakeTimers(); const changes = [];
  const client = new SyncClient({dir, fetchImpl: server.fetchImpl, now: () => server.clock.now, secrets: withSecrets ? secrets : {available: () => false}, readCapture: id => files.get(id) ?? null, makeThumb: () => ({bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), type: 'image/jpeg'}), deviceName: 'TEST-PC', onChange: s => changes.push(s), timers});
  return {client, server, files, timers, dir, changes};
}
const signIn = async ctx => { await ctx.client.login({serverUrl: 'http://127.0.0.1:4300', email: 'ed@x.test', password: 'right-pass-1'}); return ctx; };
const session = (over = {}) => ({id: 'sess-0000-0001', mode: 'company', task: 'Work', projectId: 'p1', taskId: null, startedAt: new Date(T0 - 3600_000).toISOString(), endedAt: null, trackedMs: 600_000, idleMs: 30_000, ...over});

test('server address rules: https required except localhost; no credentials; origin only', () => {
  assert.equal(normalizeServerUrl('https://tracker.example.com/some/path?x=1'), 'https://tracker.example.com');
  assert.equal(normalizeServerUrl(' http://localhost:4300 '), 'http://localhost:4300');
  assert.equal(normalizeServerUrl('http://127.0.0.1:4300'), 'http://127.0.0.1:4300');
  assert.equal(normalizeServerUrl('tracker.example.com'), 'https://tracker.example.com');          // bare host -> https
  assert.equal(normalizeServerUrl('tracker.example.com:8443/path'), 'https://tracker.example.com:8443');
  assert.equal(normalizeServerUrl('localhost:4300'), 'http://localhost:4300');                      // bare localhost -> http
  assert.equal(normalizeServerUrl('127.0.0.1:4300'), 'http://127.0.0.1:4300');
  for (const bad of ['http://tracker.example.com', 'ftp://x.example', '', '   ', null, 'user:pw@x.example', 'file:///etc/passwd', 'http://localhost.evil.com', 'https://', 'a b c', 'https://user:pw@x.example', 'javascript:alert(1)', 'http://localhost.evil.com'])
    assert.throws(() => normalizeServerUrl(bad), /server address|Enter a valid|https/, String(bad));
});

test('login signs in as a device, loads policy and active projects, and never stores the password', async () => {
  const ctx = await signIn(make());
  const login = ctx.server.of('POST /api/auth/login')[0];
  assert.deepEqual(login.body, {email: 'ed@x.test', password: 'right-pass-1', kind: 'device', deviceName: 'TEST-PC'});
  assert.equal(login.headers.Authorization, undefined);           // no token sent on login
  assert.equal(login.opts.redirect, 'error');                      // never follow a redirect with credentials
  const s = ctx.client.snapshot();
  assert.equal(s.signedIn, true); assert.equal(s.serverHost, '127.0.0.1:4300'); assert.equal(s.user.name, 'Ed Employee');
  assert.equal(s.policy.screenshotIntervalSeconds, 600); assert.equal(s.needsConsent, true);
  assert.deepEqual(s.projects.map(p => p.name), ['Website']);                  // inactive project hidden
  assert.deepEqual(s.projects[0].tasks.map(t => t.name), ['Build']);           // inactive task hidden
  const onDisk = fs.readFileSync(path.join(ctx.dir, 'sync-config.json'), 'utf8');
  assert.ok(!onDisk.includes('right-pass-1')); assert.ok(!onDisk.includes(ctx.server.state.token)); assert.ok(onDisk.includes('enc:'));
  for (const call of ctx.server.calls.filter(c => c.key !== 'POST /api/auth/login')) assert.equal(call.headers.Authorization, `Bearer ${ctx.server.state.token}`);
});

test('login errors: wrong password, unreachable server, bad address, missing fields, forced password change', async () => {
  let ctx = make();
  await assert.rejects(ctx.client.login({serverUrl: 'http://localhost:4300', email: 'ed@x.test', password: 'nope'}), /Incorrect email or password/);
  assert.equal(ctx.client.snapshot().signedIn, false); assert.equal(ctx.client.serverUrl, null);
  ctx.server.setDown(true);
  await assert.rejects(ctx.client.login({serverUrl: 'http://localhost:4300', email: 'ed@x.test', password: 'right-pass-1'}), /Could not reach the server/);
  await assert.rejects(ctx.client.login({serverUrl: 'http://evil.example', email: 'a@b.co', password: 'x'}), /https/);
  await assert.rejects(ctx.client.login({serverUrl: 'http://localhost:4300', email: '', password: 'x'}), /email and password/);
  ctx = make(); ctx.server.state.user.mustChangePassword = true;
  await assert.rejects(ctx.client.login({serverUrl: 'http://localhost:4300', email: 'ed@x.test', password: 'right-pass-1'}), /new password/);
  assert.equal(ctx.client.snapshot().signedIn, false);
  assert.equal(ctx.server.of('POST /api/auth/logout').length, 1);   // the half-open session is closed again
});

test('manual time is stored offline, counted as unsent, and retried idempotently after sign-in resumes', async () => {
  const first = await signIn(make()); await first.client.acceptConsent(); first.server.setDown(true);
  const input = {projectId: 'p1', taskId: 't1', taskLabel: 'Prepare weekly report', startAt: new Date(T0 - 2 * 3600_000).toISOString(), endAt: new Date(T0 - 3600_000).toISOString(), note: 'Synthetic offline entry'};
  const queued = await first.client.addManualEntry(input);
  assert.equal(queued.queued, true); assert.equal(first.client.snapshot().pending.manual, 1);
  const disk = JSON.parse(fs.readFileSync(path.join(first.dir, 'sync-queue.json'), 'utf8'));
  assert.equal(disk.manual.length, 1); assert.equal(disk.manual[0].payload.taskLabel, input.taskLabel);
  assert.ok(!JSON.stringify(disk).includes('right-pass-1'));
  await assert.rejects(first.client.logout(), e => e.pending === 1);

  const restarted = make({dir: first.dir, server: first.server}); restarted.client.init();
  // init() restores the encrypted device token, so the restarted client is already signed in.
  first.server.setDown(false); assert.equal(restarted.client.snapshot().signedIn, true); await restarted.client.flush();
  const call = restarted.server.of('POST /api/time-entries')[0];
  assert.equal(call.body.clientId, queued.clientId); assert.equal(call.body.projectId, 'p1'); assert.equal(call.body.note, input.note);
  assert.equal(restarted.client.snapshot().pending.manual, 0);
  assert.equal(restarted.client.snapshot().failed, 0);
  const entries = await restarted.client.getMyManualEntries(); assert.deepEqual(entries, []);
});

test('manual time is rejected locally for empty work descriptions and unassigned project/task choices', async () => {
  const ctx = await signIn(make()); await ctx.client.acceptConsent();
  const valid = {taskLabel: 'Synthetic work', startAt: new Date(T0 - 2 * 3600_000).toISOString(), endAt: new Date(T0 - 3600_000).toISOString()};
  await assert.rejects(ctx.client.addManualEntry({...valid, taskLabel: '   '}), /Describe the work/);
  await assert.rejects(ctx.client.addManualEntry({...valid, projectId: 'not-assigned'}), /Choose a project/);
  await assert.rejects(ctx.client.addManualEntry({...valid, projectId: 'p1', taskId: 't2'}), /Choose a task/);
  ctx.client.policy.requireProject = true;
  await assert.rejects(ctx.client.addManualEntry(valid), /requires choosing a project/);
  assert.equal(ctx.client.snapshot().pending.manual, 0);
  assert.equal(ctx.server.of('POST /api/time-entries').length, 0);
});

test('manual time retries the same client id when the server accepted a request but its reply was lost', async () => {
  const ctx = await signIn(make()); await ctx.client.acceptConsent();
  const accepted = new Set(); let attempts = 0;
  ctx.server.set('POST /api/time-entries', ({body}) => {
    attempts++; accepted.add(body.clientId);
    if (attempts === 1) throw new TypeError('response lost after server commit');
    return [200, {id: 'manual-e1', duplicate: true}];
  });
  const input = {taskLabel: 'Synthetic retry test', startAt: new Date(T0 - 2 * 3600_000).toISOString(), endAt: new Date(T0 - 3600_000).toISOString()};
  const first = await ctx.client.addManualEntry(input);
  assert.equal(first.queued, true); assert.equal(ctx.client.snapshot().pending.manual, 1);
  await ctx.client.flush();
  const calls = ctx.server.of('POST /api/time-entries');
  assert.equal(attempts, 2); assert.equal(calls[0].body.clientId, calls[1].body.clientId);
  assert.equal(accepted.size, 1); assert.equal(ctx.client.snapshot().pending.manual, 0);
});

test('saved sign-in survives a restart (offline until first contact); without OS encryption the user must sign in again', async () => {
  const first = await signIn(make());
  const again = new SyncClient({dir: first.dir, fetchImpl: first.server.fetchImpl, now: () => T0, secrets, readCapture: () => null});
  again.init();
  assert.equal(again.signedIn, true); assert.equal(again.snapshot().status, 'offline'); assert.equal(again.snapshot().policy.screenshotIntervalSeconds, 600);
  const noEnc = make({dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ufs-sync-')), withSecrets: false}); await signIn(noEnc);
  assert.equal(JSON.parse(fs.readFileSync(path.join(noEnc.dir, 'sync-config.json'), 'utf8')).tokenEnc, null);
  const restarted = new SyncClient({dir: noEnc.dir, fetchImpl: noEnc.server.fetchImpl, now: () => T0, secrets: {available: () => false}, readCapture: () => null});
  restarted.init(); assert.equal(restarted.signedIn, false); assert.equal(restarted.snapshot().sessionExpired, true); assert.match(restarted.snapshot().lastError, /sign in again/);
});

test('consent is sent for the policy version and clears the flag', async () => {
  const ctx = await signIn(make());
  await ctx.client.acceptConsent();
  assert.deepEqual(ctx.server.of('POST /api/me/consent')[0].body, {version: 1});
  assert.equal(ctx.client.snapshot().needsConsent, false);
  ctx.server.set('POST /api/me/consent', () => [400, {error: 'Please accept the current monitoring notice.'}]);
  await assert.rejects(ctx.client.acceptConsent(), /monitoring notice/);
});

test('time entries: only company sessions are queued, latest state wins, unchanged state is not resent, finished entries are removed', async () => {
  const ctx = await signIn(make()); const c = ctx.client;
  c.enqueueEntry(session({mode: 'manual'})); assert.equal(c.snapshot().pending.time, 0);
  c.enqueueEntry(session({trackedMs: 60_000})); c.enqueueEntry(session({trackedMs: 120_000})); c.enqueueEntry(session({trackedMs: 180_000}));
  assert.equal(c.snapshot().pending.time, 1);
  await c.flush();
  const sent = ctx.server.of('POST /api/time-entries/sync'); assert.equal(sent.length, 1);
  assert.equal(sent[0].body.trackedMs, 180_000); assert.equal(sent[0].body.clientId, 'sess-0000-0001'); assert.equal(sent[0].body.projectId, 'p1'); assert.equal(sent[0].body.endAt, null);
  await c.flush(); assert.equal(ctx.server.of('POST /api/time-entries/sync').length, 1);   // nothing changed -> nothing sent
  assert.equal(c.snapshot().pending.time, 0);                                                // running entry is uploaded: nothing is "waiting"
  c.enqueueEntry(session({trackedMs: 200_000})); assert.equal(c.snapshot().pending.time, 1); // a newer state is waiting again
  await c.flush(); assert.equal(c.snapshot().pending.time, 0);
  assert.equal(ctx.server.of('POST /api/time-entries/sync').length, 2);
  c.enqueueEntry(session({trackedMs: 240_000, endedAt: new Date(T0).toISOString()}));
  await c.flush();
  assert.equal(ctx.server.of('POST /api/time-entries/sync').length, 3);
  assert.equal(ctx.server.of('POST /api/time-entries/sync')[2].body.endAt, new Date(T0).toISOString());
  assert.equal(c.snapshot().pending.time, 0);
});

test('tracked time is clamped to the wall-clock duration so the server never rejects an honest session', async () => {
  const ctx = await signIn(make());
  ctx.client.enqueueEntry(session({startedAt: new Date(T0 - 10 * 60_000).toISOString(), trackedMs: 3 * 3600_000, idleMs: 4 * 3600_000}));
  await ctx.client.flush();
  const body = ctx.server.of('POST /api/time-entries/sync')[0].body;
  assert.equal(body.trackedMs, 10 * 60_000 + 30_000); assert.ok(body.idleMs <= body.trackedMs);
});

test('activity queue uploads only bounded minute aggregates after the company time entry', async () => {
  const ctx = await signIn(make());
  const slice = {startedAt: '2026-10-22T08:00:00.000Z', durationSeconds: 60, keyboardCount: 120, mouseCount: 8, activeSeconds: 42};
  const item = session({activityTrackingEnabled: true, activitySlices: [slice]});
  ctx.client.enqueueEntry(item); ctx.client.enqueueEntry(item);
  assert.equal(ctx.client.snapshot().pending.activity, 1);
  await ctx.client.flush();
  const order = ctx.server.calls.filter(c => ['POST /api/time-entries/sync', 'POST /api/activity-slices/sync'].includes(c.key)).map(c => c.key);
  assert.deepEqual(order, ['POST /api/time-entries/sync', 'POST /api/activity-slices/sync']);
  const payload = ctx.server.of('POST /api/time-entries/sync')[0].body;
  assert.equal(payload.activityTrackingEnabled, true);
  const sent = ctx.server.of('POST /api/activity-slices/sync')[0].body;
  assert.deepEqual(sent, {entryClientId: item.id, slice});
  assert.deepEqual(Object.keys(sent.slice).sort(), ['activeSeconds', 'durationSeconds', 'keyboardCount', 'mouseCount', 'startedAt']);
  assert.equal(ctx.client.snapshot().pending.activity, 0);
});

test('screenshots upload in order as raw PNG with metadata, then a thumbnail; the queue empties', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-1', PNG); ctx.files.set('cap-2', PNG);
  ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z', entryClientId: 'sess-0000-0001'});
  ctx.client.enqueueScreenshot({captureId: 'cap-2', takenAt: '2026-10-22T08:05:00.000Z', entryClientId: 'sess-0000-0001'});
  assert.equal(ctx.client.snapshot().pending.screenshots, 2);
  await ctx.client.flush();
  const ups = ctx.server.of('POST /api/screenshots');
  assert.deepEqual(ups.map(u => u.query.clientId), ['cap-1', 'cap-2']);
  assert.equal(ups[0].query.takenAt, '2026-10-22T08:00:00.000Z'); assert.equal(ups[0].query.entryClientId, 'sess-0000-0001');
  assert.equal(ups[0].headers['Content-Type'], 'image/png'); assert.ok(Buffer.from(ups[0].body).equals(PNG));
  assert.equal(ctx.server.of('PUT /api/screenshots/s1/thumb').length, 2);
  assert.equal(ctx.client.snapshot().pending.screenshots, 0); assert.ok(ctx.client.snapshot().lastSyncAt);
});

test('offline: nothing is lost, status shows offline, a retry is scheduled with growing delay, and everything uploads when back online', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-1', PNG);
  ctx.server.setDown(true);
  ctx.client.enqueueEntry(session({trackedMs: 300_000})); ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z', entryClientId: 'sess-0000-0001'});
  await ctx.client.flush();
  assert.equal(ctx.client.snapshot().status, 'offline'); assert.equal(ctx.client.snapshot().pending.time, 1); assert.equal(ctx.client.snapshot().pending.screenshots, 1);
  const firstDelay = Math.max(...ctx.timers.delays()); assert.ok(firstDelay >= 4000);
  await ctx.timers.runAll();                       // retry fires, still offline
  assert.ok(Math.max(...ctx.timers.delays()) > firstDelay, 'backoff grows');
  // queue persisted to disk: a restarted app still has it
  const reopened = new SyncClient({dir: ctx.dir, fetchImpl: ctx.server.fetchImpl, now: () => T0, secrets, readCapture: id => ctx.files.get(id), timers: fakeTimers()}); reopened.init();
  assert.equal(reopened.snapshot().pending.screenshots, 1); assert.equal(reopened.snapshot().pending.time, 1);
  ctx.server.setDown(false); await ctx.timers.runAll();
  const s = ctx.client.snapshot(); assert.equal(s.status, 'online'); assert.equal(s.pending.screenshots, 0);
  assert.equal(ctx.server.of('POST /api/screenshots').filter(c => c.status !== 0).length >= 1, true);
  assert.equal(s.failed, 0);
});

test('a shutdown flush with an expired deadline leaves the durable queue untouched and makes no request', async () => {
  const ctx = await signIn(make()); ctx.client.enqueueEntry(session()); ctx.client.stop();
  const before = ctx.server.calls.length;
  const result = await ctx.client.flush({deadlineAt: Date.now() - 1});
  assert.equal(result.timedOut, true);
  assert.equal(ctx.server.calls.length, before);
  assert.equal(ctx.client.snapshot().pending.time, 1);
  assert.equal(ctx.client.snapshot().failed, 0);
  assert.equal(ctx.timers.pending.size, 0, 'shutdown does not leave a retry timer behind');
});

test('a timed-out shutdown screenshot upload stays queued without retrying after process exit', async () => {
  const ctx = await signIn(make()); ctx.files.set('shutdown-shot', PNG);
  ctx.client.enqueueScreenshot({captureId: 'shutdown-shot', takenAt: '2026-10-22T08:00:00.000Z'}); ctx.client.stop();
  ctx.client.fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(new Error('aborted'));
    else options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
  });
  await ctx.client.flush({deadlineAt: Date.now() + 30});
  assert.equal(ctx.client.snapshot().pending.screenshots, 1);
  assert.equal(ctx.client.snapshot().failed, 0);
  assert.equal(ctx.timers.pending.size, 0, 'bounded shutdown flush does not schedule retries');
});

test('an in-flight request that fails after shutdown starts cannot schedule a retry', async () => {
  const ctx = await signIn(make());
  ctx.client.queue.entries[session().id] = {payload: session(), key: 'queued-at-shutdown', sentKey: null}; ctx.client._saveQueue();
  let rejectFetch;
  ctx.client.fetchImpl = () => new Promise((_resolve, reject) => {rejectFetch = reject;});
  const flushing = ctx.client.flush();
  await new Promise(resolve => setImmediate(resolve));
  ctx.client.shutdown(); rejectFetch(new Error('offline during shutdown'));
  await flushing;
  assert.equal(ctx.client.snapshot().pending.time, 1);
  assert.equal(ctx.timers.pending.size, 0, 'a late network failure does not reschedule retries');
});

test('server errors (5xx) keep items for retry; permanent rejections (4xx) are set aside, not retried forever', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-1', PNG); ctx.files.set('cap-2', PNG);
  ctx.server.set('POST /api/screenshots', () => [503, {error: 'Unavailable'}]);
  ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z'});
  await ctx.client.flush();
  assert.equal(ctx.client.snapshot().pending.screenshots, 1); assert.equal(ctx.client.snapshot().failed, 0); assert.match(ctx.client.snapshot().lastError, /503/);
  ctx.server.set('POST /api/screenshots', ({query}) => query.clientId === 'cap-1' ? [415, {error: 'Invalid PNG image.'}] : [201, {id: 's1'}]);
  ctx.client.enqueueScreenshot({captureId: 'cap-2', takenAt: '2026-10-22T08:05:00.000Z'});
  await ctx.client.flush();
  const s = ctx.client.snapshot(); assert.equal(s.pending.screenshots, 0); assert.equal(s.failed, 1);
  assert.equal(s.failedItems[0].id, 'cap-1'); assert.match(s.failedItems[0].reason, /Invalid PNG/);
  ctx.server.set('POST /api/time-entries/sync', () => [422, {error: 'trackedMs exceeds the elapsed time.'}]);
  ctx.client.enqueueEntry(session()); await ctx.client.flush();
  assert.equal(ctx.client.snapshot().pending.time, 0); assert.equal(ctx.client.snapshot().failed, 2);
});

test('a missing local file is set aside and does not block later screenshots', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-2', PNG);
  ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z'}); ctx.client.enqueueScreenshot({captureId: 'cap-2', takenAt: '2026-10-22T08:05:00.000Z'});
  await ctx.client.flush();
  assert.equal(ctx.client.snapshot().failedItems[0].reason, 'Local file is missing.');
  assert.deepEqual(ctx.server.of('POST /api/screenshots').map(c => c.query.clientId), ['cap-2']);
});

test('401 ends the session, keeps the queue, and stops sending', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-1', PNG);
  ctx.server.set('POST /api/screenshots', () => [401, {error: 'Session expired. Sign in again.'}]);
  ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z'});
  await ctx.client.flush();
  const s = ctx.client.snapshot(); assert.equal(s.signedIn, false); assert.equal(s.sessionExpired, true); assert.equal(s.pending.screenshots, 1); assert.match(s.lastError, /sign in again/i);
  ctx.files.set('cap-2', PNG);
  ctx.client.enqueueEntry(session({trackedMs: 720_000}));
  ctx.client.enqueueScreenshot({captureId: 'cap-2', takenAt: '2026-10-22T08:05:00.000Z'});
  assert.deepEqual(ctx.client.snapshot().pending, {time: 1, manual: 0, screenshots: 2, activity: 0});
  const calls = ctx.server.calls.length; await ctx.client.flush(); assert.equal(ctx.server.calls.length, calls, 'expired auth never retries or discards queued data');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'sync-config.json'), 'utf8')).tokenEnc, null);
  ctx.server.reset('POST /api/screenshots');
  await ctx.client.login({serverUrl: 'http://127.0.0.1:4300', email: 'ed@x.test', password: 'right-pass-1'});
  assert.equal(ctx.client.snapshot().sessionExpired, false);
  assert.deepEqual(ctx.client.snapshot().pending, {time: 0, manual: 0, screenshots: 0, activity: 0}, 'same-account sign-in resumes and drains uploads');
  assert.equal(ctx.server.of('POST /api/screenshots').length, 3, 'expired and new screenshots both upload once after reauthentication');
});

test('sign-out refuses while uploads are pending unless forced; forced sign-out revokes the device token and clears the queue', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-1', PNG); ctx.server.setDown(true);
  ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z'}); await ctx.client.flush();
  await assert.rejects(ctx.client.logout(), e => e.pending === 1 && /not been uploaded/.test(e.message));
  assert.equal(ctx.client.signedIn, true);
  ctx.server.setDown(false);
  const s = await ctx.client.logout({force: true});
  assert.equal(s.signedIn, false); assert.equal(s.pending.screenshots, 0); assert.equal(ctx.server.of('POST /api/auth/logout').length, 1);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'sync-config.json')), false);
  ctx.client.enqueueScreenshot({captureId: 'x', takenAt: '2026-10-22T08:00:00.000Z'}); assert.equal(ctx.client.snapshot().pending.screenshots, 0);
});

test('a different person signing in on the same computer never uploads the previous person\'s queue', async () => {
  const ctx = await signIn(make()); ctx.files.set('cap-1', PNG); ctx.server.setDown(true);
  ctx.client.enqueueScreenshot({captureId: 'cap-1', takenAt: '2026-10-22T08:00:00.000Z'}); await ctx.client.flush();
  ctx.client.token = null; ctx.client.status = 'signed-out'; ctx.server.setDown(false);       // e.g. token expired
  ctx.server.state.user = {...ctx.server.state.user, id: 'u2', name: 'Someone Else'};
  await ctx.client.login({serverUrl: 'http://localhost:4300', email: 'else@x.test', password: 'right-pass-1'});
  const uploadsBefore = ctx.server.of('POST /api/screenshots').length;
  assert.equal(ctx.client.snapshot().pending.screenshots, 0);
  await ctx.client.flush(); assert.equal(ctx.server.of('POST /api/screenshots').length, uploadsBefore);   // nothing of the old queue was sent
});

test('heartbeat is throttled, reports status changes immediately, adopts the latest policy, and handles 401', async () => {
  const ctx = await signIn(make());
  ctx.server.set('POST /api/heartbeat', () => [200, {ok: true, policy: {screenshotsEnabled: false, screenshotIntervalSeconds: 900, screenshotBlur: true, idleTimeoutSeconds: 180, retentionDays: 7, requireProject: true, screenshotVisibility: 'employee_only', consentVersion: 2}}]);
  await ctx.client.heartbeat({status: 'tracking', projectId: 'p1', taskLabel: 'Work', trackedMs: 1000});
  await ctx.client.heartbeat({status: 'tracking', projectId: 'p1', taskLabel: 'Work', trackedMs: 2000});   // same, within 30s
  assert.equal(ctx.server.of('POST /api/heartbeat').length, 1);
  await ctx.client.heartbeat({status: 'paused', projectId: 'p1', taskLabel: 'Work'});                       // changed
  assert.equal(ctx.server.of('POST /api/heartbeat').length, 2);
  assert.equal(ctx.client.snapshot().policy.screenshotIntervalSeconds, 900); assert.equal(ctx.client.snapshot().policy.screenshotBlur, true); assert.equal(ctx.client.snapshot().policy.idleTimeoutSeconds, 180);
  ctx.server.clock.now += 31_000; ctx.server.set('POST /api/heartbeat', () => [401, {error: 'x'}]);
  await ctx.client.heartbeat({status: 'paused', projectId: 'p1', taskLabel: 'Work'});
  assert.equal(ctx.client.signedIn, false);
  const quiet = make(); await quiet.client.heartbeat({status: 'tracking'}); assert.equal(quiet.server.calls.length, 0); // signed out: nothing sent
});

test('offline heartbeat failures are silent and do not raise errors', async () => {
  const ctx = await signIn(make()); ctx.server.setDown(true);
  await ctx.client.heartbeat({status: 'tracking'});
  assert.equal(ctx.client.signedIn, true);
});

test('refresh while offline keeps cached policy and projects and reports offline', async () => {
  const ctx = await signIn(make()); ctx.server.setDown(true);
  await ctx.client.refresh();
  const s = ctx.client.snapshot(); assert.equal(s.status, 'offline'); assert.equal(s.policy.screenshotIntervalSeconds, 600); assert.equal(s.projects.length, 1);
});

test('queue and config files are private (0600 where supported) and contain no password', async () => {
  const ctx = await signIn(make()); ctx.client.enqueueEntry(session());
  for (const f of ['sync-config.json', 'sync-queue.json']) {
    const file = path.join(ctx.dir, f); assert.ok(fs.existsSync(file));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('right-pass-1'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

// ---------- WebP uploads, saved thumbnails and image policy ----------
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(30, 5)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

test('a WebP screenshot is uploaded as image/webp with the thumbnail that was saved with it', async () => {
  const ctx = await signIn(make()); let thumbCalls = 0; ctx.client.makeThumb = () => { thumbCalls++; return null; };
  ctx.files.set('w-1', {bytes: WEBP, type: 'image/webp', thumb: JPEG});
  ctx.client.enqueueScreenshot({captureId: 'w-1', takenAt: '2026-10-22T08:00:00.000Z', entryClientId: 'sess-0000-0001'});
  await ctx.client.flush();
  const up = ctx.server.of('POST /api/screenshots')[0];
  assert.equal(up.headers['Content-Type'], 'image/webp'); assert.ok(Buffer.from(up.body).equals(WEBP));
  const thumb = ctx.server.of('PUT /api/screenshots/s1/thumb')[0];
  assert.equal(thumb.headers['Content-Type'], 'image/jpeg'); assert.ok(Buffer.from(thumb.body).equals(JPEG));
  assert.equal(thumbCalls, 0, 'the saved thumbnail is used; nothing is decoded or resized again');
  assert.equal(ctx.client.snapshot().pending.screenshots, 0);
});

test('a WebP without a saved thumbnail uploads without one (WebP cannot be decoded in the main process)', async () => {
  const ctx = await signIn(make()); let thumbCalls = 0; ctx.client.makeThumb = () => { thumbCalls++; return {bytes: JPEG, type: 'image/jpeg'}; };
  ctx.files.set('w-2', {bytes: WEBP, type: 'image/webp', thumb: null});
  ctx.client.enqueueScreenshot({captureId: 'w-2', takenAt: '2026-10-22T08:00:00.000Z'});
  await ctx.client.flush();
  assert.equal(ctx.server.of('POST /api/screenshots').length, 1); assert.equal(ctx.server.of('PUT /api/screenshots/s1/thumb').length, 0); assert.equal(thumbCalls, 0);
});

test('an older PNG without a saved thumbnail still gets one generated on demand, and a saved thumbnail wins over it', async () => {
  const ctx = await signIn(make());
  ctx.files.set('p-1', {bytes: PNG, type: 'image/png', thumb: null}); ctx.files.set('p-2', {bytes: PNG, type: 'image/png', thumb: Buffer.from([0xff, 0xd8, 0xff, 7])});
  ctx.client.enqueueScreenshot({captureId: 'p-1', takenAt: '2026-10-22T08:00:00.000Z'}); ctx.client.enqueueScreenshot({captureId: 'p-2', takenAt: '2026-10-22T08:05:00.000Z'});
  await ctx.client.flush();
  const thumbs = ctx.server.of('PUT /api/screenshots/s1/thumb');
  assert.equal(thumbs.length, 2); assert.deepEqual([...Buffer.from(thumbs[0].body)], [0xff, 0xd8, 0xff, 1]); assert.deepEqual([...Buffer.from(thumbs[1].body)], [0xff, 0xd8, 0xff, 7]);
});

test('a WebP the server rejects is set aside with the reason and does not block the next screenshot', async () => {
  const ctx = await signIn(make()); ctx.files.set('w-bad', {bytes: WEBP, type: 'image/webp', thumb: null}); ctx.files.set('p-ok', PNG);
  ctx.server.set('POST /api/screenshots', ({query}) => query.clientId === 'w-bad' ? [415, {error: 'Image dimensions are out of bounds.'}] : [201, {id: 's1'}]);
  ctx.client.enqueueScreenshot({captureId: 'w-bad', takenAt: '2026-10-22T08:00:00.000Z'}); ctx.client.enqueueScreenshot({captureId: 'p-ok', takenAt: '2026-10-22T08:05:00.000Z'});
  await ctx.client.flush();
  const s = ctx.client.snapshot(); assert.equal(s.failed, 1); assert.match(s.failedItems[0].reason, /out of bounds/); assert.equal(s.pending.screenshots, 0);
});

test('the snapshot exposes the image policy, with safe fallbacks for unexpected values', async () => {
  const ctx = await signIn(make());
  assert.deepEqual([ctx.client.snapshot().policy.imageFormat, ctx.client.snapshot().policy.imageQuality], ['webp', 80]);
  assert.deepEqual([ctx.client.snapshot().policy.breakReminderMinutes, ctx.client.snapshot().policy.workScheduleEnabled, ctx.client.snapshot().policy.workDays], [60, false, [1, 2, 3, 4, 5]]);
  assert.deepEqual([ctx.client.snapshot().policy.workTimeZone,ctx.client.snapshot().policy.lateGraceMinutes],['UTC',0]);
  const policy = {screenshotsEnabled: true, screenshotIntervalSeconds: 600, screenshotBlur: false, retentionDays: 90, requireProject: false, screenshotVisibility: 'employee_manager', consentVersion: 1};
  ctx.server.set('GET /api/me', () => [200, {user: ctx.server.state.user, policy: {...policy, imageFormat: 'png', imageQuality: 55}, needsConsent: false}]); await ctx.client.refresh();
  assert.deepEqual([ctx.client.snapshot().policy.imageFormat, ctx.client.snapshot().policy.imageQuality, ctx.client.snapshot().policy.retentionDays], ['png', 55, 90]);
  ctx.server.set('GET /api/me', () => [200, {user: ctx.server.state.user, policy: {...policy, imageFormat: 'gif', imageQuality: 'high'}, needsConsent: false}]); await ctx.client.refresh();
  assert.deepEqual([ctx.client.snapshot().policy.imageFormat, ctx.client.snapshot().policy.imageQuality], ['webp', 80]);
  ctx.server.set('GET /api/me', () => [200, {user: ctx.server.state.user, policy: {...policy, breakReminderMinutes: -1, workScheduleEnabled: true, workDays: [9], workTimeZone:'Mars/Olympus', lateGraceMinutes:999, workStartLocal: 'late', workEndLocal: 'bad'}, needsConsent: false}]); await ctx.client.refresh();
  assert.deepEqual([ctx.client.snapshot().policy.breakReminderMinutes, ctx.client.snapshot().policy.workDays, ctx.client.snapshot().policy.workStartLocal], [60, [1, 2, 3, 4, 5], '09:00']);
  assert.deepEqual([ctx.client.snapshot().policy.workTimeZone,ctx.client.snapshot().policy.lateGraceMinutes],['UTC',0]);
});

// ---------- authenticator code (TOTP) for admin / HR accounts ----------
test('login sends the authenticator code only when given, and never stores it', async () => {
  const ctx = make(); await ctx.client.login({serverUrl: 'http://127.0.0.1:4300', email: 'ed@x.test', password: 'right-pass-1'});
  assert.equal('totp' in ctx.server.of('POST /api/auth/login')[0].body, false, 'no code is sent unless the user entered one');
  const second = make();
  await second.client.login({serverUrl: 'http://127.0.0.1:4300', email: 'ed@x.test', password: 'right-pass-1', totp: ' 123456 '});
  assert.equal(second.server.of('POST /api/auth/login')[0].body.totp, '123456');
  for (const f of ['sync-config.json', 'sync-queue.json']) { const file = path.join(second.dir, f); if (fs.existsSync(file)) assert.ok(!fs.readFileSync(file, 'utf8').includes('123456')); }
});

test('the server asking for a code is flagged so the app can prompt for it; wrong codes and locked accounts are plain errors', async () => {
  const ctx = make();
  ctx.server.set('POST /api/auth/login', ({body}) => body.totp === '654321' ? [200, {token: ctx.server.state.token, user: ctx.server.state.user}] : body.totp ? [401, {error: 'Incorrect code. Check your authenticator app and try again.'}] : [401, {error: 'Enter the 6-digit code from your authenticator app.', mfaRequired: true}]);
  const base = {serverUrl: 'http://127.0.0.1:4300', email: 'hr@x.test', password: 'right-pass-1'};
  await assert.rejects(ctx.client.login(base), e => e.mfaRequired === true && /6-digit code/.test(e.message));
  assert.equal(ctx.client.snapshot().signedIn, false); assert.equal(ctx.client.serverUrl, null, 'nothing is remembered from a half-finished sign-in');
  await assert.rejects(ctx.client.login({...base, totp: '000000'}), e => e.mfaRequired === false && /Incorrect code/.test(e.message));
  const s = await ctx.client.login({...base, totp: '654321'}); assert.equal(s.signedIn, true);
  const locked = make(); locked.server.set('POST /api/auth/login', () => [429, {error: 'Too many failed attempts. Try again in a few minutes.'}]);
  await assert.rejects(locked.client.login({...base, totp: '111111'}), e => e.mfaRequired === false && /Too many/.test(e.message));
});

test('a malformed code is refused locally without contacting the server', async () => {
  const ctx = make();
  for (const totp of ['abc123', '12345', '123456789', '12 34 56', '1234567a']) await assert.rejects(ctx.client.login({serverUrl: 'http://127.0.0.1:4300', email: 'a@x.test', password: 'x', totp}), /6-digit code/, totp);
  assert.equal(ctx.server.calls.length, 0);
  for (const empty of [undefined, null, '']) { const c = make(); await c.client.login({serverUrl: 'http://127.0.0.1:4300', email: 'ed@x.test', password: 'right-pass-1', totp: empty}); assert.equal(c.client.signedIn, true); }
});
