import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, giveConsent, png, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';
import { notify, flushOutbox } from '../src/notifications.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'ed', 'eve', 'loner']) tok[k] = await h.login(`${k}@test.example`);
  giveConsent(h, 'ed', 'eve', 'loner');
});
after(async () => { await h.stop(); });

const manual = (token: string, startOffset: number, minutes: number, label = 'Synthetic work') =>
  h.call('POST', '/api/time-entries', { token, body: { startAt: iso(T0 + startOffset), endAt: iso(T0 + startOffset + minutes * MIN), taskLabel: label } });
const inbox = async (k: string, query = '') => (await h.call('GET', `/api/notifications${query}`, { token: tok[k] })).json;

// ---------------------------------------------------------------- notifications
test('notifications: manual time goes to the manager, or to owners and admins when there is no manager', async () => {
  assert.equal((await manual(tok.ed, -5 * HOUR, 60)).status, 201);
  const mia = await inbox('mia'); assert.equal(mia.unread, 1); assert.equal(mia.notifications[0].kind, 'time.manual_pending'); assert.match(mia.notifications[0].title, /Ed submitted manual time/); assert.equal(mia.notifications[0].link, 'timesheets');
  assert.equal((await inbox('admin')).unread, 0, 'a person with a manager does not notify admins');
  assert.equal((await manual(tok.loner, -5 * HOUR, 30)).status, 201);
  assert.equal((await inbox('owner')).unread, 1); assert.equal((await inbox('admin')).unread, 1);
  assert.equal((await inbox('ed')).unread, 0, 'you are never notified about your own submission');
});

test('notifications: approval, rejection and reviewer edits notify the person; reading is per person', async () => {
  const entries = (await h.call('GET', '/api/time-entries', { token: tok.mia })).json.entries as any[];
  const edEntry = entries.find(e => e.userName === 'Ed');
  assert.equal((await h.call('POST', `/api/time-entries/${edEntry.id}/approve`, { token: tok.mia, body: {} })).status, 200);
  assert.equal((await manual(tok.ed, -3 * HOUR, 20, 'second')).status, 201);
  const second = ((await h.call('GET', '/api/time-entries', { token: tok.mia })).json.entries as any[]).find(e => e.taskLabel === 'second');
  assert.equal((await h.call('POST', `/api/time-entries/${second.id}/reject`, { token: tok.mia, body: { note: 'overlaps a meeting' } })).status, 200);
  assert.equal((await h.call('PATCH', `/api/time-entries/${second.id}`, { token: tok.mia, body: { taskLabel: 'fixed', reason: 'typo in the label' } })).status, 200);
  const ed = await inbox('ed'); const kinds = ed.notifications.map((n: any) => n.kind);
  assert.deepEqual(kinds, ['time.edited', 'time.rejected', 'time.approved']); assert.match(ed.notifications[1].body, /overlaps a meeting/); assert.equal(ed.unread, 3);
  assert.equal((await inbox('ed', '?unread=1&limit=1')).notifications.length, 1);
  // someone else's ids are ignored
  const others = (await inbox('mia')).notifications.map((n: any) => n.id);
  assert.equal((await h.call('POST', '/api/notifications/read', { token: tok.ed, body: { ids: others } })).json.marked, 0);
  assert.equal((await inbox('mia')).unread >= 1, true);
  assert.equal((await h.call('POST', '/api/notifications/read', { token: tok.ed, body: { ids: [ed.notifications[0].id] } })).json.marked, 1);
  assert.equal((await inbox('ed')).unread, 2);
  assert.equal((await h.call('POST', '/api/notifications/read', { token: tok.ed, body: { all: true } })).json.marked, 2);
  assert.equal((await inbox('ed')).unread, 0);
  assert.equal((await h.call('POST', '/api/notifications/read', { token: tok.ed, body: {} })).status, 400);
  assert.equal((await h.call('GET', '/api/notifications')).status, 401);
});

