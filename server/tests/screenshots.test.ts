import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, giveConsent, png, jpegBytes, iso, MIN, HOUR, DAY, T0, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['admin', 'mia', 'max', 'ed', 'eve', 'finn']) tok[k] = await h.login(`${k}@test.example`);
});
after(async () => { await h.stop(); });

const up = (token: string, n: number, over: { bytes?: Buffer; takenAt?: string; type?: string; entry?: string } = {}) =>
  h.call('POST', `/api/screenshots?clientId=shot-00000000-${n}&takenAt=${encodeURIComponent(over.takenAt ?? iso(T0 - n * MIN))}${over.entry ? `&entryClientId=${over.entry}` : ''}`, { token, raw: over.bytes ?? png(64, 48, n), contentType: over.type });

test('uploads are refused until the employee has accepted the monitoring notice', async () => {
  const r = await up(tok.ed, 1);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /notice/i);
  assert.equal(h.store.files.size, 0);
  giveConsent(h, 'ed', 'eve', 'finn');
});

test('upload stores the PNG, is idempotent by clientId, and records metadata', async () => {
  const a = await up(tok.ed, 1, { entry: 'entry-00000000-1' });
  assert.equal(a.status, 201);
  const again = await up(tok.ed, 1);
  assert.equal(again.status, 200); assert.equal(again.json.id, a.json.id); assert.equal(again.json.duplicate, true);
  assert.equal(h.store.files.size, 1);
  const list = await h.call('GET', '/api/screenshots', { token: tok.ed });
  assert.equal(list.json.screenshots.length, 1);
  assert.equal(list.json.screenshots[0].width, 64); assert.equal(list.json.screenshots[0].height, 48);
  assert.equal(list.json.screenshots[0].entryClientId, 'entry-00000000-1');
});

test('invalid uploads are rejected: not a PNG, wrong content type, absurd size, bad ids/times', async () => {
  assert.equal((await up(tok.ed, 2, { bytes: Buffer.from('<html>not an image</html>'.repeat(5)) })).status, 415);
  assert.equal((await up(tok.ed, 3, { bytes: jpegBytes() })).status, 415);
  assert.equal((await up(tok.ed, 4, { type: 'text/plain' })).status, 415);
  const huge = png(64, 48); huge.writeUInt32BE(100000, 16);
  assert.equal((await up(tok.ed, 5, { bytes: huge })).status, 415);
  assert.equal((await up(tok.ed, 6, { takenAt: iso(T0 + HOUR) })).status, 422);
  assert.equal((await up(tok.ed, 7, { takenAt: iso(T0 - 8 * DAY) })).status, 422);
  assert.equal((await up(tok.ed, 8, { takenAt: 'nope' })).status, 400);
  assert.equal((await h.call('POST', `/api/screenshots?clientId=../../etc&takenAt=${encodeURIComponent(iso(T0))}`, { token: tok.ed, raw: png() })).status, 400);
  assert.equal((await h.call('POST', `/api/screenshots?takenAt=${encodeURIComponent(iso(T0))}`, { token: tok.ed, raw: png() })).status, 400);
  assert.equal((await h.call('POST', `/api/screenshots?clientId=shot-00000000-9&takenAt=${encodeURIComponent(iso(T0))}`, { token: tok.ed, raw: Buffer.alloc(0) })).status, 415);
  assert.equal(h.store.files.size, 1); // only the valid one from the previous test
});

test('upload is blocked when screenshots are disabled by policy', async () => {
  await h.call('PUT', `/api/policy/user/${h.users.eve!.id}`, { token: tok.admin, body: { screenshotsEnabled: false } });
  assert.equal((await up(tok.eve, 20)).status, 403);
  await h.call('PUT', `/api/policy/user/${h.users.eve!.id}`, { token: tok.admin, body: {} });
  assert.equal((await up(tok.eve, 20)).status, 201);
});

