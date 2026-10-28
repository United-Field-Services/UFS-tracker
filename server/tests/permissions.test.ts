import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORD, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'mia', 'max', 'ed', 'eve', 'finn', 'loner']) tok[k] = await h.login(`${k}@test.example`);
});
after(async () => { await h.stop(); });

const names = (r: any) => r.json.users.map((u: any) => u.name).sort();

test('user list is scoped: admin sees all, manager sees self + reports, employee sees only self', async () => {
  assert.equal((await h.call('GET', '/api/users', { token: tok.admin })).json.users.length, 9);
  assert.deepEqual(names(await h.call('GET', '/api/users', { token: tok.mia })), ['Ed', 'Eve', 'Mia']);
  assert.deepEqual(names(await h.call('GET', '/api/users', { token: tok.max })), ['Finn', 'Max']);
  assert.deepEqual(names(await h.call('GET', '/api/users', { token: tok.ed })), ['Ed']);
});

test('only owner/admin can create or modify users, reset passwords, set policy or read the audit log', async () => {
  const body = { email: 'x@test.example', name: 'X', temporaryPassword: 'Temp-pass-12345' };
  for (const k of ['mia', 'ed']) {
    assert.equal((await h.call('POST', '/api/users', { token: tok[k], body })).status, 403, k);
    assert.equal((await h.call('PATCH', `/api/users/${h.users.finn!.id}`, { token: tok[k], body: { name: 'Hacked' } })).status, 403, k);
    assert.equal((await h.call('POST', `/api/users/${h.users.finn!.id}/reset-password`, { token: tok[k], body: { temporaryPassword: 'Temp-pass-12345' } })).status, 403, k);
    assert.equal((await h.call('PUT', '/api/policy/org/org', { token: tok[k], body: { retentionDays: 1 } })).status, 403, k);
    assert.equal((await h.call('GET', '/api/audit', { token: tok[k] })).status, 403, k);
    assert.equal((await h.call('POST', '/api/teams', { token: tok[k], body: { name: 'Nope' } })).status, 403, k);
    assert.equal((await h.call('POST', '/api/admin/retention/run', { token: tok[k] })).status, 403, k);
  }
  assert.equal((await h.call('GET', '/api/audit', { token: tok.admin })).status, 200);
});

test('admin cannot create or promote to owner, nor modify an owner; owner can', async () => {
  const mk = { email: 'o2@test.example', name: 'O2', role: 'owner', temporaryPassword: 'Temp-pass-12345' };
  assert.equal((await h.call('POST', '/api/users', { token: tok.admin, body: mk })).status, 403);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.ed!.id}`, { token: tok.admin, body: { role: 'owner' } })).status, 403);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.owner!.id}`, { token: tok.admin, body: { name: 'Taken over' } })).status, 403);
  assert.equal((await h.call('POST', `/api/users/${h.users.owner!.id}/reset-password`, { token: tok.admin, body: { temporaryPassword: 'Temp-pass-12345' } })).status, 403);
  assert.equal((await h.call('POST', '/api/users', { token: tok.owner, body: mk })).status, 201);
});

