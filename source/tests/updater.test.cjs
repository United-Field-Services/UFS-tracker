'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const crypto = require('node:crypto');
const {createUpdater, feedBase} = require('../src/updater.cjs');

const KEYS = crypto.generateKeyPairSync('ed25519');
const PUBLIC = KEYS.publicKey.export({type: 'spki', format: 'pem'});
const INFO = {version: '0.2.1', files: [{url: 'Setup.exe', sha512: 'sha-ok'}]};
const tick = () => new Promise(resolve => setImmediate(resolve));
const MANIFEST = 'version: 0.2.1\nfiles:\n  - url: Setup.exe\n    sha512: sha-ok\n    size: 1\npath: Setup.exe\nsha512: sha-ok\n';
const sign = (text, key = KEYS.privateKey) => crypto.sign(null, Buffer.from(text), key).toString('base64');
/** A fake update server: manifest text, its signature, or an HTTP status per file. */
function feed({manifest = MANIFEST, signature = sign(manifest), missing = []} = {}) {
  return async url => {
    const name = String(url).split('/').pop();
    const body = name === 'latest.yml' ? manifest : name === 'latest.yml.sig' ? signature : null;
    if (body === null || missing.includes(name)) return {ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)};
    return {ok: true, status: 200, arrayBuffer: async () => Buffer.from(body)};
  };
}

function fixture(overrides = {}) {
  const auto = Object.assign(new EventEmitter(), {
    calls: [], autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: true,
    setFeedURL(value) { this.calls.push(['feed', value]); },
    async checkForUpdates() { this.calls.push(['check']); if (this.checkError) throw this.checkError; },
    async downloadUpdate() { this.calls.push(['download']); },
    quitAndInstall(silent, run) { this.calls.push(['install', silent, run]); },
  });
  const order = [];
  const deps = {
    isPackaged: true, currentVersion: '0.2.0', publicKey: PUBLIC, fetch: feed(), hashFile: async () => 'sha-ok', getAutoUpdater: () => auto, getServerUrl: () => 'https://tracker.example.org',
    canInstall: () => true, prepareToInstall: async () => { order.push('prepared'); }, onChange: () => { order.push('changed'); }, ...overrides,
  };
  return {auto, order, updater: createUpdater(deps)};
}

test('feed address is the server origin plus /updates/, https only (http only for localhost), no credentials or queries', () => {
  assert.equal(feedBase('https://tracker.example.org'), 'https://tracker.example.org/updates/');
  assert.equal(feedBase('https://tracker.example.org/some/path?x=1'.replace('?x=1', '')), 'https://tracker.example.org/updates/');
  assert.equal(feedBase('http://127.0.0.1:4301'), 'http://127.0.0.1:4301/updates/');
  assert.equal(feedBase('http://localhost:4301/'), 'http://localhost:4301/updates/');
  for (const bad of ['http://tracker.example.org', 'ftp://tracker.example.org', 'https://user:pw@tracker.example.org', 'https://tracker.example.org/?a=1', 'https://tracker.example.org/#x', 'not a url', '', null, undefined]) assert.equal(feedBase(bad), null, String(bad));
});

test('updates are consent-gated: no auto download, no install on quit, no downgrade, no pre-release', async () => {
  const f = fixture(); await f.updater.check();
  assert.equal(f.auto.autoDownload, false); assert.equal(f.auto.autoInstallOnAppQuit, false);
  assert.equal(f.auto.allowDowngrade, false); assert.equal(f.auto.allowPrerelease, false);
  assert.deepEqual(f.auto.calls[0], ['feed', {provider: 'generic', url: 'https://tracker.example.org/updates/'}]);
});

test('check: not in a dev run, not without a server, and failures are reported without throwing', async () => {
  assert.equal((await fixture({isPackaged: false}).updater.check()).status, 'unsupported');
  const noServer = await fixture({getServerUrl: () => null}).updater.check(); assert.equal(noServer.status, 'error'); assert.match(noServer.message, /company server/);
  const unsafe = await fixture({getServerUrl: () => 'http://tracker.example.org'}).updater.check(); assert.equal(unsafe.status, 'error');
  const f = fixture(); f.auto.checkError = new Error('connect ECONNREFUSED\nstack line');
  const failed = await f.updater.check(); assert.equal(failed.status, 'error'); assert.match(failed.message, /ECONNREFUSED/); assert.doesNotMatch(failed.message, /stack line/);
});

