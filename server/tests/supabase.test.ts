import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AuthProblem, SupabaseAuth, loadSupabaseConfig, type SupabaseConfig } from '../src/supabase-auth.ts';
import { MSG } from '../src/supabase-login.ts';
import { FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, startFakeSupabase, totp } from '../src/fake-supabase.ts';
import { FAKE_TOKEN, startFakeDirectory } from '../src/fake-directory.ts';
import { PASSWORD, setup, iso, T0, MIN, HOUR, DAY } from './helpers.ts';

const cfgFor = (fake: { url: string; issuer: string }, extra: Partial<SupabaseConfig> = {}): SupabaseConfig => ({ url: fake.url, publishableKey: FAKE_PUBLISHABLE_KEY, issuer: fake.issuer, mfaRoles: ['owner', 'admin', 'hr'], deviceSessionDays: 30, ...extra });
const uuid = () => crypto.randomUUID();

// ============================ configuration ============================
test('config: both URL and publishable key or neither; https (localhost excepted); never a secret key; roles validated', () => {
  assert.equal(loadSupabaseConfig({}), null);
  assert.throws(() => loadSupabaseConfig({ SUPABASE_URL: 'https://x.supabase.co' }), /both/); assert.throws(() => loadSupabaseConfig({ SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'a'.repeat(20) }), /both/);
  const ok = { SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'a'.repeat(20) };
  assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_URL: 'http://abc.supabase.co' }), /https/); assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_URL: 'https://u:p@abc.supabase.co' }), /plain origin/);
  assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_URL: 'https://abc.supabase.co/path?x=1' }), /plain origin/); assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_URL: 'nope' }), /valid URL/);
  assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_' + 'a'.repeat(30) }), /PUBLISHABLE/); assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_PUBLISHABLE_KEY: 'x_service_role_' + 'a'.repeat(30) }), /PUBLISHABLE/);
  assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_PUBLISHABLE_KEY: 'short' }), /too short/); assert.throws(() => loadSupabaseConfig({ ...ok, SUPABASE_REQUIRE_AAL2_ROLES: 'admin,wizard' }), /unknown role/);
  const c = loadSupabaseConfig(ok)!; assert.equal(c.issuer, 'https://abc.supabase.co/auth/v1'); assert.deepEqual(c.mfaRoles, ['owner', 'admin', 'hr']); assert.equal(c.deviceSessionDays, 30);
  assert.deepEqual(loadSupabaseConfig({ ...ok, SUPABASE_REQUIRE_AAL2_ROLES: 'none' })!.mfaRoles, []); assert.deepEqual(loadSupabaseConfig({ ...ok, SUPABASE_REQUIRE_AAL2_ROLES: 'admin, manager' })!.mfaRoles, ['admin', 'manager']);
  assert.equal(loadSupabaseConfig({ ...ok, SUPABASE_DEVICE_SESSION_DAYS: '9999' })!.deviceSessionDays, 365); assert.equal(loadSupabaseConfig({ ...ok, SUPABASE_DEVICE_SESSION_DAYS: 'abc' })!.deviceSessionDays, 30);
  assert.ok(loadSupabaseConfig({ SUPABASE_URL: 'http://localhost:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'a'.repeat(20) }));
});

// ============================ the token verifier ============================
async function unit() {
  const clock = { now: T0 }; const fake = await startFakeSupabase({ now: () => clock.now });
  const auth = new SupabaseAuth(cfgFor(fake), fetch, () => clock.now);
  const sub = uuid(), sid = uuid();
  const mint = (claims: Record<string, unknown> = {}, o: Parameters<typeof fake.mint>[1] = {}) => fake.mint({ sub, session_id: sid, ...claims }, o);
  const reason = async (token: string) => { try { await auth.verifyAccessToken(token); return 'ACCEPTED'; } catch (e) { return e instanceof AuthProblem ? e.reason : `other:${(e as Error).message}`; } };
  const jwksCalls = () => fake.requests.filter(r => r.path.endsWith('jwks.json')).length;
  return { clock, fake, auth, sub, sid, mint, reason, jwksCalls };
}

test('verifier accepts a genuine token and normalizes it', async () => {
  const u = await unit(); try {
    const c = await u.auth.verifyAccessToken(u.mint({ sub: u.sub.toUpperCase(), amr: [{ method: 'password' }, { method: 'totp' }], aal: 'aal2', email: 'a@b.co' }));
    assert.equal(c.sub, u.sub); assert.equal(c.sessionId, u.sid); assert.equal(c.aal, 'aal2'); assert.deepEqual(c.amr, ['password', 'totp']); assert.equal(c.email, 'a@b.co');
  } finally { await u.fake.close(); }
});

test('verifier rejects every wrong or missing claim (issuer, audience, role, ids, anonymity, time, assurance)', async () => {
  const u = await unit(); try {
    const bad: [string, Record<string, unknown>, string[]?][] = [
      ['wrong issuer', { iss: 'https://evil.example/auth/v1' }], ['issuer with trailing slash', { iss: u.fake.issuer + '/' }], ['missing issuer', {}, ['iss']],
      ['wrong audience', { aud: 'service_role' }], ['audience as array', { aud: ['authenticated'] }], ['missing audience', {}, ['aud']],
      ['role service_role', { role: 'service_role' }], ['role anon', { role: 'anon' }], ['missing role', {}, ['role']],
      ['missing sub', {}, ['sub']], ['sub not a uuid', { sub: 'admin' }], ['sub is a number', { sub: 123 }], ['missing session_id', {}, ['session_id']], ['session_id not a uuid', { session_id: 'abc' }],
      ['anonymous', { is_anonymous: true }], ['is_anonymous missing', {}, ['is_anonymous']], ['is_anonymous as string', { is_anonymous: 'false' }],
      ['expired', { exp: Math.floor(T0 / 1000) - 120 }], ['exp missing', {}, ['exp']], ['exp as string', { exp: String(Math.floor(T0 / 1000) + 3600) }], ['exp null', { exp: null }],
      ['iat missing', {}, ['iat']], ['iat far in the future', { iat: Math.floor(T0 / 1000) + 3600 }], ['iat as string', { iat: 'now' }], ['nbf in the future', { nbf: Math.floor(T0 / 1000) + 3600 }],
      ['unknown assurance level', { aal: 'aal3' }], ['missing assurance level', {}, ['aal']],
    ];
    for (const [name, claims, omit] of bad) assert.equal(await u.reason(u.mint(claims, { omit })), 'invalid_token', name);
    assert.equal(await u.reason(u.mint({ exp: Math.floor(T0 / 1000) - 10 })), 'ACCEPTED', 'a few seconds of clock skew are tolerated');
    assert.equal(await u.reason(u.mint({ iat: Math.floor(T0 / 1000) + 30 })), 'ACCEPTED');
  } finally { await u.fake.close(); }
});

test('verifier is immune to algorithm tricks: none, HS256 key confusion, other algorithms, foreign keys, embedded keys', async () => {
  const u = await unit(); try {
    assert.equal(await u.reason(u.mint({}, { sign: 'none' })), 'invalid_token', 'alg none');
    assert.equal(await u.reason(u.mint({}, { sign: 'none', header: { alg: 'None' } })), 'invalid_token');
    assert.equal(await u.reason(u.mint({}, { sign: 'hs256' })), 'invalid_token', 'HS256 signed with the public key as secret');
    for (const alg of ['RS256', 'ES384', 'ES512', 'PS256', 'EdDSA', 'HS512', '', 'es256']) assert.equal(await u.reason(u.mint({}, { sign: 'garbage', header: { alg } })), 'invalid_token', `alg ${alg}`);
    assert.equal(await u.reason(u.mint({}, { sign: 'foreign' })), 'invalid_token', 'right kid, someone else\'s key');
    assert.equal(await u.reason(u.mint({}, { sign: 'garbage' })), 'invalid_token');
    for (const header of [{ jwk: { kty: 'EC' } }, { jku: 'https://evil.example/keys' }, { x5u: 'https://evil.example/x' }, { crit: ['exp'] }]) assert.equal(await u.reason(u.mint({}, { header })), 'invalid_token', JSON.stringify(header));
    assert.equal(await u.reason(u.mint({}, { header: { kid: undefined } })), 'invalid_token', 'missing kid'); assert.equal(await u.reason(u.mint({}, { header: { kid: 'k'.repeat(200) } })), 'invalid_token'); assert.equal(await u.reason(u.mint({}, { header: { kid: 'unknown-key' } })), 'invalid_token', 'unknown kid');
  } finally { await u.fake.close(); }
});

test('verifier rejects tampering and malformed input without throwing anything unexpected', async () => {
  const u = await unit(); try {
    const t = u.mint(); const [h, p, s] = t.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: uuid() })).toString('base64url');
    for (const [name, token] of [['payload swapped', `${h}.${forged}.${s}`], ['signature truncated', `${h}.${p}.${s.slice(0, -4)}`], ['signature flipped', `${h}.${p}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}`], ['two parts', `${h}.${p}`], ['four parts', `${t}.x`], ['empty', ''], ['dots', '..'], ['spaces', `${h} .${p}.${s}`], ['unicode', `${h}.${p}.é${s}`], ['not base64url', `${h}.${p}.${s}=`], ['huge', 'a'.repeat(9000)], ['null bytes', `${h}\u0000.${p}.${s}`]] as const) assert.equal(await u.reason(token), 'invalid_token', name);
    for (const junk of [null, undefined, 5, {}, [], true]) assert.equal(await u.reason(junk as any), 'invalid_token');
    const notJson = `${Buffer.from('not json').toString('base64url')}.${p}.${s}`; assert.equal(await u.reason(notJson), 'invalid_token');
    const arrayClaims = `${h}.${Buffer.from('[1,2]').toString('base64url')}.${s}`; assert.equal(await u.reason(arrayClaims), 'invalid_token');
    assert.equal(await u.reason(t), 'ACCEPTED', 'the untouched token still verifies');
  } finally { await u.fake.close(); }
});

