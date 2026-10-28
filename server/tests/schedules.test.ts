import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';
import { runDueReports } from '../src/report-schedules.ts';

let h: Harness;
let tok: Record<string, string>;
// T0 is Thursday 22 Oct 2026 09:00 UTC. The report covers the seven full days before the send day: 15-21 Oct.
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'max', 'ed', 'eve', 'finn']) tok[k] = await h.login(`${k}@test.example`);
  const entry = (n: number, user: string, startIso: string, minutes: number, status: string) => h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,source,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES (?,?,?,'tracker',?,?,?,0,?,?,?)")
    .run(`r${n}`, h.users[user]!.id, `rep-entry-0000-${n}`, startIso, new Date(Date.parse(startIso) + minutes * MIN).toISOString(), minutes * MIN, status, iso(T0), iso(T0));
  entry(1, 'ed', '2026-10-18T09:00:00.000Z', 180, 'approved');
  entry(2, 'eve', '2026-10-20T09:00:00.000Z', 120, 'pending');
  entry(3, 'finn', '2026-10-19T09:00:00.000Z', 60, 'approved');
  entry(4, 'ed', '2026-10-22T08:00:00.000Z', 600, 'approved');     // today: not part of last week's report
  entry(5, 'ed', '2026-10-10T09:00:00.000Z', 600, 'approved');     // too old
  h.db.prepare("INSERT INTO breaks (id,user_id,entry_client_id,start_at,end_at,created_at,updated_at) VALUES ('b1',?,'rep-entry-0000-1','2026-10-18T10:00:00.000Z','2026-10-18T10:20:00.000Z',?,?)").run(h.users.ed!.id, iso(T0), iso(T0));
});
after(async () => { await h.stop(); });

const subscribe = (k: string, body: Record<string, unknown>) => h.call('POST', '/api/report-subscriptions', { token: tok[k], body: { kind: 'team-hours', weekday: 4, hour: 8, timeZone: 'UTC', ...body } });
const inbox = async (k: string) => (await h.call('GET', '/api/notifications', { token: tok[k] })).json.notifications as any[];

