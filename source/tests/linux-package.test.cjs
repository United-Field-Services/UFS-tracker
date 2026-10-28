'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Linux packaging replaces the default launcher and adds no executable flags', () => {
  const pkg = require('../package.json');
  assert.deepEqual(pkg.build.appImage.executableArgs, []);
  assert.ok(pkg.build.linux.extraFiles.some(f => f.from === 'build/AppRun' && f.to === 'AppRun'));
  const launcher = fs.readFileSync(path.join(root, 'build/AppRun'), 'utf8');
  assert.doesNotMatch(launcher, /--no-sandbox|--disable.*sandbox/);
  assert.match(launcher, /exec "\$APPDIR\/ufs-desktop-tracker"/);
});

function run(overrides = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufs-launcher-test-'));
  try {
    fs.copyFileSync(path.join(root, 'build/AppRun'), path.join(dir, 'AppRun'));
    fs.writeFileSync(path.join(dir, 'ufs-desktop-tracker'), '#!/bin/sh\nprintf "RUNTIME_STARTED args=%s\\n" "$#"\n', {mode: 0o755});
    fs.writeFileSync(path.join(dir, 'id'), '#!/bin/sh\nprintf "%s\\n" "${TEST_UID:-1000}"\n', {mode: 0o755});
    fs.writeFileSync(path.join(dir, 'zenity'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    return spawnSync('bash', [path.join(dir, 'AppRun'), ...args], {encoding: 'utf8', env: {...process.env, PATH: `${dir}:${process.env.PATH}`, DISPLAY: ':99', XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ...overrides}});
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
}
const unix = {skip: process.platform === 'win32'};
test('Linux launcher starts a stub runtime with zero injected arguments', unix, () => {
  const result = run(); assert.equal(result.status, 0); assert.match(result.stdout, /RUNTIME_STARTED args=0/);
});
test('Linux launcher refuses a root user', unix, () => {
  const result = run({TEST_UID: '0'}); assert.equal(result.status, 1); assert.match(result.stderr, /not root/); assert.doesNotMatch(result.stdout, /RUNTIME_STARTED/);
});
test('Linux launcher refuses command line overrides', unix, () => {
  const result = run({}, ['--no-sandbox']); assert.equal(result.status, 1); assert.match(result.stderr, /no command-line flags/); assert.doesNotMatch(result.stdout, /RUNTIME_STARTED/);
});
test('Linux launcher refuses a headless terminal', unix, () => {
  const result = run({DISPLAY: ''}); assert.equal(result.status, 1); assert.match(result.stderr, /graphical X11/); assert.doesNotMatch(result.stdout, /RUNTIME_STARTED/);
});
test('Linux launcher refuses Wayland even if Xwayland DISPLAY exists', unix, () => {
  for (const env of [{XDG_SESSION_TYPE: 'wayland'}, {WAYLAND_DISPLAY: 'wayland-0'}]) {
    const result = run(env); assert.equal(result.status, 1); assert.match(result.stderr, /Wayland/); assert.doesNotMatch(result.stdout, /RUNTIME_STARTED/);
  }
});
test('Linux launcher rejects Electron sandbox and Node overrides, even empty values', unix, () => {
  for (const key of ['ELECTRON_DISABLE_SANDBOX', 'ELECTRON_RUN_AS_NODE']) for (const value of ['', '1']) {
    const result = run({[key]: value}); assert.equal(result.status, 1); assert.match(result.stderr, /environment overrides/); assert.doesNotMatch(result.stdout, /RUNTIME_STARTED/);
  }
});
