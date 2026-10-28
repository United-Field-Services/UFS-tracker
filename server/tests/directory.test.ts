import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyPassword } from '../src/auth.ts';
import { loadDirectoryConfig, mapRole, parseFeed, runDirectorySync, startDirectoryScheduler, type DirectoryConfig } from '../src/directory.ts';
import { FAKE_TOKEN, startFakeDirectory, syntheticFeed, type FakeFeed } from '../src/fake-directory.ts';
import { setup, iso, HOUR, T0, MIN } from './helpers.ts';

// Every test gets its own fake directory (synthetic people), tracker app and clock.
async function env(opts: { count?: number; owner?: string | null } = {}) {
  const clock = { now: T0 };
  const dir = await startFakeDirectory({ count: opts.count ?? 30, now: () => clock.now });
  const cfg: DirectoryConfig = { url: dir.url, token: FAKE_TOKEN, intervalMinutes: 15, ownerEmployeeId: opts.owner === undefined ? 'emp-001' : opts.owner };
  const h = await setup(undefined, { directory: cfg, clock });
  const tok = { owner: await h.login('owner@test.example'), admin: await h.login('admin@test.example') };
  const sync = (token = tok.owner, body: unknown = {}) => h.call('POST', '/api/directory/sync', { token, body });
  const userOf = (empId: string) => h.db.prepare('SELECT * FROM users WHERE directory_id = ?').get(empId) as any;
  const tokenFor = (empId: string) => issueToken(h.db, h.ctx.cfg, userOf(empId).id, 'web', null).token;
  const count = (sql: string, ...args: any[]) => Number((h.db.prepare(sql).get(...args) as any).c);
  const run = async (fn: (e: any) => Promise<void>) => { try { await fn(e); } finally { await dir.close(); await h.stop(); } };
  const e = { clock, dir, h, db: h.db as any, tok, sync, userOf, tokenFor, count, run, cfg };
  return e;
}
const rawFeed = (n = 30): any => syntheticFeed(n, T0);

// ---------------- configuration ----------------
test('config: off unless both URL and token are set; https required except localhost; token must be long', () => {
  assert.equal(loadDirectoryConfig({}), null);
  assert.throws(() => loadDirectoryConfig({ DIRECTORY_URL: 'https://x.example/d' }), /both/);
  assert.throws(() => loadDirectoryConfig({ DIRECTORY_TOKEN: 'a'.repeat(30) }), /both/);
  assert.throws(() => loadDirectoryConfig({ DIRECTORY_URL: 'http://people.example.com/d', DIRECTORY_TOKEN: 'a'.repeat(30) }), /https/);
  assert.throws(() => loadDirectoryConfig({ DIRECTORY_URL: 'https://user:pw@people.example.com/d', DIRECTORY_TOKEN: 'a'.repeat(30) }), /credentials/);
  assert.throws(() => loadDirectoryConfig({ DIRECTORY_URL: 'not a url', DIRECTORY_TOKEN: 'a'.repeat(30) }), /valid URL/);
  assert.throws(() => loadDirectoryConfig({ DIRECTORY_URL: 'https://people.example.com/d', DIRECTORY_TOKEN: 'short' }), /too short/);
  const ok = loadDirectoryConfig({ DIRECTORY_URL: 'http://localhost:4310/directory.json', DIRECTORY_TOKEN: 'a'.repeat(30), DIRECTORY_SYNC_MINUTES: '0', DIRECTORY_OWNER_EMPLOYEE_ID: ' emp-001 ' })!;
  assert.equal(ok.intervalMinutes, 1); assert.equal(ok.ownerEmployeeId, 'emp-001');
  assert.equal(loadDirectoryConfig({ DIRECTORY_URL: 'https://p.example/d', DIRECTORY_TOKEN: 'a'.repeat(30), DIRECTORY_SYNC_MINUTES: '99999' })!.intervalMinutes, 1440);
  assert.equal(loadDirectoryConfig({ DIRECTORY_URL: 'https://p.example/d', DIRECTORY_TOKEN: 'a'.repeat(30), DIRECTORY_SYNC_MINUTES: 'abc' })!.intervalMinutes, 15);
});

test('role mapping: UFS People roles to tracker roles; unknown roles get least privilege', () => {
  assert.deepEqual(['admin', 'hr_manager', 'manager', 'employee', 'hiring_manager'].map(r => mapRole(r).role), ['admin', 'hr', 'manager', 'employee', 'employee']);
  assert.deepEqual(mapRole('superuser'), { role: 'employee', known: false });
  assert.equal(mapRole('Admin').known, false, 'role names are case-sensitive');
});

// ---------------- feed validation (pure) ----------------
test('parseFeed accepts a valid feed, normalizes values and reports nothing', () => {
  const f = parseFeed(rawFeed(), T0); assert.equal(f.employees.length, 30); assert.equal(f.identities.length, 24); assert.deepEqual(f.warnings, []);
  const mixed = rawFeed(3); mixed.employees[1].email = '  MiXeD@Example.TEST '; mixed.identities[0].subject = mixed.identities[0].subject.toUpperCase();
  const g = parseFeed(mixed, T0); assert.equal(g.employees[1]!.email, 'mixed@example.test'); assert.equal(g.identities[0]!.subject, g.identities[0]!.subject.toLowerCase());
});

