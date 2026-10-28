import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';
import { localDateTimeToMs } from '../src/timezone.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['admin', 'mia', 'max', 'ed', 'eve', 'finn']) tok[k] = await h.login(`${k}@test.example`);
});
after(async () => { await h.stop(); });

test('policy inheritance: defaults < org < team < user, and clearing falls back', async () => {
  const eff = async (k: string) => (await h.call('GET', '/api/me', { token: tok[k] })).json.policy;
  assert.equal((await eff('ed')).screenshotIntervalSeconds, 300);
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: { screenshotIntervalSeconds: 600, retentionDays: 14 } });
  assert.equal((await eff('ed')).screenshotIntervalSeconds, 600);
  await h.call('PUT', '/api/policy/team/team-1', { token: tok.admin, body: { screenshotIntervalSeconds: 120 } });
  assert.equal((await eff('ed')).screenshotIntervalSeconds, 120);
  assert.equal((await eff('ed')).retentionDays, 14);          // still inherited from org
  assert.equal((await eff('finn')).screenshotIntervalSeconds, 600); // other team unaffected
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: { screenshotIntervalSeconds: 60, screenshotBlur: true } });
  const ed = await eff('ed');
  assert.equal(ed.screenshotIntervalSeconds, 60); assert.equal(ed.screenshotBlur, true); assert.equal((await eff('eve')).screenshotBlur, false);
  const view = await h.call('GET', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin });
  assert.deepEqual(view.json.overrides, { screenshotIntervalSeconds: 60, screenshotBlur: true });
  assert.equal(view.json.effective.retentionDays, 14);
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: {} });
  assert.equal((await eff('ed')).screenshotIntervalSeconds, 120);
  await h.call('PUT', '/api/policy/team/team-1', { token: tok.admin, body: {} });
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: {} });
  assert.equal((await eff('ed')).screenshotIntervalSeconds, 300);
});

test('policy validation: bounds, unknown keys (no covert-mode switch), types and scopes', async () => {
  const put = (scope: string, id: string, body: unknown) => h.call('PUT', `/api/policy/${scope}/${id}`, { token: tok.admin, body });
  assert.equal((await put('org', 'org', { screenshotIntervalSeconds: 5 })).status, 400);
  assert.equal((await put('org', 'org', { screenshotIntervalSeconds: 99999 })).status, 400);
  assert.equal((await put('org', 'org', { retentionDays: 0 })).status, 400);
  assert.equal((await put('org', 'org', { retentionDays: 1000 })).status, 400);
  assert.equal((await put('org', 'org', { idleTimeoutSeconds: 10 })).status, 400);
  assert.equal((await put('org', 'org', { screenshotsEnabled: 'yes' })).status, 400);
  assert.equal((await put('org', 'org', { screenshotVisibility: 'everyone' })).status, 400);
  assert.equal((await put('org', 'org', { silentMode: true })).status, 400);
  assert.equal((await put('org', 'org', { trackingVisible: false })).status, 400);
  assert.equal((await put('org', 'wrong-id', {})).status, 404);
  assert.equal((await put('team', 'nope', {})).status, 404);
  assert.equal((await put('user', 'nope', {})).status, 404);
  assert.equal((await put('planet', 'x', {})).status, 404);
});

test('capture-all-screens is off by default, rejects non-booleans and needs a higher notice version before it can be enabled', async () => {
  const put = (body: unknown, scope = 'org', id = 'org') => h.call('PUT', `/api/policy/${scope}/${id}`, { token: tok.admin, body });
  const eff = async () => (await h.call('GET', '/api/me', { token: tok.ed })).json.policy;
  assert.equal((await eff()).captureAllScreens, false);
  assert.equal((await put({ captureAllScreens: 'yes' })).status, 400);
  assert.equal((await put({ captureAllScreens: true }, 'team', 'team-1')).status, 400, 'all-screens is organization scope only');
  assert.equal((await put({ captureAllScreens: false }, 'user', h.users.ed!.id)).status, 400, 'a person cannot opt out of an organization-wide screen policy');
  const version = (await eff()).consentVersion;
  const bare = await put({ captureAllScreens: true });
  assert.equal(bare.status, 422); assert.match(bare.json.error, /all screens/); assert.equal((await eff()).captureAllScreens, false);
  assert.equal((await put({ captureAllScreens: true, consentVersion: version })).status, 422, 'same version is not enough');
  assert.equal((await put({ captureAllScreens: true, consentVersion: version + 1 })).status, 200);
  const policy = await eff();
  assert.equal(policy.captureAllScreens, true); assert.equal(policy.consentVersion, version + 1);
  const turnOff = await put({ captureAllScreens: false, consentVersion: version + 1 });
  assert.equal(turnOff.status, 200, 'narrowing needs no new notice'); assert.equal((await eff()).captureAllScreens, false);
  await put({});
});

