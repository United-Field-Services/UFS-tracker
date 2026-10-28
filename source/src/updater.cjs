'use strict';
// Consent-gated in-place updates. The update feed is served by the company tracker server the employee already uses
// (<server>/updates/), so the app still talks only to that one server. Nothing is downloaded or installed without a
// click, installing is refused while tracking, and local data (screenshots, sessions, pending uploads, sign-in) is
// never touched: the NSIS update overwrites the program files only (see build/installer.nsh).

/** The feed base for a server URL, or null when it is not a safe origin (https, or http only for localhost). */
function feedBase(serverUrl) {
  let url;
  try { url = new URL(String(serverUrl || '')); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return `${url.origin}/updates/`;
}

const crypto = require('node:crypto');

/** Compares dotted numeric versions: positive when a is newer than b. */
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

/**
 * Downloads latest.yml and latest.yml.sig and verifies the Ed25519 signature with the embedded public key. Only a
 * manifest you signed can authorize an update; its version and SHA-512 are what the installer must match afterwards.
 */
async function fetchSignedManifest(base, publicKey, fetchImpl = fetch) {
  const get = async name => {
    const res = await fetchImpl(`${base}${name}`, {redirect: 'error', signal: AbortSignal.timeout(15_000), headers: {'Cache-Control': 'no-cache'}});
    if (!res.ok) throw new Error(`The update server answered ${res.status} for ${name}.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 64 * 1024) throw new Error(`${name} is too large.`);
    return bytes;
  };
  const [manifest, signature] = await Promise.all([get('latest.yml'), get('latest.yml.sig')]);
  let ok = false;
  try { ok = crypto.verify(null, manifest, crypto.createPublicKey(publicKey), Buffer.from(signature.toString('utf8').trim(), 'base64')); } catch { ok = false; }
  if (!ok) throw new Error('The update is not signed by the organization release key. It was not installed.');
  const text = manifest.toString('utf8');
  const version = /^version:\s*['"]?([0-9]+(?:\.[0-9]+){1,3})['"]?\s*$/m.exec(text)?.[1], sha512 = /^sha512:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (!version || !sha512) throw new Error('The update manifest is incomplete.');
  return {version, sha512};
}

/**
 * deps: getAutoUpdater() -> electron-updater's autoUpdater (loaded lazily), isPackaged, currentVersion,
 * getServerUrl(), canInstall() -> true only when tracking is stopped, prepareToInstall() -> Promise (stop work, flush queue),
 * onChange().
 */
function createUpdater(deps) {
  let status = 'idle', version = null, percent = 0, message = '', wired = false, updater = null, expected = null;
  const set = (next, extra = {}) => { status = next; version = extra.version ?? version; percent = extra.percent ?? percent; message = extra.message ?? ''; try { deps.onChange?.(); } catch { /* UI refresh only */ } };
  const snapshot = () => ({status, version, percent: Math.round(percent), message, currentVersion: deps.currentVersion, supported: !!deps.isPackaged});

  function wire() {
    if (wired) return;
    updater = (deps.getAutoUpdater || (() => require('electron-updater').autoUpdater))(); // loaded only when an update is requested
    // Consent and safety: no silent download, no install on quit, no downgrades, no pre-releases.
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowDowngrade = false; updater.allowPrerelease = false;
    // What the updater found must be exactly what the signed manifest authorized (version and installer SHA-512).
    updater.on('update-available', info => {
      const sha = info?.files?.[0]?.sha512 ?? info?.sha512;
      if (!expected || String(info?.version) !== expected.version || sha !== expected.sha512) { expected = null; set('error', {message: 'The update did not match the signed release manifest. It was not installed.'}); return; }
      set('available', {version: expected.version, percent: 0});
    });
    updater.on('update-not-available', () => set('current', {message: 'You have the latest version.'}));
    updater.on('download-progress', progress => set('downloading', {percent: Number(progress?.percent) || 0}));
    updater.on('update-downloaded', info => set('ready', {version: String(info?.version ?? version ?? ''), percent: 100}));
    updater.on('error', error => set('error', {message: `Update failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`}));
    wired = true;
  }

  async function check() {
    if (!deps.isPackaged) { set('unsupported', {message: 'Updates work in the installed app only.'}); return snapshot(); }
    if (['checking', 'downloading'].includes(status)) return snapshot();
    const base = feedBase(deps.getServerUrl());
    if (!base) { set('error', {message: 'Sign in to your company server first; updates come from it.'}); return snapshot(); }
    wire(); set('checking', {message: ''}); expected = null;
    try {
      const manifest = await fetchSignedManifest(base, deps.publicKey ?? require('./update-public-key.cjs'), deps.fetch);
      if (compareVersions(manifest.version, deps.currentVersion) <= 0) { set('current', {message: 'You have the latest version.'}); return snapshot(); }
      expected = manifest;
      updater.setFeedURL({provider: 'generic', url: base}); await updater.checkForUpdates();
    }
    catch (error) { set('error', {message: `Update check failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`}); }
    return snapshot();
  }

  async function download() {
    if (status !== 'available') throw new Error('There is no update to download.');
    set('downloading', {percent: 0});
    try { await updater.downloadUpdate(); }
    catch (error) { set('error', {message: `Update download failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`}); }
    return snapshot();
  }

  async function install() {
    if (status !== 'ready') throw new Error('The update has not been downloaded yet.');
    if (!deps.canInstall()) throw new Error('Stop tracking before installing the update.');
    await deps.prepareToInstall();
    updater.quitAndInstall(true, true); // silent installer, relaunch afterwards; local data stays where it is
    return snapshot();
  }

  return {check, download, install, snapshot, feedBase};
}

module.exports = {createUpdater, feedBase, fetchSignedManifest, compareVersions};
