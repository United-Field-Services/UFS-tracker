import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, giveConsent, png, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'max', 'ed', 'eve', 'finn', 'loner']) tok[k] = await h.login(`${k}@test.example`);
  giveConsent(h, 'ed', 'eve', 'finn');   // loner has not accepted the notice
  h.db.prepare("INSERT INTO projects (id,name,client,active,created_at) VALUES ('proj-1','Alpha','Acme',1,?)").run(iso(T0));
  const entry = (n: number, user: string, startOffset: number, trackedMin: number, status: string, project: string | null = null, end = true) =>
    h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,project_id,source,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES (?,?,?,?,'tracker',?,?,?,?,?,?,?)")
      .run(`e${n}`, h.users[user]!.id, `entry-00000000-${n}`, project, iso(T0 + startOffset), end ? iso(T0 + startOffset + trackedMin * MIN) : null, trackedMin * MIN, 5 * MIN, status, iso(T0), iso(T0));
  entry(1, 'ed', 0, 60, 'approved', 'proj-1');
  entry(2, 'ed', -DAY, 30, 'pending');
  entry(3, 'eve', 0, 90, 'pending', 'proj-1');
  entry(4, 'finn', 0, 600, 'rejected');            // rejected time never counts
  entry(5, 'eve', -2 * DAY, 15, 'pending', null, false);   // still running: not awaiting approval
});
after(async () => { await h.stop(); });

const up = (token: string, n: number, takenAt: string, entry?: string, bytes = png(64, 48, n)) =>
  h.call('POST', `/api/screenshots?clientId=shot-00000000-${n}&takenAt=${encodeURIComponent(takenAt)}${entry ? `&entryClientId=${entry}` : ''}`, { token, raw: bytes });

test('admin overview is for owner, admin and HR only', async () => {
  for (const k of ['owner', 'admin', 'hana']) assert.equal((await h.call('GET', '/api/admin/overview', { token: tok[k] })).status, 200, k);
  for (const k of ['mia', 'ed']) assert.equal((await h.call('GET', '/api/admin/overview', { token: tok[k] })).status, 403, k);
  assert.equal((await h.call('GET', '/api/admin/overview')).status, 401);
  assert.equal((await h.call('GET', '/api/admin/overview?tzOffsetMinutes=99999', { token: tok.admin })).status, 400);
});

test('overview numbers: hours, trend, approvals, consent, people and alerts are correct and exclude rejected time', async () => {
  const r = await h.call('GET', '/api/admin/overview?days=14', { token: tok.admin });
  const o = r.json;
  assert.equal(o.days, 14); assert.equal(o.time.trend.length, 14);
  assert.equal(o.time.todayMs, 150 * MIN, 'ed 60 + eve 90 today; the rejected 600 minutes are excluded');
  assert.equal(o.time.last7Ms, (150 + 30 + 15) * MIN, 'last 7 days: today 150, yesterday 30, plus 15 from the running entry two days ago');
  const byDate = Object.fromEntries(o.time.trend.map((d: any) => [d.date, d.trackedMs]));
  assert.equal(byDate['2026-10-22'], 150 * MIN); assert.equal(byDate['2026-10-21'], 30 * MIN);
  assert.deepEqual(o.time.topPeople.map((p: any) => [p.name, p.trackedMs]), [['Eve', 105 * MIN], ['Ed', 90 * MIN]]);
  assert.deepEqual(o.time.byProject.map((p: any) => [p.name, p.trackedMs]), [['Alpha', 150 * MIN], ['No project', 45 * MIN]]);
  assert.equal(o.approvals.pending, 2, 'a running entry is not awaiting approval'); assert.ok(o.approvals.oldestPendingAt);
  assert.equal(o.people.active, 9); assert.equal(o.people.byRole.employee, 4); assert.equal(o.people.byRole.hr, 1);
  assert.equal(o.people.withoutConsent, 6, 'everyone except ed, eve, finn has not accepted the notice');
  assert.equal(o.people.live.offline, 9);
  assert.ok(o.alerts.some((a: any) => /monitoring notice/.test(a.text) && a.view === 'people'));
  assert.ok(o.alerts.some((a: any) => /waiting for approval/.test(a.text) && a.view === 'timesheets'));
  assert.match(o.note, /productivity, attendance or pay measure/);
  const logged = h.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'admin.overview_viewed'").get() as any;
  assert.ok(logged.c >= 1, 'viewing the overview is audited');
});

test('overview day buckets follow the viewer timezone offset', async () => {
  const utc = (await h.call('GET', '/api/admin/overview?tzOffsetMinutes=0', { token: tok.admin })).json;
  const shifted = (await h.call('GET', '/api/admin/overview?tzOffsetMinutes=-600', { token: tok.admin })).json;   // UTC-10: 09:00Z is 23:00 the day before
  assert.equal(utc.time.trend.at(-1).date, '2026-10-22');
  assert.equal(shifted.time.trend.at(-1).date, '2026-10-21'); assert.equal(shifted.time.trend.length, 14);
});