test('subscriptions: role rules, validation, one per report kind, own only', async () => {
  const avail = async (k: string) => (await h.call('GET', '/api/report-subscriptions', { token: tok[k] })).json;
  assert.deepEqual((await avail('ed')).available.map((a: any) => a.kind), ['my-hours']);
  assert.deepEqual((await avail('mia')).available.map((a: any) => a.kind).sort(), ['approvals', 'my-hours', 'team-hours']);
  assert.deepEqual((await avail('hana')).available.map((a: any) => a.kind).sort(), ['my-hours', 'team-hours'], 'HR gets no approval digest: it cannot approve');
  assert.equal((await avail('ed')).emailDelivery, false);
  assert.equal((await subscribe('ed', { kind: 'team-hours' })).status, 403); assert.equal((await subscribe('ed', { kind: 'approvals' })).status, 403); assert.equal((await subscribe('hana', { kind: 'approvals' })).status, 403);
  for (const bad of [{ weekday: 7 }, { weekday: -1 }, { hour: 24 }, { hour: 1.5 }, { timeZone: 'Mars/Base' }, { kind: 'payroll' }, { extra: true }]) assert.equal((await subscribe('mia', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await subscribe('mia', {})).status, 201);
  const again = await subscribe('mia', { hour: 9 }); assert.equal(again.status, 200); assert.equal(again.json.updated, true);
  const list = (await avail('mia')).subscriptions; assert.equal(list.length, 1); assert.equal(list[0].hour, 9);
  assert.equal((await h.call('DELETE', `/api/report-subscriptions/${list[0].id}`, { token: tok.ed })).status, 404, 'not someone else\'s');
  assert.equal((await h.call('DELETE', `/api/report-subscriptions/${list[0].id}`, { token: tok.mia })).status, 200);
  assert.equal((await avail('mia')).subscriptions.length, 0);
  assert.equal((await h.call('GET', '/api/report-subscriptions')).status, 401);
});

test('a weekly report is sent once when it is due, in the subscriber\'s timezone, and again the next week', async () => {
  await subscribe('mia', { hour: 8 });                                        // Thursday 08:00 UTC: due at T0 (09:00)
  await subscribe('admin', { weekday: 5 });                                   // Friday: not due on Thursday
  await subscribe('owner', { hour: 12 });                                     // Thursday 12:00: not yet
  await subscribe('hana', { timeZone: 'Asia/Kolkata', hour: 15 });           // 14:30 local: not yet
  await subscribe('max', { timeZone: 'Asia/Kolkata', hour: 14 });             // 14:30 local: due
  assert.equal(runDueReports(h.ctx, T0), 2, 'mia and max');
  assert.equal(runDueReports(h.ctx, T0 + 30 * MIN), 1, 'hana: 15:00 in Kolkata is 09:30 UTC');
  assert.equal(runDueReports(h.ctx, T0 + 31 * MIN), 0, 'never twice on the same day');
  assert.equal(runDueReports(h.ctx, T0 + 3 * HOUR), 1, 'owner at 12:00 UTC');
  assert.equal(runDueReports(h.ctx, T0 + 3 * HOUR + DAY), 1, 'only the Friday subscription (admin) the next day');
});

test('report content follows the subscriber\'s visibility and last week\'s dates; email is queued even without the email-copy setting', async () => {
  const miaNote = (await inbox('mia')).find(n => n.kind === 'report.team-hours');
  assert.match(miaNote.title, /Weekly team hours \(2026-10-15 to 2026-10-21\)/); assert.equal(miaNote.link, 'team');
  const email = h.db.prepare("SELECT body, subject FROM email_outbox o JOIN users u ON u.id = o.user_id WHERE u.email = 'mia@test.example' AND o.subject LIKE 'Weekly team hours%'").get() as any;
  assert.ok(email, 'the subscription is an explicit request for email, so the outbox row exists although mia never turned on email copies');
  assert.match(email.body, /Ed: 3h 00m tracked, 0h 20m in breaks/); assert.match(email.body, /Eve: 2h 00m tracked, 1 waiting for approval/);
  assert.doesNotMatch(email.body, /Finn/, 'Finn is on another team'); assert.doesNotMatch(email.body, /10h|600/, 'today\'s and older entries are not in last week\'s totals');
  assert.match(email.body, /productivity, attendance or pay measure/); assert.match(email.body, /you subscribed to it/);
  const maxNote = (await inbox('max')).find(n => n.kind === 'report.team-hours'); assert.ok(maxNote.body.includes('Finn') && !maxNote.body.includes('Ed'));
  // a subscription in an organisation-wide scope sees everyone
  await subscribe('admin', { weekday: 4, hour: 8 });
  assert.equal(runDueReports(h.ctx, T0 + 5 * HOUR) >= 1, true);
  const adminEmail = h.db.prepare("SELECT body FROM email_outbox o JOIN users u ON u.id = o.user_id WHERE u.email = 'admin@test.example'").get() as any;
  assert.ok(/Ed:/.test(adminEmail.body) && /Eve:/.test(adminEmail.body) && /Finn:/.test(adminEmail.body));
  // next Thursday it is due again
  assert.equal(runDueReports(h.ctx, T0 + 7 * DAY) >= 2, true);
  assert.ok((await inbox('mia')).filter(n => n.kind === 'report.team-hours').length >= 2);
});

test('my-hours, approvals digest, send-now and inactive people', async () => {
  await subscribe('ed', { kind: 'my-hours', weekday: 4, hour: 8 });
  assert.equal(runDueReports(h.ctx, T0 + 2 * HOUR) >= 1, true);
  const mine = (await inbox('ed')).find(n => n.kind === 'report.my-hours'); assert.match(mine.body, /3h 00m tracked/); assert.equal(mine.link, 'timeline');
  assert.ok(!(await inbox('eve')).some(n => n.kind === 'report.my-hours'));
  // approvals digest: only entries the subscriber can review; nothing to say means nothing is sent
  await subscribe('mia', { kind: 'approvals', weekday: 4, hour: 8 });
  const before = (await inbox('mia')).length;
  runDueReports(h.ctx, T0 + 2 * HOUR + MIN);
  const digest = (await inbox('mia')).find(n => n.kind === 'report.approvals'); assert.ok(digest); assert.match(digest.title, /: 1$/); assert.match(digest.body, /Eve: 1 entry/);
  h.db.prepare("UPDATE time_entries SET status = 'approved' WHERE id = 'r2'").run();
  const after = (await inbox('mia')).length; runDueReports(h.ctx, T0 + 7 * DAY + 2 * HOUR);
  assert.equal((await inbox('mia')).filter(n => n.kind === 'report.approvals').length, 1, 'no pending entries: no digest');
  void before; void after;
  const subs = (await h.call('GET', '/api/report-subscriptions', { token: tok.mia })).json.subscriptions as any[];
  const approvals = subs.find(s => s.kind === 'approvals');
  const now = await h.call('POST', `/api/report-subscriptions/${approvals.id}/send-now`, { token: tok.mia }); assert.equal(now.status, 200); assert.equal(now.json.sent, true, 'send-now sends even an empty digest');
  assert.equal((await h.call('POST', `/api/report-subscriptions/${approvals.id}/send-now`, { token: tok.ed })).status, 404);
  h.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(h.users.max!.id);
  const countFor = () => (h.db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ?').get(h.users.max!.id) as any).c; const maxCount = countFor(); runDueReports(h.ctx, T0 + 14 * DAY + 2 * HOUR); assert.equal(countFor(), maxCount, 'inactive people get nothing');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'report.sent'").get()); assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'report.subscribed'").get());
});
