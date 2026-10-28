import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'ed']) tok[k] = await h.login(`${k}@test.example`);
  h.db.prepare("INSERT INTO projects (id,name,client,active,created_at) VALUES ('proj-1','Alpha','Acme',1,?)").run(iso(T0));
  h.db.prepare("INSERT INTO tasks (id,project_id,name,active,created_at) VALUES ('task-1','proj-1','Build',1,?)").run(iso(T0));
  const entry = (n: number, user: string, offset: number, status: string) => h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,project_id,source,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES (?,?,?,'proj-1','tracker',?,?,?,0,?,?,?)")
    .run(`a${n}`, h.users[user]!.id, `api-entry-0000-${n}`, iso(T0 + offset), iso(T0 + offset + 30 * MIN), 30 * MIN, status, iso(T0), iso(T0));
  for (let i = 0; i < 5; i++) entry(i, 'ed', -i * HOUR - 10 * DAY, 'approved');
  entry(10, 'ed', -3 * DAY, 'pending'); entry(11, 'ed', -4 * DAY, 'rejected');
  h.db.prepare("INSERT INTO time_entries (id,user_id,client_id,source,start_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES ('run',?,'api-entry-running','tracker',?,1000,0,'approved',?,?)").run(h.users.ed!.id, iso(T0 - HOUR), iso(T0), iso(T0));
});
after(async () => { await h.stop(); });

const create = async (k: string, body: unknown) => h.call('POST', '/api/admin/api-keys', { token: tok[k], body });
const v1 = (key: string | undefined, path: string, method = 'GET') => h.call(method, `/api/v1${path}`, { token: key });

test('only owners and admins manage keys; the key is shown once and only its hash is stored', async () => {
  for (const k of ['hana', 'mia', 'ed']) assert.equal((await create(k, { name: 'x1', scopes: ['users:read'] })).status, 403, k);
  assert.equal((await h.call('GET', '/api/admin/api-keys', { token: tok.hana })).status, 403);
  for (const bad of [{ name: 'a', scopes: ['users:read'] }, { name: 'ok name', scopes: [] }, { name: 'ok name', scopes: ['screenshots:read'] }, { name: 'ok name', scopes: ['users:read'], extra: 1 }]) assert.equal((await create('admin', bad)).status, 400, JSON.stringify(bad));
  const made = await create('admin', { name: 'Payroll sync', scopes: ['time:read', 'users:read'] });
  assert.equal(made.status, 201); assert.match(made.json.key, /^ufs_[A-Za-z0-9_-]{40}$/); assert.match(made.json.note, /only once/);
  const list = (await h.call('GET', '/api/admin/api-keys', { token: tok.owner })).json;
  assert.equal(list.keys.length, 1); assert.equal(list.keys[0].name, 'Payroll sync'); assert.deepEqual(list.keys[0].scopes, ['time:read', 'users:read']); assert.equal(list.keys[0].prefix, made.json.key.slice(0, 10));
  assert.doesNotMatch(JSON.stringify(list), new RegExp(made.json.key.slice(12)), 'the key cannot be read back');
  const row = h.db.prepare('SELECT key_hash FROM api_keys').get() as any; assert.match(row.key_hash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(row).includes(made.json.key));
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'apikey.created'").get());
});

test('the public API accepts only keys, enforces scopes, is read-only and stays away from the dashboard API', async () => {
  const key = (await create('admin', { name: 'Reader', scopes: ['users:read', 'projects:read'] })).json.key as string;
  assert.equal((await v1(key, '/me')).json.key.name, 'Reader');
  assert.equal((await v1(undefined, '/users')).status, 401); assert.equal((await v1('ufs_' + 'x'.repeat(40), '/users')).status, 401); assert.equal((await v1('not-a-key', '/users')).status, 401);
  assert.equal((await v1(tok.owner, '/users')).status, 401, 'a dashboard session token is not an API key');
  assert.equal((await h.call('GET', '/api/me', { token: key })).status, 401, 'an API key is not a dashboard session');
  const users = (await v1(key, '/users')).json.users; assert.equal(users.length, 9); assert.deepEqual(Object.keys(users[0]).sort(), ['email', 'id', 'managerId', 'name', 'role', 'team']);
  const projects = (await v1(key, '/projects')).json.projects; assert.deepEqual(projects[0].tasks, [{ id: 'task-1', name: 'Build' }]);
  assert.equal((await v1(key, '/time-entries')).status, 403, 'no time:read scope');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await v1(key, '/users', method)).status, 405, method);
  assert.equal((await v1(key, '/screenshots')).status, 404); assert.equal((await v1(key, '/activity')).status, 404);
  assert.equal((await v1(key, '/users')).headers.get('cache-control'), 'no-store');
  const used = h.db.prepare('SELECT last_used_at FROM api_keys WHERE name = ?').get('Reader') as any; assert.ok(used.last_used_at, 'last use is recorded');
});