test('schedule and break reminder policy validates, inherits and rolls back invalid effective hours', async () => {
  const valid = {breakReminderMinutes: 45, workScheduleEnabled: true, workDays: [1, 2, 3, 4, 5], workStartLocal: '08:30', workEndLocal: '17:30'};
  assert.equal((await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: valid})).status, 200);
  const policy = (await h.call('GET', '/api/me', {token: tok.ed})).json.policy;
  assert.equal(policy.breakReminderMinutes, 45); assert.equal(policy.workScheduleEnabled, true);
  assert.deepEqual(policy.workDays, [1, 2, 3, 4, 5]); assert.equal(policy.workStartLocal, '08:30');
  assert.equal((await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: {workScheduleEnabled: true, workStartLocal: '08:30', workEndLocal: '08:00'}})).status, 400);
  assert.equal((await h.call('GET', '/api/policy/org/org', {token: tok.admin})).json.overrides.workEndLocal, '17:30');
  for (const invalid of [
    {breakReminderMinutes: 241}, {workDays: []}, {workDays: [1, 1]}, {workDays: [7]}, {workTimeZone:'Mars/Olympus'}, {lateGraceMinutes:181},
    {workStartLocal: '9:00'}, {workEndLocal: '24:00'}, {silentMode: true},
  ]) assert.equal((await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: invalid})).status, 400, JSON.stringify(invalid));
  await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: {}});
});

test('timezone conversion resolves DST gaps and repeated wall times deterministically', () => {
  assert.equal(new Date(localDateTimeToMs('2026-01-15','09:00','America/New_York')).toISOString(),'2026-01-15T14:00:00.000Z');
  assert.equal(new Date(localDateTimeToMs('2026-03-08','02:30','America/New_York')).toISOString(),'2026-03-08T07:00:00.000Z'); // skipped 02:30 advances to 03:00
  assert.equal(new Date(localDateTimeToMs('2026-11-01','01:30','America/New_York')).toISOString(),'2026-11-01T05:30:00.000Z'); // earlier repeated minute
});

