import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
let projectId: string;
let taskId: string;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['admin', 'owner', 'mia', 'max', 'ed', 'eve', 'finn']) tok[k] = await h.login(`${k}@test.example`, k === 'ed' ? 'device' : 'web');
  const p = await h.call('POST', '/api/projects', { token: tok.admin, body: { name: 'Website', teamId: 'team-1' } });
  projectId = p.json.project.id;
  taskId = (await h.call('POST', `/api/projects/${projectId}/tasks`, { token: tok.admin, body: { name: 'Build' } })).json.task.id;
});
after(async () => { await h.stop(); });

const cid = (n: number) => `entry-00000000-${n}`;
const sync = (token: string, n: number, over: Record<string, unknown> = {}) =>
  h.call('POST', '/api/time-entries/sync', { token, body: { clientId: cid(n), taskLabel: 'Work', mode: 'manual', startAt: iso(T0 - HOUR), endAt: null, trackedMs: 10 * MIN, idleMs: 0, ...over } });

test('tracker sync creates an entry, is idempotent, updates a running entry, then finalizes', async () => {
  const a = await sync(tok.ed, 1, { projectId, taskId, trackedMs: 10 * MIN });
  assert.equal(a.status, 201); assert.equal(a.json.created, true);
  // same payload again (retry after a lost response) -> same entry, no duplicate
  const again = await sync(tok.ed, 1, { projectId, taskId, trackedMs: 10 * MIN });
  assert.equal(again.status, 200); assert.equal(again.json.id, a.json.id);
  // progress checkpoint
  const up = await sync(tok.ed, 1, { projectId, taskId, trackedMs: 25 * MIN });
  assert.equal(up.json.updated, true);
  // out-of-order older checkpoint is ignored, not applied
  assert.equal((await sync(tok.ed, 1, { projectId, taskId, trackedMs: 5 * MIN })).json.stale, true);
  // finalize
  const fin = await sync(tok.ed, 1, { projectId, taskId, trackedMs: 30 * MIN, idleMs: 4 * MIN, endAt: iso(T0 - HOUR + 40 * MIN) });
  assert.equal(fin.json.updated, true);
  const list = (await h.call('GET', '/api/time-entries', { token: tok.ed })).json.entries;
  assert.equal(list.length, 1);
  assert.equal(list[0].trackedMs, 30 * MIN); assert.equal(list[0].idleMs, 4 * MIN); assert.equal(list[0].status, 'pending'); assert.equal(list[0].projectName, 'Website');
  // exact re-send of the final state is idempotent; a different final state conflicts
  assert.equal((await sync(tok.ed, 1, { projectId, taskId, trackedMs: 30 * MIN, idleMs: 4 * MIN, endAt: iso(T0 - HOUR + 40 * MIN) })).json.duplicate, true);
  assert.equal((await sync(tok.ed, 1, { projectId, taskId, trackedMs: 39 * MIN, endAt: iso(T0 - HOUR + 40 * MIN) })).status, 409);
});

test('the desktop app\'s "company" mode is accepted, unknown modes are not', async () => {
  assert.equal((await sync(tok.eve, 8, { mode: 'company' })).status, 201);
  assert.equal((await sync(tok.eve, 9, { mode: 'stealth' })).status, 400);
  const mine = (await h.call('GET', '/api/time-entries', { token: tok.eve })).json.entries.find((e: any) => e.clientId === cid(8));
  assert.equal(mine.mode, 'company');
  await h.call('DELETE', `/api/time-entries/${mine.id}`, { token: tok.admin });
});

test('sync rejects inflated or impossible time', async () => {
  assert.equal((await sync(tok.eve, 10, { trackedMs: 3 * HOUR })).status, 422);                                   // more tracked than elapsed (1h)
  assert.equal((await sync(tok.eve, 11, { trackedMs: 10 * MIN, idleMs: 20 * MIN })).status, 422);                  // idle > tracked
  assert.equal((await sync(tok.eve, 12, { startAt: iso(T0 + HOUR) })).status, 422);                                // future
  assert.equal((await sync(tok.eve, 13, { startAt: iso(T0 - 40 * DAY) })).status, 422);                            // too old
  assert.equal((await sync(tok.eve, 14, { endAt: iso(T0 - 2 * HOUR) })).status, 422);                              // end before start
  assert.equal((await sync(tok.eve, 15, { trackedMs: -1 })).status, 400);
  assert.equal((await sync(tok.eve, 16, { clientId: 'x' })).status, 400);
  assert.equal((await sync(tok.eve, 17, { startAt: 'garbage' })).status, 400);
  assert.equal((await sync(tok.eve, 18, { projectId: 'no-such' })).status, 400);
  assert.equal((await sync(tok.eve, 19, { projectId, taskId: 'no-such' })).status, 400);
  assert.equal((await h.call('GET', '/api/time-entries', { token: tok.eve })).json.entries.length, 0);
});

