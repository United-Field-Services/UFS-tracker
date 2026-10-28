import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../src/db.ts';
import { inspectScreenshot } from '../src/storage.ts';
import { setup, giveConsent, png, webp, jpegBytes, iso, MIN, HOUR, DAY, T0, PASSWORD, type Harness } from './helpers.ts';

let h: Harness; let tok: Record<string, string>;
before(async () => {
  h = await setup(); tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'max', 'ed', 'eve', 'finn']) tok[k] = await h.login(`${k}@test.example`);
  giveConsent(h, 'ed', 'eve', 'finn', 'hana');
});
after(async () => { await h.stop(); });

const upload = (token: string, n: number, bytes: Buffer, type: string) =>
  h.call('POST', `/api/screenshots?clientId=hr-shot-00000000-${n}&takenAt=${encodeURIComponent(iso(T0 - n * MIN))}`, { token, raw: bytes, contentType: type });
const sync = (token: string, n: number, over: Record<string, unknown> = {}) =>
  h.call('POST', '/api/time-entries/sync', { token, body: { clientId: `hr-entry-0000-${n}`, taskLabel: 'Work', mode: 'company', startAt: iso(T0 - 2 * HOUR), endAt: iso(T0 - HOUR), trackedMs: 50 * MIN, idleMs: 0, ...over } });

// ---------------- HR role ----------------
test('HR can read everyone\'s users, time, live status, reports and screenshots', async () => {
  await sync(tok.ed, 1); await sync(tok.finn, 2);
  await upload(tok.ed, 1, png(), 'image/png'); await upload(tok.finn, 2, webp(), 'image/webp');
  assert.equal((await h.call('GET', '/api/users', { token: tok.hana })).json.users.length, 9);
  const entries = (await h.call('GET', '/api/time-entries', { token: tok.hana })).json.entries;
  assert.deepEqual(entries.map((e: any) => e.userName).sort(), ['Ed', 'Finn']);
  assert.ok((await h.call('GET', '/api/team/live', { token: tok.hana })).json.members.length >= 8);
  const q = `from=${encodeURIComponent(iso(T0 - DAY))}&to=${encodeURIComponent(iso(T0))}`;
  assert.equal((await h.call('GET', `/api/reports/hours?${q}&groupBy=user`, { token: tok.hana })).json.groups.length, 2);
  const shots = (await h.call('GET', '/api/screenshots', { token: tok.hana })).json.screenshots;
  assert.deepEqual(shots.map((s: any) => s.userName).sort(), ['Ed', 'Finn']);
  const view = await h.call('GET', `/api/screenshots/${shots[0].id}/image`, { token: tok.hana });
  assert.equal(view.status, 200);
  const audited = (await h.call('GET', '/api/audit?limit=100', { token: tok.admin })).json.entries.filter((e: any) => e.action === 'screenshot.viewed' && e.actorName === 'Hana');
  assert.equal(audited.length, 1, 'HR views are audited like any other non-owner view');
});

test('HR can never edit, approve, reject, delete or administer', async () => {
  const entry = (await h.call('GET', '/api/time-entries', { token: tok.hana })).json.entries.find((e: any) => e.userName === 'Ed');
  const shot = (await h.call('GET', '/api/screenshots?userId=' + h.users.ed!.id, { token: tok.hana })).json.screenshots[0];
  const denied: [string, string, unknown?][] = [
    ['POST', `/api/time-entries/${entry.id}/approve`], ['POST', `/api/time-entries/${entry.id}/reject`],
    ['PATCH', `/api/time-entries/${entry.id}`, { trackedMs: 1, reason: 'because' }], ['DELETE', `/api/time-entries/${entry.id}`],
    ['DELETE', `/api/screenshots/${shot.id}`],
    ['POST', '/api/users', { email: 'x@test.example', name: 'X', temporaryPassword: 'Temp-pass-12345' }], ['PATCH', `/api/users/${h.users.ed!.id}`, { name: 'Hacked' }],
    ['POST', `/api/users/${h.users.ed!.id}/reset-password`, { temporaryPassword: 'Temp-pass-12345' }], ['POST', `/api/users/${h.users.ed!.id}/revoke-sessions`],
    ['POST', '/api/projects', { name: 'Nope' }], ['POST', '/api/teams', { name: 'Nope' }], ['PUT', '/api/policy/org/org', { retentionDays: 1 }],
    ['GET', '/api/audit'], ['POST', '/api/admin/retention/run'],
  ];
  for (const [method, path, body] of denied) assert.equal((await h.call(method, path, { token: tok.hana, body })).status, 403, `${method} ${path}`);
});

