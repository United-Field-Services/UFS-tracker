'use strict';
const {app, BrowserWindow, ipcMain, desktopCapturer, screen, session, systemPreferences, powerMonitor, shell, nativeImage, Menu, dialog, safeStorage} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {Tracker} = require('./tracker.cjs');
const {ActivityCounter} = require('./activity.cjs');
const {LocalStore} = require('./storage.cjs');
const {createCaptureClock} = require('./clock.cjs');
const {SyncClient} = require('./sync.cjs');
const entryPath = path.join(__dirname, '..', 'renderer', 'index.html');
const entryUrl = pathToFileURL(entryPath).href;
const captureClock = createCaptureClock({onFailure: message => {
  clearTimeout(deadlineTimer);
  const finished = tracker.stop(message, 'clock-unavailable');
  if (store) save(finished);
  if (win) broadcast();
}});
const tracker = new Tracker({now: captureClock.now});
let win, store, sync, loop, deadlineTimer, checkpoint = 0, activityCounter = null, uIOhook = null;
let quitting = false, quitAllowed = false;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('Tracker could not open', error.message); app.quit(); });
}
function permission() { return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'system-managed'; }
function state() { captureClock.now(); return {...tracker.snapshot(), permission: permission(), platform: process.platform, version: app.getVersion(), directory: store.root, sync: sync ? sync.snapshot() : null}; }
// Every session save also queues company sessions for upload (a no-op unless signed in to a company server).
function save(session) { store.saveSession(session); if (sync && session?.mode === 'company') sync.enqueueEntry(session); }
function persist() { save(tracker.current); }
// Per-capture settings from the organization's policy (company sessions only). Local sessions stay full-quality PNG.
function captureSettings() {
  const policy = tracker.current?.mode === 'company' ? sync?.snapshot().policy : null;
  return {blur: !!policy?.screenshotBlur, format: policy?.imageFormat === 'webp' ? 'webp' : 'png', quality: Number.isInteger(policy?.imageQuality) ? policy.imageQuality : 80};
}
function broadcast() { if (win && !win.isDestroyed()) { const snapshot = state(); win.setTitle(`${snapshot.phase === 'tracking' ? '● TRACKING' : snapshot.phase === 'paused' ? 'Ⅱ PAUSED' : 'UFS'} · Desktop Tracker`); win.webContents.send('tracker:state', snapshot); } }
function finishExpired() { if (tracker.deadlineReached()) stopActivity(); const finished = tracker.expireIfNeeded(idle()); if (finished) {clearTimeout(deadlineTimer); save(finished); broadcast();} return finished; }
function appendActivity(slices) { if (tracker.current && Array.isArray(slices) && slices.length) tracker.current.activitySlices.push(...slices); }
function stopActivity() {
  if (!activityCounter) return;
  const meter = activityCounter; activityCounter = null;
  try { appendActivity(meter.stop(Date.parse(tracker.wall()))); } catch (error) { try { appendActivity(meter.drain()); } catch {} console.warn('Count-only activity hook stopped with an error.'); }
}
function startActivity() {
  if (activityCounter || tracker.phase !== 'tracking' || !tracker.current?.activityTrackingEnabled || tracker.current?.idleReview) return;
  try { uIOhook ||= require('uiohook-napi').uIOhook; }
  catch { tracker.pause('Count-only activity measurement is unavailable on this computer. Tracking is paused.'); throw new Error('Count-only activity measurement is unavailable on this computer.'); }
  const meter = new ActivityCounter({source: uIOhook, now: () => Date.parse(tracker.wall())});
  try { meter.start(); activityCounter = meter; }
  catch { tracker.pause('Count-only activity measurement could not start. Tracking is paused; contact your administrator.'); throw new Error('Count-only activity measurement could not start. Tracking is paused.'); }
}
function tick() {
  if (activityCounter) { activityCounter.tick(Date.parse(tracker.wall())); appendActivity(activityCounter.drain()); if (tracker.deadlineReached()) stopActivity(); }
  const finished = tracker.tick(idle());
  if (tracker.phase !== 'tracking' || tracker.current?.idleReview) stopActivity();
  if (finished) {clearTimeout(deadlineTimer); save(finished);} return finished;
}
function scheduleDeadline() {
  clearTimeout(deadlineTimer);
  const remaining = tracker.remainingMs();
  if (remaining !== null) deadlineTimer = setTimeout(() => {
    try {if (!finishExpired()) scheduleDeadline();}
    catch(error) {tracker.pause(`Time-limit check failed: ${error.message}`); broadcast();}
  }, Math.max(1, remaining));
}
function pause(reason) { tick(); stopActivity(); tracker.pause(reason); persist(); broadcast(); }
function stop() { tick(); stopActivity(); clearTimeout(deadlineTimer); const finished = tracker.stop(); save(finished); broadcast(); }
function idle() { try { return powerMonitor.getSystemIdleTime(); } catch { return NaN; } }
function handle(name, fn) { ipcMain.handle(`tracker:${name}`, (event, value) => { if (!win || event.sender !== win.webContents || event.senderFrame?.url !== entryUrl) throw new Error('Untrusted request.'); return fn(value); }); }
async function start() {
  captureClock.assertHealthy();
  app.setAppUserModelId('com.ufs.desktoptracker.local');
  store = new LocalStore(path.join(app.getPath('userData'), 'Local Tracker Data')); store.recoverInterrupted();
  sync = new SyncClient({
    dir: store.root, deviceName: String(require('node:os').hostname() || 'Desktop Tracker').slice(0, 80), onChange: () => { if (win) broadcast(); },
    secrets: safeStorage ? {available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text).toString('base64'), decrypt: text => safeStorage.decryptString(Buffer.from(text, 'base64'))} : undefined,
    // WebP/PNG bytes plus the JPEG thumbnail made at capture time; older PNG captures without one get a thumbnail on demand.
    readCapture: id => { const thumbFile = store.thumbFor(id); return {bytes: fs.readFileSync(store.fileFor(id)), type: store.typeFor(id), thumb: thumbFile ? fs.readFileSync(thumbFile) : null}; },
    makeThumb: bytes => ({bytes: nativeImage.createFromBuffer(bytes).resize({width: 320}).toJPEG(70), type: 'image/jpeg'}),
  });
  sync.init(); sync.start();
  // The renderer has no network access at all. Company sync runs only here in the main process, and only after
  // the user explicitly signs in to a company server; there are no analytics, update checks or remote content.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: !['file:', 'data:', 'devtools:'].includes(new URL(details.url).protocol)}));
  // getDisplayMedia() surfaces as 'display-capture' on some platforms and as 'media' with an EMPTY
  // mediaTypes list on others (observed on Electron 44 / Windows). Camera or microphone requests carry
  // 'video' / 'audio' in mediaTypes and stay denied.
  const isDisplayCapture = (requested, details) => requested === 'display-capture' || (requested === 'media' && Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 0);
  function mayCapture(wc, requested, details) {
    try {return isDisplayCapture(requested, details) && wc === win?.webContents && details?.requestingUrl === entryUrl && tracker.phase === 'starting' && !tracker.deadlineReached();}
    catch {return false;}
  }
  session.defaultSession.setPermissionRequestHandler((wc, requested, callback, details) => callback(mayCapture(wc, requested, details)));
  session.defaultSession.setPermissionCheckHandler((wc, requested, _origin, details) => mayCapture(wc, requested, details));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const token = tracker.token;
    try {
      if (finishExpired()) {callback(null); return;}
      if (tracker.phase !== 'starting' || request.frame?.url !== entryUrl || !request.videoRequested || request.audioRequested) { callback(null); return; }
      // Enumerate only: zero-sized thumbnails avoid capturing unselected display pixels.
      const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: {width: 0, height: 0}, fetchWindowIcons: false});
      if (finishExpired() || tracker.phase !== 'starting' || tracker.token !== token) { callback(null); return; }
      // Capture-all policy: the renderer asks once per screen; each ask gets the next screen in left-to-right order.
      const wanted = tracker.current.allScreens ? screenQueue.shift() : String(tracker.current.displayId);
      const selected = wanted === undefined ? null : sources.find(source => source.display_id === String(wanted));
      if (!selected) throw new Error(tracker.current.allScreens ? 'One of your screens is no longer available.' : 'Your selected screen is no longer available.');
      callback({video: selected});
    } catch (error) { tracker.fail(token, error.message); persist(); broadcast(); callback(null); }
  });
  win = new BrowserWindow({width: 1120, height: 850, minWidth: 800, minHeight: 640, backgroundColor: '#f5f7fa', show: false, webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label: 'UFS Tracker', submenu: [{label: 'Pause tracking', click: () => pause('Paused from the app menu.')}, {label: 'Stop tracking', click: stop}, {type: 'separator'}, {role: 'quit'}]}, {role: 'editMenu'}, {role: 'windowMenu'}]));
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => pause('Tracking stopped because the app window closed unexpectedly.'));
  win.on('minimize', () => pause('Paused while the app is minimized. Restore the window and press Resume.'));
  win.on('hide', () => pause('Paused while the app is hidden. Press Resume when ready.'));
  win.once('ready-to-show', () => win.show());
  handle('status', () => {finishExpired(); return state();});
  // Left-to-right (then top-to-bottom) so the "all screens" image reads like the desk layout.
  const orderedDisplays = () => [...screen.getAllDisplays()].sort((a, b) => (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) || (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));
  let screenQueue = [];
  handle('displays', () => orderedDisplays().map((display, index) => ({id: display.id, label: display.label || `Screen ${index + 1}`, width: display.size.width, height: display.size.height, primary: display.id === screen.getPrimaryDisplay().id})));
  // Signed in to a company account: the organization's policy (not the renderer) decides mode, interval and screenshots.
  function applyCompanyPolicy(value) {
    if (!sync || !sync.signedIn) { if (value?.mode === 'company') throw new Error('Sign in to your company account first.'); return value; }
    const snap = sync.snapshot();
    if (!snap.policy) throw new Error('Company settings are not available yet. Check your connection and try again.');
    if (snap.needsConsent) throw new Error('Please read and accept the monitoring notice first.');
    const projectId = value?.projectId || null, taskId = value?.taskId || null;
    const project = projectId ? snap.projects.find(p => p.id === projectId) : null;
    if (projectId && !project) throw new Error('Choose a project from the list.');
    if (taskId && !project?.tasks.some(t => t.id === taskId)) throw new Error('Choose a task that belongs to the project.');
    if (snap.policy.requireProject && !projectId) throw new Error('Your organization requires choosing a project.');
    const screenshots = snap.policy.screenshotsEnabled;
    // Capture-all policy: the employee's single-screen choice is replaced by every connected screen (the main screen anchors the session).
    const allScreens = screenshots && snap.policy.captureAllScreens === true;
    return {...value, mode: 'company', intervalSeconds: snap.policy.screenshotIntervalSeconds, idleTimeoutSeconds: snap.policy.idleTimeoutSeconds, activityTrackingEnabled: snap.policy.activityTrackingEnabled === true, screenshots, allScreens, projectId, taskId, displayId: !screenshots ? null : allScreens ? screen.getPrimaryDisplay().id : value?.displayId};
  }
  handle('prepare', input => {
    captureClock.assertHealthy();
    if (finishExpired()) throw new Error('The one-hour test has ended. Press Start again only if you want a new test.');
    const value = applyCompanyPolicy(input);
    if (!value || (value.screenshots !== false && !screen.getAllDisplays().some(display => display.id === value.displayId))) throw new Error('Choose an available screen.');
    const token = tracker.prepare(value); screenQueue = value.allScreens ? orderedDisplays().map(display => String(display.id)) : []; persist(); broadcast();
    return {token, screenCount: value.allScreens ? screenQueue.length : 1};
  });
  handle('confirm', token => { captureClock.assertHealthy(); if (finishExpired()) throw new Error('The one-hour test has ended.'); if (!win.isVisible() || win.isMinimized()) throw new Error('Keep the app window visible while tracking.'); tracker.confirm(token); try { startActivity(); } catch { persist(); broadcast(); throw new Error('Count-only activity measurement could not start. Tracking is paused.'); } scheduleDeadline(); persist(); broadcast(); return state(); });
  handle('fail', value => { tracker.fail(value?.token, process.platform === 'darwin' ? 'Screen sharing did not start. Allow screen recording in System Settings if requested, reopen the app, and try again.' : 'Screen sharing did not start. Press Resume to try again.'); persist(); broadcast(); });
  handle('pause', () => {pause(); return state();});
  handle('stop', () => {stop(); return state();});
  handle('idle-review', value => {
    tick();
    const result = tracker.resolveIdleReview(value?.keep);
    try { startActivity(); } catch { /* tracking state already communicates the failure */ }
    persist(); broadcast(); return {result, state: state()};
  });
  handle('authorize-capture', value => {finishExpired(); return {allowed: !!value && tracker.canSave(value), remainingMs: tracker.remainingMs()};});
  // A narrow synchronous final gate prevents a queued pre-sleep authorization
  // from being used after the sleep-inclusive main clock has expired.
  ipcMain.on('tracker:finalize-capture', (event, value) => {
    let allowed = false;
    try {
      if (win && event.sender === win.webContents && event.senderFrame?.url === entryUrl) {
        finishExpired(); allowed = !!value && tracker.canSave(value);
      }
    } catch {allowed = false;}
    finally {event.returnValue = allowed;} // Electron sends the reply on assignment: exactly once.
  });
  handle('save-capture', value => {
    finishExpired();
    if (!value || !tracker.canSave(value)) return {saved: false};
    try {
      const company = tracker.current.mode === 'company', entryId = tracker.current.id;
      const result = store.saveCapture(tracker.current, value.dataUrl, () => tracker.canSave(value), value.thumbUrl); tracker.saved(value, true);
      if (company && sync) sync.enqueueScreenshot({captureId: result.id, takenAt: result.takenAt ?? new Date().toISOString(), entryClientId: entryId});
      finishExpired(); persist(); broadcast(); return {saved: true, id: result.id};
    }
    catch(error) { if (finishExpired()) return {saved: false}; tracker.captureFailed(value, `Screenshot could not be saved: ${error.message}`); persist(); broadcast(); throw error; }
  });
  handle('capture-failed', value => { finishExpired(); tracker.captureFailed(value || {}, 'Screen sharing ended or a screenshot could not be read. Tracking is paused.'); persist(); broadcast(); });
  // Decoding a 1080p PNG takes ~70 ms on the main thread. Decoding 60 on every refresh froze the app for ~4 s, long enough
  // to trip the 5 s "timing gap" safety pause. So: decode each screenshot once (cached) and at most a few per call;
  // the renderer asks again while any thumbnail is still pending.
  const thumbnails = new Map(); const THUMBNAILS_PER_CALL = 2;
  handle('gallery', () => {
    const result = store.list(); let budget = THUMBNAILS_PER_CALL;
    return {...result, captures: result.captures.map(capture => {
      let thumbnail = thumbnails.get(capture.id);
      if (thumbnail === undefined) {
        // Preferred: the small JPEG saved with the screenshot (no decoding at all).
        let saved = null; try { saved = store.thumbFor(capture.id); } catch { saved = null; }
        if (saved) { try { thumbnail = `data:image/jpeg;base64,${fs.readFileSync(saved).toString('base64')}`; } catch { thumbnail = ''; } thumbnails.set(capture.id, thumbnail); }
        else if (!/\.webp$/.test(String(capture.fileName)) && budget > 0) { // older PNG captures: decode once, a couple per call
          budget--;
          try { thumbnail = nativeImage.createFromPath(store.fileFor(capture.id)).resize({width: 340}).toDataURL(); } catch { thumbnail = ''; }
          thumbnails.set(capture.id, thumbnail);
        } else if (/\.webp$/.test(String(capture.fileName))) { thumbnail = ''; thumbnails.set(capture.id, thumbnail); } // WebP without a thumbnail: nativeImage cannot decode it
      }
      return {...capture, thumbnail: thumbnail || null, thumbnailPending: thumbnail === undefined};
    })};
  });
  handle('image', id => { const file = store.fileFor(id); return `data:${store.typeFor(id)};base64,${fs.readFileSync(file).toString('base64')}`; });
  handle('reveal', id => shell.showItemInFolder(store.fileFor(id)));
  handle('open-folder', async () => {const error = await shell.openPath(store.root); if (error) throw new Error(error);});
  // ---- company account (explicit sign-in only) ----
  const idleOnly = () => { if (tracker.phase !== 'stopped') throw new Error('Stop tracking before changing your company account.'); };
  // The server asks for an authenticator code (admin/HR accounts) by answering mfaRequired; that is a prompt, not an error.
  handle('sync-login', async value => { idleOnly(); try { const snapshot = await sync.login(value || {}); broadcast(); return snapshot; } catch (error) { if (error.mfaRequired) return {mfaRequired: true, message: error.message}; throw error; } });
  handle('sync-logout', async value => { idleOnly(); const snapshot = await sync.logout({force: value?.force === true}); broadcast(); return snapshot; });
  handle('sync-consent', async () => { const snapshot = await sync.acceptConsent(); broadcast(); return snapshot; });
  handle('sync-now', async () => { await sync.refresh().catch(() => {}); await sync.flush(); broadcast(); return sync.snapshot(); });
  handle('sync-manual-entry', async value => { idleOnly(); const result = await sync.addManualEntry(value || {}); broadcast(); return result; });
  handle('sync-manual-entries', async () => { idleOnly(); return sync.getMyManualEntries(); });
  screen.on('display-removed', (_event, display) => {
    if (tracker.current?.allScreens && ['starting', 'tracking'].includes(tracker.phase)) pause('A screen was disconnected. Press Resume to capture the screens that are connected now.');
    else if (tracker.current?.displayId === display.id) pause('Your selected screen was disconnected. Choose a screen to resume.');
  });
  // A screen added while "all screens" is on would otherwise be captured by nothing; pause so the employee sees the change.
  screen.on('display-added', () => {if (tracker.current?.allScreens && ['starting', 'tracking'].includes(tracker.phase)) pause('A new screen was connected. Press Resume to include it in screenshots.');});
  powerMonitor.on('suspend', () => pause('Paused because this computer went to sleep.'));
  powerMonitor.on('lock-screen', () => pause('Paused because this computer was locked.'));
  powerMonitor.on('resume', () => {if (finishExpired()) return; if (tracker.phase === 'tracking') pause('Paused after waking. Press Resume when ready.');});
  loop = setInterval(() => {
    try {
      tick(); tracker.checkCaptureTimeout();
      if (tracker.phase !== 'tracking') stopActivity();
      if (tracker.phase === 'tracking' && tracker.current?.mode === 'company' && sync?.snapshot().needsConsent) pause('Your organization updated the monitoring notice. Read and accept it before tracking again.');
      if (tracker.phase === 'tracking' && tracker.current?.activityTrackingEnabled && sync?.snapshot().policy?.activityTrackingEnabled !== true) { stopActivity(); tracker.current.activityTrackingEnabled = false; persist(); }
      if (tracker.phase === 'tracking' && tracker.current?.activityTrackingEnabled && !tracker.current?.idleReview && !sync?.snapshot().needsConsent) startActivity();
      const capture = tracker.captureDue(); if (capture && !win.isDestroyed()) win.webContents.send('tracker:capture', {...capture, ...captureSettings()});
      if (++checkpoint % 5 === 0) persist();
      if (sync?.signedIn) sync.heartbeat({status: tracker.phase === 'tracking' ? 'tracking' : tracker.phase === 'paused' ? 'paused' : 'stopped', projectId: tracker.current?.projectId ?? null, taskLabel: tracker.current?.task ?? '', trackedMs: tracker.current?.trackedMs ?? 0});
      broadcast();
    }
    catch(error) { stopActivity(); tracker.pause(`Tracking paused: ${error.message}`); persist(); broadcast(); }
  }, 1000);
  await win.loadFile(entryPath);
}
app.on('before-quit', event => {
  if (quitAllowed) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  clearInterval(loop); clearTimeout(deadlineTimer);
  if (store) { try { stop(); } catch {} }
  const client = sync;
  if (client?.shutdown) client.shutdown(); else client?.stop();
  const deadlineAt = Date.now() + 10_000;
  (async () => {
    if (!client) return;
    while (client.flushing && Date.now() < deadlineAt) await new Promise(resolve => setTimeout(resolve, Math.min(50, deadlineAt - Date.now())));
    if (!client.flushing && Date.now() < deadlineAt) await client.flush({deadlineAt});
  })().catch(() => {}).finally(() => { if (client?.shutdown) client.shutdown(); else client?.stop(); quitAllowed = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