test('time entries: approved by default, filters, finished only, cursor paging, no sensitive fields', async () => {
  const key = (await create('owner', { name: 'Time reader', scopes: ['time:read'] })).json.key as string;
  const all = (await v1(key, '/time-entries?limit=3')).json;
  assert.equal(all.entries.length, 3); assert.ok(all.next, 'there is another page');
  assert.ok(all.entries.every((e: any) => e.status === 'approved' && e.endAt), 'approved and finished only by default');
  assert.deepEqual(Object.keys(all.entries[0]).sort(), ['endAt', 'id', 'idleMs', 'projectId', 'source', 'startAt', 'status', 'taskId', 'taskLabel', 'trackedMs', 'updatedAt', 'userId']);
  const page2 = (await v1(key, `/time-entries?limit=3&after=${encodeURIComponent(all.next)}`)).json;
  assert.equal(page2.entries.length, 2); assert.equal(page2.next, null);
  assert.equal(new Set([...all.entries, ...page2.entries].map((e: any) => e.id)).size, 5, 'pages do not overlap or skip');
  assert.equal((await v1(key, '/time-entries?status=pending')).json.entries.length, 1); assert.equal((await v1(key, '/time-entries?status=rejected')).json.entries.length, 1);
  assert.equal((await v1(key, '/time-entries?status=all')).json.entries.length, 7, 'all finished entries; the running one is never included');
  assert.equal((await v1(key, `/time-entries?userId=${h.users.eve!.id}`)).json.entries.length, 0);
  assert.equal((await v1(key, `/time-entries?from=${encodeURIComponent(iso(T0 - 10 * DAY - 2 * HOUR))}&to=${encodeURIComponent(iso(T0 - 5 * DAY))}`)).json.entries.length, 3, 'range filter: the first three approved entries start inside the range');
  for (const bad of ['status=weird', 'from=nope', `from=${encodeURIComponent(iso(T0))}&to=${encodeURIComponent(iso(T0 - DAY))}`, `from=${encodeURIComponent(iso(T0 - 200 * DAY))}&to=${encodeURIComponent(iso(T0))}`]) assert.equal((await v1(key, `/time-entries?${bad}`)).status, 400, bad);
});

test('revoking a key stops it at once; the rate limit protects the server; changes are audited', async () => {
  const made = (await create('admin', { name: 'Temporary', scopes: ['users:read'] })).json; const key = made.key as string;
  assert.equal((await v1(key, '/users')).status, 200);
  assert.equal((await h.call('DELETE', `/api/admin/api-keys/${made.id}`, { token: tok.ed })).status, 403);
  assert.equal((await h.call('DELETE', `/api/admin/api-keys/${made.id}`, { token: tok.admin })).status, 200);
  assert.equal((await v1(key, '/users')).status, 401, 'revoked');
  assert.equal((await h.call('DELETE', `/api/admin/api-keys/${made.id}`, { token: tok.admin })).status, 404, 'already revoked');
  const busy = (await create('admin', { name: 'Busy', scopes: ['users:read'] })).json.key as string;
  let limited: any = null; for (let i = 0; i < 305 && !limited; i++) { const r = await v1(busy, '/me'); if (r.status === 429) limited = r; }
  assert.ok(limited, 'the 301st request in five minutes is refused'); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  h.clock.now += 6 * MIN; assert.equal((await v1(busy, '/me')).status, 200, 'the window slides');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'apikey.revoked'").get());
});