test('HR still respects the "employee only" screenshot policy, and tracks their own time like anyone', async () => {
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: { screenshotVisibility: 'employee_only' } });
  assert.equal((await h.call('GET', '/api/screenshots?userId=' + h.users.ed!.id, { token: tok.hana })).status, 403);
  assert.ok(!(await h.call('GET', '/api/screenshots', { token: tok.hana })).json.screenshots.some((s: any) => s.userName === 'Ed'));
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: {} });
  assert.equal((await sync(tok.hana, 9)).status, 201);
  assert.equal((await upload(tok.hana, 9, png(), 'image/png')).status, 201);
  const own = (await h.call('GET', '/api/time-entries?userId=' + h.users.hana!.id, { token: tok.hana })).json.entries[0];
  assert.equal((await h.call('POST', `/api/time-entries/${own.id}/approve`, { token: tok.hana })).status, 403, 'HR cannot approve their own time');
  assert.equal((await h.call('POST', `/api/time-entries/${own.id}/approve`, { token: tok.admin })).status, 200);
});

test('admins can create and assign the HR role; managers cannot', async () => {
  const created = await h.call('POST', '/api/users', { token: tok.admin, body: { email: 'new.hr@test.example', name: 'New HR', role: 'hr', temporaryPassword: 'Temp-pass-12345' } });
  assert.equal(created.status, 201); assert.equal(created.json.user.role, 'hr');
  assert.equal((await h.call('PATCH', `/api/users/${h.users.loner!.id}`, { token: tok.admin, body: { role: 'hr' } })).status, 200);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.loner!.id}`, { token: tok.mia, body: { role: 'hr' } })).status, 403);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.loner!.id}`, { token: tok.admin, body: { role: 'superuser' } })).status, 400);
});

test('migrations add the hr role, directory, auth and aggregate activity tables without losing existing data or constraints', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, 1);
  assert.equal(Number((db.prepare('PRAGMA user_version').get() as any).user_version), 1);
  assert.throws(() => db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES ('x','x@x.co','X','hr','h','t')").run(), /CHECK/);
  db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at,consent_version) VALUES ('u1','a@x.co','A','manager','h','t',1)").run();
  db.prepare("INSERT INTO users (id,email,name,role,manager_id,password_hash,created_at) VALUES ('u2','b@x.co','B','employee','u1','h','t')").run();
  db.prepare("INSERT INTO sessions (token_hash,user_id,kind,created_at,last_seen_at,expires_at) VALUES ('t1','u2','web','t','t','t')").run();
  db.prepare("INSERT INTO time_entries (id,user_id,client_id,source,start_at,created_at,updated_at) VALUES ('e1','u2','c1','tracker','t','t','t')").run();
  applyMigrations(db, 5);
  db.prepare("INSERT INTO activity_slices (id,user_id,entry_client_id,slice_start_at,duration_seconds,keyboard_count,mouse_count,active_seconds,created_at) VALUES ('s1','u2','c1','2026-10-21T23:59:00.000Z',60,2,3,30,'t'),('s2','u2','c1','2026-10-22T00:00:00.000Z',45,5,7,20,'t')").run();
  applyMigrations(db);
  assert.equal(Number((db.prepare('PRAGMA user_version').get() as any).user_version), 6);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM users').get() as any).c, 2);
  assert.equal((db.prepare("SELECT manager_id FROM users WHERE id='u2'").get() as any).manager_id, 'u1');
  assert.equal((db.prepare("SELECT consent_version FROM users WHERE id='u1'").get() as any).consent_version, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM sessions').get() as any).c, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM time_entries').get() as any).c, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM activity_slices').get() as any).c, 2);
  const backfilled=db.prepare('SELECT * FROM activity_daily_rollups ORDER BY utc_date').all() as any[];
  assert.deepEqual(backfilled.map(row=>[row.utc_date,row.slice_count,row.duration_seconds,row.active_seconds,row.keyboard_count,row.mouse_count]),[['2026-10-21',1,60,30,2,3],['2026-10-22',1,45,20,5,7]]);
  db.prepare("INSERT INTO activity_slices (id,user_id,entry_client_id,slice_start_at,duration_seconds,keyboard_count,mouse_count,active_seconds,created_at) VALUES ('s3','u2','c1','2026-10-22T00:01:00.000Z',30,1,1,10,'t')").run();
  assert.deepEqual(Object.values(db.prepare("SELECT slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count FROM activity_daily_rollups WHERE utc_date='2026-10-22'").get() as any),[2,75,30,6,8]);
  db.prepare("DELETE FROM activity_slices WHERE id='s2'").run();
  assert.deepEqual(Object.values(db.prepare("SELECT slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count FROM activity_daily_rollups WHERE utc_date='2026-10-22'").get() as any),[1,30,10,1,1]);
  db.prepare("UPDATE activity_slices SET slice_start_at='2026-10-23T00:00:00.000Z',duration_seconds=15,keyboard_count=3,mouse_count=4,active_seconds=5 WHERE id='s3'").run();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM activity_daily_rollups WHERE utc_date='2026-10-22'").get() as any).c,0);
  assert.deepEqual(Object.values(db.prepare("SELECT slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count FROM activity_daily_rollups WHERE utc_date='2026-10-23'").get() as any),[1,15,5,3,4]);
  db.prepare("DELETE FROM time_entries WHERE id='e1'").run();
  assert.equal((db.prepare('SELECT COUNT(*) c FROM activity_daily_rollups').get() as any).c,0,'entry deletion cascades to its rollups');
  db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES ('u3','h@x.co','H','hr','h','t')").run();
  assert.throws(() => db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES ('u4','z@x.co','Z','root','h','t')").run(), /CHECK/);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1, 'foreign keys are switched back on');
  assert.throws(() => db.prepare("INSERT INTO sessions (token_hash,user_id,kind,created_at,last_seen_at,expires_at) VALUES ('t2','nobody','web','t','t','t')").run(), /FOREIGN KEY/);
  applyMigrations(db); // idempotent
  assert.equal(Number((db.prepare('PRAGMA user_version').get() as any).user_version), 6);
});

