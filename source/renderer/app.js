'use strict';
const $ = id => document.getElementById(id);
const api = window.tracker;
let snapshot, stream, streams = [], captureVideos = [], activeToken, operation = 0, selectedCapture, latestCapture, refreshing = false, galleryRetry, resolvingIdleReview = false, manualHistoryKey = '', manualHistoryRequest = 0;
const duration = ms => { const s = Math.floor((ms || 0) / 1000); return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m ${s % 60}s`; };
const clock = ms => {const s = Math.floor((ms || 0) / 1000); return [Math.floor(s / 3600),Math.floor(s % 3600 / 60),s % 60].map(n=>String(n).padStart(2,'0')).join(':');};
const date = value => new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'});
const NOTICE = 'This app records the time you track and estimates idle time from your computer\'s inactivity timer. It may ask you whether to keep or discard time classified as idle. When enabled by your organization, it counts keyboard key-downs and mouse clicks and estimates the number of seconds with input in each minute. It never records key identity, typed text, mouse position, or app and website names. When your organization turns screenshots on, it periodically captures the screen or screens specified by organization policy while tracking is visibly on. Screenshots are sent to your organization\'s server, where your manager, HR and administrators can review them under company policy. You can pause or stop at any time. No audio or camera is recorded.';
const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const setHidden = (id, hidden) => { const parent = $(id).parentElement; if (parent) parent.hidden = hidden; };
let projectKey = '';
let breakReminderSession = '', breakReminderNextAt = 0, breakReminderInterval = null, scheduleReminderDismissedDay = '', currentReminder = null;
function accountError(message) { $('account-error').textContent = message; $('account-error').hidden = !message; }
function accountInfo(message) { $('account-info').textContent = message; $('account-info').hidden = !message; }
function fillTasks() {
  const project = snapshot?.sync?.projects?.find(p => p.id === $('project').value); const tasks = project?.tasks ?? [];
  $('task-pick').replaceChildren(new Option('No task', '')); for (const task of tasks) $('task-pick').add(new Option(task.name, task.id));
  setHidden('task-pick', !tasks.length);
}
function fillManualTasks() {
  const project = snapshot?.sync?.projects?.find(p => p.id === $('manual-project').value); const tasks = project?.tasks ?? [];
  $('manual-task').replaceChildren(new Option('No task', '')); for (const task of tasks) $('manual-task').add(new Option(task.name, task.id));
  $('manual-task').disabled = !tasks.length;
}
function renderManualEntries(entries, message = '') {
  const list = $('manual-time-list'); list.replaceChildren();
  if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = message || 'No manual time submissions in the last 60 days.'; list.append(empty); return; }
  for (const entry of entries) {
    const card = document.createElement('article'); card.className = 'manual-time-item';
    const title = document.createElement('strong'); title.textContent = entry.taskLabel || 'Manual time';
    const state = document.createElement('span'); state.className = `status manual-${entry.status}`; state.textContent = entry.status;
    const top = document.createElement('div'); top.className = 'manual-time-top'; top.append(title, state);
    const range = document.createElement('p'); range.textContent = `${new Date(entry.startAt).toLocaleString()} – ${new Date(entry.endAt).toLocaleTimeString()} · ${entry.projectName || 'No project'}`;
    card.append(top, range);
    if (entry.note) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = `Note: ${entry.note}`; card.append(note); }
    list.append(card);
  }
}
async function refreshManualEntries() {
  const request = ++manualHistoryRequest;
  try { const entries = await api.manualEntries(); if (request === manualHistoryRequest) renderManualEntries(entries); }
  catch (e) { if (request === manualHistoryRequest) renderManualEntries([], clean(e)); }
}
// Everything company-specific: the account card, wording that says where data goes, and the project picker.
function renderCompany(state) {
  const sync = state.sync; const company = !!sync?.signedIn; const policy = sync?.policy;
  const sessionExpired = !company && sync?.sessionExpired === true; const companyPolicyActive = company || sessionExpired;
  const active = state.phase === 'tracking', starting = state.phase === 'starting';
  const shots = !companyPolicyActive || policy?.screenshotsEnabled !== false;
  $('account-out').hidden = company; $('account-in').hidden = !company;
  $('manual-time-open').hidden = !company;
  $('manual-time-open').disabled = state.phase !== 'stopped' || !!sync?.needsConsent;
  $('manual-time-history').hidden = !company;
  if (!company) { projectKey = ''; manualHistoryKey = ''; manualHistoryRequest++; $('manual-time-list').replaceChildren(); }
  if (sessionExpired) {
    const waiting = (sync.pending?.time || 0) + (sync.pending?.manual || 0) + (sync.pending?.screenshots || 0) + (sync.pending?.activity || 0);
    const account = sync.user?.email || sync.user?.name || 'your organization account';
    $('account-info').dataset.state = 'session-expired';
    accountInfo(`Your organization sign-in expired. This company session continues locally; uploads are paused and ${waiting} queued item(s) are kept on this device. Stop tracking, then sign in again as ${account} to resume uploads. Signing in as a different account discards this account's queue to prevent cross-account uploads.`);
    $('local-pill').textContent = '◈ Organization sign-in expired';
    $('local-note-title').textContent = 'Organization sign-in expired';
    $('local-note-text').textContent = `This company session is being saved on this computer. ${waiting} queued item(s) stay here until you stop tracking and sign in again as ${account}.`;
    $('privacy-line').textContent = 'Your organization sign-in expired. This company session continues locally; uploads are paused. Stop tracking and sign in again to resume uploads. Queued items stay on this device and are never transferred to another account.';
  } else {
    if ($('account-info').dataset?.state === 'session-expired') { delete $('account-info').dataset.state; accountInfo(''); }
    $('local-pill').textContent = company ? `◈ Synced to ${sync.serverHost}` : '◈ Local only';
    $('local-note-title').textContent = company ? 'Synced to your organization' : 'On this computer only';
    $('local-note-text').textContent = company ? `Your tracked time${shots ? ' and screenshots' : ''}${policy?.activityTrackingEnabled ? ' and minute-level keyboard/mouse counts' : ''} are sent to ${sync.serverHost}, where authorized staff can review them under company policy.` : 'Your time and screenshots stay here. No account needed.';
    $('privacy-line').textContent = company ? `${policy?.activityTrackingEnabled ? 'Keyboard key-down and mouse-click counts, with per-minute active seconds, are enabled. ' : 'Keyboard and mouse counts are off. '}No key identity, typed text, mouse position, audio, camera, app or website names are recorded. Your time${shots ? ' and screenshots' : ''}${policy?.activityTrackingEnabled ? ' and minute-level activity counts' : ''} are uploaded to ${sync.serverHost}. Pause, Stop, hiding, minimizing, locking, or quitting stops tracking.` : 'No keyboard or mouse counts, uploads, audio, camera, app or website tracking, or automatic startup. Pause, Stop, hiding, minimizing, locking, or quitting stops capture. The one-hour limit includes pauses and sleep; it never restarts itself.';
  }
  $('consent-text').textContent = companyPolicyActive ? `${shots ? (policy?.captureAllScreens ? 'I understand screenshots will include all connected screens, joined in one image, while this app is tracking. ' : 'I allow screenshots of the screen I select while this app is tracking. ') : 'No screenshots are taken. '}${policy?.activityTrackingEnabled ? 'I understand keyboard key-down and mouse-click counts and per-minute active seconds are also collected; no content is stored. ' : ''}${sessionExpired ? 'I understand this data stays queued on this device until sign-in is restored.' : 'I understand this data is sent to my organization.'}` : 'I allow screenshots of the screen I select while this app is tracking. I understand anything visible on that screen may be saved locally.';
  $('project-row').hidden = !company; setHidden('interval', company); setHidden('display', companyPolicyActive && (!shots || policy?.captureAllScreens));
  if (!company) { if (sync?.serverUrl && !$('sync-server').value) $('sync-server').value = sync.serverUrl; return; }
  $('account-who').textContent = `${sync.user?.name ?? ''} · ${sync.user?.role ?? ''}`; $('account-server').textContent = sync.serverHost;
  const online = sync.status === 'online';
  $('sync-status').className = `status ${online ? 'online' : 'offline'}`; $('sync-status').textContent = online ? '● Connected' : '○ Offline, will retry';
  const waiting = sync.pending.time + (sync.pending.manual || 0) + sync.pending.screenshots + (sync.pending.activity || 0);
  $('sync-detail').textContent = [waiting ? `${waiting} item(s) waiting to upload.` : 'Everything is uploaded.', sync.lastSyncAt ? `Last upload ${new Date(sync.lastSyncAt).toLocaleTimeString()}.` : '', sync.failed ? `${sync.failed} item(s) could not be uploaded${sync.failedItems?.[0] ? ` (${sync.failedItems[0].reason})` : ''}.` : '', !online && sync.lastError ? sync.lastError : ''].filter(Boolean).join(' ');
  const idleTimeout = Number.isInteger(policy?.idleTimeoutSeconds) ? policy.idleTimeoutSeconds : 60;
  $('policy-summary').textContent = policy ? `${policy.screenshotsEnabled ? `Your organization takes a screenshot every ${policy.screenshotIntervalSeconds >= 60 ? `${Math.round(policy.screenshotIntervalSeconds / 60)} min` : `${policy.screenshotIntervalSeconds} s`}${policy.screenshotBlur ? ' (blurred)' : ''} while you track, keeps them ${policy.retentionDays} days, and ${policy.screenshotVisibility === 'employee_only' ? 'only you can view them' : 'your direct manager and HR can view them'}.` : 'Your organization does not take screenshots; only your tracked time is sent.'} Idle time is estimated from computer inactivity after ${idleTimeout >= 60 ? `${Math.round(idleTimeout / 60)} minutes` : `${idleTimeout} seconds`}. ${policy.activityTrackingEnabled ? 'Keyboard/mouse counts and active seconds per minute are enabled; event content is never saved.' : 'Keyboard/mouse counts are off.'}` : 'Loading your organization\'s settings…';
  if (policy) $('policy-summary').textContent += ` ${policy.breakReminderMinutes ? `A break reminder appears after ${policy.breakReminderMinutes} tracked minutes; it never changes your time.` : 'Break reminders are off.'} ${policy.workScheduleEnabled ? `Work-hour reminders follow ${policy.workDays.map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')} ${policy.workStartLocal}–${policy.workEndLocal} (${policy.workTimeZone}), while this app is open.` : 'Scheduled-hour reminders are off.'}`;
  $('consent-notice').hidden = !sync.needsConsent; if (sync.needsConsent) $('consent-notice-text').textContent = NOTICE;
  $('sync-signout').disabled = state.phase !== 'stopped'; $('sync-now').disabled = false;
  if (sync.needsConsent || !policy) $('start').disabled = true;
  const key = JSON.stringify(sync.projects.map(project => [project.id, project.name, project.tasks.map(t => t.id)]));
  if (key !== projectKey) {
    projectKey = key; const keep = $('project').value;
    $('project').replaceChildren(new Option('No project', '')); for (const project of sync.projects) $('project').add(new Option(project.client ? `${project.name} (${project.client})` : project.name, project.id));
    if (sync.projects.some(project => project.id === keep)) $('project').value = keep;
    fillTasks();
    const manualKeep = $('manual-project').value;
    $('manual-project').replaceChildren(new Option('No project', ''));
    for (const project of sync.projects) $('manual-project').add(new Option(project.client ? `${project.name} (${project.client})` : project.name, project.id));
    if (sync.projects.some(project => project.id === manualKeep)) $('manual-project').value = manualKeep;
    $('manual-project').required = policy.requireProject === true;
    fillManualTasks();
  }
  const historyKey = `${sync.user?.id ?? sync.user?.email ?? ''}|${sync.lastSyncAt ?? ''}|${sync.pending.manual ?? 0}`;
  if (historyKey !== manualHistoryKey) { manualHistoryKey = historyKey; refreshManualEntries(); }
  $('project').disabled = active || starting; $('task-pick').disabled = active || starting;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function endStream() { activeToken = null; const oldStreams = streams.length ? streams : stream ? [stream] : []; streams = []; captureVideos = []; stream = null; for (const old of oldStreams) old.getTracks().forEach(track => {if (track.readyState !== 'ended') track.stop();}); $('capture-video').srcObject = null; }
// In-place updates: nothing downloads or installs until the employee clicks, and installing waits until tracking is stopped.
function renderUpdate(state) {
  const update = state.update, banner = $('update-banner'), action = $('update-action');
  $('update-check').disabled = !update || ['checking', 'downloading'].includes(update.status);
  if (!update || update.status === 'idle') { banner.hidden = true; return; }
  const stopped = state.phase === 'stopped', version = update.version || 'a new version';
  const text = {
    checking: 'Checking for updates…',
    available: `Version ${version} is available. Updating keeps your local data, sign-in and anything waiting to upload.`,
    downloading: `Downloading version ${version}… ${update.percent}%`,
    ready: stopped ? `Version ${version} is downloaded. The app will restart to install it; your local data stays on this computer.` : `Version ${version} is downloaded. Stop tracking to install it.`,
  }[update.status] || update.message;
  banner.hidden = !text; $('update-text').textContent = text || '';
  action.hidden = !['available', 'ready'].includes(update.status);
  action.textContent = update.status === 'ready' ? 'Restart and install' : 'Download update';
  action.disabled = update.status === 'ready' && !stopped;
}
$('update-check').addEventListener('click', () => api.updateCheck().catch(e => error(clean(e))));
$('update-action').addEventListener('click', () => (snapshot?.update?.status === 'ready' ? api.updateInstall() : api.updateDownload()).catch(e => error(clean(e))));
function render(state) {
  snapshot = state; renderUpdate(state);
  const sync = state.sync; const company = !!sync?.signedIn;
  // Signed in: every session is a company session (the organization's policy decides interval, screenshots, project list).
  if (company) $('mode').value = 'company'; else if ($('mode').value === 'company') $('mode').value = 'one-hour';
  const shownSession = state.current || state.lastCompleted;
  const isTest = shownSession?.mode === 'one-hour' || (!shownSession && $('mode').value === 'one-hour');
  $('test-limit').hidden = !isTest;
  $('remaining-time').textContent = clock(state.testRemainingMs ?? (state.lastCompleted?.stopReason === 'time-limit' ? 0 : state.lastCompleted?.mode === 'one-hour' ? Math.max(0,3600000 - (state.lastCompleted.testElapsedMs || 0)) : 3600000));
  if (state.current?.mode) $('mode').value = state.current.mode;
  if ($('mode').value === 'one-hour') $('interval').value = '300';
  const active = state.phase === 'tracking'; const starting = state.phase === 'starting'; const paused = state.phase === 'paused';
  if (!active && !starting) endStream();
  $('status-badge').className = `status ${state.phase}`;
  $('status-badge').textContent = active ? '● Tracking is on' : starting ? '◌ Starting…' : paused ? 'Ⅱ Paused' : '● Ready to start';
  $('status-message').textContent = state.message;
  $('timer').textContent = clock(shownSession?.trackedMs);
  $('tracked-stat').textContent = duration(shownSession?.trackedMs);
  $('idle-stat').textContent = duration(shownSession?.idleMs);
  $('next-stat').textContent = active ? (state.current?.idleReview ? 'Idle review' : state.nextCaptureIn === null ? 'Test ends next' : state.nextCaptureIn ? `${state.nextCaptureIn}s` : 'Saving…') : 'Not running';
  $('capture-count').textContent = `${shownSession?.captureCount || 0} screenshots this session`;
  $('start').disabled = active || starting;
  $('start').textContent = $('mode').value === 'one-hour' ? (paused ? '▶ Resume one-hour test' : '▶ Start one-hour test') : (paused ? '▶ Resume tracking' : '▶ Start tracking');
  $('pause').disabled = !active; $('break').hidden = !(company && active); // breaks are recorded for company sessions only
  $('stop').disabled = !state.current;
  for (const id of ['mode', 'task', 'display', 'interval', 'consent']) $(id).disabled = active || starting || (['mode', 'task'].includes(id) && paused) || (id === 'interval' && $('mode').value === 'one-hour') || (id === 'mode' && company);
  renderCompany(state);
  renderWorkReminder(state);
  $('permission').textContent = state.platform === 'darwin' ? `macOS screen permission: ${state.permission}` : 'System screen permission required on start';
  $('storage-path').textContent = `Saved locally: ${state.directory}`;
  const review = state.current?.idleReview;
  const idleDialog = $('idle-review');
  if (review) {
    $('idle-review-time').textContent = duration(Math.max(0, (state.current.idleMs || 0) - review.baselineIdleMs));
    if (!idleDialog.open) idleDialog.showModal();
  } else if (idleDialog.open) idleDialog.close();
}
function localDayKey(value) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function renderWorkReminder(state) {
  const sync = state.sync, policy = sync?.policy, panel = $('work-reminder');
  const hide = () => { currentReminder = null; panel.hidden = true; };
  if (!sync?.signedIn || sync.needsConsent || !policy) { hide(); return; }
  const session = state.phase === 'tracking' && state.current?.mode === 'company' ? state.current : null;
  if (session && Number.isInteger(policy.breakReminderMinutes) && policy.breakReminderMinutes > 0) {
    const interval = policy.breakReminderMinutes * 60_000;
    if (breakReminderSession !== session.id) { breakReminderSession = session.id; breakReminderInterval = policy.breakReminderMinutes; breakReminderNextAt = interval; }
    else if (breakReminderInterval !== policy.breakReminderMinutes) { breakReminderInterval = policy.breakReminderMinutes; breakReminderNextAt = session.trackedMs + interval; }
    if (session.trackedMs >= breakReminderNextAt) {
      currentReminder = {kind: 'break'};
      $('work-reminder-text').textContent = `You have tracked ${duration(session.trackedMs)}. Consider taking a short break; this reminder does not change your time.`;
      $('work-reminder-action').textContent = 'Pause for a break'; panel.hidden = false; return;
    }
  }
  if (!session) breakReminderSession = '';
  if (policy.workScheduleEnabled && ['stopped', 'paused'].includes(state.phase)) {
    const timeZone = typeof policy.workTimeZone === 'string' ? policy.workTimeZone : 'UTC';
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone, weekday:'short', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(Date.now()).filter(part => part.type !== 'literal').map(part => [part.type,part.value]));
    const minute = Number(values.hour) * 60 + Number(values.minute);
    const parseTime = value => { const [hours, minutes] = String(value).split(':').map(Number); return hours * 60 + minutes; };
    const today = `${values.year}-${values.month}-${values.day}`;
    const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(values.weekday);
    if ((policy.workDays || []).includes(day) && minute >= parseTime(policy.workStartLocal) && minute < parseTime(policy.workEndLocal) && scheduleReminderDismissedDay !== today) {
      const paused = state.phase === 'paused'; currentReminder = {kind: 'schedule', day: today};
      $('work-reminder-text').textContent = paused ? 'Tracking is paused during your scheduled work hours. Resume when you are ready.' : 'You are not tracking during your scheduled work hours. Start when you are ready.';
      $('work-reminder-action').textContent = paused ? 'Resume tracking' : 'Start tracking'; panel.hidden = false; return;
    }
  }
  hide();
}
$('work-reminder-dismiss').addEventListener('click', () => {
  if (currentReminder?.kind === 'break' && snapshot?.current) breakReminderNextAt = snapshot.current.trackedMs + 10 * 60_000;
  if (currentReminder?.kind === 'schedule') scheduleReminderDismissedDay = currentReminder.day;
  renderWorkReminder(snapshot);
});
$('work-reminder-action').addEventListener('click', async () => {
  try {
    if (currentReminder?.kind === 'break') { if (snapshot?.current) breakReminderNextAt = snapshot.current.trackedMs + (snapshot.sync?.policy?.breakReminderMinutes || 60) * 60_000; await api.pause({break: true}); }
    else if (currentReminder?.kind === 'schedule') $('start').click();
  } catch (e) { accountError(clean(e)); }
});
async function refreshDisplays() {
  const selected = $('display').value;
  const screens = await api.displays();
  $('display').replaceChildren(new Option('Choose a screen…',''));
  for (const screen of screens) $('display').add(new Option(`${screen.label}${screen.primary ? ' · Main' : ''} (${screen.width} × ${screen.height})`,String(screen.id)));
  if (screens.some(screen => String(screen.id) === selected)) $('display').value = selected;
}
function showPanel(id) { for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== id; for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('selected', item.dataset.panel === id); refreshGallery().catch(e=>error(e.message)); }
for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel));
$('start').addEventListener('click', async () => {
  error('');
  const companyStart = !!snapshot?.sync?.signedIn; const needsScreen = !companyStart || snapshot.sync.policy?.screenshotsEnabled !== false;
  const allScreens = companyStart && snapshot.sync.policy?.captureAllScreens === true;
  if (needsScreen && !allScreens && !$('display').value) {error('Choose the screen you want to capture first.'); return;}
  if (!$('consent').checked) {error('Please check the screen-capture permission box before starting.'); return;}
  const sequence = ++operation; let token; const ownedStreams = []; const ownedVideos = []; let startTimeout;
  const closeOwnedStream = () => {
    for (const owned of ownedStreams) owned.getTracks().forEach(track => {if (track.readyState !== 'ended') track.stop();});
    if (ownedStreams.some(owned => streams.includes(owned))) endStream();
  };
  $('start').disabled = true;
  try {
    const prepared = await api.prepare({displayId:$('display').value ? Number($('display').value) : null, intervalSeconds:Number($('interval').value), consent:$('consent').checked, task:$('task').value, mode:$('mode').value || 'manual', projectId:$('project').value || null, taskId:$('task-pick').value || null});
    token = prepared.token;
    if (sequence !== operation) return;
    if (!needsScreen) { await api.confirm(token); return; } // time-only company session: the screen is never shared
    const screenCount = allScreens ? prepared.screenCount : 1;
    if (!Number.isInteger(screenCount) || screenCount < 1 || screenCount > 16) throw new Error('The connected screen list is invalid. Stop and try again.');
    for (let index = 0; index < screenCount; index++) {
      const owned = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:1,width:{max:4096},height:{max:4096}},audio:false});
      ownedStreams.push(owned);
      if (sequence !== operation || snapshot.phase !== 'starting') {closeOwnedStream(); return;}
      const track = owned.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('Screen sharing has already ended.');
      track.addEventListener('ended', () => {
        if (sequence === operation && (streams.includes(owned) || ownedStreams.includes(owned))) {
          ++operation;
          if (streams.includes(owned)) endStream(); else for (const pending of ownedStreams) pending.getTracks().forEach(item => {if (item.readyState !== 'ended') item.stop();});
          api.pause().catch(e=>error(e.message));
        }
      });
      const video = allScreens ? document.createElement('video') : $('capture-video');
      video.muted = true; video.playsInline = true; video.srcObject = owned; ownedVideos.push(video);
      await Promise.race([video.play(), new Promise((_resolve,reject)=>{startTimeout=setTimeout(()=>reject(new Error('A shared screen did not start in time.')),8000);})]);
      clearTimeout(startTimeout);
      if (sequence !== operation || snapshot.phase !== 'starting') {closeOwnedStream(); return;}
      if (track.readyState !== 'live') throw new Error('Screen sharing has ended.');
    }
    streams = ownedStreams.slice(); captureVideos = ownedVideos.slice(); stream = streams[0]; activeToken = token;
    await api.confirm(token);
    if (sequence !== operation) closeOwnedStream();
  } catch (e) {
    clearTimeout(startTimeout);
    closeOwnedStream();
    if (sequence !== operation) return;
    if (token) await api.fail({token}).catch(()=>{});
    if (sequence !== operation) return;
    if (!token) $('start').disabled = snapshot.phase === 'tracking' || snapshot.phase === 'starting';
    error(`${needsScreen ? 'Screen capture' : 'Tracking'} could not start. ${clean(e)}`);
  }
});
$('pause').addEventListener('click', async () => { ++operation; endStream(); try {await api.pause(); await refreshGallery();} catch(e){error(e.message);} });
$('break').addEventListener('click', async () => { ++operation; endStream(); try {await api.pause({break: true}); await refreshGallery();} catch(e){error(e.message);} });
$('stop').addEventListener('click', async () => { ++operation; endStream(); try {await api.stop(); await refreshGallery(); await refreshDisplays();} catch(e){error(e.message);} });
$('idle-review').addEventListener('cancel', event => event.preventDefault());
async function resolveIdleReview(keep) {
  if (resolvingIdleReview) return;
  resolvingIdleReview = true; $('idle-keep').disabled = $('idle-discard').disabled = true;
  try { const result = await api.idleReview({keep}); render(result.state); }
  catch (e) { error(e.message); }
  finally { resolvingIdleReview = false; $('idle-keep').disabled = $('idle-discard').disabled = false; }
}
$('idle-keep').addEventListener('click', () => resolveIdleReview(true));
$('idle-discard').addEventListener('click', () => resolveIdleReview(false));
api.onState(render);
api.onCapture(async request => {
  if (!stream || !streams.length || streams.some(item => item.getVideoTracks()[0]?.readyState !== 'live') || activeToken !== request.token || snapshot.phase !== 'tracking') {await api.captureFailed(request); return;}
  try {
    const authorizationRequestedAt = performance.now();
    const authorizationRequestedWall = Date.now();
    const authorization = await api.authorizeCapture(request);
    // Anchor the remaining duration BEFORE the round trip so transport delay only shortens permission.
    const elapsed = Math.max(performance.now() - authorizationRequestedAt, Date.now() - authorizationRequestedWall);
    if (authorization.remainingMs !== null && authorization.remainingMs !== undefined && elapsed >= authorization.remainingMs) return;
    if (!authorization.allowed || !stream || !streams.length || streams.some(item => item.getVideoTracks()[0]?.readyState !== 'live') || activeToken !== request.token || snapshot.phase !== 'tracking') return;
    const videos = captureVideos.length ? captureVideos : [$('capture-video')];
    if (videos.some(video => !video.videoWidth || !video.videoHeight || video.readyState < 2)) throw new Error('A screen frame is not ready.');
    const sourceWidth = videos.reduce((sum, video) => sum + video.videoWidth, 0); const sourceHeight = Math.max(...videos.map(video => video.videoHeight));
    const ratio = Math.min(1,4096 / sourceWidth,4096 / sourceHeight,Math.sqrt(16_000_000 / (sourceWidth * sourceHeight))); const canvas = $('capture-canvas');
    canvas.width = Math.max(1,Math.round(sourceWidth * ratio)); canvas.height = Math.max(1,Math.round(sourceHeight * ratio));
    // No await between this final main-process deadline/token check and reading pixels.
    if (!api.finalizeCapture(request)) {canvas.width = 0; canvas.height = 0; return;}
    const drawing = canvas.getContext('2d',{alpha:false}); if (request.blur) drawing.filter = 'blur(12px)'; // blurred before anything is saved
    let x = 0; for (const video of videos) { const width = Math.max(1,Math.round(video.videoWidth * ratio)); const height = Math.max(1,Math.round(video.videoHeight * ratio)); drawing.drawImage(video,x,0,width,height); x += width; }
    // Company sessions follow the organization's format policy (WebP is ~4x smaller); local sessions stay lossless PNG.
    const dataUrl = request.format === 'webp' ? canvas.toDataURL('image/webp', Math.min(0.95, Math.max(0.4, (Number(request.quality) || 80) / 100))) : canvas.toDataURL('image/png');
    // Small JPEG thumbnail made from the same (possibly blurred) pixels, so the main process never has to decode a screenshot.
    let thumbUrl = null;
    try { const thumb = $('thumb-canvas'); thumb.width = 320; thumb.height = Math.max(1, Math.round(320 * canvas.height / canvas.width)); thumb.getContext('2d',{alpha:false}).drawImage(canvas,0,0,thumb.width,thumb.height); thumbUrl = thumb.toDataURL('image/jpeg',0.7); thumb.width = 0; thumb.height = 0; } catch { thumbUrl = null; }
    canvas.width = 0; canvas.height = 0;
    const result = await api.saveCapture({...request,dataUrl,thumbUrl}); if (result.saved) await refreshGallery();
  } catch(e) {await api.captureFailed(request); error(`Capture paused: ${e.message}`);}
});
async function openImage(capture) {selectedCapture = capture; $('image-title').textContent = capture.task; $('image-description').textContent = `${date(capture.takenAt)} · ${capture.width} × ${capture.height} pixels`; $('full-image').src = await api.image(capture.id); $('image-modal').showModal();}
async function refreshGallery() {
  if (refreshing) return; refreshing = true;
  try {
    const data = await api.gallery(); $('nav-count').textContent = data.totalCaptureCount; $('gallery-empty').hidden = !!data.captures.length; $('gallery').replaceChildren();
    latestCapture = data.captures[0]; $('latest-empty').hidden = !!latestCapture; $('latest').hidden = !latestCapture;
    if (latestCapture) {$('latest-image').src = latestCapture.thumbnail || ''; $('latest-caption').textContent = `${date(latestCapture.takenAt)} · ${latestCapture.width} × ${latestCapture.height} · Click to inspect the saved image`;}
    for (const capture of data.captures) {
      const button = document.createElement('button'); button.className = 'capture-card'; const img = document.createElement('img'); img.alt = `Saved screenshot at ${date(capture.takenAt)}`; if(capture.thumbnail) img.src = capture.thumbnail;
      const caption = document.createElement('div'); caption.className = 'caption'; const title = document.createElement('strong'); title.textContent = capture.task; const detail = document.createElement('p'); detail.textContent = `${date(capture.takenAt)} · ${capture.width} × ${capture.height}`; caption.append(title,detail); button.append(img,caption); button.addEventListener('click',()=>openImage(capture).catch(e=>error(e.message))); $('gallery').append(button);
    }
    const completed = data.sessions.filter(s=>s.endedAt); $('sessions-empty').hidden = !!completed.length; $('sessions').replaceChildren();
    for (const session of completed) {
      const card = document.createElement('div'); card.className='session-card'; const info=document.createElement('div');const title=document.createElement('h3');title.textContent=session.task;const dates=document.createElement('p');dates.textContent=`${date(session.startedAt)}${session.stopReason === 'time-limit' ? ' · One-hour limit reached' : session.interrupted ? ' · Interrupted on previous run' : ''}`;info.append(title,dates);const numbers=document.createElement('div');numbers.className='numbers';const time=document.createElement('strong');time.textContent=duration(session.trackedMs);const details=document.createElement('p');details.textContent=`${session.captureCount} screenshots · ${duration(session.idleMs)} observed idle`;numbers.append(time,details);card.append(info,numbers);$('sessions').append(card);
    }
    // Thumbnails are prepared a couple at a time so the app never freezes; come back until they are all there.
    clearTimeout(galleryRetry); if (data.captures.some(capture => capture.thumbnailPending)) galleryRetry = setTimeout(() => refreshGallery().catch(() => {}), 700);
  } finally {refreshing=false;}
}
$('mode').addEventListener('change', () => {if ($('mode').value === 'one-hour') $('interval').value='300'; if(snapshot) render(snapshot);});
$('latest').addEventListener('click',()=>{if(latestCapture)openImage(latestCapture).catch(e=>error(e.message));});
$('close-modal').addEventListener('click',()=>$('image-modal').close());
$('reveal-image').addEventListener('click',()=>api.reveal(selectedCapture.id).catch(e=>error(e.message)));
for(const id of ['open-folder','folder-sidebar']) $(id).addEventListener('click',()=>api.openFolder().catch(e=>error(e.message)));
$('project').addEventListener('change', fillTasks);
$('manual-project').addEventListener('change', fillManualTasks);
$('manual-time-open').addEventListener('click', () => {
  if (snapshot?.phase !== 'stopped') { accountError('Stop tracking before adding manual time.'); return; }
  $('manual-time-status').hidden = true;
  const end = new Date(), start = new Date(end.getTime() - 60 * 60_000);
  const localValue = value => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  $('manual-start').value = localValue(start); $('manual-end').value = localValue(end);
  $('manual-task-label').value = ''; $('manual-note').value = ''; $('manual-time-error').hidden = true;
  $('manual-time-dialog').showModal();
});
$('manual-time-close').addEventListener('click', () => $('manual-time-dialog').close());
$('manual-time-submit').addEventListener('click', async () => {
  const message = $('manual-time-error'); message.hidden = true; $('manual-time-submit').disabled = true;
  try {
    const start = new Date($('manual-start').value), end = new Date($('manual-end').value);
    if (!$('manual-task-label').value.trim()) throw new Error('Describe the work you are submitting.');
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('Choose a valid start and end time.');
    const result = await api.addManualEntry({projectId:$('manual-project').value || null, taskId:$('manual-task').value || null, taskLabel:$('manual-task-label').value, startAt:start.toISOString(), endAt:end.toISOString(), note:$('manual-note').value});
    $('manual-time-dialog').close();
    $('manual-time-status').textContent = result.queued ? 'Manual time is saved on this device and will upload when the server is reachable.' : 'Manual time was submitted and is waiting for review.';
    $('manual-time-status').hidden = false;
    await refreshManualEntries();
  } catch (e) { message.textContent = clean(e); message.hidden = false; }
  finally { $('manual-time-submit').disabled = false; }
});
$('sync-signin').addEventListener('click', async () => {
  accountError(''); accountInfo(''); $('sync-signin').disabled = true;
  try {
    const result = await api.syncLogin({serverUrl:$('sync-server').value, email:$('sync-email').value, password:$('sync-password').value, totp:$('sync-totp').value.trim() || undefined});
    if (result?.mfaRequired) { $('totp-row').hidden = false; accountInfo(result.message || 'Enter the 6-digit code from your authenticator app.'); if ($('sync-totp').focus) $('sync-totp').focus(); } // the password stays in the field for the second step
    else { $('sync-password').value = ''; $('sync-totp').value = ''; $('totp-row').hidden = true; await refreshManualEntries(); }
  }
  catch (e) { accountError(clean(e)); } finally { $('sync-signin').disabled = false; }
});
$('sync-signout').addEventListener('click', async () => {
  accountError('');
  try { await api.syncLogout({}); }
  catch (e) {
    const message = clean(e);
    if (/not been uploaded/.test(message) && confirm(`${message} Sign out anyway? Pending time entries, manual submissions, screenshots, and activity totals will be deleted from this computer without upload.`)) { try { await api.syncLogout({force:true}); } catch (second) { accountError(clean(second)); } }
    else accountError(message);
  }
});
$('accept-consent').addEventListener('click', async () => { accountError(''); try { await api.syncConsent(); } catch (e) { accountError(clean(e)); } });
$('sync-now').addEventListener('click', async () => { accountError(''); $('sync-now').disabled = true; try { await api.syncNow(); await refreshManualEntries(); } catch (e) { accountError(clean(e)); } finally { $('sync-now').disabled = false; } });
window.addEventListener('beforeunload',endStream);
Promise.all([api.status().then(render),refreshDisplays(),refreshGallery()]).catch(e=>error(`Could not load local tracker: ${e.message}`));