test('verifier follows key rotation, but only looks for new keys at a limited rate (no key-fetch flooding)', async () => {
  const u = await unit(); try {
    assert.equal(await u.reason(u.mint()), 'ACCEPTED'); const before = u.jwksCalls(); assert.equal(before, 1);
    assert.equal(await u.reason(u.mint()), 'ACCEPTED'); assert.equal(u.jwksCalls(), before, 'cached');
    u.fake.rotateKey(); u.clock.now += 31_000;
    assert.equal(await u.reason(u.mint()), 'ACCEPTED', 'a token signed by a freshly rotated key is accepted after one refetch'); assert.equal(u.jwksCalls(), before + 1);
    assert.equal(await u.reason(u.mint({}, { header: { kid: uuid() } })), 'invalid_token'); const afterFlood = u.jwksCalls();
    for (let i = 0; i < 20; i++) await u.reason(u.mint({}, { header: { kid: uuid() } })); assert.ok(u.jwksCalls() - afterFlood <= 1, 'unknown key ids cannot make us hammer the provider');
    u.fake.retireOldKeys(); u.clock.now += 31_000; await u.reason(u.mint({}, { header: { kid: uuid() } }));
    assert.equal(await u.reason(u.mint()), 'ACCEPTED'); assert.equal(u.auth['keys'].size, 1, 'retired keys are dropped');
  } finally { await u.fake.close(); }
});

