'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LocalStore, decodeScreenshot, decodeThumbnail} = require('../src/storage.cjs');

// Minimal WebP containers: enough for the header/size checks (the main process never decodes pixels).
function webp(width = 64, height = 48, kind = 'lossy') {
  const body = Buffer.alloc(40, 7); let chunk;
  if (kind === 'lossy') { chunk = Buffer.concat([Buffer.from('VP8 '), Buffer.alloc(4), Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]), Buffer.alloc(4), body]); chunk.writeUInt16LE(width, 14); chunk.writeUInt16LE(height, 16); }
  else if (kind === 'lossless') { chunk = Buffer.concat([Buffer.from('VP8L'), Buffer.alloc(4), Buffer.from([0x2f]), Buffer.alloc(4), body]); chunk.writeUInt32LE((width - 1) | ((height - 1) << 14), 9); }
  else { chunk = Buffer.concat([Buffer.from('VP8X'), Buffer.alloc(4), Buffer.alloc(10), body]); chunk.writeUIntLE(width - 1, 12, 3); chunk.writeUIntLE(height - 1, 15, 3); }
  chunk.writeUInt32LE(chunk.length - 8, 4);
  const out = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), chunk]); out.writeUInt32LE(out.length - 8, 4); return out;
}
const url = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;
const webpUrl = (w, h, kind) => url('image/webp', webp(w, h, kind));
const jpeg = (size = 40) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 1)]);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ufs-webp-test-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return {root, store: new LocalStore(root), files: () => fs.readdirSync(path.join(root, 'Screenshots')).sort()}; }

test('decodeScreenshot reads PNG and all three WebP container variants', () => {
  assert.deepEqual({...decodeScreenshot(png), bytes: undefined}, {bytes: undefined, width: 1, height: 1, ext: 'png', type: 'image/png'});
  for (const kind of ['lossy', 'lossless', 'extended']) {
    const d = decodeScreenshot(webpUrl(1920, 1080, kind));
    assert.equal(d.width, 1920, kind); assert.equal(d.height, 1080, kind); assert.equal(d.ext, 'webp'); assert.equal(d.type, 'image/webp');
  }
});

test('decodeScreenshot rejects anything that is not a bounded PNG or WebP', () => {
  const riff = (type, extra = Buffer.alloc(60)) => { const b = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(type), extra]); return b; };
  for (const bad of [
    null, undefined, 42, '', 'file:///etc/passwd', 'data:text/html;base64,SGk=', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/webp;base64,',
    'data:image/webp;base64,AAAA', url('image/webp', riff('WAVE')), url('image/webp', riff('WEBP', Buffer.concat([Buffer.from('JUNK'), Buffer.alloc(60)]))),
    webpUrl(5000, 100, 'lossy'), webpUrl(100, 5000, 'lossless'), webpUrl(4097, 10, 'extended'), url('image/png', webp()),
  ]) assert.throws(() => decodeScreenshot(bad), /Invalid|out of bounds|PNG|WebP/, String(bad).slice(0, 50));
  assert.ok(decodeScreenshot(webpUrl(4096, 4096, 'lossy')));   // the limit itself is fine
});

test('decodeThumbnail accepts small JPEGs only and quietly ignores everything else', () => {
  assert.ok(decodeThumbnail(url('image/jpeg', jpeg())));
  for (const bad of [null, '', 'data:image/png;base64,AAAA', url('image/jpeg', Buffer.from('not a jpeg at all')), url('image/jpeg', jpeg(310 * 1024)), 'data:image/jpeg;base64,' + 'A'.repeat(500 * 1024), 'data:text/html;base64,SGk=']) assert.equal(decodeThumbnail(bad), null);
});

