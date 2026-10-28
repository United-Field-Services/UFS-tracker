import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, giveConsent, png, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'max', 'ed', 'eve', 'finn']) tok[k] = await h.login(`${k}@test.example`);
  giveConsent(h, 'ed', 'eve', 'finn');
  h.db.prepare("INSERT INTO projects (id,name,client,active,created_at) VALUES ('proj-1','Alpha',NULL,1,?)").run(iso(T0));
  const entry = (n: number, user: string, startOffset: number, minutes: number, status = 'approved', end = true) =>
    h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,project_id,source,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES (?,?,?,'proj-1','tracker',?,?,?,?,?,?,?)")
      .run(`t${n}`, h.users[user]!.id, `tl-entry-0000-${n}`, iso(T0 + startOffset), end ? iso(T0 + startOffset + minutes * MIN) : null, minutes * MIN, 5 * MIN, status, iso(T0), iso(T0));
  entry(1, 'ed', -HOUR, 50);                 // 08:00-08:50 on 22 Oct (T0 = 09:00Z)
  entry(2, 'ed', -3 * HOUR, 60, 'pending');  // 06:00-07:00
  entry(3, 'ed', -DAY, 120);                 // yesterday
  entry(4, 'eve', -2 * HOUR, 30);
  entry(5, 'finn', -2 * HOUR, 45);
  h.db.prepare("INSERT INTO activity_slices (id,user_id,entry_client_id,slice_start_at,duration_seconds,keyboard_count,mouse_count,active_seconds,created_at) VALUES ('s1',?,'tl-entry-0000-1',?,60,10,4,40,?),('s2',?,'tl-entry-0000-1',?,60,6,2,20,?)")
    .run(h.users.ed!.id, iso(T0 - HOUR + 5 * MIN), iso(T0), h.users.ed!.id, iso(T0 - 30 * MIN), iso(T0));
  const up = (token: string, n: number, at: number) => h.call('POST', `/api/screenshots?clientId=shot-00000000-${n}&takenAt=${encodeURIComponent(iso(at))}`, { token, raw: png(64, 48, n) });
  await up(tok.ed, 1, T0 - 50 * MIN); await up(tok.ed, 2, T0 - 20 * MIN); await up(tok.finn, 3, T0 - 2 * HOUR);
});
after(async () => { await h.stop(); });

const day = (k: string, user: string, date = '2026-10-22', extra = '') => h.call('GET', `/api/timeline?userId=${h.users[user]!.id}&date=${date}${extra}`, { token: tok[k] });

test('timeline: a person sees their own day with blocks, totals and screenshots', async () => {
  const r = await h.call('GET', '/api/timeline?date=2026-10-22', { token: tok.ed });
  assert.equal(r.status, 200); assert.equal(r.json.person.name, 'Ed');
  assert.deepEqual(r.json.entries.map((e: any) => e.status), ['pending', 'approved']);
  assert.equal(r.json.totals.trackedMs, 110 * MIN); assert.equal(r.json.totals.idleMs, 10 * MIN); assert.equal(r.json.totals.pending, 1); assert.equal(r.json.totals.screenshots, 2);
  assert.equal(r.json.screenshots.length, 2); assert.equal(r.json.screenshotsHidden, false); assert.equal(r.json.entries[0].projectName, 'Alpha');
  assert.equal(r.json.dayStartAt, '2026-10-22T00:00:00.000Z');
  assert.equal((await day('ed', 'ed', '2026-10-21')).json.totals.trackedMs, 120 * MIN, 'the day before');
  assert.equal((await day('ed', 'ed', '2026-10-20')).json.entries.length, 0);
});

test('timeline: count-only activity per hour, no per-key detail, and viewing someone else is audited', async () => {
  const r = await day('mia', 'ed');
  assert.equal(r.status, 200); assert.ok(r.json.activity); assert.match(r.json.activity.note, /Not a measure of productivity/);
  const hour8 = r.json.activity.hours[8], hour7 = r.json.activity.hours[7];
  assert.equal(hour8.keyDownCount + hour7.keyDownCount, 16); assert.equal(hour8.activeSeconds + hour7.activeSeconds, 60);
  assert.deepEqual(Object.keys(r.json.activity.hours[0]).sort(), ['activeSeconds', 'hour', 'keyDownCount', 'mouseClickCount', 'sampledSeconds'], 'only counts and seconds');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'activity.viewed' AND actor_id = ? AND target_type = 'user'").get(h.users.mia!.id), 'a manager viewing activity is audited');
  const own = await h.call('GET', '/api/timeline?date=2026-10-22', { token: tok.ed }); assert.ok(own.json.activity);
  assert.equal((await day('eve', 'eve')).json.activity, null, 'no activity data means none is shown');
});