test('thumbnails: only the owner uploads, PNG/JPEG only, served for the grid', async () => {
  const id = (await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots[0].id;
  assert.equal((await h.call('PUT', `/api/screenshots/${id}/thumb`, { token: tok.mia, raw: jpegBytes(), contentType: 'image/jpeg' })).status, 404);
  assert.equal((await h.call('PUT', `/api/screenshots/${id}/thumb`, { token: tok.ed, raw: Buffer.from('not-an-image-not-an-image'), contentType: 'image/jpeg' })).status, 415);
  assert.equal((await h.call('PUT', `/api/screenshots/${id}/thumb`, { token: tok.ed, raw: jpegBytes(), contentType: 'image/jpeg' })).status, 200);
  const t = await h.call('GET', `/api/screenshots/${id}/thumb`, { token: tok.mia });
  assert.equal(t.status, 200); assert.equal(t.headers.get('content-type'), 'image/jpeg');
  assert.equal((await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots[0].hasThumb, true);
});

test('who can see what: employee own, direct manager, admin; never other teams or peers', async () => {
  const edShot = (await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots[0];
  await up(tok.finn, 30);
  const finnShot = (await h.call('GET', '/api/screenshots', { token: tok.finn })).json.screenshots[0];
  for (const [who, shot, expected] of [
    ['ed', edShot, 200], ['mia', edShot, 200], ['admin', edShot, 200],
    ['eve', edShot, 404], ['max', edShot, 404], ['finn', edShot, 404],
    ['finn', finnShot, 200], ['max', finnShot, 200], ['mia', finnShot, 404],
  ] as const) {
    const r = await h.call('GET', `/api/screenshots/${shot.id}/image`, { token: tok[who] });
    assert.equal(r.status, expected, `${who} -> ${shot.userName}`);
    if (expected === 200) { assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.ok(r.buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))); }
  }
  // list scoping
  const miaSees = new Set((await h.call('GET', '/api/screenshots', { token: tok.mia })).json.screenshots.map((s: any) => s.userName));
  assert.deepEqual([...miaSees].sort(), ['Ed', 'Eve']);
  assert.equal((await h.call('GET', `/api/screenshots?userId=${h.users.ed!.id}`, { token: tok.eve })).status, 403);
  assert.equal((await h.call('GET', `/api/screenshots?userId=${h.users.finn!.id}`, { token: tok.mia })).status, 403);
  assert.equal((await h.call('GET', '/api/screenshots/not-a-real-id/image', { token: tok.admin })).status, 404);
});

test('viewing someone else\'s screenshot is audited; viewing your own is not; thumbnails are not', async () => {
  const shot = (await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots[0];
  const countViews = async () => (await h.call('GET', '/api/audit?limit=500', { token: tok.admin })).json.entries.filter((e: any) => e.action === 'screenshot.viewed').length;
  const before = await countViews();
  await h.call('GET', `/api/screenshots/${shot.id}/image`, { token: tok.ed });
  await h.call('GET', `/api/screenshots/${shot.id}/thumb`, { token: tok.mia });
  assert.equal(await countViews(), before);
  await h.call('GET', `/api/screenshots/${shot.id}/image`, { token: tok.mia });
  assert.equal(await countViews(), before + 1);
});

test('policy "employee_only" hides screenshots from managers and admins but not from the employee', async () => {
  await h.call('PUT', '/api/policy/team/team-1', { token: tok.admin, body: { screenshotVisibility: 'employee_only' } });
  const shot = (await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots[0];
  assert.equal((await h.call('GET', `/api/screenshots/${shot.id}/image`, { token: tok.ed })).status, 200);
  assert.equal((await h.call('GET', `/api/screenshots/${shot.id}/image`, { token: tok.mia })).status, 404);
  assert.equal((await h.call('GET', `/api/screenshots/${shot.id}/image`, { token: tok.admin })).status, 404);
  assert.equal((await h.call('GET', `/api/screenshots?userId=${h.users.ed!.id}`, { token: tok.mia })).status, 403);
  assert.equal((await h.call('GET', '/api/screenshots', { token: tok.mia })).json.screenshots.length, 0);
  assert.equal((await h.call('DELETE', `/api/screenshots/${shot.id}`, { token: tok.mia })).status, 404);
  // finn (team 2) is unaffected
  assert.ok((await h.call('GET', '/api/screenshots', { token: tok.max })).json.screenshots.length >= 1);
  await h.call('PUT', '/api/policy/team/team-1', { token: tok.admin, body: {} });
});

test('deleting: employee own (if allowed), manager/admin for reports, others cannot; file and thumb are removed', async () => {
  await up(tok.ed, 40); await up(tok.ed, 41); await up(tok.ed, 42);
  const shots = (await h.call('GET', '/api/screenshots?limit=200', { token: tok.ed })).json.screenshots;
  const [a, b, c] = shots.filter((s: any) => /shot-00000000-4[012]/.test(s.clientId));
  assert.equal((await h.call('DELETE', `/api/screenshots/${a.id}`, { token: tok.eve })).status, 404);   // peer: not even visible
  assert.equal((await h.call('DELETE', `/api/screenshots/${a.id}`, { token: tok.ed })).status, 200);
  assert.equal((await h.call('DELETE', `/api/screenshots/${a.id}`, { token: tok.ed })).status, 404);    // already gone
  assert.equal(await h.store.get(h.users.ed!.id, `${a.id}.png`), null);
  assert.equal((await h.call('DELETE', `/api/screenshots/${b.id}`, { token: tok.mia })).status, 200);   // manager of ed
  assert.equal((await h.call('DELETE', `/api/screenshots/${c.id}`, { token: tok.max })).status, 404);   // other team's manager
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: { allowEmployeeDelete: false } });
  assert.equal((await h.call('DELETE', `/api/screenshots/${c.id}`, { token: tok.ed })).status, 403);
  assert.equal((await h.call('DELETE', `/api/screenshots/${c.id}`, { token: tok.admin })).status, 200);
  await h.call('PUT', '/api/policy/org/org', { token: tok.admin, body: {} });
  assert.equal((await h.call('GET', `/api/screenshots/${a.id}/image`, { token: tok.admin })).status, 404);
  const log = (await h.call('GET', '/api/audit?limit=500', { token: tok.admin })).json.entries.filter((e: any) => e.action === 'screenshot.deleted');
  assert.equal(log.length, 3);
});

test('retention: expired screenshots are removed per effective policy, newer ones kept', async () => {
  await h.call('PUT', `/api/policy/user/${h.users.finn!.id}`, { token: tok.admin, body: { retentionDays: 2 } });
  await up(tok.finn, 50, { takenAt: iso(T0 - 1 * HOUR) });
  // advance 3 days: finn's (2-day) shots expire; ed's default 30-day shots stay
  const relogin = async () => { for (const k of ['admin', 'ed', 'finn']) tok[k] = await h.login(`${k}@test.example`); };
  h.clock.now = T0 + 3 * DAY; await relogin();
  const finnBefore = (await h.call('GET', '/api/screenshots', { token: tok.finn })).json.screenshots.length;
  const edBefore = (await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots.length;
  assert.ok(finnBefore >= 1 && edBefore >= 1);
  const run = await h.call('POST', '/api/admin/retention/run', { token: tok.admin });
  assert.equal(run.status, 200); assert.ok(run.json.removed >= finnBefore);
  assert.equal((await h.call('GET', '/api/screenshots', { token: tok.finn })).json.screenshots.length, 0);
  assert.equal((await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots.length, edBefore);
  // 100 days later ed's expire too (the default retention is now 90 days)
  h.clock.now = T0 + 100 * DAY; await relogin();
  await h.call('POST', '/api/admin/retention/run', { token: tok.admin });
  assert.equal((await h.call('GET', '/api/screenshots', { token: tok.ed })).json.screenshots.length, 0);
  assert.equal(h.store.files.size, 0, 'no orphaned image files remain');
});