test('available, download and ready states follow the updater events; download needs an available update', async () => {
  const f = fixture();
  await assert.rejects(f.updater.download(), /no update/);
  await f.updater.check(); assert.equal(f.updater.snapshot().status, 'checking');
  f.auto.emit('update-not-available'); assert.equal(f.updater.snapshot().status, 'current');
  await f.updater.check(); f.auto.emit('update-available', INFO);
  assert.deepEqual({status: f.updater.snapshot().status, version: f.updater.snapshot().version}, {status: 'available', version: '0.2.1'});
  assert.equal(f.auto.calls.filter(call => call[0] === 'download').length, 0, 'nothing downloads without a click');
  await f.updater.download(); assert.deepEqual(f.auto.calls.at(-1), ['download']);
  f.auto.emit('download-progress', {percent: 42.6}); assert.equal(f.updater.snapshot().percent, 43);
  f.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick(); assert.equal(f.updater.snapshot().status, 'ready');
  f.auto.emit('error', new Error('boom')); assert.equal(f.updater.snapshot().status, 'error');
});

test('install is refused until the update is downloaded and while tracking; otherwise it prepares first, then installs silently and relaunches', async () => {
  const f = fixture(); await assert.rejects(f.updater.install(), /not been downloaded/);
  await f.updater.check(); f.auto.emit('update-available', INFO); f.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick();
  let tracking = true; const busy = fixture({canInstall: () => !tracking});
  await busy.updater.check(); busy.auto.emit('update-available', INFO); busy.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick();
  await assert.rejects(busy.updater.install(), /Stop tracking/); assert.equal(busy.auto.calls.some(call => call[0] === 'install'), false);
  tracking = false; await busy.updater.install();
  assert.deepEqual(busy.auto.calls.at(-1), ['install', true, true]); assert.ok(busy.order.includes('prepared'));
  await f.updater.install(); assert.ok(f.order.lastIndexOf('prepared') < f.auto.calls.length + f.order.length); assert.deepEqual(f.auto.calls.at(-1), ['install', true, true]);
});

test('preparing to install happens before the installer is launched', async () => {
  const sequence = []; const f = fixture({prepareToInstall: async () => { sequence.push('prepare'); await new Promise(resolve => setTimeout(resolve, 5)); sequence.push('prepared'); }});
  f.auto.quitAndInstall = () => sequence.push('install');
  await f.updater.check(); f.auto.emit('update-available', INFO); f.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick();
  await f.updater.install(); assert.deepEqual(sequence, ['prepare', 'prepared', 'install']);
});

test('only a manifest signed with the release key is accepted: bad signature, wrong key, tampering and missing signature all stop the update', async () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const cases = {
    'garbage signature': feed({signature: 'AAAA'}),
    'signed by another key': feed({signature: sign(MANIFEST, other)}),
    'manifest changed after signing': feed({manifest: MANIFEST.replace('sha-ok', 'sha-evil'), signature: sign(MANIFEST)}),
    'signature file missing': feed({missing: ['latest.yml.sig']}),
    'manifest missing': feed({missing: ['latest.yml']}),
  };
  for (const [name, fetch] of Object.entries(cases)) {
    const f = fixture({fetch}); const result = await f.updater.check();
    assert.equal(result.status, 'error', name); assert.equal(f.auto.calls.some(call => call[0] === 'check' || call[0] === 'download'), false, `${name}: the updater must not run`);
  }
  const unsigned = await fixture({fetch: feed({signature: sign(MANIFEST, other)})}).updater.check(); assert.match(unsigned.message, /not signed by the organization/);
});

