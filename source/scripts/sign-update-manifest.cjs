'use strict';
// Release tool for the in-app updater: signs release/latest.yml with an Ed25519 key so installed apps accept only
// manifests (and therefore installers, via the SHA-512 inside) that you released.
//   node scripts/sign-update-manifest.cjs --generate <private-key-file>   creates a key pair; prints the PUBLIC key to paste into src/update-public-key.cjs
//   node scripts/sign-update-manifest.cjs <latest.yml> <private-key-file>  writes <latest.yml>.sig (base64)
// Keep the private key out of git and out of chat (a CI secret or an offline file).
const crypto = require('node:crypto');
const fs = require('node:fs');

const [first, second] = process.argv.slice(2);
if (first === '--generate' && second) {
  if (fs.existsSync(second)) { console.error('Refusing to overwrite an existing key file.'); process.exit(1); }
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(second, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
  console.log('Private key written to the file you named. Public key (put this in src/update-public-key.cjs):\n');
  console.log(publicKey.export({type: 'spki', format: 'pem'}));
} else if (first && second) {
  const manifest = fs.readFileSync(first);
  const signature = crypto.sign(null, manifest, crypto.createPrivateKey(fs.readFileSync(second)));
  fs.writeFileSync(`${first}.sig`, signature.toString('base64'));
  console.log(`Signed ${first} (${signature.length}-byte Ed25519 signature written to ${first}.sig)`);
} else {
  console.error('Usage: sign-update-manifest.cjs --generate <private-key-file> | <latest.yml> <private-key-file>');
  process.exit(1);
}