// ---------------- image format policy ----------------
test('defaults: 90-day retention, WebP, activity counts off, policy reaches the employee through /api/me', async () => {
  const p = (await h.call('GET', '/api/me', { token: tok.eve })).json.policy;
  assert.equal(p.retentionDays, 90); assert.equal(p.imageFormat, 'webp'); assert.equal(p.imageQuality, 80); assert.equal(p.activityTrackingEnabled, false);
});

test('image policy is validated and inherits org > team > user', async () => {
  const put = (scope: string, id: string, body: unknown) => h.call('PUT', `/api/policy/${scope}/${id}`, { token: tok.admin, body });
  for (const bad of [{ imageFormat: 'gif' }, { imageFormat: 'jpeg' }, { imageQuality: 10 }, { imageQuality: 99 }, { imageQuality: 80.5 }, { imageQuality: '80' }]) assert.equal((await put('org', 'org', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await put('org', 'org', { imageFormat: 'png' })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { token: tok.eve })).json.policy.imageFormat, 'png');
  assert.equal((await put('team', 'team-1', { imageFormat: 'webp', imageQuality: 60 })).status, 200);
  const eve = (await h.call('GET', '/api/me', { token: tok.eve })).json.policy; assert.equal(eve.imageFormat, 'webp'); assert.equal(eve.imageQuality, 60);
  assert.equal((await h.call('GET', '/api/me', { token: tok.finn })).json.policy.imageFormat, 'png');          // other team keeps the org value
  await put('team', 'team-1', {}); await put('org', 'org', {});
  assert.equal((await h.call('GET', '/api/me', { token: tok.eve })).json.policy.imageFormat, 'webp');
});

test('WebP uploads are accepted in all three container variants and served with the right type', async () => {
  for (const [i, kind] of (['lossy', 'lossless', 'extended'] as const).entries()) {
    const r = await upload(tok.eve, 20 + i, webp(1280, 720, kind), 'image/webp');
    assert.equal(r.status, 201, kind); assert.equal(r.json.format, 'webp');
  }
  const shots = (await h.call('GET', '/api/screenshots?userId=' + h.users.eve!.id, { token: tok.mia })).json.screenshots;
  assert.equal(shots.length, 3); assert.ok(shots.every((s: any) => s.format === 'webp' && s.width === 1280 && s.height === 720), JSON.stringify(shots.map((s: any) => [s.width, s.height])));
  const img = await h.call('GET', `/api/screenshots/${shots[0].id}/image`, { token: tok.mia });
  assert.equal(img.headers.get('content-type'), 'image/webp'); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
});