test('what the updater finds must match the signed manifest (version and installer hash); a swapped installer is refused', async () => {
  const f = fixture(); await f.updater.check();
  f.auto.emit('update-available', {version: '0.2.1', files: [{url: 'Setup.exe', sha512: 'sha-swapped'}]});
  assert.equal(f.updater.snapshot().status, 'error'); assert.match(f.updater.snapshot().message, /did not match the signed release manifest/);
  await assert.rejects(f.updater.download(), /no update/);
  const wrongVersion = fixture(); await wrongVersion.updater.check(); wrongVersion.auto.emit('update-available', {version: '9.9.9', files: [{url: 'Setup.exe', sha512: 'sha-ok'}]});
  assert.equal(wrongVersion.updater.snapshot().status, 'error');
});

test('a signed manifest that is not newer than the installed version needs no download and never calls the updater', async () => {
  const f = fixture({currentVersion: '0.2.1'}); const result = await f.updater.check();
  assert.equal(result.status, 'current'); assert.equal(f.auto.calls.some(call => call[0] === 'check'), false);
  const { compareVersions } = require('../src/updater.cjs');
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0); assert.ok(compareVersions('1.0', '1.0.0') === 0); assert.ok(compareVersions('0.2.0', '0.2.1') < 0);
});
test('a second or odd installer entry, a mismatching extra hash or a non-exe file in the updater metadata is refused', async () => {
  const bad = {
    'two entries': {version: '0.2.1', files: [{url: 'Setup.exe', sha512: 'sha-ok'}, {url: 'Other.exe', sha512: 'sha-evil'}]},
    'two entries, first honest': {version: '0.2.1', files: [{url: 'Setup.exe', sha512: 'sha-ok'}, {url: 'Setup2.exe', sha512: 'sha-ok'}]},
    'not an installer': {version: '0.2.1', files: [{url: 'payload.zip', sha512: 'sha-ok'}]},
    'top-level hash differs': {version: '0.2.1', files: [{url: 'Setup.exe', sha512: 'sha-ok'}], sha512: 'sha-evil'},
    'no files': {version: '0.2.1', files: []},
  };
  for (const [name, info] of Object.entries(bad)) {
    const f = fixture(); await f.updater.check(); f.auto.emit('update-available', info);
    assert.equal(f.updater.snapshot().status, 'error', name);
  }
  const good = fixture(); await good.updater.check(); good.auto.emit('update-available', {...INFO, sha512: 'sha-ok'}); assert.equal(good.updater.snapshot().status, 'available');
});

test('the downloaded installer is hashed and must equal the signed SHA-512 before the update can be installed', async () => {
  const swapped = fixture({hashFile: async () => 'sha-other-bytes'});
  await swapped.updater.check(); swapped.auto.emit('update-available', INFO); await swapped.updater.download();
  swapped.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick();
  assert.equal(swapped.updater.snapshot().status, 'error'); assert.match(swapped.updater.snapshot().message, /does not match the signed release manifest/);
  await assert.rejects(swapped.updater.install(), /not been downloaded/); assert.equal(swapped.auto.calls.some(call => call[0] === 'install'), false);
  const unreadable = fixture({hashFile: async () => { throw new Error('ENOENT'); }});
  await unreadable.updater.check(); unreadable.auto.emit('update-available', INFO); unreadable.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick();
  assert.equal(unreadable.updater.snapshot().status, 'error'); await assert.rejects(unreadable.updater.install(), /not been downloaded/);
  const genuine = fixture(); await genuine.updater.check(); genuine.auto.emit('update-available', INFO); genuine.auto.emit('update-downloaded', {version: '0.2.1', downloadedFile: 'x'}); await tick();
  assert.equal(genuine.updater.snapshot().status, 'ready'); await genuine.updater.install(); assert.deepEqual(genuine.auto.calls.at(-1), ['install', true, true]);
});

test('the real file hasher produces the base64 SHA-512 that electron-builder writes into latest.yml', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const {fileSha512} = require('../src/updater.cjs'); const file = path.join(os.tmpdir(), `ufs-hash-${process.pid}.bin`); fs.writeFileSync(file, 'installer bytes');
  try { assert.equal(await fileSha512(file), crypto.createHash('sha512').update('installer bytes').digest('base64')); await assert.rejects(fileSha512(file + '.missing')); }
  finally { fs.rmSync(file, {force: true}); }
});