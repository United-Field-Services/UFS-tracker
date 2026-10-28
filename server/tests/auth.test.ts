import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORD, MIN, HOUR, DAY, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h.stop(); });

test('login succeeds and /api/me returns the user, policy and consent state', async () => {
  const token = await h.login('ed@test.example');
  const me = await h.call('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'ed@test.example');
  assert.equal(me.json.user.role, 'employee');
  assert.equal(me.json.policy.screenshotIntervalSeconds, 300);
  assert.equal(me.json.needsConsent, true);
  assert.equal(JSON.stringify(me.json).includes('password'), false);
});

test('wrong password and unknown email give the same generic error', async () => {
  const a = await h.call('POST', '/api/auth/login', { body: { email: 'ed@test.example', password: 'wrong-password-1' } });
  const b = await h.call('POST', '/api/auth/login', { body: { email: 'nobody@test.example', password: 'wrong-password-1' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.json.error, b.json.error);
});

test('malformed login bodies are rejected with 400', async () => {
  for (const body of [{}, { email: 'not-an-email', password: 'x' }, { email: 'ed@test.example' }, { email: 'ed@test.example', password: 'x', kind: 'root' }]) {
    const r = await h.call('POST', '/api/auth/login', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('requests without or with a bad token are 401', async () => {
  assert.equal((await h.call('GET', '/api/me')).status, 401);
  assert.equal((await h.call('GET', '/api/me', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await h.call('GET', '/api/me', { token: 'short' })).status, 401);
});

test('login is throttled after repeated failures, and a correct password is also blocked during the lockout', async () => {
  const email = 'finn@test.example';
  for (let i = 0; i < 8; i++) assert.equal((await h.call('POST', '/api/auth/login', { body: { email, password: 'bad-password-1' } })).status, 401);
  const blocked = await h.call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(blocked.status, 429);
  h.clock.now += 16 * MIN; // window passes
  const ok = await h.call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(ok.status, 200);
});

test('logout revokes the token', async () => {
  const token = await h.login('eve@test.example');
  assert.equal((await h.call('POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { token })).status, 401);
});

test('web sessions expire after 12h, device tokens last 90 days', async () => {
  const web = await h.login('loner@test.example', 'web');
  const device = await h.login('loner@test.example', 'device');
  h.clock.now += 13 * HOUR;
  assert.equal((await h.call('GET', '/api/me', { token: web })).status, 401);
  assert.equal((await h.call('GET', '/api/me', { token: device })).status, 200);
  h.clock.now += 91 * DAY;
  assert.equal((await h.call('GET', '/api/me', { token: device })).status, 401);
});

test('deactivated users cannot sign in and existing sessions stop working', async () => {
  const adminToken = await h.login('admin@test.example');
  const finnToken = await h.login('finn@test.example');
  const r = await h.call('PATCH', `/api/users/${h.users.finn!.id}`, { token: adminToken, body: { active: false } });
  assert.equal(r.status, 200);
  assert.equal((await h.call('GET', '/api/me', { token: finnToken })).status, 401);
  assert.equal((await h.call('POST', '/api/auth/login', { body: { email: 'finn@test.example', password: PASSWORD } })).status, 401);
  await h.call('PATCH', `/api/users/${h.users.finn!.id}`, { token: adminToken, body: { active: true } });
});

test('change password: checks current, enforces strength, revokes other sessions', async () => {
  const t1 = await h.login('eve@test.example');
  const t2 = await h.login('eve@test.example');
  assert.equal((await h.call('POST', '/api/auth/change-password', { token: t1, body: { currentPassword: 'nope-nope-1', newPassword: 'Brand-new-pass-9' } })).status, 403);
  assert.equal((await h.call('POST', '/api/auth/change-password', { token: t1, body: { currentPassword: PASSWORD, newPassword: 'short1' } })).status, 400);
  assert.equal((await h.call('POST', '/api/auth/change-password', { token: t1, body: { currentPassword: PASSWORD, newPassword: 'onlyletterspassword' } })).status, 400);
  assert.equal((await h.call('POST', '/api/auth/change-password', { token: t1, body: { currentPassword: PASSWORD, newPassword: PASSWORD } })).status, 400);
  assert.equal((await h.call('POST', '/api/auth/change-password', { token: t1, body: { currentPassword: PASSWORD, newPassword: 'Brand-new-pass-9' } })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { token: t1 })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { token: t2 })).status, 401);
  assert.equal((await h.call('POST', '/api/auth/login', { body: { email: 'eve@test.example', password: PASSWORD } })).status, 401);
  assert.equal((await h.call('POST', '/api/auth/login', { body: { email: 'eve@test.example', password: 'Brand-new-pass-9' } })).status, 200);
});

test('users created by an admin must change their password before doing anything else', async () => {
  const admin = await h.login('admin@test.example');
  const created = await h.call('POST', '/api/users', { token: admin, body: { email: 'New.Person@test.example', name: 'New Person', temporaryPassword: 'Temp-pass-12345' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.email, 'new.person@test.example');
  const login = await h.call('POST', '/api/auth/login', { body: { email: 'new.person@test.example', password: 'Temp-pass-12345' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.mustChangePassword, true);
  const token = login.json.token;
  assert.equal((await h.call('GET', '/api/me', { token })).status, 200);
  assert.equal((await h.call('GET', '/api/projects', { token })).status, 403);
  assert.equal((await h.call('POST', '/api/heartbeat', { token, body: { status: 'tracking' } })).status, 403);
  assert.equal((await h.call('POST', '/api/auth/change-password', { token, body: { currentPassword: 'Temp-pass-12345', newPassword: 'Chosen-pass-2468' } })).status, 200);
  assert.equal((await h.call('GET', '/api/projects', { token })).status, 200);
});

test('consent: must accept the current notice version', async () => {
  const token = await h.login('loner@test.example');
  assert.equal((await h.call('POST', '/api/me/consent', { token, body: { version: 0 } })).status, 400);
  assert.equal((await h.call('POST', '/api/me/consent', { token, body: { version: 1 } })).status, 200);
  const me = await h.call('GET', '/api/me', { token });
  assert.equal(me.json.needsConsent, false);
  assert.ok(me.json.user.consentAt);
});

test('device list shows own sessions, can revoke another one but ids are scoped to the owner', async () => {
  const a = await h.login('ed@test.example', 'device');
  const b = await h.login('ed@test.example', 'web');
  const other = await h.login('max@test.example', 'web');
  const list = await h.call('GET', '/api/me/devices', { token: b });
  assert.ok(list.json.sessions.length >= 2);
  assert.equal(list.json.sessions.filter((s: any) => s.current).length, 1);
  const deviceSession = list.json.sessions.find((s: any) => s.kind === 'device');
  // another user cannot revoke it
  assert.equal((await h.call('DELETE', `/api/me/devices/${deviceSession.id}`, { token: other })).status, 404);
  assert.equal((await h.call('DELETE', `/api/me/devices/${deviceSession.id}`, { token: b })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { token: a })).status, 401);
  assert.equal((await h.call('DELETE', '/api/me/devices/not-valid', { token: b })).status, 400);
});

test('security headers are present and responses do not leak the framework', async () => {
  const r = await h.call('GET', '/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('content-security-policy')!.includes("default-src 'none'"));
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('oversized JSON and invalid JSON get clean errors', async () => {
  const big = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as any).code, 400);
});