test('parseFeed blocks malformed, unsupported, stale, future and oversized feeds', () => {
  const bad = (mutate: (f: any) => any, re: RegExp, now = T0) => assert.throws(() => parseFeed(mutate(rawFeed()), now), re);
  for (const junk of [null, 'x', 5, [], undefined]) assert.throws(() => parseFeed(junk, T0), /not a JSON object/);
  bad(f => ({ ...f, version: 2 }), /version/); bad(f => ({ ...f, version: undefined }), /version/);
  bad(f => ({ ...f, generatedAt: 'yesterday' }), /generatedAt/); bad(f => ({ ...f, generatedAt: undefined }), /generatedAt/);
  bad(f => f, /48 hours/, T0 + 49 * HOUR); bad(f => ({ ...f, generatedAt: iso(T0 + 11 * MIN) }), /future/);
  bad(f => ({ ...f, employees: 'nope' }), /employees list/); bad(f => ({ ...f, employees: undefined }), /employees list/);
  bad(f => ({ ...f, employees: Array.from({ length: 5001 }, () => ({})) }), /more than 5000/);
  bad(f => ({ ...f, identities: 'nope' }), /identities list/);
});

test('parseFeed blocks anything that looks like sensitive HR data, without echoing its value', () => {
  for (const key of ['salary', 'compensation', 'baseSalary', 'dateOfBirth', 'passportNumber', 'nationalId', 'taxNumber', 'bankAccount', 'iban', 'homeAddress', 'personalPhone', 'gender', 'maritalStatus', 'medicalNotes', 'emergencyContact', 'benefitPlan', 'password', 'apiToken', 'ssn', 'payGrade']) {
    const f = rawFeed(5); f.employees[2][key] = 'TOP-SECRET-VALUE-123';
    try { parseFeed(f, T0); assert.fail(`${key} must be blocked`); }
    catch (error: any) { assert.equal(error.kind, 'blocked', key); assert.match(error.message, /Sensitive HR fields/, key); assert.ok(error.message.includes(key)); assert.ok(!error.message.includes('TOP-SECRET'), `${key}: value must never be echoed`); }
  }
  const top = rawFeed(5); top.compensation = [1]; assert.throws(() => parseFeed(top, T0), /top-level field/);
  const ident = rawFeed(5); ident.identities[0].personalEmail = 'x'; assert.throws(() => parseFeed(ident, T0), /Sensitive HR fields/);
});

test('parseFeed ignores harmless extra fields but names them in a warning (never their values)', () => {
  const f = rawFeed(5); f.employees[0].costCenter = 'CC-VALUE-9'; f.employees[1].badge = 'B-7'; f.extraTop = 1;
  const p = parseFeed(f, T0); assert.equal(p.warnings.length, 1); assert.match(p.warnings[0]!, /badge, costCenter, extraTop/); assert.ok(!p.warnings[0]!.includes('CC-VALUE'));
  assert.equal((p.employees[0] as any).costCenter, undefined, 'unknown fields are stripped');
});

test('parseFeed: invalid rows are skipped with a warning, unless more than 10% are invalid', () => {
  const one = rawFeed(30); one.employees[5].email = 'not-an-email';
  const p = parseFeed(one, T0); assert.equal(p.employees.length, 29); assert.match(p.warnings[0]!, /skipped/);
  const many = rawFeed(30); for (let i = 0; i < 4; i++) many.employees[i].role = '';
  assert.throws(() => parseFeed(many, T0), /more than 10%/);
  for (const [field, value] of [['id', '../evil'], ['id', ''], ['name', ''], ['active', 'yes'], ['managerId', 'a b'], ['department', 'x'.repeat(101)]] as const) {
    const f = rawFeed(30); f.employees[3][field] = value; assert.equal(parseFeed(f, T0).employees.length, 29, `${field}=${value}`);
  }
});

test('parseFeed blocks duplicate ids, emails and sign-in identities; skips identities for unknown employees', () => {
  const id = rawFeed(5); id.employees[1].id = id.employees[0].id; assert.throws(() => parseFeed(id, T0), /Duplicate employee id/);
  const email = rawFeed(5); email.employees[1].email = email.employees[0].email.toUpperCase(); assert.throws(() => parseFeed(email, T0), /Duplicate email/);
  const sub = rawFeed(10); sub.identities[1].subject = sub.identities[0].subject; assert.throws(() => parseFeed(sub, T0), /more than once/);
  const orphan = rawFeed(5); orphan.identities.push({ subject: '11111111-2222-4333-8444-555555555555', employeeId: 'emp-999', enabled: true });
  const p = parseFeed(orphan, T0); assert.equal(p.identities.length, 4); assert.match(p.warnings.join(' '), /not in the feed/);
  const junkIdentity = rawFeed(5); junkIdentity.identities.push({ subject: 'not-a-uuid', employeeId: 'emp-001', enabled: true }, 'x'); assert.equal(parseFeed(junkIdentity, T0).identities.length, 4);
});