test('saving a WebP screenshot with a thumbnail writes both files and indexes them', t => {
  const {store, files, root} = fixture(t);
  const entry = store.saveCapture({id: 's1', task: 'T', displayId: 1}, webpUrl(1280, 720, 'lossy'), () => true, url('image/jpeg', jpeg()));
  assert.match(entry.fileName, /\.webp$/); assert.match(entry.thumbFileName, /\.thumb\.jpg$/);
  assert.equal(entry.width, 1280); assert.equal(entry.height, 720);
  assert.equal(files().length, 2); assert.ok(files().some(f => f.endsWith('.webp')) && files().some(f => f.endsWith('.thumb.jpg')));
  assert.equal(store.fileFor(entry.id).endsWith('.webp'), true); assert.equal(store.typeFor(entry.id), 'image/webp');
  assert.equal(store.thumbFor(entry.id), path.join(root, 'Screenshots', entry.thumbFileName)); assert.ok(fs.readFileSync(store.thumbFor(entry.id)).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
  const reopened = new LocalStore(root);                                  // survives a restart
  assert.equal(reopened.typeFor(entry.id), 'image/webp'); assert.ok(reopened.thumbFor(entry.id));
  assert.equal(reopened.list().captures[0].thumbFileName, entry.thumbFileName);
});

test('PNG screenshots keep working (with and without a thumbnail) and are typed as PNG', t => {
  const {store, files} = fixture(t);
  const a = store.saveCapture({id: 's', task: 'T'}, png);
  assert.match(a.fileName, /\.png$/); assert.equal(a.thumbFileName, undefined); assert.equal(store.thumbFor(a.id), null); assert.equal(store.typeFor(a.id), 'image/png');
  const b = store.saveCapture({id: 's', task: 'T'}, png, () => true, url('image/jpeg', jpeg()));
  assert.ok(store.thumbFor(b.id)); assert.equal(files().length, 3);
});

test('a bad thumbnail is ignored but the screenshot is still saved', t => {
  const {store, files} = fixture(t);
  const e = store.saveCapture({id: 's', task: 'T'}, webpUrl(), () => true, 'data:image/jpeg;base64,AAAA');
  assert.equal(e.thumbFileName, undefined); assert.equal(files().length, 1); assert.equal(store.thumbFor(e.id), null);
});

test('rollback removes BOTH files: failed index commit, and expiry before/after the thumbnail is written', t => {
  let {store, files} = fixture(t);
  store.persist = () => { throw new Error('Disk full'); };
  assert.throws(() => store.saveCapture({id: 'f', task: 'T'}, webpUrl(), () => true, url('image/jpeg', jpeg())), /Disk full/);
  assert.deepEqual(files(), []); assert.equal(store.data.captures.length, 0);
  for (let limit = 1; limit <= 7; limit++) {          // cancel at every checkpoint inside saveCapture
    ({store, files} = fixture(t)); let checks = 0;
    try { store.saveCapture({id: 'x', task: 'T'}, webpUrl(), () => ++checks < limit, url('image/jpeg', jpeg())); } catch { /* cancelled */ }
    if (store.data.captures.length === 0) assert.deepEqual(files(), [], `limit ${limit}: nothing may remain`);
    else assert.equal(files().length, 2, `limit ${limit}: committed screenshots keep both files`);
  }
});

test('altered metadata cannot make thumbFor or fileFor read outside the screenshots folder', t => {
  const {store} = fixture(t);
  store.data.captures.push({id: 'a', fileName: 'ok.webp', thumbFileName: '../../secret.thumb.jpg'}, {id: 'b', fileName: 'ok.webp', thumbFileName: 'x.png'}, {id: 'c', fileName: '../evil.webp'}, {id: 'd', fileName: 'a.exe'}, {id: 'e', fileName: 'ok.webp', thumbFileName: 5});
  assert.equal(store.thumbFor('a'), null); assert.equal(store.thumbFor('b'), null); assert.equal(store.thumbFor('e'), null); assert.equal(store.thumbFor('missing'), null);
  assert.throws(() => store.fileFor('c'), /not found/); assert.throws(() => store.fileFor('d'), /not found/); assert.doesNotThrow(() => store.fileFor('a'));
});

test('screenshot and thumbnail files are private on Unix', t => {
  if (process.platform === 'win32') return;
  const {store} = fixture(t); const e = store.saveCapture({id: 'm', task: 'T'}, webpUrl(), () => true, url('image/jpeg', jpeg()));
  assert.equal(fs.statSync(store.fileFor(e.id)).mode & 0o777, 0o600); assert.equal(fs.statSync(store.thumbFor(e.id)).mode & 0o777, 0o600);
});