test('notifications: the "dedupe" option avoids flooding someone who has not read the last one', async () => {
  const before = (await inbox('owner')).notifications.length;
  notify(h.ctx, [h.users.owner!.id], { kind: 'directory.blocked', title: 'Blocked', dedupe: true });
  notify(h.ctx, [h.users.owner!.id], { kind: 'directory.blocked', title: 'Blocked again', dedupe: true });
  assert.equal((await inbox('owner')).notifications.length, before + 1);
  notify(h.ctx, [h.users.owner!.id, h.users.owner!.id], { kind: 'other', title: 'listed twice' }); // the same person twice counts once
  assert.equal((await inbox('owner')).notifications.length, before + 2);
});

test('email: opt-in queues an outbox row; sending works with a mailer, failures are kept and retried a limited number of times', async () => {
  assert.equal((await h.call('PUT', '/api/me/notification-settings', { token: tok.ed, body: { email: 'yes' } })).status, 400);
  assert.equal((await h.call('PUT', '/api/me/notification-settings', { token: tok.ed, body: { email: true } })).status, 200);
  assert.equal((await inbox('ed')).settings.email, true); assert.equal((await inbox('ed')).settings.emailDelivery, false, 'the dashboard must not promise delivery while no mail provider exists');
  notify(h.ctx, [h.users.ed!.id], { kind: 'test', title: 'Hello Ed', body: 'Body text' });
  notify(h.ctx, [h.users.eve!.id], { kind: 'test', title: 'Hello Eve' });            // eve did not opt in: in-app only
  const queued = h.db.prepare('SELECT * FROM email_outbox').all() as any[];
  assert.equal(queued.length, 1); assert.match(queued[0].body, /turn these emails off/);
  assert.equal(await flushOutbox(h.ctx, null), 0, 'no mailer configured: nothing is sent and nothing is lost');
  const sent: string[] = [];
  assert.equal(await flushOutbox(h.ctx, { send: async (to, subject) => { sent.push(`${to}|${subject}`); } }), 1);
  assert.deepEqual(sent, ['ed@test.example|Hello Ed']); assert.equal(await flushOutbox(h.ctx, { send: async () => { throw new Error('unexpected resend'); } }), 0, 'sent mail is not sent twice');
  notify(h.ctx, [h.users.ed!.id], { kind: 'test', title: 'Will fail' });
  for (let i = 0; i < 7; i++) await flushOutbox(h.ctx, { send: async () => { throw new Error('smtp down'); } });
  const failed = h.db.prepare("SELECT attempts, last_error, sent_at FROM email_outbox WHERE subject = 'Will fail'").get() as any;
  assert.equal(failed.attempts, 5, 'retries stop after 5 attempts'); assert.equal(failed.last_error, 'smtp down'); assert.equal(failed.sent_at, null);
});