test('verifier fails closed when keys cannot be loaded, tolerates a short outage, and ignores non-ES256 keys', async () => {
  const u = await unit(); try {
    u.fake.behavior.jwks = 500; assert.equal(await u.reason(u.mint()), 'unavailable', 'cold cache + provider down');
    u.fake.behavior.jwks = undefined; u.clock.now += 31_000; assert.equal(await u.reason(u.mint()), 'ACCEPTED');
    u.fake.behavior.jwks = 500; u.clock.now += 11 * MIN; assert.equal(await u.reason(u.mint()), 'ACCEPTED', 'cached keys keep working through a short outage');
    u.clock.now += 61 * MIN; assert.equal(await u.reason(u.mint()), 'unavailable', 'but not forever');
  } finally { await u.fake.close(); }
  const v = await unit(); try { v.fake.behavior.badJwks = true; assert.equal(await v.reason(v.mint()), 'unavailable', 'a keyset with only RSA keys is unusable'); } finally { await v.fake.close(); }
  const down = await unit(); await down.fake.close(); assert.equal(await down.reason(down.mint()), 'unavailable', 'unreachable provider');
});

// ============================ the full sign-in flow ============================
async function env() {
  const clock = { now: T0 };
  const fake = await startFakeSupabase({ now: () => clock.now, synthetic: true });
  const dir = await startFakeDirectory({ now: () => clock.now });
  const supabase = new SupabaseAuth(cfgFor(fake), fetch, () => clock.now);
  const h = await setup(undefined, { directory: { url: dir.url, token: FAKE_TOKEN, intervalMinutes: 15, ownerEmployeeId: 'emp-001' }, clock, supabase });
  let owner = await h.login('owner@test.example');
  const sync = async () => { owner = await h.login('owner@test.example'); return (await h.call('POST', '/api/directory/sync', { token: owner, body: {} })).json; };
  await sync();
  const userOf = (id: string) => h.db.prepare('SELECT * FROM users WHERE directory_id = ?').get(id) as any;
  const subOf = (id: string) => dir.feed.identities.find(i => i.employeeId === id)!.subject;
  const emailOf = (id: string) => dir.find(id).email;
  const login = (idOrEmail: string, over: Record<string, unknown> = {}) => h.call('POST', '/api/auth/login', { body: { email: idOrEmail.includes('@') ? idOrEmail : emailOf(idOrEmail), password: FAKE_PASSWORD, kind: 'web', ...over } });
  const rows = (sql: string, ...a: any[]) => h.db.prepare(sql).all(...a) as any[];
  const count = (sql: string, ...a: any[]) => Number((h.db.prepare(sql).get(...a) as any).c);
  const run = async (fn: () => Promise<void>) => { try { await fn(); } finally { await fake.close(); await dir.close(); await h.stop(); } };
  const audit = async () => (await h.call('GET', '/api/audit?limit=300', { token: await h.login('owner@test.example') })).json.entries as any[];
  return { clock, fake, dir, h, sync, userOf, subOf, emailOf, login, rows, count, run, audit, auth: supabase };
}
const EMP = 'emp-009', HR = 'emp-002', ADMIN = 'emp-001', MGR = 'emp-004', NO_IDENTITY = 'emp-010';

