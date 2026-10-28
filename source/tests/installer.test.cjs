'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('interactive uninstaller asks before removing only the local tracker data folder', () => {
  const packageJson = JSON.parse(read('package.json'));
  const include = packageJson.build.nsis.include;
  assert.equal(include, 'build/installer.nsh');
  assert.equal(packageJson.build.nsis.deleteAppDataOnUninstall, undefined, 'uninstall must not delete data automatically');

  const script = read(include);
  assert.match(script, /!macro customUnInstall/);
  assert.match(script, /MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2/);
  assert.match(script, /saved screenshots, session history, and pending company uploads/);
  assert.match(script, /IDNO ufsKeepTrackerData/);
  assert.match(script, /RMDir \/r "\$APPDATA\\UFS Desktop Tracker\\Local Tracker Data"/);
  assert.doesNotMatch(script, /RMDir \/r "\$APPDATA\\UFS Desktop Tracker"/);
});
