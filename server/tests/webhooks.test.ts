import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setup, giveConsent, iso, MIN, HOUR, T0, type Harness } from './helpers.ts';
import { isPublicAddress, resolvePublic, validateWebhookUrl, runWebhookDeliveries, signWebhook, WebhookUrlError, MAX_ATTEMPTS } from '../src/webhooks.ts';

let h: Harness;
let tok: Record<string, string>;
let receiver: http.Server; let port = 0;
const received: { headers: http.IncomingHttpHeaders; body: string; url: string }[] = [];
let respond: (req: http.IncomingMessage) => { status: number; headers?: Record<string, string> } = () => ({ status: 200 });
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['owner', 'admin', 'hana', 'mia', 'ed']) tok[k] = await h.login(`${k}@test.example`);
  giveConsent(h, 'ed');
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url ?? '' }); const r = respond(req); res.writeHead(r.status, r.headers); res.end('ok'); });
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', () => resolve())); port = (receiver.address() as AddressInfo).port;
});
after(async () => { await new Promise<void>(resolve => receiver.close(() => resolve())); await h.stop(); });

// Sessions last 12 h and these tests move the clock, so sign in again when needed.
const relogin = async () => { for (const k of ['owner', 'admin', 'hana', 'mia', 'ed']) tok[k] = await h.login(`${k}@test.example`); };
const create = (k: string, body: unknown) => h.call('POST', '/api/admin/webhooks', { token: tok[k], body });
const hooksOf = async () => (await h.call('GET', '/api/admin/webhooks', { token: tok.owner })).json.webhooks as any[];
const manual = (n: number) => h.call('POST', '/api/time-entries', { token: tok.ed, body: { startAt: iso(T0 - (n + 3) * HOUR), endAt: iso(T0 - (n + 3) * HOUR + 30 * MIN), taskLabel: `work ${n}` } });

// ------------------------------------------------------------------ SSRF protection
test('addresses: only globally routable unicast addresses are public', () => {
  for (const ok of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e']) assert.equal(isPublicAddress(ok), true, ok);
  for (const bad of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '203.0.113.5',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', '2001::1', '100::1',
    'not an ip', '', '999.1.1.1', '1.2.3', '8.8.8.8/32', ' 8.8.8.8', '0x7f.0.0.1', '2130706433']) assert.equal(isPublicAddress(bad), false, bad || '(empty)');
});