test('an employee signs in with their UFS People password and gets a tracker session (nothing from Supabase is kept)', async () => {
  const e = await env();
  await e.run(async () => {
    const r = await e.login(EMP, { kind: 'device', deviceName: 'ED-PC' });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.user.email, e.emailOf(EMP)); assert.equal(r.json.user.role, 'employee'); assert.equal(r.json.user.source, 'directory'); assert.ok(r.json.token.length >= 40);
    const me = await e.h.call('GET', '/api/me', { token: r.json.token }); assert.equal(me.status, 200); assert.equal(me.json.user.directoryId, EMP);
    const s = e.rows("SELECT * FROM sessions WHERE auth_source = 'supabase'")[0]; assert.equal(s.supabase_sub, e.subOf(EMP)); assert.equal(s.aal, 'aal1'); assert.equal(s.kind, 'device'); assert.equal(Date.parse(s.expires_at) - Date.parse(s.created_at), 30 * DAY, 'device sessions from UFS People logins last 30 days, not 90');
    const web = await e.login(EMP); const ws = e.rows("SELECT * FROM sessions WHERE kind = 'web' AND auth_source = 'supabase'")[0]; assert.equal(Date.parse(ws.expires_at) - Date.parse(ws.created_at), 12 * HOUR); assert.equal(web.status, 200);
    assert.ok([...e.fake.sessions.values()].every(x => x.revoked), 'the temporary Supabase sessions were closed again');
    assert.ok(e.fake.requests.filter(q => q.passwordInBody).every(q => q.path === '/auth/v1/token'), 'the password only ever goes to the token endpoint'); assert.ok(e.fake.requests.every(q => q.path.endsWith('jwks.json') || q.apikey === FAKE_PUBLISHABLE_KEY));
    const audit = (await e.audit()).find(a => a.action === 'auth.login' && a.detail.via === 'supabase'); assert.deepEqual([audit.detail.kind, audit.detail.aal], ['web', 'aal1']);
  });
});

test('no Supabase token and no password is ever stored or logged by the tracker', async () => {
  const e = await env();
  await e.run(async () => {
    e.fake.addUser({ email: e.emailOf(NO_IDENTITY) });
    await e.login(EMP); await e.login(HR); await e.login(HR, { totp: e.fake.code(e.subOf(HR)) }); await e.login(NO_IDENTITY); await e.login(EMP, { password: 'wrong-wrong-1' });
    assert.ok(e.fake.issued.length >= 6);
    const dump = JSON.stringify(['sessions', 'users', 'audit_log', 'directory_employees', 'directory_identities', 'directory_sync_log', 'presence', 'policy'].map(t => e.rows(`SELECT * FROM ${t}`)));
    for (const secret of [...e.fake.issued, FAKE_PASSWORD, 'wrong-wrong-1']) assert.ok(!dump.includes(secret), 'secret found in the database');
    const denied = (await e.audit()).filter(a => a.action === 'auth.login_denied'); assert.ok(denied.length >= 2); for (const d of denied) assert.ok(!JSON.stringify(d).includes(e.subOf(HR)), 'the raw Supabase user id is not in the audit trail (a short hash is)');
  });
});

test('identity binding: a login is matched by the approved Supabase identity, never by email', async () => {
  const e = await env();
  await e.run(async () => {
    // 1. a Supabase user with the same email as a directory person but no approved identity gets nothing
    const intruder = e.fake.addUser({ email: e.emailOf(NO_IDENTITY) }); let r = await e.login(NO_IDENTITY); assert.equal(r.status, 403); assert.equal(r.json.error, MSG.notEnabled); assert.equal(e.count("SELECT COUNT(*) c FROM sessions WHERE auth_source = 'supabase'"), 0); void intruder;
    // 2. same for a brand-new person and for a stranger
    e.fake.addUser({ email: 'stranger@elsewhere.test' }); assert.equal((await e.login('stranger@elsewhere.test')).json.error, MSG.notEnabled);
    // 3. the account is found through the identity even if the Supabase email says something else
    e.fake.users.get(e.subOf(EMP))!.email = 'renamed.in.supabase@example.test'; r = await e.login('renamed.in.supabase@example.test'); assert.equal(r.status, 200); assert.equal(r.json.user.email, e.emailOf(EMP), 'bound by subject, not email');
    // 4. a Supabase user that steals a directory email gets NO access to that person's account
    e.fake.users.get(e.subOf('emp-012'))!.email = 'x@x.test'; const thief = e.fake.addUser({ email: e.emailOf('emp-012') }); r = await e.login(e.emailOf('emp-012')); assert.equal(r.status, 403); void thief;
    assert.equal(e.count("SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.directory_id = 'emp-012'"), 0);
    const reasons = (await e.audit()).filter(a => a.action === 'auth.login_denied').map(a => a.detail.reason); assert.ok(reasons.includes('no_identity'));
  });
});

