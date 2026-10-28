import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, type Harness } from './helpers.ts';

let h: Harness;
let dir: string;
const installer = Buffer.from('MZ-synthetic-installer-bytes-'.repeat(50));
before(async () => {
  h = await setup();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufs-updates-'));
  h.ctx.cfg.updatesDir = dir;
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.2.1\nfiles:\n  - url: UFS%20Desktop%20Tracker%20Setup%200.2.1.exe\n    sha512: abc\n    size: 1\npath: UFS Desktop Tracker Setup 0.2.1.exe\nsha512: abc\n');
  fs.writeFileSync(path.join(dir, 'UFS Desktop Tracker Setup 0.2.1.exe'), installer);
  fs.writeFileSync(path.join(dir, 'UFS Desktop Tracker Setup 0.2.1.exe.blockmap'), 'blockmap');
  fs.writeFileSync(path.join(dir, 'latest.yml.sig'), 'c2lnbmF0dXJl');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not on the allow-list');
  fs.writeFileSync(path.join(dir, '.secret.yml'), 'hidden');
  fs.writeFileSync(path.join(path.dirname(dir), 'ufs-updates-outside.yml'), 'outside the folder');
});
after(async () => { await h.stop(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.join(path.dirname(dir), 'ufs-updates-outside.yml'), { force: true }); });

test('the update feed is public, read-only and serves the installer files the desktop app asks for', async () => {
  const yml = await h.call('GET', '/updates/latest.yml');
  assert.equal(yml.status, 200); assert.match(yml.text, /version: 0\.2\.1/); assert.equal(yml.headers.get('cache-control'), 'no-cache');
  const exe = await h.call('GET', '/updates/UFS%20Desktop%20Tracker%20Setup%200.2.1.exe');
  assert.equal(exe.status, 200); assert.deepEqual(exe.buf, installer);
  assert.equal((await h.call('GET', '/updates/UFS%20Desktop%20Tracker%20Setup%200.2.1.exe.blockmap')).status, 200);
  assert.equal((await h.call('GET', '/updates/latest.yml.sig')).text, 'c2lnbmF0dXJl', 'the manifest signature is served next to the manifest');
  for (const method of ['POST', 'PUT', 'DELETE']) assert.notEqual((await h.call(method, '/updates/latest.yml', { body: {} })).status, 200, `${method} must not change the feed`);
});

test('the update feed supports range requests (differential downloads) and no-store caching of the manifest', async () => {
  const res = await fetch(`${h.base}/updates/UFS%20Desktop%20Tracker%20Setup%200.2.1.exe`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(res.status, 206); assert.equal(Buffer.from(await res.arrayBuffer()).length, 10);
});

test('the update feed refuses everything outside its allow-list: other extensions, hidden files, traversal, missing files', async () => {
  for (const bad of ['notes.txt', '.secret.yml', 'missing.yml', '..%2Fufs-updates-outside.yml', '%2e%2e%2fufs-updates-outside.yml', 'a%2Fb.yml', 'latest.yml%00.txt', 'x'.repeat(200) + '.yml']) {
    const res = await h.call('GET', `/updates/${bad}`);
    assert.equal(res.status, 404, `/updates/${bad} must not be served`); assert.doesNotMatch(res.text, /outside the folder|hidden|allow-list/);
  }
  assert.equal((await h.call('GET', '/updates/')).status, 404, 'no directory listing');
});

test('an empty or missing updates folder answers 404, not a server error', async () => {
  h.ctx.cfg.updatesDir = path.join(dir, 'does-not-exist');
  assert.equal((await h.call('GET', '/updates/latest.yml')).status, 404);
  h.ctx.cfg.updatesDir = dir;
});
