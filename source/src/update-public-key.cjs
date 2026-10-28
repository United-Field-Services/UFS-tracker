'use strict';
// Public half of the key that signs release manifests (see scripts/sign-update-manifest.cjs). Installed apps accept an
// update only when latest.yml carries a valid signature from this key. THIS IS A DEVELOPMENT KEY: before any rollout,
// generate a production pair, keep its private key in a CI secret or offline, and replace the value below.
module.exports = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF6rtEFTYnvADZy/Bft3pPXeJsL276PiA+jEZ7xMGkf8=
-----END PUBLIC KEY-----
`;