// ---------------- first sync: users are projections of the directory ----------------
test('first sync creates tracker users from the directory with the right roles, managers, teams and identities', async () => {
  const e = await env();
  await e.run(async () => {
    const r = await e.sync(); assert.equal(r.status, 200); assert.equal(r.json.status, 'ok'); assert.equal(r.json.added, 30);
    const users = e.db.prepare("SELECT * FROM users WHERE source = 'directory'").all() as any[];
    assert.equal(users.length, 30); assert.ok(users.every(u => u.active === 1 && u.directory_id && u.password_hash === 'directory:no-password' && u.must_change_password === 0));
    const roles = Object.fromEntries(users.map(u => [u.directory_id, u.role]));
    assert.equal(roles['emp-001'], 'owner', 'the configured owner id becomes tracker owner');
    assert.deepEqual(['emp-002', 'emp-003'].map(i => roles[i]), ['hr', 'hr']); assert.deepEqual(['emp-004', 'emp-005', 'emp-006', 'emp-007'].map(i => roles[i]), ['manager', 'manager', 'manager', 'manager']);
    assert.equal(roles['emp-008'], 'employee', 'hiring_manager has no tracker rights'); assert.equal(roles['emp-009'], 'employee');
    const feed: FakeFeed = e.dir.feed; const byDir = Object.fromEntries(users.map(u => [u.directory_id, u]));
    for (const emp of feed.employees) { const u = byDir[emp.id]; assert.equal(u.email, emp.email); assert.equal(u.name, emp.name); assert.equal(u.manager_id, emp.managerId ? byDir[emp.managerId].id : null, `manager of ${emp.id}`); }
    const teams = e.db.prepare('SELECT name FROM teams ORDER BY name').all().map((t: any) => t.name);
    assert.deepEqual(teams, ['Engineering', 'Executive', 'Finance', 'Operations', 'People', 'Team One', 'Team Two']);
    assert.equal(e.count("SELECT COUNT(*) c FROM users u JOIN teams t ON t.id = u.team_id WHERE u.source = 'directory' AND t.name = u.directory_id"), 0);
    assert.equal(byDir['emp-010'].team_id, e.db.prepare('SELECT id FROM teams WHERE name = ?').get(feed.employees[9]!.department).id);
    assert.equal(e.count('SELECT COUNT(*) c FROM directory_identities WHERE enabled = 1'), 24); assert.equal(e.count('SELECT COUNT(*) c FROM directory_employees'), 30);
    assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'local'"), 9, 'local accounts are untouched');
  });
});

test('projected users have no password: password sign-in is impossible and the hash never leaves the server', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const u = e.userOf('emp-009');
    assert.equal(verifyPassword('anything-at-all-123', u.password_hash), false); assert.equal(verifyPassword('', u.password_hash), false);
    for (const pw of ['directory:no-password', 'Test-passw0rd-123', '']) assert.equal((await e.h.call('POST', '/api/auth/login', { body: { email: u.email, password: pw || 'x' } })).status, 401);
    const list = (await e.h.call('GET', '/api/users', { token: e.tok.admin })).json;
    assert.ok(!JSON.stringify(list).includes('password') && !JSON.stringify(list).includes('no-password'));
    const row = list.users.find((x: any) => x.email === u.email); assert.equal(row.source, 'directory'); assert.equal(row.directoryId, 'emp-009');
    assert.equal(list.users.filter((x: any) => x.source === 'local').length, 9);
  });
});

test('directory-owned fields are locked in the tracker; revoking sessions and local accounts still work', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const u = e.userOf('emp-009'); const mgr = e.userOf('emp-004').id;
    for (const body of [{ name: 'Renamed' }, { role: 'manager' }, { managerId: mgr }, { teamId: 'team-1' }, { active: false }]) {
      const r = await e.h.call('PATCH', `/api/users/${u.id}`, { token: e.tok.owner, body }); assert.equal(r.status, 409, JSON.stringify(body)); assert.match(r.json.error, /UFS People/);
    }
    assert.equal((await e.h.call('POST', `/api/users/${u.id}/reset-password`, { token: e.tok.owner, body: { temporaryPassword: 'Temp-pass-12345' } })).status, 409);
    assert.equal((await e.h.call('POST', `/api/users/${u.id}/revoke-sessions`, { token: e.tok.owner })).status, 200);
    assert.equal((await e.h.call('PATCH', `/api/users/${e.h.users.ed!.id}`, { token: e.tok.owner, body: { name: 'Ed Renamed' } })).status, 200);
    assert.equal(e.userOf('emp-009').name, e.dir.find('emp-009').name, 'unchanged');
  });
});

test('a second sync of the same feed changes nothing', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const before = e.db.prepare('SELECT * FROM users ORDER BY id').all(); const empBefore = e.db.prepare('SELECT * FROM directory_employees ORDER BY id').all();
    e.clock.now += 5 * MIN; e.dir.touch();
    const r = (await e.sync()).json; assert.deepEqual([r.added, r.updated, r.deactivated, r.reactivated, r.unchanged], [0, 0, 0, 0, 30]);
    assert.deepEqual(e.db.prepare('SELECT * FROM users ORDER BY id').all(), before); assert.deepEqual(e.db.prepare('SELECT * FROM directory_employees ORDER BY id').all(), empBefore, 'updated_at is not bumped when nothing changed');
  });
});

test('managers are linked even when the feed lists reports before their manager', async () => {
  const e = await env();
  await e.run(async () => {
    e.dir.feed.employees.reverse(); e.dir.feed.identities.reverse();
    assert.equal((await e.sync()).json.status, 'ok');
    const m = e.userOf('emp-004').id; assert.equal(e.userOf('emp-012').manager_id, m); assert.equal(e.userOf('emp-001').manager_id, null);
  });
});