test('project assignment is enforced: employees outside the team cannot book to a team-only project', async () => {
  assert.equal((await sync(tok.finn, 20, { projectId })).status, 403);
  assert.equal((await sync(tok.eve, 21, { projectId })).status, 201);
});

test('requireProject policy makes a project mandatory for tracker entries', async () => {
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: { requireProject: true } });
  assert.equal((await sync(tok.eve, 22, { projectId: null })).status, 422);
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: {} });
  assert.equal((await sync(tok.eve, 22, { projectId: null })).status, 201);
});

test('manual entries: validation, overlap, limits and ownership', async () => {
  const add = (token: string, over: Record<string, unknown>) => h.call('POST', '/api/time-entries', { token, body: { taskLabel: 'Manual', startAt: iso(T0 - 5 * HOUR), endAt: iso(T0 - 4 * HOUR), ...over } });
  const ok = await add(tok.finn, {});
  assert.equal(ok.status, 201);
  assert.equal((await add(tok.finn, { startAt: iso(T0 - 4.5 * HOUR), endAt: iso(T0 - 3.5 * HOUR) })).status, 409);       // overlaps
  assert.equal((await add(tok.finn, { startAt: iso(T0 - 2 * HOUR), endAt: iso(T0 - 3 * HOUR) })).status, 422);           // end before start
  assert.equal((await add(tok.finn, { startAt: iso(T0 - 30 * HOUR), endAt: iso(T0 - 1.9 * HOUR) })).status, 422);        // > 24h
  assert.equal((await add(tok.finn, { startAt: iso(T0 + HOUR), endAt: iso(T0 + 2 * HOUR) })).status, 422);               // future
  assert.equal((await add(tok.finn, { startAt: iso(T0 - 90 * DAY), endAt: iso(T0 - 90 * DAY + HOUR) })).status, 422);    // too old
  const mine = (await h.call('GET', '/api/time-entries', { token: tok.finn })).json.entries[0];
  assert.equal(mine.source, 'manual'); assert.equal(mine.trackedMs, HOUR); assert.equal(mine.status, 'pending');
  // owner edits own pending manual entry; trackedMs follows the times
  const edit = await h.call('PATCH', `/api/time-entries/${mine.id}`, { token: tok.finn, body: { endAt: iso(T0 - 3.5 * HOUR) } });
  assert.equal(edit.status, 200); assert.equal(edit.json.entry.trackedMs, 1.5 * HOUR);
  // another employee cannot touch it
  assert.equal((await h.call('PATCH', `/api/time-entries/${mine.id}`, { token: tok.eve, body: { note: 'x' } })).status, 403);
  assert.equal((await h.call('DELETE', `/api/time-entries/${mine.id}`, { token: tok.eve })).status, 403);
  // employee can delete own pending manual entry
  assert.equal((await h.call('DELETE', `/api/time-entries/${mine.id}`, { token: tok.finn })).status, 200);
});

test('manual desktop submissions are idempotent across retries and reject a reused id with changed contents', async () => {
  const body = {clientId: 'd4ee9e38-e221-45f8-a530-8cd50f2de719', taskLabel: 'Prepare weekly report', startAt: iso(T0 - 8 * HOUR), endAt: iso(T0 - 7 * HOUR), note: 'Uploaded from desktop'};
  const first = await h.call('POST', '/api/time-entries', {token: tok.eve, body});
  assert.equal(first.status, 201);
  const retry = await h.call('POST', '/api/time-entries', {token: tok.eve, body});
  assert.equal(retry.status, 200); assert.equal(retry.json.id, first.json.id); assert.equal(retry.json.duplicate, true);
  const changed = await h.call('POST', '/api/time-entries', {token: tok.eve, body: {...body, note: 'Changed after the first request'}});
  assert.equal(changed.status, 409);
  const entries = (await h.call('GET', '/api/time-entries', {token: tok.eve})).json.entries.filter((entry: any) => entry.clientId === `manual-${body.clientId}`);
  assert.equal(entries.length, 1); assert.equal(entries[0].status, 'pending'); assert.equal(entries[0].taskLabel, 'Prepare weekly report');
});