test('timeline: visibility follows the same rules as everything else', async () => {
  assert.equal((await day('eve', 'ed')).status, 403, 'a colleague cannot');
  assert.equal((await day('max', 'ed')).status, 403, 'another team\'s manager cannot');
  for (const k of ['mia', 'admin', 'owner', 'hana']) assert.equal((await day(k, 'ed')).status, 200, k);
  assert.equal((await day('mia', 'finn')).status, 403);
  // employee-only screenshot policy hides the pictures but not the hours
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: { screenshotVisibility: 'employee_only' } });
  const hidden = await day('mia', 'ed'); assert.equal(hidden.json.screenshots, null); assert.equal(hidden.json.screenshotsHidden, true); assert.equal(hidden.json.totals.screenshots, null); assert.equal(hidden.json.totals.trackedMs, 110 * MIN);
  assert.equal((await h.call('GET', '/api/timeline?date=2026-10-22', { token: tok.ed })).json.screenshots.length, 2, 'the person still sees their own');
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: {} });
});

test('timeline: timezone offset moves the day boundaries; bad input is refused', async () => {
  const shifted = await day('ed', 'ed', '2026-10-22', '&tzOffsetMinutes=-600');   // UTC-10: the day runs 10:00Z to 10:00Z
  assert.equal(shifted.json.dayStartAt, '2026-10-22T10:00:00.000Z'); assert.equal(shifted.json.entries.length, 0, 'both 22 Oct UTC entries end before this local day starts');
  const previous = await day('ed', 'ed', '2026-10-21', '&tzOffsetMinutes=-600'); assert.equal(previous.json.entries.length, 3, 'they belong to the previous local day, together with the overlapping entry from 21 Oct');
  assert.equal((await h.call('GET', '/api/timeline?date=22-10-2026', { token: tok.ed })).status, 400);
  assert.equal((await h.call('GET', '/api/timeline?date=2026-02-31', { token: tok.ed })).status, 400);
  assert.equal((await h.call('GET', '/api/timeline?date=2026-10-22&tzOffsetMinutes=5000', { token: tok.ed })).status, 400);
  assert.equal((await h.call('GET', '/api/timeline?date=2026-10-22&userId=nobody', { token: tok.admin })).status, 404);
  assert.equal((await h.call('GET', '/api/timeline?date=2026-10-22')).status, 401);
});

test('team summary: managers see their reports, admins and HR see everyone, employees see themselves; facts only', async () => {
  const sum = async (k: string, q = '') => (await h.call('GET', `/api/team/summary${q}`, { token: tok[k] })).json;
  const mia = await sum('mia'); assert.deepEqual(mia.people.map((p: any) => p.name).sort(), ['Ed', 'Eve', 'Mia']);
  const ed = mia.people.find((p: any) => p.name === 'Ed');
  assert.equal(ed.daily.length, 7); assert.equal(ed.trackedMs, 230 * MIN); assert.equal(ed.pendingApprovals, 1); assert.equal(ed.screenshots, 2); assert.equal(ed.activeDays, 2);
  assert.equal(ed.daily.at(-1).trackedMs, 110 * MIN); assert.equal(ed.daily.at(-2).trackedMs, 120 * MIN); assert.equal(mia.totals.pending, 1);
  assert.equal((await sum('admin')).people.length, 9); assert.equal((await sum('hana')).people.length, 9);
  assert.deepEqual((await sum('ed')).people.map((p: any) => p.name), ['Ed']);
  assert.equal((await sum('mia', '?days=3')).dates.length, 3); assert.equal((await sum('mia', '?days=99')).dates.length, 31, 'capped at 31 days');
  assert.match(mia.note, /productivity, attendance or pay/);
  for (const p of mia.people) assert.ok(!('score' in p) && !('productivity' in p), 'no scoring fields');
  assert.equal((await h.call('GET', '/api/team/summary?tzOffsetMinutes=9999', { token: tok.mia })).status, 400);
  assert.equal((await h.call('GET', '/api/team/summary')).status, 401);
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: { screenshotVisibility: 'employee_only' } });
  assert.equal((await sum('mia')).people.find((p: any) => p.name === 'Ed').screenshots, null, 'screenshot counts follow the visibility policy');
  await h.call('PUT', `/api/policy/user/${h.users.ed!.id}`, { token: tok.admin, body: {} });
});
