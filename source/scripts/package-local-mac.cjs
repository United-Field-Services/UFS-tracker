'use strict';
// Development-only bundle built on the same Mac used for testing.
// This is not a signed/notarized download release and does not alter Gatekeeper.
if (process.platform !== 'darwin') {
  console.error('A local Mac app must be packaged on an authorized Mac.');
  process.exit(1);
}
const {build, Platform, Arch} = require('electron-builder');
build({
  targets: Platform.MAC.createTarget(['dir'], process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
  publish: 'never',
  config: {
    directories: {output: 'local-mac-build'},
    mac: {
      identity: '-',
      notarize: false,
      forceCodeSigning: false,
      entitlements: 'build/entitlements.local.mac.plist',
      entitlementsInherit: 'build/entitlements.local.mac.plist'
    }
  }
}).catch(error => {console.error(error.message);process.exitCode=1;});