test('every "not allowed" case gives the same message: no identity, disabled identity, inactive person', async () => {
  const e = await env();
  await e.run(async () => {
    const msgs = new Set<string>(); const statuses = new Set<number>(); e.fake.addUser({ email: e.emailOf(NO_IDENTITY) });
    for (const r of [await e.login(NO_IDENTITY)]) { msgs.add(r.json.error); statuses.add(r.status); }
    e.dir.feed.identities.find(i => i.employeeId === 'emp-011')!.enabled = false; e.dir.find('emp-013').active = false; e.clock.now += MIN; e.dir.touch(); await e.sync();
    for (const id of ['emp-011', 'emp-013']) { const r = await e.login(id); msgs.add(r.json.error); statuses.add(r.status); }
    assert.deepEqual([...msgs], [MSG.notEnabled]); assert.deepEqual([...statuses], [403]);
    const why = (await e.audit()).filter(a => a.action === 'auth.login_denied').map(a => a.detail.reason).sort(); assert.deepEqual(why, ['identity_disabled', 'no_identity', 'person_inactive'].sort());
  });
});

test('wrong credentials: generic error for wrong password and unknown email, lockout after repeated failures', async () => {
  const e = await env();
  await e.run(async () => {
    const a = await e.login(EMP, { password: 'nope-nope-12' }), b = await e.login('nobody@nowhere.test', { password: 'nope-nope-12' });
    assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.error, MSG.invalid); assert.equal(b.json.error, MSG.invalid);
    for (let i = 0; i < 7; i++) await e.login(EMP, { password: 'nope-nope-12' });   // 8 failures for this email in total
    assert.equal((await e.login(EMP, { password: 'nope-nope-12' })).status, 429);
    assert.equal((await e.login(EMP)).status, 429, 'even the right password is refused during the lockout');
    const callsDuringLock = e.fake.requests.length; await e.login(EMP); assert.equal(e.fake.requests.length, callsDuringLock, 'a locked-out login does not even reach the provider');
    e.clock.now += 16 * MIN; assert.equal((await e.login(EMP)).status, 200);
    assert.equal(e.count("SELECT COUNT(*) c FROM audit_log WHERE action = 'auth.login_failed'"), 9, 'every failure is audited, lockouts are not');
  });
});