// ---------------------------------------------------------------- payroll
test('payroll rates: owners and admins set them, HR can view, everyone else is refused, input is validated, no self-set for admins', async () => {
  const set = (k: string, body: unknown) => h.call('POST', '/api/payroll/rates', { token: tok[k], body });
  const ed = h.users.ed!.id, eve = h.users.eve!.id;
  assert.equal((await set('admin', { userId: ed, hourlyRate: 20, currency: 'USD', effectiveFrom: '2026-10-01' })).status, 201);
  assert.equal((await set('owner', { userId: ed, hourlyRate: 25.5, currency: 'USD', effectiveFrom: '2026-10-20' })).status, 201);
  assert.equal((await set('admin', { userId: ed, hourlyRate: 22, currency: 'USD', effectiveFrom: '2026-10-01' })).status, 201, 'a second rate for the same start date replaces the first');
  for (const k of ['hana', 'mia', 'ed']) assert.equal((await set(k, { userId: eve, hourlyRate: 1, currency: 'USD', effectiveFrom: '2026-10-01' })).status, 403, k);
  assert.equal((await set('admin', { userId: h.users.admin!.id, hourlyRate: 1, currency: 'USD', effectiveFrom: '2026-10-01' })).status, 403, 'an admin cannot set their own pay');
  assert.equal((await set('owner', { userId: h.users.owner!.id, hourlyRate: 90, currency: 'USD', effectiveFrom: '2026-10-01' })).status, 201, 'the owner can');
  for (const bad of [{ hourlyRate: -1 }, { hourlyRate: 99999 }, { currency: 'usd' }, { currency: 'DOLLARS' }, { effectiveFrom: '10/01/2026' }, { effectiveFrom: '2026-13-45' }, { extra: 1 }]) assert.equal((await set('admin', { userId: eve, hourlyRate: 10, currency: 'USD', effectiveFrom: '2026-10-01', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await set('admin', { userId: 'nobody', hourlyRate: 10, currency: 'USD', effectiveFrom: '2026-10-01' })).status, 404);
  const hr = await h.call('GET', '/api/payroll/rates', { token: tok.hana }); assert.equal(hr.status, 200);
  const edRow = hr.json.people.find((p: any) => p.userId === ed); assert.equal(edRow.current.hourlyRate, '25.50'); assert.equal(edRow.changes, 2);
  assert.equal((await h.call('GET', `/api/payroll/rates?userId=${ed}`, { token: tok.admin })).json.rates.length, 2);
  for (const k of ['mia', 'ed']) assert.equal((await h.call('GET', '/api/payroll/rates', { token: tok[k] })).status, 403, k);
  const audits = h.db.prepare("SELECT detail FROM audit_log WHERE action = 'payroll.rate_set'").all() as any[];
  assert.ok(audits.length >= 4 && audits.every(a => !/25\.5|2550|\b90\b/.test(a.detail)), 'rate amounts are not copied into the audit log');
});

test('payroll export: approved time only, rate in force on the entry date, missing rates flagged, CSV safe, audited', async () => {
  const ed = h.users.ed!.id, eve = h.users.eve!.id;
  const entry = (n: number, user: string, date: string, hours: number, status: string) => h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,source,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES (?,?,?,'tracker',?,?,?,0,?,?,?)")
    .run(`pay${n}`, user, `pay-entry-0000-${n}`, `${date}T09:00:00.000Z`, `${date}T${String(9 + hours).padStart(2, '0')}:00:00.000Z`, hours * HOUR, status, iso(T0), iso(T0));
  entry(1, ed, '2026-10-10', 2, 'approved');   // rate 22.00 (replaced the 20.00 for 10-01)
  entry(2, ed, '2026-10-21', 1, 'approved');   // rate 25.50
  entry(3, ed, '2026-10-12', 3, 'pending');
  entry(4, ed, '2026-10-13', 4, 'rejected');
  entry(5, eve, '2026-10-14', 1, 'approved'); // no rate for eve
  h.db.prepare('UPDATE users SET name = ? WHERE id = ?').run('=HYPERLINK("http://evil.example")', eve);
  const q = 'from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z';
  const r = await h.call('GET', `/api/payroll/export?${q}`, { token: tok.hana }); assert.equal(r.status, 200);
  const edLine = r.json.people.find((p: any) => p.userId === ed);
  // Ed also has the 1 h manual entry approved earlier (22 Oct, rate 25.50) and a 20 min manual entry that a reviewer edit sent back to pending.
  assert.equal(edLine.approvedHours, 4); assert.equal(edLine.pendingHours, 3.33); assert.equal(edLine.rejectedHours, 4);
  assert.deepEqual(edLine.lines.map((l: any) => [l.hourlyRate, l.hours, l.amount]).sort(), [['22.00', 2, '44.00'], ['25.50', 2, '51.00']].sort());
  assert.equal(r.json.totals.USD, '95.00'); assert.equal(r.json.missingRateCount, 1); assert.equal(r.json.people.find((p: any) => p.userId === eve).missingRate, true);
  assert.match(r.json.note, /APPROVED/);
  const csv = await h.call('GET', `/api/payroll/export?${q}&format=csv`, { token: tok.admin });
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/); assert.match(csv.headers.get('content-disposition') ?? '', /attachment/);
  assert.ok(csv.text.includes("'=HYPERLINK"), 'spreadsheet formulas are neutralized'); assert.ok(csv.text.includes('44.00') && csv.text.includes('51.00')); assert.match(csv.text, /No pay rate set/);
  for (const k of ['mia', 'ed']) assert.equal((await h.call('GET', `/api/payroll/export?${q}`, { token: tok[k] })).status, 403, k);
  assert.equal((await h.call('GET', '/api/payroll/export?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z', { token: tok.admin })).status, 400, 'at most 93 days');
  assert.equal((await h.call('GET', `/api/payroll/export?${q}&format=xml`, { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', '/api/payroll/export?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z', { token: tok.admin })).status, 400);
  assert.ok((h.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'payroll.exported'").get() as any).c >= 2);
});

// ---------------------------------------------------------------- my data
test('my data export: everything about me, who looked at it, no secrets, and an audit entry', async () => {
  const up = (n: number) => h.call('POST', `/api/screenshots?clientId=shot-00000000-${n}&takenAt=${encodeURIComponent(iso(T0 - n * MIN))}`, { token: tok.ed, raw: png(64, 48, n) });
  const s1 = await up(1); await up(2); assert.equal(s1.status, 201);
  h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,source,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES ('act-e',?,'act-entry-0000-1','tracker',?,?,600000,0,'approved',?,?)").run(h.users.ed!.id, iso(T0 - 2 * HOUR), iso(T0 - HOUR), iso(T0), iso(T0));
  h.db.prepare("INSERT INTO activity_slices (id,user_id,entry_client_id,slice_start_at,duration_seconds,keyboard_count,mouse_count,active_seconds,created_at) VALUES ('sl1',?,'act-entry-0000-1',?,60,5,6,30,?)").run(h.users.ed!.id, iso(T0 - 2 * HOUR), iso(T0));
  assert.equal((await h.call('GET', `/api/screenshots/${s1.json.id}/image`, { token: tok.mia })).status, 200);   // the manager looks: this is audited and must show up for Ed
  const r = await h.call('GET', '/api/me/export', { token: tok.ed });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="my-tracker-data-/); assert.equal(r.headers.get('cache-control'), 'no-store');
  const d = r.json; assert.equal(d.profile.email, 'ed@test.example'); assert.equal(d.profile.manager, 'Mia');
  assert.ok(d.timeEntries.length >= 3); assert.equal(d.screenshots.length, 2); assert.equal(d.activityDailyCounts[0].keyDownCount, 5);
  assert.ok(d.whoLookedAtYourData.some((x: any) => x.by === 'Mia' && /screenshot/.test(x.what)), 'the employee can see that their manager viewed a screenshot');
  assert.equal(d.devices.length >= 0, true); assert.ok(d.policyThatAppliesToYou.retentionDays > 0); assert.match(d.about, /kept for payroll/);
  assert.doesNotMatch(r.text, /password|token_hash|sha256|file_name/i, 'no secrets or internals in the export');
  assert.equal((await h.call('GET', '/api/me/export')).status, 401);
  assert.ok((h.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'me.exported'").get() as any).c >= 1);
  const other = (await h.call('GET', '/api/me/export', { token: tok.eve })).json; assert.equal(other.screenshots.length, 0); assert.ok(!JSON.stringify(other).includes('ed@test.example'), 'nobody else\'s data appears');
});

test('deletion request: employee asks, an admin fulfils (screenshots and activity go, time entries stay), self-resolution and repeats are refused', async () => {
  const filesBefore = h.store.files.size;
  assert.equal((await h.call('POST', '/api/me/data-requests', { token: tok.ed, body: { note: 'please remove my screenshots' } })).status, 201);
  assert.equal((await h.call('POST', '/api/me/data-requests', { token: tok.ed, body: {} })).status, 409);
  assert.ok((await inbox('admin')).notifications.some((n: any) => n.kind === 'data.delete_requested' && n.link === 'privacy'), 'admins are told');
  const queue = await h.call('GET', '/api/admin/data-requests?status=open', { token: tok.hana }); assert.equal(queue.json.requests.length, 1); const id = queue.json.requests[0].id;
  assert.equal((await h.call('GET', '/api/admin/data-requests', { token: tok.mia })).status, 403);
  for (const k of ['ed', 'mia', 'hana']) assert.equal((await h.call('POST', `/api/admin/data-requests/${id}/resolve`, { token: tok[k], body: { action: 'fulfil' } })).status, 403, k);
  assert.equal((await h.call('POST', `/api/admin/data-requests/${id}/resolve`, { token: tok.admin, body: { action: 'maybe' } })).status, 400);
  const done = await h.call('POST', `/api/admin/data-requests/${id}/resolve`, { token: tok.admin, body: { action: 'fulfil', note: 'done' } });
  assert.equal(done.status, 200); assert.deepEqual(done.json.removed, { screenshots: 2, activitySlices: 1 });
  assert.ok(h.store.files.size <= filesBefore, 'the stored images are removed');
  assert.equal(((await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots as any[]).length, 0);
  assert.equal((h.db.prepare("SELECT COUNT(*) c FROM activity_slices WHERE user_id = ?").get(h.users.ed!.id) as any).c, 0); assert.equal((h.db.prepare('SELECT COUNT(*) c FROM activity_daily_rollups WHERE user_id = ?').get(h.users.ed!.id) as any).c, 0);
  assert.ok((h.db.prepare("SELECT COUNT(*) c FROM time_entries WHERE user_id = ?").get(h.users.ed!.id) as any).c >= 3, 'time entries are kept for payroll');
  assert.ok((await inbox('ed')).notifications.some((n: any) => n.kind === 'data.erased'));
  assert.equal((await h.call('POST', `/api/admin/data-requests/${id}/resolve`, { token: tok.admin, body: { action: 'fulfil' } })).status, 409, 'already resolved');
  assert.equal((await h.call('GET', '/api/me/data-requests', { token: tok.ed })).json.requests[0].status, 'fulfilled');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'data.erased'").get());
  // declining needs a reason; an admin cannot resolve their own request, the owner can
  assert.equal((await h.call('POST', '/api/me/data-requests', { token: tok.eve, body: {} })).status, 201);
  const eveReq = (await h.call('GET', '/api/admin/data-requests?status=open', { token: tok.admin })).json.requests[0].id;
  assert.equal((await h.call('POST', `/api/admin/data-requests/${eveReq}/resolve`, { token: tok.admin, body: { action: 'decline' } })).status, 400);
  assert.equal((await h.call('POST', `/api/admin/data-requests/${eveReq}/resolve`, { token: tok.admin, body: { action: 'decline', note: 'we must keep these for an open review' } })).status, 200);
  assert.match((await inbox('eve')).notifications[0].body, /open review/);
  assert.equal((await h.call('POST', '/api/me/data-requests', { token: tok.admin, body: {} })).status, 201);
  const adminReq = (await h.call('GET', '/api/admin/data-requests?status=open', { token: tok.owner })).json.requests[0].id;
  assert.equal((await h.call('POST', `/api/admin/data-requests/${adminReq}/resolve`, { token: tok.admin, body: { action: 'fulfil' } })).status, 403);
  assert.equal((await h.call('POST', `/api/admin/data-requests/${adminReq}/resolve`, { token: tok.owner, body: { action: 'fulfil' } })).status, 200);
});