test('urls: https, a real public host name, ports 443/8443, no credentials; development mode relaxes only the scheme and host', () => {
  for (const ok of ['https://hooks.example.com/ufs', 'https://hooks.example.com:8443/x?y=1', 'https://a.b.example.org/']) assert.ok(validateWebhookUrl(ok), ok);
  for (const bad of ['http://example.com/x', 'https://127.0.0.1/x', 'https://8.8.8.8/x', 'https://[::1]/x', 'https://localhost/x', 'https://intranet/x', 'https://db.internal/x', 'https://printer.local/x', 'https://user:pw@example.com/x', 'https://example.com:22/x', 'https://example.com:8080/x', 'https://example.com/#a', 'ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'https://']) assert.throws(() => validateWebhookUrl(bad), WebhookUrlError, bad);
  assert.ok(validateWebhookUrl('http://127.0.0.1:4000/x', true)); assert.throws(() => validateWebhookUrl('https://user:pw@127.0.0.1/x', true), WebhookUrlError, 'credentials are refused even in development');
});

test('resolution: every answer must be public, and the checked address is the one used', async () => {
  const lookup = (answers: string[]) => async () => answers.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
  assert.equal((await resolvePublic('hooks.example.com', false, lookup(['93.184.216.34', '93.184.216.35']))).address, '93.184.216.34');
  await assert.rejects(resolvePublic('hooks.example.com', false, lookup(['93.184.216.34', '10.0.0.5'])), /non-public/, 'one private answer is enough to refuse');
  await assert.rejects(resolvePublic('hooks.example.com', false, lookup(['169.254.169.254'])), /non-public/);
  await assert.rejects(resolvePublic('hooks.example.com', false, lookup(['::ffff:127.0.0.1'])), /non-public/);
  await assert.rejects(resolvePublic('hooks.example.com', false, lookup([])), /did not resolve/);
  assert.equal((await resolvePublic('localhost', true, lookup(['127.0.0.1']))).address, '127.0.0.1', 'development mode only');
});

test('a hook whose host name resolves to a private address is never contacted', async () => {
  h.db.prepare("INSERT INTO webhooks (id,name,url,secret,events,created_at) VALUES ('ssrf','Rebinding','https://hooks.example.com/ufs','whsec_x','[\"time.approved\"]',?)").run(iso(T0));
  h.db.prepare("INSERT INTO webhook_deliveries (id,webhook_id,event,payload,next_attempt_at,created_at) VALUES ('d-ssrf','ssrf','time.approved','{}',?,?)").run(iso(T0), iso(T0));
  const before = received.length;
  assert.equal(await runWebhookDeliveries(h.ctx, { lookup: async () => [{ address: '10.0.0.7', family: 4 }] }), 0);
  const d = h.db.prepare("SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = 'd-ssrf'").get() as any;
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1); assert.match(d.last_error, /non-public/); assert.equal(received.length, before, 'nothing was sent');
  h.db.prepare("DELETE FROM webhooks WHERE id = 'ssrf'").run();
});

// ------------------------------------------------------------------ management API
test('only owners and admins manage webhooks; input is validated; the secret is shown once', async () => {
  for (const k of ['hana', 'mia', 'ed']) assert.equal((await create(k, { name: 'x1', url: 'https://hooks.example.com/a', events: ['time.approved'] })).status, 403, k);
  assert.equal((await h.call('GET', '/api/admin/webhooks', { token: tok.hana })).status, 403);
  for (const bad of [{ name: 'a' }, { events: [] }, { events: ['screenshot.deleted'] }, { extra: 1 }, { url: 'x' }]) assert.equal((await create('admin', { name: 'Hook', url: 'https://hooks.example.com/a', events: ['time.approved'], ...bad })).status, 400, JSON.stringify(bad));
  for (const url of ['http://hooks.example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://intranet/a', 'https://example.com:22/a']) { const r = await create('admin', { name: 'Hook', url, events: ['time.approved'] }); assert.equal(r.status, 422, url); }
  assert.equal((await h.call('GET', '/api/admin/webhooks', { token: tok.owner })).json.webhooks.length, 0, 'nothing was created by the refused requests');
});

test('delivery: signed, schema-only payload, pinned to the receiver, only for subscribed events', async () => {
  h.ctx.cfg.webhookDev = true;                                       // the test receiver is on 127.0.0.1
  const made = await create('admin', { name: 'Payroll', url: `http://127.0.0.1:${port}/hook`, events: ['time.approved'] });
  assert.equal(made.status, 201); const secret = made.json.secret as string; assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/); assert.match(made.json.note, /only once/);
  assert.doesNotMatch(JSON.stringify(await hooksOf()), new RegExp(secret.slice(10)), 'the secret cannot be read back');
  const first = await manual(1); const second = await manual(2);   // time.submitted: this hook did not subscribe
  assert.equal((h.db.prepare("SELECT COUNT(*) c FROM webhook_deliveries WHERE event = 'time.submitted'").get() as any).c, 0);
  const entries = ((await h.call('GET', '/api/time-entries', { token: tok.mia })).json.entries as any[]);
  const target = entries.find(e => e.id === first.json.id);
  assert.equal((await h.call('POST', `/api/time-entries/${target.id}/approve`, { token: tok.mia, body: {} })).status, 200);
  assert.equal((await h.call('POST', `/api/time-entries/${second.json.id}/reject`, { token: tok.mia, body: {} })).status, 200);
  received.length = 0;
  assert.equal(await runWebhookDeliveries(h.ctx), 1, 'only the approval was subscribed');
  const hit = received[0]!; assert.equal(hit.url, '/hook'); assert.equal(hit.headers['x-ufs-event'], 'time.approved'); assert.equal(hit.headers['user-agent'], 'UFS-Tracker-Webhooks/1'); assert.equal(hit.headers['content-type'], 'application/json');
  const ts = String(hit.headers['x-ufs-timestamp']); assert.equal(hit.headers['x-ufs-signature'], signWebhook(secret, ts, hit.body)); assert.equal(hit.headers['x-ufs-signature'], `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${hit.body}`).digest('hex')}`);
  assert.notEqual(hit.headers['x-ufs-signature'], signWebhook('whsec_wrong', ts, hit.body), 'a different secret gives a different signature');
  const payload = JSON.parse(hit.body); assert.equal(payload.event, 'time.approved'); assert.equal(payload.id, hit.headers['x-ufs-delivery']);
  assert.deepEqual(Object.keys(payload.data).sort(), ['endAt', 'entryId', 'reviewedBy', 'startAt', 'status', 'trackedMs', 'userId']);
  assert.doesNotMatch(hit.body, /@|work 1|Ed\b|Mia\b/, 'no names, emails or notes in the payload');
  assert.equal((await hooksOf())[0].last.status, 'delivered');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action = 'webhook.created'").get());
});

test('failures retry with backoff, redirects are not followed, and the delivery list tells the story', async () => {
  const hook = (await hooksOf())[0]; const entry = await manual(3);
  const approve = async (id: string) => h.call('POST', `/api/time-entries/${id}/approve`, { token: tok.mia, body: {} });
  respond = () => ({ status: 500 }); received.length = 0;
  await approve(entry.json.id); assert.equal(await runWebhookDeliveries(h.ctx), 0);
  let d = h.db.prepare("SELECT status, attempts, last_status, last_error, next_attempt_at FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1); assert.equal(d.last_status, 500); assert.match(d.last_error, /answered 500/); assert.equal(Date.parse(d.next_attempt_at), h.clock.now + 60_000, 'first retry after one minute');
  assert.equal(await runWebhookDeliveries(h.ctx), 0); assert.equal(received.length, 1, 'not retried before it is due');
  respond = () => ({ status: 302, headers: { Location: `http://127.0.0.1:${port}/elsewhere` } }); h.clock.now += 61_000;
  assert.equal(await runWebhookDeliveries(h.ctx), 0); assert.ok(!received.some(r => r.url === '/elsewhere'), 'the redirect was not followed');
  assert.match((h.db.prepare("SELECT last_error FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any).last_error, /redirects are not followed/);
  respond = () => ({ status: 200 }); h.clock.now += 5 * MIN + 1000;
  assert.equal(await runWebhookDeliveries(h.ctx), 1, 'the third attempt succeeds');
  d = h.db.prepare("SELECT status, attempts FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any; assert.deepEqual([d.status, d.attempts], ['delivered', 3]);
  assert.equal((h.db.prepare('SELECT consecutive_failures c FROM webhooks WHERE id = ?').get(hook.id) as any).c, 0);
  const list = (await h.call('GET', `/api/admin/webhooks/${hook.id}/deliveries`, { token: tok.admin })).json.deliveries as any[];
  assert.equal(list[0].status, 'delivered'); assert.equal(list[0].attempts, 3); assert.ok(!('payload' in list[0]), 'payloads are not listed');
});

test('a delivery that never succeeds is given up after the last attempt, and a hook that keeps failing is switched off and the admins are told', async () => {
  const hook = (await hooksOf())[0]; respond = () => ({ status: 503 });
  h.db.prepare('UPDATE webhooks SET consecutive_failures = 19 WHERE id = ?').run(hook.id);
  const e = await manual(4); await h.call('POST', `/api/time-entries/${e.json.id}/approve`, { token: tok.mia, body: {} });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { await runWebhookDeliveries(h.ctx); h.clock.now += 13 * HOUR; }
  const d = h.db.prepare("SELECT status, attempts FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any; assert.deepEqual([d.status, d.attempts], ['failed', MAX_ATTEMPTS]);
  const row = h.db.prepare('SELECT active, disabled_reason FROM webhooks WHERE id = ?').get(hook.id) as any; assert.equal(row.active, 0); assert.match(row.disabled_reason, /repeated failed/);
  await relogin();
  const owner = (await h.call('GET', '/api/notifications', { token: tok.owner })).json.notifications as any[]; assert.ok(owner.some(n => n.kind === 'webhook.disabled' && n.link === 'integrations'));
  const before = h.db.prepare('SELECT COUNT(*) c FROM webhook_deliveries').get() as any; const e2 = await manual(5); await h.call('POST', `/api/time-entries/${e2.json.id}/approve`, { token: tok.mia, body: {} });
  assert.equal((h.db.prepare('SELECT COUNT(*) c FROM webhook_deliveries').get() as any).c, before.c, 'a switched-off hook gets no new deliveries');
  respond = () => ({ status: 200 });
  const back = await h.call('PATCH', `/api/admin/webhooks/${hook.id}`, { token: tok.admin, body: { active: true } }); assert.equal(back.json.webhook.active, true); assert.equal(back.json.webhook.disabledReason, null);
});

test('test button, secret rotation and deletion', async () => {
  const hook = (await hooksOf())[0]; respond = () => ({ status: 200 }); received.length = 0;
  const ping = await h.call('POST', `/api/admin/webhooks/${hook.id}/test`, { token: tok.admin }); assert.equal(ping.status, 200); assert.equal(ping.json.webhook.last.status, 'delivered');
  assert.equal(received.at(-1)!.headers['x-ufs-event'], 'ping'); assert.match(received.at(-1)!.body, /test delivery/);
  const oldSecretSig = received.at(-1)!.headers['x-ufs-signature'];
  const rotated = await h.call('POST', `/api/admin/webhooks/${hook.id}/rotate-secret`, { token: tok.admin }); assert.match(rotated.json.secret, /^whsec_/);
  await h.call('POST', `/api/admin/webhooks/${hook.id}/test`, { token: tok.admin });
  const latest = received.at(-1)!; assert.equal(latest.headers['x-ufs-signature'], signWebhook(rotated.json.secret, String(latest.headers['x-ufs-timestamp']), latest.body), 'new deliveries use the new secret'); assert.notEqual(latest.headers['x-ufs-signature'], oldSecretSig);
  assert.equal((await h.call('POST', `/api/admin/webhooks/${hook.id}/test`, { token: tok.ed })).status, 403);
  assert.equal((await h.call('PATCH', `/api/admin/webhooks/${hook.id}`, { token: tok.admin, body: { active: false } })).status, 200);
  assert.equal((await h.call('POST', `/api/admin/webhooks/${hook.id}/test`, { token: tok.admin })).status, 409, 'turn it on first');
  assert.equal((await h.call('DELETE', `/api/admin/webhooks/${hook.id}`, { token: tok.mia })).status, 403);
  assert.equal((await h.call('DELETE', `/api/admin/webhooks/${hook.id}`, { token: tok.owner })).status, 200);
  assert.equal((h.db.prepare('SELECT COUNT(*) c FROM webhook_deliveries WHERE webhook_id = ?').get(hook.id) as any).c, 0, 'its deliveries go with it');
  assert.equal((await h.call('GET', `/api/admin/webhooks/${hook.id}/deliveries`, { token: tok.owner })).status, 404);
  for (const a of ['webhook.created', 'webhook.updated', 'webhook.tested', 'webhook.secret_rotated', 'webhook.deleted', 'webhook.auto_disabled']) assert.ok(h.db.prepare('SELECT 1 FROM audit_log WHERE action = ?').get(a), a);
});