test('screenshots: summary respects visibility, list filters by project and pages with a cursor', async () => {
  for (let n = 1; n <= 5; n++) assert.equal((await up(tok.ed, n, iso(T0 - n * MIN), n <= 2 ? 'entry-00000000-1' : undefined)).status, 201);
  for (let n = 11; n <= 13; n++) assert.equal((await up(tok.eve, n, iso(T0 - n * MIN), n === 11 ? 'entry-00000000-3' : undefined)).status, 201);
  assert.equal((await up(tok.finn, 21, iso(T0 - 21 * MIN))).status, 201);
  const sum = async (k: string) => (await h.call('GET', '/api/screenshots/summary?days=14', { token: tok[k] })).json;
  assert.equal((await sum('ed')).total.count, 5, 'an employee sees only their own');
  assert.equal((await sum('mia')).total.count, 8, 'a manager sees direct reports: ed + eve');
  assert.equal((await sum('admin')).total.count, 9); assert.equal((await sum('hana')).total.count, 9);
  const admin = await sum('admin');
  assert.equal(admin.byUser.length, 3); assert.equal(admin.byDay.length, 14); assert.equal(admin.byDay.at(-1).count, 9);
  assert.equal(admin.byUser.reduce((t: number, x: any) => t + x.bytes, 0), admin.total.bytes);
  assert.equal(admin.retentionDays, 90);

  const byProject = await h.call('GET', '/api/screenshots?projectId=proj-1', { token: tok.admin });
  assert.deepEqual(byProject.json.screenshots.map((s: any) => s.clientId).sort(), ['shot-00000000-1', 'shot-00000000-11', 'shot-00000000-2']);
  const page1 = await h.call('GET', '/api/screenshots?limit=4', { token: tok.admin });
  assert.equal(page1.json.screenshots.length, 4); assert.equal(page1.json.hasMore, true);
  const last = page1.json.screenshots.at(-1).takenAt;
  const page2 = await h.call('GET', `/api/screenshots?limit=10&before=${encodeURIComponent(last)}`, { token: tok.admin });
  assert.equal(page2.json.screenshots.length, 5); assert.equal(page2.json.hasMore, false);
  const ids = new Set([...page1.json.screenshots, ...page2.json.screenshots].map((s: any) => s.id)); assert.equal(ids.size, 9, 'pages do not overlap or skip');
  assert.equal((await h.call('GET', '/api/screenshots?before=nope', { token: tok.admin })).status, 400);
});

test('bulk delete: per-item permission checks, partial success, storage cleanup, audit, limits', async () => {
  const list = async (k: string) => (await h.call('GET', '/api/screenshots?limit=200', { token: tok[k] })).json.screenshots as any[];
  const edShots = (await list('ed')).map(s => s.id), eveShots = (await list('eve')).map(s => s.id), finnShot = (await list('finn'))[0].id;
  const filesBefore = h.store.files.size;
  // an employee can delete their own (policy allows) but not a colleague's: the colleague's screenshot is invisible to them
  const own = await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.ed, body: { ids: [edShots[0], eveShots[0], 'no-such-id-0000'], reason: 'wrong window' } });
  assert.equal(own.status, 200); assert.equal(own.json.deleted, 1); assert.equal(own.json.skipped.length, 2);
  assert.ok(own.json.skipped.every((s: any) => s.reason === 'Not found.'), 'no hint that other people\'s screenshots exist');
  assert.ok(h.store.files.size < filesBefore, 'the stored object is removed');
  assert.equal((await h.call('GET', `/api/screenshots/${edShots[0]}/image`, { token: tok.ed })).status, 404);
  // HR can see but never delete
  const hr = await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.hana, body: { ids: [eveShots[1]] } });
  assert.equal(hr.json.deleted, 0); assert.match(hr.json.skipped[0].reason, /cannot delete/);
  // a manager deletes a direct report's, but not another team's
  const mgr = await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.mia, body: { ids: [eveShots[1], eveShots[1], finnShot] } });
  assert.equal(mgr.json.deleted, 1, 'duplicates count once'); assert.equal(mgr.json.skipped.length, 1);
  // an admin deletes anyone's
  const adm = await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.admin, body: { ids: [finnShot, ...edShots.slice(1, 3)] } });
  assert.equal(adm.json.deleted, 3);
  // limits and validation
  assert.equal((await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.admin, body: { ids: [] } })).status, 400);
  assert.equal((await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.admin, body: { ids: Array.from({ length: 101 }, (_, i) => `shot-id-${String(i).padStart(4, '0')}`) } })).status, 400);
  assert.equal((await h.call('POST', '/api/screenshots/bulk-delete', { token: tok.admin, body: { ids: ['../etc'] } })).status, 400);
  assert.equal((await h.call('POST', '/api/screenshots/bulk-delete', { body: { ids: [edShots[3]] } })).status, 401);
  // audit: one line per deleted item plus one summary, reason recorded
  const audits = h.db.prepare("SELECT action, detail FROM audit_log WHERE action IN ('screenshot.deleted','screenshot.bulk_deleted')").all() as any[];
  assert.ok(audits.filter(a => a.action === 'screenshot.deleted').length >= 5); assert.ok(audits.some(a => a.action === 'screenshot.bulk_deleted'));
  assert.ok(audits.some(a => /wrong window/.test(a.detail)));
  const after = (await h.call('GET', '/api/admin/overview', { token: tok.admin })).json;
  assert.equal(after.screenshots.total, 9 - 5); assert.ok(after.audit.deletions24h >= 1);
});
