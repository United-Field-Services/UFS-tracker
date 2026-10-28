import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Store } from '../src/s3-store.ts';
import { createStore } from '../src/store-factory.ts';
import { loadConfig } from '../src/config.ts';
import { DiskStore } from '../src/storage.ts';
import { setup, giveConsent, png, webp, iso, T0, MIN, DAY, type Harness } from './helpers.ts';

// A tiny in-process S3 look-alike (path-style). It records every request so tests can check what the SDK really sent.
interface Req { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
async function fakeS3() {
  const objects = new Map<string, Buffer>(); const requests: Req[] = []; const control = { failStatus: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks); requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
      if (control.failStatus) { res.writeHead(control.failStatus, { 'Content-Type': 'application/xml' }); return void res.end('<Error><Code>InternalError</Code><Message>boom</Message></Error>'); }
      if (req.method === 'PUT') { objects.set(key, stripChunkFraming(body, req.headers)); res.writeHead(200, { ETag: '"fake"' }); return void res.end(); }
      if (req.method === 'GET') {
        const found = objects.get(key);
        if (!found) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return void res.end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>'); }
        res.writeHead(200, { 'Content-Length': found.length }); return void res.end(found);
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return void res.end(); }
      res.writeHead(405); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { endpoint, objects, requests, control, close: () => new Promise<void>(r => server.close(() => r())) };
}
// aws-chunked bodies (used when the SDK streams) carry framing; plain Buffer uploads do not. Handle both.
function stripChunkFraming(body: Buffer, headers: http.IncomingHttpHeaders): Buffer {
  if (!String(headers['content-encoding'] ?? '').includes('aws-chunked') && headers['x-amz-content-sha256'] !== 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD') return body;
  const parts: Buffer[] = []; let i = 0;
  while (i < body.length) { const nl = body.indexOf('\r\n', i); const size = parseInt(body.subarray(i, nl).toString().split(';')[0]!, 16); if (!size) break; parts.push(body.subarray(nl + 2, nl + 2 + size)); i = nl + 2 + size + 2; }
  return Buffer.concat(parts);
}

let s3: Awaited<ReturnType<typeof fakeS3>>;
before(async () => { s3 = await fakeS3(); });
after(async () => { await s3.close(); });
const make = (extra: Partial<ConstructorParameters<typeof S3Store>[0]> = {}) =>
  new S3Store({ bucket: 'tracker-test', region: 'us-east-1', endpoint: s3.endpoint, forcePathStyle: true, accessKeyId: 'AKIATESTKEY', secretAccessKey: 'secret-test-value', ...extra });
const U = '11111111-2222-3333-4444-555555555555';

test('S3 store: put, get and remove round-trip through a signed path-style request', async () => {
  const store = make({ prefix: 'screenshots' }); const bytes = png(80, 60, 3);
  await store.put(U, 'abc.png', bytes);
  const put = s3.requests.find(r => r.method === 'PUT')!;
  assert.equal(new URL(put.url, 'http://x').pathname, `/tracker-test/screenshots/${U}/abc.png`);
  assert.match(String(put.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\/\d{8}\/us-east-1\/s3\/aws4_request/);
  assert.ok(put.headers['x-amz-date']); assert.equal(put.headers['cache-control'], 'private, no-store');
  assert.equal(put.headers['x-amz-server-side-encryption'], undefined);           // off unless asked for
  assert.ok((await store.get(U, 'abc.png'))!.equals(bytes));
  await store.remove(U, 'abc.png');
  assert.equal(await store.get(U, 'abc.png'), null);                                // gone -> null, not an error
  await store.remove(U, 'abc.png');                                                 // removing a missing object is fine
});

test('S3 store: server-side encryption is requested only when enabled; the secret never appears on the wire', async () => {
  await make({ serverSideEncryption: true }).put(U, 'sse.png', png());
  const put = s3.requests.filter(r => r.method === 'PUT').at(-1)!;
  assert.equal(put.headers['x-amz-server-side-encryption'], 'AES256');
  for (const r of s3.requests) assert.ok(!JSON.stringify(r.headers).includes('secret-test-value'));
});

test('S3 store: unsafe keys are refused before any request is made', async () => {
  const store = make(); const before = s3.requests.length;
  for (const [u, f] of [['../evil', 'a.png'], [U, '../a.png'], [U, 'a/b.png'], [U, 'a..png'], ['', 'a.png'], [U, ''], ['u/v', 'a.png']] as const) {
    await assert.rejects(store.put(u, f, png()), /Invalid storage path/, `${u} ${f}`);
    await assert.rejects(store.get(u, f), /Invalid storage path/); await assert.rejects(store.remove(u, f), /Invalid storage path/);
  }
  assert.equal(s3.requests.length, before);
});

test('S3 store: a service error is raised (not treated as "missing"), then works again', async () => {
  const store = make(); await store.put(U, 'ok.png', png());
  s3.control.failStatus = 500;
  await assert.rejects(store.get(U, 'ok.png'));
  await assert.rejects(store.remove(U, 'ok.png'));
  await assert.rejects(store.put(U, 'new.png', png()));
  s3.control.failStatus = 0;
  assert.ok(await store.get(U, 'ok.png'));
});

test('S3 store: configuration errors are caught early', () => {
  assert.throws(() => new S3Store({ bucket: '' }), /bucket/);
  assert.throws(() => new S3Store({ bucket: 'b', accessKeyId: 'only-id' }), /both/);
  assert.throws(() => new S3Store({ bucket: 'b', secretAccessKey: 'only-secret' }), /both/);
});

test('store factory: disk by default, S3 from environment, unknown drivers and missing bucket rejected', () => {
  const cfg = loadConfig({ dataDir: process.cwd() + '/data-test-factory' });
  assert.ok(createStore(cfg, {}) instanceof DiskStore);
  assert.ok(createStore(cfg, { STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: s3.endpoint, S3_FORCE_PATH_STYLE: '1', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }) instanceof S3Store);
  assert.throws(() => createStore(cfg, { STORAGE_DRIVER: 's3' }), /bucket/);
  assert.throws(() => createStore(cfg, { STORAGE_DRIVER: 'ftp' }), /Unknown STORAGE_DRIVER/);
  assert.throws(() => createStore(cfg, { STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' }), /both/);
  import('node:fs').then(fs => fs.rmSync(process.cwd() + '/data-test-factory', { recursive: true, force: true }));
});

// ---- the whole product on top of an S3-compatible store ----
let h: Harness; let tok: Record<string, string>;
test('full flow on S3: upload, view as manager, thumbnail, delete, retention, nothing left behind', async () => {
  s3.objects.clear();
  h = await setup(make({ prefix: 'e2e' }));
  try {
    tok = {}; for (const k of ['admin', 'mia', 'ed']) tok[k] = await h.login(`${k}@test.example`);
    giveConsent(h, 'ed');
    const up = (n: number, bytes: Buffer, type: string) => h.call('POST', `/api/screenshots?clientId=s3-shot-0000-${n}&takenAt=${encodeURIComponent(iso(T0 - n * MIN))}`, { token: tok.ed, raw: bytes, contentType: type });
    const a = await up(1, png(100, 60, 1), 'image/png'); const b = await up(2, webp(100, 60), 'image/webp');
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    assert.deepEqual([...s3.objects.keys()].map(k => k.replace(/[0-9a-f-]{36}/g, 'ID')).sort(), ['/tracker-test/e2e/ID/ID.png', '/tracker-test/e2e/ID/ID.webp'].sort());
    const list = (await h.call('GET', '/api/screenshots', { token: tok.mia })).json.screenshots;
    assert.deepEqual(list.map((s: any) => s.format).sort(), ['png', 'webp']);
    const png1 = await h.call('GET', `/api/screenshots/${a.json.id}/image`, { token: tok.mia });
    assert.equal(png1.status, 200); assert.equal(png1.headers.get('content-type'), 'image/png'); assert.equal(png1.buf.length, png(100, 60, 1).length);
    const web = await h.call('GET', `/api/screenshots/${b.json.id}/image`, { token: tok.mia });
    assert.equal(web.headers.get('content-type'), 'image/webp');
    assert.equal((await h.call('PUT', `/api/screenshots/${a.json.id}/thumb`, { token: tok.ed, raw: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30, 2)]), contentType: 'image/jpeg' })).status, 200);
    assert.equal((await h.call('GET', `/api/screenshots/${a.json.id}/thumb`, { token: tok.mia })).headers.get('content-type'), 'image/jpeg');
    // delete removes the stored objects
    assert.equal((await h.call('DELETE', `/api/screenshots/${a.json.id}`, { token: tok.ed })).status, 200);
    assert.equal([...s3.objects.keys()].filter(k => k.includes(a.json.id)).length, 0);
    // retention: 100 days later the remaining one expires
    h.clock.now = T0 + 100 * DAY; tok.admin = await h.login('admin@test.example');
    assert.equal((await h.call('POST', '/api/admin/retention/run', { token: tok.admin })).json.removed, 1);
    assert.equal(s3.objects.size, 0, 'no orphaned objects in the bucket');
  } finally { await h.stop(); }
});

test('S3 outage: a failed upload stores nothing; a failed delete keeps the record so it can be retried', async () => {
  s3.objects.clear();
  h = await setup(make());
  try {
    const ed = await h.login('ed@test.example'); const admin = await h.login('admin@test.example'); giveConsent(h, 'ed');
    const up = (n: number) => h.call('POST', `/api/screenshots?clientId=out-shot-0000-${n}&takenAt=${encodeURIComponent(iso(T0 - MIN))}`, { token: ed, raw: png(), contentType: 'image/png' });
    s3.control.failStatus = 503;
    assert.equal((await up(1)).status, 500);
    s3.control.failStatus = 0;
    assert.equal((await h.call('GET', '/api/screenshots', { token: ed })).json.screenshots.length, 0, 'no database row without an object');
    const ok = await up(2); assert.equal(ok.status, 201);
    s3.control.failStatus = 503;
    assert.equal((await h.call('DELETE', `/api/screenshots/${ok.json.id}`, { token: ed })).status, 500);
    s3.control.failStatus = 0;
    assert.equal((await h.call('GET', '/api/screenshots', { token: ed })).json.screenshots.length, 1, 'record kept after a failed delete');
    h.clock.now = T0 + 100 * DAY; const admin2 = await h.login('admin@test.example'); void admin;
    s3.control.failStatus = 503;
    assert.equal((await h.call('POST', '/api/admin/retention/run', { token: admin2 })).json.removed, 0);   // storage down: nothing marked deleted
    s3.control.failStatus = 0;
    assert.equal((await h.call('POST', '/api/admin/retention/run', { token: admin2 })).json.removed, 1);   // retried successfully
    assert.equal(s3.objects.size, 0);
    const audit = (await h.call('GET', '/api/audit?limit=50', { token: admin2 })).json.entries.find((e: any) => e.action === 'retention.purged' && e.detail.failed > 0);
    assert.ok(audit, 'the failed purge attempt is audited');
  } finally { await h.stop(); }
});
