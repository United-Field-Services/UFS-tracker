'use strict';
const {execFileSync} = require('node:child_process');
if (process.argv[2] === 'mac') {
  if (process.platform !== 'darwin') { console.error('Mac release blocked: run this build on an authorized macOS environment. A Linux-built source archive is not a Mac installer.'); process.exit(1); }
  let identities = ''; try {identities = execFileSync('/usr/bin/security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'});} catch {}
  if (!identities.includes('Developer ID Application:') && !process.env.CSC_LINK) {console.error('Mac release blocked: configure a valid Apple Developer ID Application signing identity through a secure channel. Do not paste credentials into chat.'); process.exit(1);}
  const notarize = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) || !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  if (!notarize) {console.error('Mac release blocked: Apple notarization authentication must be configured securely in this build environment.');process.exit(1);}
}