test('attendance evidence uses each person timezone, tracker sessions only, scoped access and audited CSV', async () => {
  const policy={workScheduleEnabled:true,workDays:[5],workTimeZone:'America/New_York',workStartLocal:'09:00',workEndLocal:'17:00',lateGraceMinutes:10};
  assert.equal((await h.call('PUT','/api/policy/org/org',{token:tok.admin,body:policy})).status,200);
  const addEntry=(token:string,clientId:string,start:string,end:string)=>h.call('POST','/api/time-entries/sync',{token,body:{clientId,taskLabel:'Synthetic attendance fixture',mode:'company',startAt:start,endAt:end,trackedMs:HOUR,idleMs:0}});
  assert.equal((await addEntry(tok.ed,'attendance-late','2026-10-02T14:30:00.000Z','2026-10-02T15:30:00.000Z')).status,201);
  assert.equal((await addEntry(tok.ed,'attendance-after-hours','2026-10-02T21:30:00.000Z','2026-10-02T22:30:00.000Z')).status,201);
  const q='from=2026-10-02&to=2026-10-02';
  const report=await h.call('GET',`/api/reports/attendance?${q}&userId=${h.users.ed!.id}`,{token:tok.admin});
  assert.equal(report.status,200);
  assert.deepEqual([report.json.rows[0].status,report.json.rows[0].timeZone,report.json.rows[0].trackedMs,report.json.rows[0].trackedWithinScheduleMs,report.json.rows[0].trackedOutsideScheduleEstimateMs],['late','America/New_York',2*HOUR,HOUR,HOUR]);
  assert.match(report.json.note,/does not establish absence/);
  const manual=await h.call('POST','/api/time-entries',{token:tok.eve,body:{clientId:'03d1a782-df81-4d89-a08b-a775ae573a51',taskLabel:'Manual only',startAt:'2026-10-02T14:30:00.000Z',endAt:'2026-10-02T15:30:00.000Z'}});
  assert.equal(manual.status,201);
  const empty=await h.call('GET',`/api/reports/attendance?${q}&userId=${h.users.eve!.id}`,{token:tok.admin});
  assert.equal(empty.json.rows[0].status,'no_tracked_session');
  assert.equal((await h.call('GET',`/api/reports/attendance?${q}&userId=${h.users.ed!.id}`,{token:tok.finn})).status,403);
  assert.equal((await h.call('GET','/api/reports/attendance?from=2026-02-30&to=2026-03-01',{token:tok.admin})).status,400);
  assert.equal((await h.call('GET','/api/reports/attendance?from=2026-09-01&to=2026-10-02',{token:tok.admin})).status,400);
  const upcoming=await h.call('GET',`/api/reports/attendance?from=2026-10-23&to=2026-10-23&userId=${h.users.ed!.id}`,{token:tok.admin});
  assert.equal(upcoming.json.rows[0].status,'upcoming');
  const manager=await h.call('GET',`/api/reports/attendance?${q}`,{token:tok.mia});
  assert.ok(manager.json.rows.some((row:any)=>row.name==='Ed'));
  const csv=await h.call('GET',`/api/reports/attendance?${q}&userId=${h.users.ed!.id}&format=csv`,{token:tok.admin});
  assert.match(csv.text,/America\/New_York/); assert.match(csv.text,/does not establish absence/); assert.match(csv.headers.get('content-disposition')??'',/attendance-evidence\.csv/);
  assert.ok((await h.call('GET','/api/audit?limit=200',{token:tok.admin})).json.entries.some((event:any)=>event.action==='report.exported'&&event.targetId==='attendance'));
  await h.call('PUT','/api/policy/org/org',{token:tok.admin,body:{...policy,workDays:[4],workTimeZone:'UTC',workStartLocal:'08:00',workEndLocal:'17:00'}});
  const running=await h.call('POST','/api/time-entries/sync',{token:tok.ed,body:{clientId:'attendance-running',taskLabel:'Synthetic in-progress fixture',mode:'company',startAt:iso(T0-MIN),endAt:null,trackedMs:MIN,idleMs:0}});
  assert.equal(running.status,201);
  const inProgress=await h.call('GET',`/api/reports/attendance?from=2026-10-22&to=2026-10-22&userId=${h.users.ed!.id}`,{token:tok.admin});
  assert.equal(inProgress.json.rows[0].status,'in_progress');
  await h.call('PUT','/api/policy/org/org',{token:tok.admin,body:{}});
});