test('image uploads that lie or are malformed are rejected', async () => {
  assert.equal((await upload(tok.eve, 30, png(), 'image/webp')).status, 415, 'PNG body declared as WebP');
  assert.equal((await upload(tok.eve, 31, webp(), 'image/png')).status, 415, 'WebP body declared as PNG');
  assert.equal((await upload(tok.eve, 32, jpegBytes(), 'image/png')).status, 415, 'JPEG is not an accepted screenshot format');
  assert.equal((await upload(tok.eve, 33, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('JUNK'), Buffer.alloc(40)]), 'image/webp')).status, 415, 'unknown WebP chunk');
  assert.equal((await upload(tok.eve, 34, webp(5000, 100), 'image/webp')).status, 415, 'too wide');
  assert.equal((await upload(tok.eve, 35, webp(100, 0 + 5000), 'image/webp')).status, 415, 'too tall');
  assert.equal((await upload(tok.eve, 36, Buffer.from('RIFF....WEBP'), 'image/webp')).status, 415, 'truncated');
  assert.equal((await upload(tok.eve, 37, Buffer.alloc(0), 'image/webp')).status, 415, 'empty');
  assert.equal((await upload(tok.eve, 38, Buffer.from('<svg onload=alert(1)>'.repeat(5)), 'image/svg+xml')).status, 415, 'SVG');
});

test('inspectScreenshot reads size and kind for each supported format', () => {
  assert.deepEqual(inspectScreenshot(png(321, 123)), { kind: 'png', width: 321, height: 123 });
  assert.deepEqual(inspectScreenshot(webp(1920, 1080, 'lossy')), { kind: 'webp', width: 1920, height: 1080 });
  assert.deepEqual(inspectScreenshot(webp(1920, 1080, 'lossless')), { kind: 'webp', width: 1920, height: 1080 });
  assert.deepEqual(inspectScreenshot(webp(1920, 1080, 'extended')), { kind: 'webp', width: 1920, height: 1080 });
  assert.throws(() => inspectScreenshot(Buffer.alloc(100)), /PNG or WebP/);
});

test('thumbnails may be WebP, and are served with their own type', async () => {
  const shot = (await h.call('GET', '/api/screenshots?userId=' + h.users.eve!.id, { token: tok.eve })).json.screenshots[0];
  assert.equal((await h.call('PUT', `/api/screenshots/${shot.id}/thumb`, { token: tok.eve, raw: webp(160, 90), contentType: 'image/webp' })).status, 200);
  assert.equal((await h.call('GET', `/api/screenshots/${shot.id}/thumb`, { token: tok.mia })).headers.get('content-type'), 'image/webp');
  assert.equal((await h.call('PUT', `/api/screenshots/${shot.id}/thumb`, { token: tok.eve, raw: Buffer.from('not an image at all, really'), contentType: 'image/png' })).status, 415);
});

test('default retention is 90 days: a 60-day-old screenshot stays, a 100-day-old one is purged', async () => {
  const ed = tok.ed;
  await upload(ed, 40, png(), 'image/png');                      // taken at T0 - 40 min
  h.clock.now = T0 + 60 * DAY; tok.admin = await h.login('admin@test.example');
  await h.call('POST', '/api/admin/retention/run', { token: tok.admin });
  tok.ed = await h.login('ed@test.example');
  assert.ok((await h.call('GET', '/api/screenshots?userId=' + h.users.ed!.id, { token: tok.ed })).json.screenshots.some((s: any) => s.clientId.endsWith('-40')), 'still there at 60 days');
  h.clock.now = T0 + 100 * DAY; tok.admin = await h.login('admin@test.example'); tok.ed = await h.login('ed@test.example');
  await h.call('POST', '/api/admin/retention/run', { token: tok.admin });
  assert.equal((await h.call('GET', '/api/screenshots?userId=' + h.users.ed!.id, { token: tok.ed })).json.screenshots.length, 0);
  void PASSWORD;
});