test('input validation: malformed fields are rejected before anything is sent to Supabase', async () => {
  const e = await env();
  await e.run(async () => {
    const before = e.fake.requests.length;
    for (const body of [{ email: 'bad', password: 'x' }, { email: e.emailOf(EMP) }, { email: e.emailOf(EMP), password: 'x'.repeat(201) }, { email: e.emailOf(EMP), password: FAKE_PASSWORD, totp: 'abcdef' }, { email: e.emailOf(EMP), password: FAKE_PASSWORD, totp: '12345' }, { email: e.emailOf(EMP), password: FAKE_PASSWORD, totp: '123456789' }, { email: e.emailOf(EMP), password: FAKE_PASSWORD, kind: 'root' }, { email: e.emailOf(EMP), password: FAKE_PASSWORD, totp: '12 456' }])
      assert.equal((await e.h.call('POST', '/api/auth/login', { body })).status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(e.fake.requests.length, before);
  });
});

test('local break-glass accounts keep their own password and work even if Supabase is down', async () => {
  const e = await env();
  await e.run(async () => {
    const supabaseOnly = e.fake.addUser({ email: 'ed@test.example', password: 'Supabase-only-pass-1' }); void supabaseOnly;
    const calls = e.fake.requests.length;
    assert.equal((await e.h.call('POST', '/api/auth/login', { body: { email: 'ed@test.example', password: PASSWORD } })).status, 200, 'local password works');
    assert.equal((await e.h.call('POST', '/api/auth/login', { body: { email: 'ed@test.example', password: 'Supabase-only-pass-1' } })).status, 401, 'a Supabase password does not unlock a local account');
    assert.equal(e.fake.requests.length, calls, 'local accounts never involve Supabase');
    await e.fake.close(); assert.equal((await e.h.call('POST', '/api/auth/login', { body: { email: 'owner@test.example', password: PASSWORD } })).status, 200);
    assert.equal((await e.login(EMP)).status, 503, 'directory people cannot sign in while the provider is down');
    e.fake.close = async () => {};
  });
});

test('provider trouble is a clean 503 with no session and no details', async () => {
  const e = await env();
  await e.run(async () => {
    for (const [name, apply, clear] of [
      ['rate limited', () => { e.fake.behavior.token = 429; }, () => { e.fake.behavior.token = undefined; }], ['server error', () => { e.fake.behavior.token = 500; }, () => { e.fake.behavior.token = undefined; }],
      ['keys unavailable', () => { e.fake.behavior.jwks = 500; }, () => { e.fake.behavior.jwks = undefined; }], ['live check down', () => { e.fake.behavior.user = 502; }, () => { e.fake.behavior.user = undefined; }],
    ] as const) {
      (apply as () => void)(); e.clock.now += 40_000; const r = await e.login(EMP); assert.equal(r.status, 503, name); assert.equal(r.json.error, MSG.unavailable, name); assert.ok(!r.text.includes('upstream') && !r.text.includes('127.0.0.1'), name); (clear as () => void)();
    }
    assert.equal(e.count("SELECT COUNT(*) c FROM sessions WHERE auth_source = 'supabase'"), 0); assert.equal((await e.login(EMP)).status, 200, 'recovers by itself');
  });
});

test('the live session check refuses revoked sessions, banned users and mismatched users', async () => {
  const e = await env();
  await e.run(async () => {
    e.fake.behavior.user = 401; assert.equal((await e.login(EMP)).json.error, MSG.again); e.fake.behavior.user = undefined;
    e.fake.behavior.userReturnsOtherId = true; assert.equal((await e.login(EMP)).status, 401); e.fake.behavior.userReturnsOtherId = false;
    e.fake.users.get(e.subOf(EMP))!.bannedUntil = iso(e.clock.now + DAY); assert.equal((await e.login(EMP)).status, 401, 'banned'); e.fake.users.get(e.subOf(EMP))!.bannedUntil = iso(e.clock.now - DAY); assert.equal((await e.login(EMP)).status, 200, 'an expired ban no longer applies');
    const reasons = (await e.audit()).filter(a => a.action === 'auth.login_denied').map(a => a.detail.reason); assert.ok(reasons.includes('revoked') && reasons.includes('invalid_token') && reasons.includes('banned'), reasons.join());
  });
});

test('a hostile access token returned by the provider is rejected (wrong issuer, expired, foreign key, none)', async () => {
  const e = await env();
  await e.run(async () => {
    const sub = e.subOf(EMP), sid = uuid();
    for (const [name, token] of [['wrong issuer', e.fake.mint({ sub, session_id: sid, iss: 'https://evil.example/auth/v1' })], ['expired', e.fake.mint({ sub, session_id: sid, exp: Math.floor(T0 / 1000) - 600 })], ['foreign key', e.fake.mint({ sub, session_id: sid }, { sign: 'foreign' })], ['alg none', e.fake.mint({ sub, session_id: sid }, { sign: 'none' })], ['anonymous', e.fake.mint({ sub, session_id: sid, is_anonymous: true })]] as const) {
      e.fake.behavior.accessTokenOverride = token; const r = await e.login(EMP); assert.equal(r.status, 401, name); assert.equal(r.json.error, MSG.again, name);
    }
    e.fake.behavior.accessTokenOverride = undefined; assert.equal(e.count("SELECT COUNT(*) c FROM sessions WHERE auth_source = 'supabase'"), 0);
  });
});

// ============================ authenticator code (TOTP) ============================
test('admin, HR and owner must enter an authenticator code; employees and managers do not', async () => {
  const e = await env();
  await e.run(async () => {
    for (const id of [HR, ADMIN]) {
      const first = await e.login(id); assert.equal(first.status, 401, id); assert.equal(first.json.mfaRequired, true); assert.equal(first.json.error, MSG.mfaRequired);
      assert.equal(e.count("SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.directory_id = ?", id), 0, 'no tracker session without the code');
      const ok = await e.login(id, { totp: e.fake.code(e.subOf(id)) }); assert.equal(ok.status, 200, ok.text);
      const s = e.rows("SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.directory_id = ?", id)[0]; assert.equal(s.aal, 'aal2'); assert.equal(s.supabase_sub, e.subOf(id));
    }
    assert.equal(e.userOf(ADMIN).role, 'owner', 'the configured owner id is an owner, and owners need the code too');
    assert.equal((await e.login(EMP)).status, 200); assert.equal((await e.login(MGR)).status, 200, 'managers sign in with a password only by default');
    assert.equal((await e.login(EMP, { totp: '123456' })).status, 200, 'a code nobody asked for is ignored');
    assert.ok([...e.fake.sessions.values()].every(x => x.revoked), 'every temporary Supabase session was closed, including the ones that stopped at the code prompt');
  });
});

test('authenticator code: wrong codes are refused and counted, then locked; a correct code works again after the window', async () => {
  const e = await env();
  await e.run(async () => {
    const sub = e.subOf(HR); const wrong = () => e.login(HR, { totp: e.fake.code(sub) === '000000' ? '111111' : '000000' });
    const r = await wrong(); assert.equal(r.status, 401); assert.equal(r.json.error, MSG.code); assert.ok(!r.json.mfaRequired);
    for (let i = 0; i < 7; i++) await wrong();
    assert.equal((await e.login(HR, { totp: e.fake.code(sub) })).status, 429, 'locked even for the right code');
    e.clock.now += 16 * MIN; assert.equal((await e.login(HR, { totp: e.fake.code(sub) })).status, 200);
    const stale = totp(e.fake.users.get(sub)!.factors[0]!.secret, e.clock.now, -5); assert.equal((await e.login(HR, { totp: stale })).status, 401, 'an old code is refused');
  });
});

test('authenticator edge cases: not enrolled, provider errors, a downgraded token, other roles configured', async () => {
  const e = await env();
  await e.run(async () => {
    const sub = e.subOf(HR); const factors = e.fake.users.get(sub)!.factors; const code = () => e.fake.code(sub);
    e.fake.behavior.verifyReturnsAal1 = true; assert.equal((await e.login(HR, { totp: code() })).status, 401, 'a provider that answers with an aal1 token does not satisfy the requirement'); e.fake.behavior.verifyReturnsAal1 = false;
    e.fake.behavior.challenge = 500; assert.equal((await e.login(HR, { totp: code() })).status, 503); e.fake.behavior.challenge = undefined;
    e.fake.behavior.verify = 500; assert.equal((await e.login(HR, { totp: code() })).status, 503); e.fake.behavior.verify = undefined;
    e.fake.behavior.verify = 400; assert.equal((await e.login(HR, { totp: code() })).status, 401); e.fake.behavior.verify = undefined;
    assert.equal(e.count("SELECT COUNT(*) c FROM sessions WHERE auth_source = 'supabase'"), 0);
    e.fake.users.get(sub)!.factors = []; const none = await e.login(HR, { totp: '123456' }); assert.equal(none.status, 403); assert.equal(none.json.error, MSG.noFactor); e.fake.users.get(sub)!.factors = factors;
    const fresh = code(); e.fake.users.get(sub)!.factors[0]!.status = 'unverified'; assert.equal((await e.login(HR, { totp: fresh })).status, 403, 'an unverified factor does not count'); e.fake.users.get(sub)!.factors[0]!.status = 'verified';
    e.h.ctx.supabase!.cfg.mfaRoles.push('manager'); assert.equal((await e.login(MGR)).json.mfaRequired, true, 'the list of roles that need a code is configurable'); e.h.ctx.supabase!.cfg.mfaRoles.pop();
    assert.equal((await e.login(HR, { totp: code() })).status, 200);
  });
});

// ============================ directory changes revoke the right sessions ============================
test('disabling, removing or moving an identity in the directory ends the matching tracker sessions', async () => {
  const e = await env();
  await e.run(async () => {
    const a = (await e.login(EMP, { kind: 'device' })).json.token, b = (await e.login('emp-011')).json.token, c = (await e.login('emp-012')).json.token, local = await e.h.login('ed@test.example');
    for (const t of [a, b, c, local]) assert.equal((await e.h.call('GET', '/api/me', { token: t })).status, 200);
    e.clock.now += MIN; e.dir.feed.identities.find(i => i.employeeId === EMP)!.enabled = false;                                   // disabled
    e.dir.feed.identities = e.dir.feed.identities.filter(i => i.employeeId !== 'emp-011');                                           // removed
    e.dir.feed.identities.find(i => i.employeeId === 'emp-012')!.employeeId = 'emp-010'; e.dir.touch();                              // moved to another person
    const r = await e.sync(); assert.equal(r.status, 'ok'); assert.match(r.warnings.join(' '), /3 sign-in session\(s\) were revoked/);
    for (const t of [a, b, c]) assert.equal((await e.h.call('GET', '/api/me', { token: t })).status, 401);
    assert.equal((await e.h.call('GET', '/api/me', { token: local })).status, 200, 'local sessions are untouched');
    assert.equal((await e.login(EMP)).status, 403); assert.equal((await e.login('emp-011')).status, 403);
    const moved = await e.login('emp-012'); assert.equal(moved.status, 200); assert.equal(moved.json.user.email, e.emailOf('emp-010'), 'the identity now belongs to emp-010');
  });
});

test('a password-reset cutoff (notBefore) revokes older sessions and rejects older logins', async () => {
  const e = await env();
  await e.run(async () => {
    const early = (await e.login(EMP)).json.token; assert.equal((await e.h.call('GET', '/api/me', { token: early })).status, 200);
    e.clock.now += 10 * MIN; const cutoff = iso(e.clock.now + 5 * MIN); e.dir.feed.identities.find(i => i.employeeId === EMP)!.notBefore = cutoff; e.dir.touch(); await e.sync();
    assert.equal((await e.h.call('GET', '/api/me', { token: early })).status, 401, 'a session from before the reset is gone');
    assert.equal((e.h.db.prepare('SELECT not_before FROM directory_identities WHERE subject = ?').get(e.subOf(EMP)) as any).not_before, cutoff);
    const denied = await e.login(EMP); assert.equal(denied.status, 401); assert.equal(denied.json.error, MSG.again, 'a token issued before the cutoff is refused');
    e.clock.now += 6 * MIN; assert.equal((await e.login(EMP)).status, 200, 'after the cutoff a fresh login works');
    assert.ok((await e.audit()).some(a => a.action === 'auth.login_denied' && a.detail.reason === 'before_cutoff'));
  });
});

test('deactivating a person ends their sessions at once; role changes apply to live sessions; reactivation needs a new login', async () => {
  const e = await env();
  await e.run(async () => {
    const t = (await e.login(MGR)).json.token; const report = e.dir.feed.employees.find(x => x.managerId === MGR)!.id;
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${e.userOf(report).id}`, { token: t })).status, 200);
    e.clock.now += MIN; e.dir.find(MGR).role = 'employee'; e.dir.touch(); await e.sync();
    assert.equal((await e.h.call('GET', `/api/time-entries?userId=${e.userOf(report).id}`, { token: t })).status, 403, 'demoted in UFS People = no longer sees reports');
    e.clock.now += MIN; e.dir.find(MGR).active = false; e.dir.touch(); await e.sync(); assert.equal((await e.h.call('GET', '/api/me', { token: t })).status, 401); assert.equal((await e.login(MGR)).status, 403);
    e.clock.now += MIN; e.dir.find(MGR).active = true; e.dir.touch(); await e.sync(); assert.equal((await e.h.call('GET', '/api/me', { token: t })).status, 401, 'old session stays dead'); assert.equal((await e.login(MGR)).status, 200);
  });
});

test('people from UFS People have no tracker password; the config endpoint says how to sign in', async () => {
  const e = await env();
  await e.run(async () => {
    const t = (await e.login(EMP)).json.token;
    const r = await e.h.call('POST', '/api/auth/change-password', { token: t, body: { currentPassword: FAKE_PASSWORD, newPassword: 'Another-pass-12345' } }); assert.equal(r.status, 409); assert.match(r.json.error, /UFS People/);
    const c = await e.h.call('GET', '/api/auth/config'); assert.equal(c.status, 200); assert.deepEqual(c.json, { signIn: 'ufs-people', authenticatorRoles: ['owner', 'admin', 'hr'] });
  });
  const plain = await setup(); try { assert.deepEqual((await plain.call('GET', '/api/auth/config')).json, { signIn: 'local', authenticatorRoles: [] }); } finally { await plain.stop(); }
});

test('without Supabase configured, directory people simply cannot sign in (no fallback password)', async () => {
  const clock = { now: T0 }; const dir = await startFakeDirectory({ now: () => clock.now });
  const h = await setup(undefined, { directory: { url: dir.url, token: FAKE_TOKEN, intervalMinutes: 15, ownerEmployeeId: null }, clock });
  try {
    const owner = await h.login('owner@test.example'); await h.call('POST', '/api/directory/sync', { token: owner, body: {} });
    for (const pw of [FAKE_PASSWORD, 'directory:no-password', PASSWORD]) assert.equal((await h.call('POST', '/api/auth/login', { body: { email: dir.find('emp-009').email, password: pw } })).status, 401);
  } finally { await dir.close(); await h.stop(); }
});

test('sessions that came from a UFS People login are listed and can be revoked like any other device', async () => {
  const e = await env();
  await e.run(async () => {
    const a = (await e.login(EMP, { kind: 'device', deviceName: 'ED-LAPTOP' })).json.token, b = (await e.login(EMP)).json.token;
    const list = (await e.h.call('GET', '/api/me/devices', { token: b })).json.sessions; assert.ok(list.some((s: any) => s.deviceName === 'ED-LAPTOP' && s.kind === 'device'));
    assert.equal((await e.h.call('POST', `/api/users/${e.userOf(EMP).id}/revoke-sessions`, { token: await e.h.login('admin@test.example') })).status, 200);
    assert.equal((await e.h.call('GET', '/api/me', { token: a })).status, 401);
    const out = await e.login(EMP); assert.equal((await e.h.call('POST', '/api/auth/logout', { token: out.json.token })).status, 200); assert.equal((await e.h.call('GET', '/api/me', { token: out.json.token })).status, 401);
  });
});