test('activity estimate report aggregates only consented sampled data, enforces scope and audits views/exports', async () => {
  const policy = await h.call('PUT', '/api/policy/org/org', {token:tok.admin, body:{activityTrackingEnabled:true,consentVersion:2}});
  assert.equal(policy.status, 200);
  assert.equal((await h.call('POST', '/api/me/consent', {token:tok.ed, body:{version:2}})).status, 200);
  const clientId = 'activity-report-001', start = T0 - 20 * DAY - 10 * MIN;
  const entry = await h.call('POST', '/api/time-entries/sync', {token:tok.ed, body:{clientId,taskLabel:'Synthetic work',mode:'company',activityTrackingEnabled:true,startAt:iso(start),endAt:iso(start + 8 * MIN),trackedMs:8 * MIN,idleMs:0}});
  assert.equal(entry.status, 201);
  const slice = {entryClientId:clientId,slice:{startedAt:iso(start),durationSeconds:60,keyboardCount:25,mouseCount:4,activeSeconds:30}};
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token:tok.ed,body:slice})).status, 201);
  const q = `from=${encodeURIComponent(iso(T0 - 21 * DAY))}&to=${encodeURIComponent(iso(T0 + MIN))}&groupBy=user`;
  const adminReport = await h.call('GET', `/api/reports/activity?${q}`, {token:tok.admin});
  assert.equal(adminReport.status, 200);
  const group = adminReport.json.groups.find((row:any) => row.label === 'Ed');
  assert.deepEqual([group.activityPercent,group.activeSeconds,group.sampledSeconds,group.keyboardCount,group.mouseCount,group.entries],[50,30,60,25,4,1]);
  assert.deepEqual(Object.values(h.db.prepare('SELECT slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count FROM activity_daily_rollups WHERE user_id=? AND entry_client_id=? AND utc_date=?').get(h.users.ed!.id,clientId,'2026-10-02') as any),[1,60,30,25,4]);
  assert.match(adminReport.json.note,/not a measure of productivity, quality, attendance, or pay/);
  assert.equal((await h.call('GET', `/api/reports/activity?${q}&userId=${h.users.ed!.id}`, {token:tok.finn})).status,403);
  const managerReport = await h.call('GET', `/api/reports/activity?${q}`, {token:tok.mia});
  assert.ok(managerReport.json.groups.some((row:any) => row.label === 'Ed'));
  assert.ok((await h.call('GET', '/api/audit?limit=100', {token:tok.admin})).json.entries.some((event:any) => event.action === 'activity.viewed' && event.detail.report === true));
  const csv = await h.call('GET', `/api/reports/activity?${q}&format=csv`, {token:tok.admin});
  assert.match(csv.text,/Activity estimate \(%\),Keyboard key-down count,Mouse click count/);
  assert.match(csv.headers.get('content-disposition') ?? '',/activity-by-user\.csv/);
  assert.equal((await h.call('GET', `/api/reports/activity?${q}&groupBy=invalid`, {token:tok.admin})).status,400);
  const daily=await h.call('GET',`/api/reports/activity/daily?from=2026-10-02&to=2026-10-02&groupBy=day&userId=${h.users.ed!.id}`,{token:tok.admin});
  assert.equal(daily.status,200);
  assert.deepEqual([daily.json.groups[0].date,daily.json.groups[0].activityPercent,daily.json.groups[0].activeSeconds,daily.json.groups[0].sampledSeconds,daily.json.groups[0].keyboardCount,daily.json.groups[0].mouseCount,daily.json.groups[0].entries],['2026-10-02',50,30,60,25,4,1]);
  assert.match(daily.json.note,/UTC date/);
  assert.ok((await h.call('GET','/api/audit?limit=100',{token:tok.admin})).json.entries.some((event:any)=>event.action==='activity.viewed'&&event.detail.dailyRollup===true));
  assert.equal((await h.call('GET',`/api/reports/activity/daily?from=2026-10-02&to=2026-10-02&userId=${h.users.ed!.id}`,{token:tok.finn})).status,403);
  const dailyCsv=await h.call('GET',`/api/reports/activity/daily?from=2026-10-02&to=2026-10-02&format=csv`,{token:tok.admin});
  assert.match(dailyCsv.text,/Report note/);assert.match(dailyCsv.text,/not productivity, attendance, or pay evidence/);
  assert.equal((await h.call('GET','/api/reports/activity/daily?from=2026-02-30&to=2026-03-01',{token:tok.admin})).status,400);
  await h.call('PUT', '/api/policy/org/org', {token:tok.admin,body:{}});
});

test('raising the consent version asks everyone to accept the notice again', async () => {
  await h.call('POST', '/api/me/consent', { token: tok.ed, body: { version: 1 } });
  assert.equal((await h.call('GET', '/api/me', { token: tok.ed })).json.needsConsent, false);
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: { consentVersion: 2 } });
  assert.equal((await h.call('GET', '/api/me', { token: tok.ed })).json.needsConsent, true);
  assert.equal((await h.call('POST', '/api/me/consent', { token: tok.ed, body: { version: 1 } })).status, 400);
  assert.equal((await h.call('POST', '/api/me/consent', { token: tok.ed, body: { version: 2 } })).status, 200);
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: {} });
});