test('changes in the directory flow through: rename, email, role, manager, department, hire', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync();
    e.clock.now += 20 * MIN; const d = e.dir;
    d.find('emp-009').name = 'Renamed Person'; d.find('emp-010').email = 'changed.mail@example.test'; d.find('emp-011').role = 'manager'; d.find('emp-012').managerId = 'emp-005'; d.find('emp-013').department = 'Finance';
    d.feed.employees.push({ id: 'emp-031', email: 'new.person@example.test', name: 'New Person', managerId: 'emp-004', role: 'employee', active: true, department: 'Brand New Dept', location: 'Remote', title: 'x' }); d.touch();
    const r = (await e.sync()).json; assert.equal(r.status, 'ok'); assert.deepEqual([r.added, r.updated, r.deactivated], [1, 5, 0], JSON.stringify(r));
    assert.equal(e.userOf('emp-009').name, 'Renamed Person'); assert.equal(e.userOf('emp-010').email, 'changed.mail@example.test'); assert.equal(e.userOf('emp-011').role, 'manager');
    assert.equal(e.userOf('emp-012').manager_id, e.userOf('emp-005').id); assert.equal(e.db.prepare('SELECT name FROM teams WHERE id = ?').get(e.userOf('emp-013').team_id).name, 'Finance');
    assert.equal(e.db.prepare('SELECT name FROM teams WHERE id = ?').get(e.userOf('emp-031').team_id).name, 'Brand New Dept'); assert.equal(e.userOf('emp-031').manager_id, e.userOf('emp-004').id);
    // demotion flows too
    e.clock.now += 20 * MIN; d.find('emp-011').role = 'employee'; d.find('emp-002').role = 'employee'; d.touch(); await e.sync(); assert.equal(e.userOf('emp-011').role, 'employee'); assert.equal(e.userOf('emp-002').role, 'employee');
  });
});

test('departments reuse existing teams by name, and an empty department clears the team', async () => {
  const e = await env();
  await e.run(async () => {
    const pre = e.db.prepare('SELECT id FROM teams WHERE name = ?').get('Team One').id;
    e.dir.find('emp-020').department = 'Team One'; e.dir.find('emp-021').department = ''; await e.sync();
    assert.equal(e.userOf('emp-020').team_id, pre); assert.equal(e.userOf('emp-021').team_id, null); assert.equal(e.count("SELECT COUNT(*) c FROM teams WHERE name = 'Team One'"), 1);
  });
});

test('team policy applies to projected users through their department, and they inherit the org policy', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const team = e.db.prepare('SELECT id FROM teams WHERE name = ?').get(e.dir.find('emp-010').department).id;
    await e.h.call('PUT', `/api/policy/team/${team}`, { token: e.tok.owner, body: { retentionDays: 14, imageFormat: 'png' } });
    const me = (await e.h.call('GET', '/api/me', { token: e.tokenFor('emp-010') })).json; assert.equal(me.policy.retentionDays, 14); assert.equal(me.policy.imageFormat, 'png'); assert.equal(me.user.source, 'directory'); assert.equal(me.needsConsent, true);
    const other = e.dir.feed.employees.find(x => x.department !== e.dir.find('emp-010').department)!; assert.equal((await e.h.call('GET', '/api/me', { token: e.tokenFor(other.id) })).json.policy.retentionDays, 90);
  });
});

// ---------------- leavers, returners, new inactive people ----------------
test('leavers are deactivated: sessions revoked, live status cleared, data kept, never re-created inactive', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const token = e.tokenFor('emp-010'); const uid = e.userOf('emp-010').id;
    await e.h.call('POST', '/api/heartbeat', { token, body: { status: 'tracking' } });
    assert.equal((await e.h.call('POST', '/api/time-entries/sync', { token, body: { clientId: 'leaver-entry-0001', taskLabel: 'x', mode: 'company', startAt: iso(T0 - HOUR), endAt: iso(T0 - 30 * MIN), trackedMs: 20 * MIN, idleMs: 0 } })).status, 201);
    e.clock.now += 20 * MIN; e.dir.find('emp-010').active = false; e.dir.touch();
    const r = (await e.sync()).json; assert.equal(r.deactivated, 1);
    assert.equal(e.userOf('emp-010').active, 0); assert.equal((await e.h.call('GET', '/api/me', { token })).status, 401);
    assert.equal(e.db.prepare('SELECT status FROM presence WHERE user_id = ?').get(uid).status, 'stopped');
    const entries = (await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tok.admin })).json.entries; assert.equal(entries.length, 1, 'their time stays visible to admins');
    assert.equal(e.count('SELECT COUNT(*) c FROM sessions WHERE user_id = ? AND revoked_at IS NULL', uid), 0);
    // someone who is already inactive in the directory never gets an account
    e.dir.feed.employees.push({ id: 'emp-040', email: 'gone.person@example.test', name: 'Gone Person', managerId: null, role: 'employee', active: false, department: '', location: '', title: '' }); e.clock.now += MIN; e.dir.touch();
    assert.equal((await e.sync()).json.added, 0); assert.equal(e.userOf('emp-040'), undefined);
    e.dir.find('emp-040').active = true; e.clock.now += MIN; e.dir.touch(); assert.equal((await e.sync()).json.added, 1, 'created once they become active');
  });
});

test('people removed from the feed are deactivated; local accounts are never touched by the sync', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const token = e.tokenFor('emp-011'); e.clock.now += MIN;
    e.dir.feed.employees = e.dir.feed.employees.filter(x => x.id !== 'emp-011'); e.dir.feed.identities = e.dir.feed.identities.filter(i => i.employeeId !== 'emp-011'); e.dir.touch();
    const r = (await e.sync()).json; assert.equal(r.deactivated, 1); assert.equal(e.userOf('emp-011').active, 0); assert.equal((await e.h.call('GET', '/api/me', { token })).status, 401);
    assert.equal(e.db.prepare('SELECT removed_at FROM directory_employees WHERE id = ?').get('emp-011').removed_at !== null, true);
    assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'local' AND active = 1"), 9);
  });
});