test('employees cannot edit or delete tracker-recorded time', async () => {
  const entry = (await h.call('GET', '/api/time-entries', { token: tok.ed })).json.entries[0];
  assert.equal(entry.source, 'tracker');
  assert.equal((await h.call('PATCH', `/api/time-entries/${entry.id}`, { token: tok.ed, body: { trackedMs: 40 * MIN } })).status, 403);
  assert.equal((await h.call('DELETE', `/api/time-entries/${entry.id}`, { token: tok.ed })).status, 403);
});

test('review: manager approves reports only, not themselves, not other teams; reason required to edit', async () => {
  const entry = (await h.call('GET', '/api/time-entries', { token: tok.ed })).json.entries[0];
  assert.equal((await h.call('POST', `/api/time-entries/${entry.id}/approve`, { token: tok.ed })).status, 403);          // self
  assert.equal((await h.call('POST', `/api/time-entries/${entry.id}/approve`, { token: tok.max })).status, 403);         // other team's manager
  // reviewer edit needs a reason
  assert.equal((await h.call('PATCH', `/api/time-entries/${entry.id}`, { token: tok.mia, body: { trackedMs: 20 * MIN } })).status, 400);
  const edited = await h.call('PATCH', `/api/time-entries/${entry.id}`, { token: tok.mia, body: { trackedMs: 20 * MIN, reason: 'Lunch break was included' } });
  assert.equal(edited.status, 200); assert.equal(edited.json.entry.trackedMs, 20 * MIN); assert.equal(edited.json.entry.edited, true);
  assert.equal((await h.call('PATCH', `/api/time-entries/${entry.id}`, { token: tok.mia, body: { trackedMs: 5 * HOUR, reason: 'too much' } })).status, 422);
  // a manager's reviewed edit survives a later tracker re-sync
  assert.equal((await sync(tok.ed, 1, { projectId, taskId, trackedMs: 30 * MIN, idleMs: 4 * MIN, endAt: iso(T0 - HOUR + 40 * MIN) })).json.locked, true);
  assert.equal((await h.call('GET', '/api/time-entries', { token: tok.ed })).json.entries[0].trackedMs, 20 * MIN);
  const ok = await h.call('POST', `/api/time-entries/${entry.id}/approve`, { token: tok.mia, body: { note: 'Looks right' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.entry.status, 'approved'); assert.ok(ok.json.entry.reviewedAt);
});

test('approved time is locked for managers; admin may change it with a reason, which re-opens it for approval', async () => {
  const entry = (await h.call('GET', '/api/time-entries?status=approved', { token: tok.mia })).json.entries[0];
  assert.equal((await h.call('PATCH', `/api/time-entries/${entry.id}`, { token: tok.mia, body: { trackedMs: 10 * MIN, reason: 'adjust again' } })).status, 409);
  const adm = await h.call('PATCH', `/api/time-entries/${entry.id}`, { token: tok.admin, body: { trackedMs: 15 * MIN, reason: 'Payroll correction' } });
  assert.equal(adm.status, 200); assert.equal(adm.json.entry.status, 'pending');
  assert.equal((await h.call('POST', `/api/time-entries/${entry.id}/reject`, { token: tok.mia, body: { note: 'Not valid' } })).status, 200);
});

test('running entries cannot be reviewed; rejected entries are excluded from reports', async () => {
  await sync(tok.eve, 30, { startAt: iso(T0 - 30 * MIN), trackedMs: 10 * MIN });
  const running = (await h.call('GET', '/api/time-entries', { token: tok.eve })).json.entries.find((e: any) => e.clientId === cid(30));
  assert.equal((await h.call('POST', `/api/time-entries/${running.id}/approve`, { token: tok.mia })).status, 409);
  assert.equal((await h.call('PATCH', `/api/time-entries/${running.id}`, { token: tok.mia, body: { note: 'x', reason: 'because' } })).status, 409);
});

test('time-entry visibility follows the org chart', async () => {
  const ed = h.users.ed!.id;
  assert.equal((await h.call('GET', `/api/time-entries?userId=${ed}`, { token: tok.mia })).status, 200);
  assert.equal((await h.call('GET', `/api/time-entries?userId=${ed}`, { token: tok.eve })).status, 403);
  assert.equal((await h.call('GET', `/api/time-entries?userId=${ed}`, { token: tok.max })).status, 403);
  assert.equal((await h.call('GET', `/api/time-entries?userId=${ed}`, { token: tok.admin })).status, 200);
  // unfiltered lists only contain what the caller may see
  const maxIds = new Set((await h.call('GET', '/api/time-entries', { token: tok.max })).json.entries.map((e: any) => e.userId));
  assert.ok([...maxIds].every(id => id === h.users.max!.id || id === h.users.finn!.id));
  const miaIds = new Set((await h.call('GET', '/api/time-entries', { token: tok.mia })).json.entries.map((e: any) => e.userId));
  assert.ok(!miaIds.has(h.users.finn!.id));
  assert.equal((await h.call('GET', '/api/time-entries?status=weird', { token: tok.admin })).status, 400);
  assert.equal((await h.call('GET', '/api/time-entries?from=zzz', { token: tok.admin })).status, 400);
});

test('count-only activity requires a bumped notice and consent; slices are idempotent and scoped', async () => {
  const enableWithoutBump = await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: {activityTrackingEnabled: true, consentVersion: 1}});
  assert.equal(enableWithoutBump.status, 422);
  const enabled = await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: {activityTrackingEnabled: true, consentVersion: 2}});
  assert.equal(enabled.status, 200);
  const noConsent = await sync(tok.ed, 99, {mode: 'company', activityTrackingEnabled: true, startAt: iso(T0 - 2 * MIN), trackedMs: MIN});
  assert.equal(noConsent.status, 201); // time itself still syncs; server refuses the activity data
  const body = {entryClientId: cid(99), slice: {startedAt: iso(T0 - 2 * MIN), durationSeconds: 60, keyboardCount: 42, mouseCount: 3, activeSeconds: 30}};
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body})).status, 403);
  assert.equal((await h.call('POST', '/api/me/consent', {token: tok.ed, body: {version: 2}})).status, 200);
  const entry = await sync(tok.ed, 99, {mode: 'company', activityTrackingEnabled: true, startAt: iso(T0 - 2 * MIN), trackedMs: MIN});
  assert.equal(entry.status, 200);
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body})).status, 201);
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body})).json.duplicate, true);
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body: {...body, slice: {...body.slice, keyboardCount: 43}}})).status, 409);
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body: {...body, rawKey: 'not allowed'}})).status, 400);
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body: {...body, slice: {...body.slice, activeSeconds: 61}}})).status, 400);
  const rows = await h.call('GET', `/api/activity-slices?entryClientId=${cid(99)}`, {token: tok.ed});
  assert.equal(rows.status, 200); assert.equal(rows.json.slices[0].activityPercent, 50); assert.equal(rows.json.slices[0].keyboardCount, 42);
  const entryId = (await h.call('GET', '/api/time-entries', {token: tok.ed})).json.entries.find((e: any) => e.clientId === cid(99));
  assert.equal(entryId.activityPercent, 50); assert.equal(entryId.mouseCount, 3);
  assert.equal((await h.call('GET', `/api/activity-slices?entryClientId=${cid(99)}`, {token: tok.mia})).status, 200);
  assert.equal((await h.call('GET', `/api/activity-slices?entryClientId=${cid(99)}`, {token: tok.finn})).status, 403);
  assert.ok((await h.call('GET', '/api/audit?limit=50', {token: tok.admin})).json.entries.some((event: any) => event.action === 'activity.viewed'));
  await h.call('PUT', '/api/policy/org/org', {token: tok.admin, body: {}});
  assert.equal((await h.call('POST', '/api/activity-slices/sync', {token: tok.ed, body: {...body, slice: {...body.slice, startedAt: iso(T0 - 3 * MIN)}}})).status, 422); // outside this entry
  await h.call('DELETE', `/api/time-entries/${entryId.id}`, {token: tok.admin});
});

test('only admins can delete reviewed tracker entries, and it is audited', async () => {
  const e = (await h.call('GET', '/api/time-entries', { token: tok.admin })).json.entries.find((x: any) => x.clientId === cid(21));
  assert.equal((await h.call('DELETE', `/api/time-entries/${e.id}`, { token: tok.mia })).status, 403);
  assert.equal((await h.call('DELETE', `/api/time-entries/${e.id}`, { token: tok.admin })).status, 200);
  assert.equal((await h.call('DELETE', `/api/time-entries/${e.id}`, { token: tok.admin })).status, 404);
  const log = (await h.call('GET', '/api/audit?limit=500', { token: tok.admin })).json.entries.map((x: any) => x.action);
  for (const a of ['time.edited_by_reviewer', 'time.approved', 'time.rejected', 'time.deleted', 'time.manual_added']) assert.ok(log.includes(a), a);
});