// ---------- live / heartbeat ----------
test('heartbeat feeds the live view; stale presence shows as offline; scope applies', async () => {
  await h.call('POST', '/api/heartbeat', { token: tok.ed, body: { status: 'tracking', taskLabel: 'Report', trackedMs: 5 * MIN, deviceName: 'ED-PC' } });
  await h.call('POST', '/api/heartbeat', { token: tok.eve, body: { status: 'paused' } });
  const live = (t: string) => h.call('GET', '/api/team/live', { token: t }).then(r => Object.fromEntries(r.json.members.map((m: any) => [m.name, m])));
  let m = await live(tok.mia);
  assert.equal(m.Ed.state, 'tracking'); assert.equal(m.Ed.taskLabel, 'Report'); assert.equal(m.Eve.state, 'paused');
  assert.equal(m.Finn, undefined);                       // other team's employee not visible to mia
  assert.equal((await live(tok.admin)).Ed.state, 'tracking');
  assert.deepEqual(Object.keys(await live(tok.ed)), ['Ed']);
  h.clock.now += 2 * MIN;                                // no heartbeat for 2 minutes -> offline
  tok.mia = await h.login('mia@test.example');
  m = await live(tok.mia);
  assert.equal(m.Ed.state, 'offline'); assert.equal(m.Ed.trackedMs, 0);
  tok.ed = await h.login('ed@test.example'); tok.eve = await h.login('eve@test.example');
  await h.call('POST', '/api/heartbeat', { token: tok.ed, body: { status: 'stopped' } });
  assert.equal((await live(tok.mia)).Ed.state, 'offline');
  assert.equal((await h.call('POST', '/api/heartbeat', { token: tok.ed, body: { status: 'hacking' } })).status, 400);
});

// ---------- reports ----------
const sync = (token: string, n: number, startAt: number, trackedMs: number, extra: Record<string, unknown> = {}) =>
  h.call('POST', '/api/time-entries/sync', { token, body: { clientId: `report-0000-${n}`, taskLabel: 't', mode: 'manual', startAt: iso(startAt), endAt: iso(startAt + trackedMs), trackedMs, idleMs: 0, ...extra } });

test('hours report aggregates by user, project and day, honors scope and excludes rejected time', async () => {
  tok.mia = await h.login('mia@test.example'); tok.ed = await h.login('ed@test.example'); tok.eve = await h.login('eve@test.example'); tok.finn = await h.login('finn@test.example'); tok.admin = await h.login('admin@test.example');
  const p = (await h.call('POST', '/api/projects', { token: tok.admin, body: { name: 'Alpha' } })).json.project.id;
  const day1 = T0 - 3 * DAY, day2 = T0 - 2 * DAY;
  await sync(tok.ed, 1, day1, 2 * HOUR, { projectId: p, idleMs: 10 * MIN });
  await sync(tok.ed, 2, day2, HOUR);
  await sync(tok.eve, 3, day1, 3 * HOUR, { projectId: p });
  await sync(tok.finn, 4, day1, 5 * HOUR);
  const rejected = await sync(tok.eve, 5, day2, 4 * HOUR);
  const eveEntries = (await h.call('GET', '/api/time-entries', { token: tok.eve })).json.entries;
  await h.call('POST', `/api/time-entries/${eveEntries.find((e: any) => e.id === rejected.json.id).id}/reject`, { token: tok.mia });
  const approveId = eveEntries.find((e: any) => e.clientId === 'report-0000-3').id;
  await h.call('POST', `/api/time-entries/${approveId}/approve`, { token: tok.mia });
  const q = `from=${encodeURIComponent(iso(T0 - 10 * DAY))}&to=${encodeURIComponent(iso(T0))}`;

  const byUser = (await h.call('GET', `/api/reports/hours?${q}&groupBy=user`, { token: tok.admin })).json;
  const get = (name: string) => byUser.groups.find((g: any) => g.label === name);
  assert.equal(get('Ed').trackedMs, 3 * HOUR); assert.equal(get('Ed').idleMs, 10 * MIN);
  assert.equal(get('Eve').trackedMs, 3 * HOUR); assert.equal(get('Eve').approvedMs, 3 * HOUR); assert.equal(get('Eve').pendingMs, 0);  // rejected 4h excluded
  assert.equal(get('Finn').trackedMs, 5 * HOUR);
  assert.equal(byUser.total.trackedMs, 11 * HOUR);
  assert.match(byUser.note, /estimate/i);

  const miaView = (await h.call('GET', `/api/reports/hours?${q}&groupBy=user`, { token: tok.mia })).json;
  assert.deepEqual(miaView.groups.map((g: any) => g.label).sort(), ['Ed', 'Eve']);
  const edView = (await h.call('GET', `/api/reports/hours?${q}&groupBy=user`, { token: tok.ed })).json;
  assert.deepEqual(edView.groups.map((g: any) => g.label), ['Ed']);

  const byProject = (await h.call('GET', `/api/reports/hours?${q}&groupBy=project`, { token: tok.admin })).json.groups;
  assert.equal(byProject.find((g: any) => g.label === 'Alpha').trackedMs, 5 * HOUR);
  assert.equal(byProject.find((g: any) => g.label === 'No project').trackedMs, 6 * HOUR);

  const byDay = (await h.call('GET', `/api/reports/hours?${q}&groupBy=day`, { token: tok.admin })).json.groups;
  assert.deepEqual(byDay.map((g: any) => g.key), ['2026-10-19', '2026-10-20']);
  assert.equal(byDay[0].trackedMs, 10 * HOUR);
  // timezone: UTC+10 pushes a 09:00Z start (= 19:00 local) still on the same day; UTC+15 would not be allowed (clamped to +14h)
  const tz = (await h.call('GET', `/api/reports/hours?${q}&groupBy=day&tzOffsetMinutes=900`, { token: tok.admin })).json.groups;
  assert.deepEqual(tz.map((g: any) => g.key), ['2026-10-19', '2026-10-20']);
  const late = (await h.call('GET', `/api/reports/hours?${q}&groupBy=day&tzOffsetMinutes=840`, { token: tok.admin })).json.groups;
  assert.ok(late.length >= 1);
});

