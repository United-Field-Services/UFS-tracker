'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
if (process.platform !== 'darwin') {console.error('Mac signature and notarization verification requires macOS.');process.exit(1);}
const root = path.join(__dirname, '..', 'release');
const bundle = path.join(root, 'mac-universal', 'UFS Desktop Tracker.app');
if (!fs.existsSync(bundle)) throw new Error('Expected universal app bundle is missing.');
function run(command, args) {try {return execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});} catch(error) {throw new Error(`${command} verification failed: ${String(error.stderr || error.message)}`);}}
run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',bundle]);
run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',bundle]);
run('/usr/bin/xcrun',['stapler','validate',bundle]);
const version = require('../package.json').version;
const disks = [`UFS-Desktop-Tracker-${version}-mac-universal.dmg`];
if (!fs.existsSync(path.join(root,disks[0]))) throw new Error('Expected versioned DMG release artifact was not produced.');
const result = {verifiedAt:new Date().toISOString(),checks:['codesign --verify --deep --strict','spctl --assess --type execute','xcrun stapler validate'],bundle:path.relative(root,bundle),artifacts:disks.map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')})),realDeviceCaptureVerified:false};
fs.writeFileSync(path.join(root,'MAC-RELEASE-VERIFIED.json'),JSON.stringify(result,null,2));
console.log('Signature, Gatekeeper assessment, and notarization ticket checks passed. Test actual capture on a supported Mac before delivery.');