test('returning employees are reactivated (old sessions stay revoked)', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const oldToken = e.tokenFor('emp-010'); e.dir.find('emp-010').active = false; e.clock.now += MIN; e.dir.touch(); await e.sync();
    e.dir.find('emp-010').active = true; e.clock.now += MIN; e.dir.touch(); const r = (await e.sync()).json;
    assert.equal(r.reactivated, 1); assert.equal(e.userOf('emp-010').active, 1); assert.equal((await e.h.call('GET', '/api/me', { token: oldToken })).status, 401);
    assert.equal((await e.h.call('GET', '/api/me', { token: e.tokenFor('emp-010') })).status, 200);
  });
});

// ---------------- visibility follows the synced org chart ----------------
test('manager, HR and employee scoping all come from the directory', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const feed = e.dir.feed; const reports = (id: string) => feed.employees.filter(x => x.managerId === id).map(x => x.id);
    const names = async (empId: string) => (await e.h.call('GET', '/api/users', { token: e.tokenFor(empId) })).json.users.map((u: any) => u.name).sort();
    const nameOf = (id: string) => feed.employees.find(x => x.id === id)!.name;
    assert.deepEqual(await names('emp-004'), [nameOf('emp-004'), ...reports('emp-004').map(nameOf)].sort(), 'manager sees self + direct reports');
    assert.deepEqual(await names('emp-012'), [nameOf('emp-012')], 'employee sees only self');
    assert.equal((await names('emp-002')).length, 39, 'HR sees every user (30 directory + 9 local)');
    // a report's time is visible to their manager only
    const rep = reports('emp-004')[0]!, tok = e.tokenFor(rep);
    await e.h.call('POST', '/api/time-entries/sync', { token: tok, body: { clientId: 'dir-entry-00000001', taskLabel: 'x', mode: 'company', startAt: iso(T0 - HOUR), endAt: iso(T0 - 30 * MIN), trackedMs: 25 * MIN, idleMs: 0 } });
    const uid = e.userOf(rep).id;
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-004') })).status, 200);
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-005') })).status, 403);
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-002') })).status, 200);
    // moving the report to another manager moves the visibility
    e.clock.now += MIN; e.dir.find(rep).managerId = 'emp-005'; e.dir.touch(); await e.sync();
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-004') })).status, 403);
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-005') })).status, 200);
    // a demoted manager loses the review rights immediately
    e.clock.now += MIN; e.dir.find('emp-005').role = 'employee'; e.dir.touch(); await e.sync();
    const entryId = (await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-002') })).json.entries[0].id;
    assert.equal((await e.h.call('POST', `/api/time-entries/${entryId}/approve`, { token: e.tokenFor('emp-005') })).status, 403);
    assert.equal((await e.h.call('POST', `/api/time-entries/${entryId}/approve`, { token: e.tokenFor('emp-002') })).status, 403, 'HR is read-only');
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${uid}`, { token: e.tokenFor('emp-005') })).status, 403, 'a demoted manager no longer sees reports');
  });
});

// ---------------- safety guards ----------------
test('guard: a feed that would deactivate more than 30% is blocked, changes nothing, and only an owner can force it', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); e.clock.now += MIN; for (let i = 9; i <= 20; i++) e.dir.find(`emp-0${String(i).padStart(2, '0')}`).active = false; e.dir.touch();
    const r = await e.sync(); assert.equal(r.json.status, 'blocked'); assert.match(r.json.message, /deactivate 12 of 30/); assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 30);
    assert.equal((await e.sync(e.tok.admin, { force: true })).status, 403, 'admins cannot force');
    assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 30);
    const forced = await e.sync(e.tok.owner, { force: true }); assert.equal(forced.json.status, 'ok'); assert.equal(forced.json.deactivated, 12); assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 18);
    const audit = (await e.h.call('GET', '/api/audit?limit=100', { token: e.tok.owner })).json.entries.filter((x: any) => x.action.startsWith('directory.'));
    assert.ok(audit.some((x: any) => x.action === 'directory.sync_blocked')); assert.ok(audit.some((x: any) => x.action === 'directory.synced' && x.detail.forced === true && x.actorName === 'Owner'));
  });
});

test('guard: small organisations (under 10 people) are not subject to the 30% rule', async () => {
  const e = await env({ count: 8 });
  await e.run(async () => {
    await e.sync(); e.clock.now += MIN; for (const id of ['emp-005', 'emp-006', 'emp-007']) e.dir.find(id).active = false; e.dir.touch();
    assert.equal((await e.sync()).json.status, 'ok'); assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 5);
  });
});

test('guard: an empty feed is blocked (it would lock everyone out); forced, it deactivates directory users but not local ones', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); e.clock.now += MIN; e.dir.feed.employees = []; e.dir.feed.identities = []; e.dir.touch();
    const r = (await e.sync()).json; assert.equal(r.status, 'blocked'); assert.match(r.message, /empty/); assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 30);
    const forced = (await e.sync(e.tok.owner, { force: true })).json; assert.equal(forced.deactivated, 30); assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 0);
    assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'local' AND active = 1"), 9); assert.equal((await e.h.call('GET', '/api/me', { token: e.tok.owner })).status, 200, 'the local break-glass owner still works');
    assert.equal(e.count('SELECT COUNT(*) c FROM directory_identities WHERE enabled = 1'), 0);
  });
});

test('guard: stale, time-travelling and replayed feeds are refused', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); e.clock.now += HOUR; e.dir.touch(); await e.sync();
    e.dir.feed.generatedAt = iso(T0 + 10 * MIN); let r = (await e.sync()).json; assert.equal(r.status, 'blocked'); assert.match(r.message, /older than the last applied/);
    e.clock.now += 50 * HOUR; e.tok.owner = await e.h.login('owner@test.example'); r = (await e.sync()).json; assert.equal(r.status, 'blocked'); assert.match(r.message, /48 hours/);
    assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), 30);
  });
});

test('guard: sensitive fields, duplicates and mostly-invalid feeds are blocked and change nothing', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); e.clock.now += MIN; const good = JSON.parse(JSON.stringify(e.dir.feed)) as any; const before = e.db.prepare("SELECT id,name,role,active FROM users WHERE source='directory' ORDER BY id").all();
    const attempt = async (mutate: (f: any) => void, re: RegExp) => { const f = JSON.parse(JSON.stringify(good)); mutate(f); f.generatedAt = iso(e.clock.now); e.dir.feed = f; const r = (await e.sync()).json; assert.equal(r.status, 'blocked'); assert.match(r.message, re); assert.deepEqual(e.db.prepare("SELECT id,name,role,active FROM users WHERE source='directory' ORDER BY id").all(), before); return r; };
    const leak = await attempt(f => { f.employees[3].salary = 123456; f.employees[3].name = 'Hacked Name'; }, /Sensitive HR fields/); assert.ok(!JSON.stringify(leak).includes('123456'));
    await attempt(f => { f.employees[4].id = f.employees[5].id; }, /Duplicate employee id/);
    await attempt(f => { for (let i = 0; i < 5; i++) f.employees[i].email = 'bad'; }, /more than 10%/);
    assert.equal(e.count('SELECT COUNT(*) c FROM directory_employees WHERE name = ?', 'Hacked Name'), 0, 'nothing from a blocked feed is stored');
  });
});

test('guard: one invalid row is skipped and reported while everyone else is applied', async () => {
  const e = await env();
  await e.run(async () => {
    e.dir.feed.employees[12]!.email = 'nope'; const r = (await e.sync()).json;
    assert.equal(r.status, 'ok'); assert.equal(r.added, 29); assert.match(r.warnings.join(' '), /emp-013 skipped/); assert.equal(e.userOf('emp-013'), undefined);
  });
});

test('data quality: manager loops, self-management, unknown managers and unknown roles are handled and reported', async () => {
  const e = await env();
  await e.run(async () => {
    const d = e.dir; d.find('emp-009').managerId = 'emp-010'; d.find('emp-010').managerId = 'emp-009'; d.find('emp-011').managerId = 'emp-011'; d.find('emp-012').managerId = 'emp-777'; d.find('emp-013').role = 'wizard';
    const r = (await e.sync()).json; assert.equal(r.status, 'ok'); const w = r.warnings.join('\n');
    assert.match(w, /Manager loop among emp-009, emp-010/); assert.match(w, /emp-011 lists themselves/); assert.match(w, /emp-012 has a manager \(emp-777\)/); assert.match(w, /unknown role "wizard"/);
    for (const id of ['emp-009', 'emp-010', 'emp-011', 'emp-012']) assert.equal(e.userOf(id).manager_id, null, id);
    assert.equal(e.userOf('emp-013').role, 'employee');
  });
});

test('email clashes with local accounts never merge accounts: new people are skipped, renames keep the old email', async () => {
  const e = await env();
  await e.run(async () => {
    e.dir.find('emp-014').email = 'ed@test.example'; let r = (await e.sync()).json;
    assert.equal(r.added, 29); assert.equal(e.userOf('emp-014'), undefined); assert.match(r.warnings.join(' '), /emp-014: the email is already used/);
    assert.equal(e.db.prepare("SELECT source FROM users WHERE email = 'ed@test.example'").get().source, 'local', 'the local account is not adopted');
    const original = e.userOf('emp-015').email; e.clock.now += MIN; e.dir.find('emp-015').email = 'mia@test.example'; e.dir.touch(); r = (await e.sync()).json;
    assert.equal(e.userOf('emp-015').email, original); assert.match(r.warnings.join(' '), /kept the old one/);
  });
});

test('the last active owner is never demoted or deactivated by a sync', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(e.tok.admin); assert.equal(e.userOf('emp-001').role, 'owner');
    e.db.prepare("UPDATE users SET active = 0 WHERE source = 'local' AND role = 'owner'").run();          // make emp-001 the only active owner
    e.clock.now += MIN; e.dir.find('emp-001').active = false; e.dir.touch(); let r = (await e.sync(e.tok.admin)).json;
    assert.equal(e.userOf('emp-001').active, 1); assert.match(r.warnings.join(' '), /last active owner; they were not deactivated/);
    e.clock.now += MIN; e.dir.find('emp-001').active = true; e.cfg.ownerEmployeeId = null; e.dir.touch(); r = (await e.sync(e.tok.admin)).json;
    assert.equal(e.userOf('emp-001').role, 'owner'); assert.match(r.warnings.join(' '), /last active owner; the owner role was kept/);
    e.clock.now += MIN; e.dir.feed.employees = e.dir.feed.employees.filter(x => x.id !== 'emp-001'); e.dir.touch(); r = (await e.sync(e.tok.admin)).json;
    assert.equal(e.userOf('emp-001').active, 1); assert.match(r.warnings.join(' '), /missing from the feed; they were not deactivated/);
    e.db.prepare("UPDATE users SET active = 1 WHERE source = 'local' AND role = 'owner'").run();           // with another owner available the demotion goes through
    e.clock.now += MIN; e.dir.feed.employees.unshift({ ...syntheticFeed(1).employees[0]! }); e.dir.touch(); await e.sync(e.tok.admin);
    assert.equal(e.userOf('emp-001').role, 'admin');
  });
});

test('an exception halfway through applying rolls everything back and leaks no internals', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); e.clock.now += MIN; const before = e.db.prepare('SELECT * FROM users ORDER BY id').all(); const teamsBefore = e.count('SELECT COUNT(*) c FROM teams');
    e.db.exec("CREATE TRIGGER boom BEFORE INSERT ON users WHEN NEW.email LIKE 'explode%' BEGIN SELECT RAISE(ABORT, 'secret internal failure details'); END;");
    e.dir.find('emp-009').name = 'Changed Before The Crash'; e.dir.find('emp-010').department = 'New Dept Before The Crash';
    e.dir.feed.employees.push({ id: 'emp-050', email: 'explode@example.test', name: 'Boom', managerId: null, role: 'employee', active: true, department: '', location: '', title: '' }); e.dir.touch();
    const r = await e.sync(); assert.equal(r.json.status, 'failed'); assert.ok(!JSON.stringify(r.json).includes('secret internal'));
    assert.deepEqual(e.db.prepare('SELECT * FROM users ORDER BY id').all(), before, 'no partial changes'); assert.equal(e.count('SELECT COUNT(*) c FROM teams'), teamsBefore);
    assert.equal(e.count('SELECT COUNT(*) c FROM directory_employees WHERE id = ?', 'emp-050'), 0);
    assert.equal(e.count("SELECT COUNT(*) c FROM directory_sync_log WHERE status = 'failed'"), 1);
    e.db.exec('DROP TRIGGER boom'); e.clock.now += MIN; e.dir.touch(); assert.equal((await e.sync()).json.status, 'ok', 'the next sync recovers');
  });
});

// ---------------- identities ----------------
test('sign-in identities are stored lower-cased, disabled when they leave the feed, and moves are reported', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const feed = e.dir.feed; const first = feed.identities[0]!;
    assert.equal(e.db.prepare('SELECT employee_id, enabled FROM directory_identities WHERE subject = ?').get(first.subject).employee_id, first.employeeId);
    e.clock.now += MIN; feed.identities.shift(); const moved = feed.identities[0]!; const other = feed.employees.find(x => !feed.identities.some(i => i.employeeId === x.id) && x.id !== first.employeeId)!;
    moved.employeeId = other.id; feed.identities[1]!.enabled = false; e.dir.touch(); const r = (await e.sync()).json;
    assert.equal(e.db.prepare('SELECT enabled FROM directory_identities WHERE subject = ?').get(first.subject).enabled, 0, 'removed from the feed -> disabled, not deleted');
    assert.equal(e.db.prepare('SELECT employee_id FROM directory_identities WHERE subject = ?').get(moved.subject).employee_id, other.id); assert.match(r.warnings.join(' '), /moved to a different employee/);
    assert.equal(e.db.prepare('SELECT enabled FROM directory_identities WHERE subject = ?').get(feed.identities[1]!.subject).enabled, 0);
    assert.equal(e.count('SELECT COUNT(*) c FROM directory_identities'), 24, 'nothing is ever deleted');
  });
});

// ---------------- fetching ----------------
test('fetch failures change nothing and are reported without leaking the token', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const before = e.db.prepare('SELECT * FROM users ORDER BY id').all(); const cases: [{ status?: number; body?: string }, RegExp, string][] = [
      [{ status: 500 }, /HTTP 500/, 'failed'], [{ status: 503, body: 'down' }, /HTTP 503/, 'failed'], [{ status: 401 }, /rejected the access token/, 'failed'], [{ status: 403 }, /rejected the access token/, 'failed'],
      [{ body: '<html>login</html>' }, /not valid JSON/, 'blocked'], [{ body: 'x'.repeat(5_100_000) }, /larger than 5 MB/, 'blocked'], [{ body: '[]' }, /not a JSON object/, 'blocked'],
    ];
    for (const [behavior, re, kind] of cases) {
      e.dir.behavior = behavior; const r = await e.sync(); assert.equal(r.json.status, kind, JSON.stringify(behavior)); assert.match(r.json.message, re); assert.ok(!JSON.stringify(r.json).includes(FAKE_TOKEN));
      assert.equal(r.status, kind === 'failed' ? 502 : 200); assert.deepEqual(e.db.prepare('SELECT * FROM users ORDER BY id').all(), before);
    }
    e.dir.behavior = {}; e.clock.now += MIN; e.dir.touch(); assert.equal((await e.sync()).json.status, 'ok', 'recovers by itself');
  });
});

test('an unreachable directory is a clean failure, and a bad token header is never sent anywhere else', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); assert.ok(e.dir.requests.length >= 1 && e.dir.requests.every(r => r.authorization === `Bearer ${FAKE_TOKEN}`));
    const port = e.dir.port; await e.dir.close(); const r = await e.sync(); assert.equal(r.status, 502); assert.equal(r.json.message, 'Could not reach the directory.');
    assert.ok(!r.json.message.includes(String(port)), 'no internal addresses in errors');
    e.dir.close = async () => {};                                                                       // already closed; keep the harness teardown quiet
  });
});

test('a redirect from the directory is refused (the token must never follow a redirect)', async () => {
  const e = await env();
  await e.run(async () => {
    const real = e.h.ctx.directoryFetch; let seen: RequestInit | undefined;
    e.h.ctx.directoryFetch = (async (url: any, init: any) => { seen = init; return real(url, init); }) as typeof fetch;
    await e.sync(); assert.equal(seen?.redirect, 'error'); assert.ok(seen?.signal);
  });
});

test('concurrent syncs are refused instead of racing', async () => {
  const e = await env();
  await e.run(async () => {
    e.dir.behavior = { delayMs: 300 }; const first = e.sync(); await new Promise(r => setTimeout(r, 80));
    const second = await e.sync(); assert.equal(second.status, 409); assert.match(second.json.error, /already running/);
    assert.equal((await first).json.status, 'ok');
  });
});

// ---------------- API access, status, secrets ----------------
test('directory endpoints are admin-only; HR, managers and employees are refused; unconfigured servers say so', async () => {
  const e = await env();
  await e.run(async () => {
    await e.sync(); const tokens = [e.tokenFor('emp-002'), e.tokenFor('emp-004'), e.tokenFor('emp-020'), await e.h.login('hana@test.example'), await e.h.login('mia@test.example')];
    for (const t of tokens) for (const [m, p] of [['GET', '/api/directory/status'], ['GET', '/api/directory/log'], ['POST', '/api/directory/sync']] as const) assert.equal((await e.h.call(m, p, { token: t, body: m === 'POST' ? {} : undefined })).status, 403, `${m} ${p}`);
    for (const [m, p] of [['GET', '/api/directory/status'], ['GET', '/api/directory/log'], ['POST', '/api/directory/sync']] as const) assert.equal((await e.h.call(m, p, { body: m === 'POST' ? {} : undefined })).status, 401);
    assert.equal((await e.h.call('GET', '/api/directory/status', { token: e.tok.admin })).status, 200);
    assert.equal((await e.sync(e.tok.owner, { force: 'yes' })).status, 400); assert.equal((await e.sync(e.tok.owner, { surprise: 1 })).status, 400);
  });
  const plain = await setup();
  try { const t = await plain.login('admin@test.example'); const s = await plain.call('GET', '/api/directory/status', { token: t }); assert.equal(s.json.enabled, false); assert.equal((await plain.call('POST', '/api/directory/sync', { token: t, body: {} })).status, 409); } finally { await plain.stop(); }
});

test('status and log describe the last sync; the token and sensitive values appear nowhere', async () => {
  const e = await env();
  await e.run(async () => {
    assert.equal((await e.h.call('GET', '/api/directory/status', { token: e.tok.admin })).json.lastSync, null);
    await e.sync(); e.clock.now += MIN; e.dir.find('emp-009').name = 'A Visible Change'; (e.dir.feed.employees[2] as any).costCenter = 'CC-OPAQUE-77'; e.dir.touch(); await e.sync();
    const status = (await e.h.call('GET', '/api/directory/status', { token: e.tok.admin })).json;
    assert.equal(status.enabled, true); assert.equal(status.host, `127.0.0.1:${e.dir.port}`); assert.equal(status.ownerConfigured, true); assert.equal(status.intervalMinutes, 15);
    assert.equal(status.lastSync.status, 'ok'); assert.equal(status.lastSync.updated, 1); assert.equal(status.lastSync.trigger, 'manual'); assert.equal(status.counts.activeUsers, 30); assert.equal(status.counts.identities, 24); assert.equal(status.lastSuccessAt, status.lastSync.at);
    const log = (await e.h.call('GET', '/api/directory/log?limit=5', { token: e.tok.admin })).json.entries; assert.equal(log.length, 2); assert.equal(log[0].added, 0); assert.equal(log[1].added, 30);
    const everything = JSON.stringify([status, log, (await e.h.call('GET', '/api/audit?limit=300', { token: e.tok.admin })).json, e.db.prepare('SELECT * FROM directory_sync_log').all()]);
    assert.ok(!everything.includes(FAKE_TOKEN), 'the directory token is never logged, audited or returned'); assert.ok(!everything.includes('CC-OPAQUE'), 'values of ignored fields are never kept');
    assert.ok(!everything.includes(e.dir.find('emp-009').email), 'no personal data in the sync log or audit trail');
  });
});

test('scheduler: runs once at startup (recorded as "startup") and can be stopped; unconfigured servers do nothing', async () => {
  const e = await env();
  await e.run(async () => {
    const stop = startDirectoryScheduler(e.h.ctx); await new Promise(r => setTimeout(r, 400)); stop();
    const log = (e.db.prepare('SELECT trigger, status FROM directory_sync_log').all() as any[]).map(x => ({ trigger: x.trigger, status: x.status })); assert.deepEqual(log, [{ trigger: 'startup', status: 'ok' }]);
    assert.equal(e.count("SELECT COUNT(*) c FROM users WHERE source = 'directory'"), 30);
    const none = { ...e.h.ctx, directory: null }; assert.doesNotThrow(() => startDirectoryScheduler(none)());
    assert.equal((await runDirectorySync(none as any)).status, 'failed');
  });
});