test('report parameters are validated and scoped', async () => {
  const q = `from=${encodeURIComponent(iso(T0 - DAY))}&to=${encodeURIComponent(iso(T0))}`;
  assert.equal((await h.call('GET', `/api/reports/hours?${q}&groupBy=weird`, { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', `/api/reports/hours?${q}&format=xml`, { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', '/api/reports/hours?from=x&to=y', { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', '/api/reports/hours', { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', `/api/reports/hours?from=${encodeURIComponent(iso(T0))}&to=${encodeURIComponent(iso(T0 - DAY))}`, { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', `/api/reports/hours?from=${encodeURIComponent(iso(T0 - 400 * DAY))}&to=${encodeURIComponent(iso(T0))}`, { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', `/api/reports/hours?${q}&userId=${h.users.finn!.id}`, { token: tok.mia })).status, 403);
  assert.equal((await h.call('GET', `/api/reports/hours?${q}`)).status, 401);
});

test('CSV export neutralizes spreadsheet formulas, quotes commas/quotes, and is audited', async () => {
  // a malicious project/user name must not become a formula in Excel
  const evil = (await h.call('POST', '/api/projects', { token: tok.admin, body: { name: '=HYPERLINK("http://evil.example","x"),+cmd' } })).json.project.id;
  tok.ed = await h.login('ed@test.example');
  await sync(tok.ed, 90, T0 - 5 * HOUR, HOUR, { projectId: evil });
  const q = `from=${encodeURIComponent(iso(T0 - DAY))}&to=${encodeURIComponent(iso(T0))}`;
  const r = await h.call('GET', `/api/reports/hours?${q}&groupBy=project&format=csv`, { token: tok.admin });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /text\/csv/);
  assert.match(r.headers.get('content-disposition')!, /attachment/);
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines[0], 'Group,Tracked hours,Idle hours (estimate),Approved hours,Pending hours,Entries');
  const row = lines.find(l => l.includes('HYPERLINK'))!;
  assert.ok(row.startsWith(`"'=HYPERLINK(""http://evil.example"",""x""),+cmd"`), row);
  assert.ok(lines.at(-1)!.startsWith('Total,'));
  const log = (await h.call('GET', '/api/audit?limit=500', { token: tok.admin })).json.entries.map((e: any) => e.action);
  assert.ok(log.includes('report.exported'));
});