test('the last active owner cannot be demoted or deactivated', async () => {
  const o2 = (await h.call('GET', '/api/users', { token: tok.owner })).json.users.find((u: any) => u.email === 'o2@test.example');
  // two owners now: demoting one is fine
  assert.equal((await h.call('PATCH', `/api/users/${o2.id}`, { token: tok.owner, body: { role: 'admin' } })).status, 200);
  // one owner left
  assert.equal((await h.call('PATCH', `/api/users/${h.users.owner!.id}`, { token: tok.owner, body: { role: 'admin' } })).status, 409);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.owner!.id}`, { token: tok.owner, body: { active: false } })).status, 409);
});

test('user validation: duplicate email, weak password, bad manager/team, self-management, unknown fields', async () => {
  const base = { email: 'dup@test.example', name: 'Dup', temporaryPassword: 'Temp-pass-12345' };
  assert.equal((await h.call('POST', '/api/users', { token: tok.admin, body: base })).status, 201);
  assert.equal((await h.call('POST', '/api/users', { token: tok.admin, body: { ...base, email: 'DUP@test.example' } })).status, 409);
  assert.equal((await h.call('POST', '/api/users', { token: tok.admin, body: { ...base, email: 'w@test.example', temporaryPassword: 'weak' } })).status, 400);
  assert.equal((await h.call('POST', '/api/users', { token: tok.admin, body: { ...base, email: 'm@test.example', managerId: 'nonexistent' } })).status, 400);
  assert.equal((await h.call('POST', '/api/users', { token: tok.admin, body: { ...base, email: 't@test.example', teamId: 'nonexistent' } })).status, 400);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.ed!.id}`, { token: tok.admin, body: { managerId: h.users.ed!.id } })).status, 400);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.ed!.id}`, { token: tok.admin, body: { password_hash: 'x' } })).status, 400);
  assert.equal((await h.call('PATCH', '/api/users/does-not-exist', { token: tok.admin, body: { name: 'x' } })).status, 404);
});

test('admin password reset forces change and signs the user out everywhere', async () => {
  const before = await h.login('loner@test.example');
  assert.equal((await h.call('POST', `/api/users/${h.users.loner!.id}/reset-password`, { token: tok.admin, body: { temporaryPassword: 'Reset-pass-98765' } })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { token: before })).status, 401);
  const login = await h.call('POST', '/api/auth/login', { body: { email: 'loner@test.example', password: 'Reset-pass-98765' } });
  assert.equal(login.json.user.mustChangePassword, true);
});

test('revoke-sessions signs a user out of all devices', async () => {
  const t = await h.login('finn@test.example', 'device');
  const r = await h.call('POST', `/api/users/${h.users.finn!.id}/revoke-sessions`, { token: tok.admin });
  assert.equal(r.status, 200);
  assert.ok(r.json.revoked >= 1);
  assert.equal((await h.call('GET', '/api/me', { token: t })).status, 401);
});

test('moving an employee to another manager changes who can see them', async () => {
  assert.equal((await h.call('GET', `/api/time-entries?userId=${h.users.ed!.id}`, { token: tok.max })).status, 403);
  assert.equal((await h.call('PATCH', `/api/users/${h.users.ed!.id}`, { token: tok.admin, body: { managerId: h.users.max!.id } })).status, 200);
  assert.equal((await h.call('GET', `/api/time-entries?userId=${h.users.ed!.id}`, { token: tok.max })).status, 200);
  assert.equal((await h.call('GET', `/api/time-entries?userId=${h.users.ed!.id}`, { token: tok.mia })).status, 403);
  await h.call('PATCH', `/api/users/${h.users.ed!.id}`, { token: tok.admin, body: { managerId: h.users.mia!.id } });
});

test('projects: managers/admins create, employees cannot; employees see only active projects for their team', async () => {
  const mk = (token: string, body: unknown) => h.call('POST', '/api/projects', { token, body });
  assert.equal((await mk(tok.ed, { name: 'Nope' })).status, 403);
  const open = await mk(tok.mia, { name: 'Open project' });
  const t1 = await mk(tok.admin, { name: 'Team 1 only', teamId: 'team-1' });
  const t2 = await mk(tok.admin, { name: 'Team 2 only', teamId: 'team-2' });
  assert.equal(open.status, 201); assert.equal(t1.status, 201);
  assert.equal((await mk(tok.admin, { name: 'Bad team', teamId: 'nope' })).status, 400);
  assert.equal((await mk(tok.admin, { name: '' })).status, 400);
  const ed = (await h.call('GET', '/api/projects', { token: tok.ed })).json.projects.map((p: any) => p.name).sort();
  assert.deepEqual(ed, ['Open project', 'Team 1 only']);
  const finn = (await h.call('GET', '/api/projects', { token: await h.login('finn@test.example') })).json.projects.map((p: any) => p.name).sort();
  assert.deepEqual(finn, ['Open project', 'Team 2 only']);
  // deactivate hides from employees
  assert.equal((await h.call('PATCH', `/api/projects/${open.json.project.id}`, { token: tok.mia, body: { active: false } })).status, 200);
  assert.ok(!(await h.call('GET', '/api/projects', { token: tok.ed })).json.projects.some((p: any) => p.name === 'Open project'));
  assert.ok((await h.call('GET', '/api/projects', { token: tok.mia })).json.projects.some((p: any) => p.name === 'Open project'));
  // tasks
  const task = await h.call('POST', `/api/projects/${t1.json.project.id}/tasks`, { token: tok.mia, body: { name: 'Design' } });
  assert.equal(task.status, 201);
  assert.equal((await h.call('POST', `/api/projects/${t1.json.project.id}/tasks`, { token: tok.ed, body: { name: 'x' } })).status, 403);
  assert.equal((await h.call('POST', '/api/projects/none/tasks', { token: tok.mia, body: { name: 'x' } })).status, 404);
  assert.equal((await h.call('PATCH', `/api/tasks/${task.json.task.id}`, { token: tok.mia, body: { active: false } })).status, 200);
  assert.equal((await h.call('GET', '/api/projects', { token: tok.ed })).json.projects.find((p: any) => p.name === 'Team 1 only').tasks.length, 0);
  void t2;
});

test('teams: unique names', async () => {
  assert.equal((await h.call('POST', '/api/teams', { token: tok.admin, body: { name: 'Team One' } })).status, 409);
  assert.equal((await h.call('POST', '/api/teams', { token: tok.admin, body: { name: 'Ops' } })).status, 201);
});

test('every state-changing admin action is written to the audit log', async () => {
  const log = (await h.call('GET', '/api/audit?limit=500', { token: tok.admin })).json.entries.map((e: any) => e.action);
  for (const a of ['user.created', 'user.updated', 'user.password_reset', 'user.sessions_revoked', 'project.created', 'task.created', 'team.created', 'auth.login']) assert.ok(log.includes(a), `missing ${a}`);
  void PASSWORD;
});
