'use strict';
// Company sync for the desktop tracker. Runs ONLY in the Electron main process, so the renderer keeps
// its "no network" CSP. Nothing here runs unless the user explicitly signs in to a company server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BACKOFF_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;
const POLICY_REFRESH_MS = 5 * 60_000;
const MAX_FAILED_KEPT = 50;

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', {timeZone:value}).format(0); return true; } catch { return false; }
}

function normalizeServerUrl(input) {
  let url;
  let text = String(input ?? '').trim();
  // A bare host such as "tracker.company.com" means https; localhost means plain http (development only).
  if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^(javascript|data|mailto|file):/i.test(text)) {
    text = `${/^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(text) ? 'http' : 'https'}://${text}`;
  }
  try { url = new URL(text); } catch { throw new Error('Enter a valid server address, for example https://tracker.example.com'); }
  if (url.username || url.password) throw new Error('The server address must not contain a username or password.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use an https:// server address (plain http:// is only allowed for localhost).');
  return url.origin;
}

class SyncClient {
  constructor({dir, fetchImpl = globalThis.fetch, now = Date.now, secrets, readCapture, makeThumb = () => null, deviceName = 'Desktop Tracker', onChange = () => {}, timers = {setInterval, clearInterval, setTimeout, clearTimeout}}) {
    this.dir = dir; this.fetchImpl = fetchImpl; this.now = now; this.secrets = secrets ?? {available: () => false};
    this.readCapture = readCapture; this.makeThumb = makeThumb; this.deviceName = deviceName; this.onChange = onChange; this.timers = timers;
    this.configPath = path.join(dir, 'sync-config.json'); this.queuePath = path.join(dir, 'sync-queue.json');
    this.serverUrl = null; this.token = null; this.user = null; this.policy = null; this.projects = []; this.needsConsent = false;
    this.status = 'signed-out'; this.lastError = null; this.lastSyncAt = null; this.persistentToken = false;
    this.queue = {userId: null, entries: {}, manual: [], shots: [], activity: [], failed: []};
    this.flushing = false; this.failures = 0; this.retryTimer = null; this.debounce = null; this.interval = null; this.shuttingDown = false;
    this.lastHeartbeat = {at: 0, key: ''}; this.lastRefreshAt = 0;
  }

  get signedIn() { return !!this.token; }
  get canQueueForCurrentUser() { return !!this.user?.id && this.queue.userId === this.user.id; }

  // ---------- persistence ----------
  _writeJson(file, value) {
    fs.mkdirSync(this.dir, {recursive: true});
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600});
    fs.renameSync(temp, file);
  }
  _readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  _saveConfig() {
    if (!this.serverUrl) { try { fs.unlinkSync(this.configPath); } catch { /* none */ } return; }
    let tokenEnc = null;
    if (this.token && this.secrets.available()) { try { tokenEnc = this.secrets.encrypt(this.token); } catch { tokenEnc = null; } }
    this.persistentToken = !!tokenEnc;
    this._writeJson(this.configPath, {serverUrl: this.serverUrl, user: this.user, policy: this.policy, projects: this.projects, needsConsent: this.needsConsent, tokenEnc});
  }
  _saveQueue() { this._writeJson(this.queuePath, this.queue); }

  /** Load saved sign-in and queue. Never touches the network. */
  init() {
    const q = this._readJson(this.queuePath);
    if (q && typeof q === 'object') this.queue = {userId: q.userId ?? null, entries: q.entries ?? {}, manual: Array.isArray(q.manual) ? q.manual : [], shots: Array.isArray(q.shots) ? q.shots : [], activity: Array.isArray(q.activity) ? q.activity : [], failed: Array.isArray(q.failed) ? q.failed : []};
    const c = this._readJson(this.configPath);
    if (c?.serverUrl) {
      try { this.serverUrl = normalizeServerUrl(c.serverUrl); } catch { return; }
      this.user = c.user ?? null; this.policy = c.policy ?? null; this.projects = c.projects ?? []; this.needsConsent = !!c.needsConsent;
      if (c.tokenEnc && this.secrets.available()) { try { this.token = this.secrets.decrypt(c.tokenEnc); this.persistentToken = true; } catch { this.token = null; } }
      this.status = this.token ? 'offline' : 'signed-out'; // 'offline' until the first successful call
      if (!this.token) this.lastError = 'Please sign in again.';
    }
  }

  // ---------- HTTP ----------
  async _request(method, urlPath, {body, raw, contentType, auth = true, timeoutMs = 20_000} = {}) {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (raw) { headers['Content-Type'] = contentType; payload = raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try {
      res = await this.fetchImpl(this.serverUrl + urlPath, {method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
    } catch (error) {
      const e = new Error('Could not reach the server.'); e.network = true; e.cause = error; throw e;
    }
    let json = null; try { json = await res.json(); } catch { /* not JSON */ }
    return {status: res.status, json};
  }
  _fail(res, fallback) { const e = new Error(res.json?.error || fallback || `Server error (${res.status}).`); e.status = res.status; return e; }
  _authFailed() {
    this.token = null; this.status = 'signed-out'; this.lastError = 'Your session ended. Please sign in again.';
    this._saveConfig(); this._changed();
  }
  _changed() { try { this.onChange(this.snapshot()); } catch { /* UI gone */ } }

  // ---------- account ----------
  /** `totp` is the authenticator code, sent only when the server asked for it (admin/HR accounts). It is never stored. */
  async login({serverUrl, email, password, totp}) {
    if (this.token) throw new Error('Already signed in.');
    const origin = normalizeServerUrl(serverUrl);
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) throw new Error('Enter your work email and password.');
    if (totp !== undefined && totp !== null && totp !== '' && !/^\d{6,8}$/.test(String(totp).trim())) throw new Error('Enter the 6-digit code from your authenticator app.');
    const previous = this.serverUrl; this.serverUrl = origin;
    let res;
    const body = {email: email.trim(), password, kind: 'device', deviceName: this.deviceName}; if (totp) body.totp = String(totp).trim();
    try { res = await this._request('POST', '/api/auth/login', {body, auth: false}); }
    catch (error) { this.serverUrl = previous; throw error; }
    if (res.status !== 200 || !res.json?.token) { this.serverUrl = previous; const failure = this._fail(res, 'Could not sign in.'); failure.mfaRequired = res.json?.mfaRequired === true; throw failure; }
    this.token = res.json.token; this.user = res.json.user;
    if (this.user.mustChangePassword) {
      await this._request('POST', '/api/auth/logout').catch(() => {});
      this.token = null; this.user = null; this.serverUrl = previous;
      throw new Error('You must choose a new password first. Sign in once on the web dashboard, then try again here.');
    }
    if (this.queue.userId && this.queue.userId !== this.user.id) this.queue = {userId: null, entries: {}, manual: [], shots: [], activity: [], failed: []}; // never upload one person's data as another
    this.queue.userId = this.user.id; this.status = 'online'; this.lastError = null; this.failures = 0;
    this._saveQueue(); this._saveConfig();
    await this.refresh().catch(() => {});
    await this.flush().catch(() => {});
    this._changed();
    return this.snapshot();
  }

  async refresh() {
    if (!this.token) return;
    try {
      const me = await this._request('GET', '/api/me');
      if (me.status === 401) return this._authFailed();
      if (me.status !== 200) throw this._fail(me);
      this.user = me.json.user; this.policy = me.json.policy; this.needsConsent = !!me.json.needsConsent;
      const projects = await this._request('GET', '/api/projects');
      if (projects.status === 200) this.projects = (projects.json.projects ?? []).filter(p => p.active).map(p => ({id: p.id, name: p.name, client: p.client ?? null, tasks: (p.tasks ?? []).filter(t => t.active).map(t => ({id: t.id, name: t.name}))}));
      this.status = 'online'; this.lastError = null; this.lastRefreshAt = this.now(); this._saveConfig(); this._changed();
    } catch (error) {
      if (error.network) { this.status = 'offline'; this.lastError = error.message; this._changed(); }
      else { this.lastError = error.message; this._changed(); throw error; }
    }
  }

  async acceptConsent() {
    if (!this.token || !this.policy) throw new Error('Sign in first.');
    const res = await this._request('POST', '/api/me/consent', {body: {version: this.policy.consentVersion}});
    if (res.status === 401) { this._authFailed(); throw new Error('Your session ended. Please sign in again.'); }
    if (res.status !== 200) throw this._fail(res, 'Could not record your acceptance.');
    this.needsConsent = false; this._saveConfig(); this._changed();
    return this.snapshot();
  }

  /** Sign out. Refuses while items are waiting to upload unless force is set (discarding them). */
  /** Entries still to send: a running entry that was already uploaded is not "waiting". */
  _unsentEntries() { return Object.values(this.queue.entries).filter(item => item.sentKey !== item.key).length; }
  async logout({force = false} = {}) {
    const pending = this._unsentEntries() + this.queue.manual.length + this.queue.shots.length + this.queue.activity.length;
    if (pending > 0 && !force) { const e = new Error(`${pending} item(s) have not been uploaded yet.`); e.pending = pending; throw e; }
    if (this.token) await this._request('POST', '/api/auth/logout', {timeoutMs: 5000}).catch(() => {});
    this.token = null; this.user = null; this.policy = null; this.projects = []; this.needsConsent = false; this.serverUrl = null; this.status = 'signed-out'; this.lastError = null;
    this.queue = {userId: null, entries: {}, manual: [], shots: [], activity: [], failed: []};
    this._saveQueue(); this._saveConfig(); this.stop(); this._changed();
    return this.snapshot();
  }

  // ---------- queueing ----------
  _entryPayload(session) {
    const start = Date.parse(session.startedAt); const end = session.endedAt ? Date.parse(session.endedAt) : this.now();
    const elapsed = Math.max(0, end - start);
    const tracked = Math.min(Math.round(session.trackedMs || 0), elapsed + 30_000); // never claim more than wall-clock time
    return {clientId: session.id, projectId: session.projectId ?? null, taskId: session.taskId ?? null, taskLabel: String(session.task ?? '').slice(0, 120), mode: 'company', activityTrackingEnabled: session.activityTrackingEnabled === true,
      startAt: session.startedAt, endAt: session.endedAt ?? null, trackedMs: Math.max(0, tracked), idleMs: Math.min(Math.max(0, Math.round(session.idleMs || 0)), Math.max(0, tracked))};
  }
  enqueueEntry(session) {
    if (!this.canQueueForCurrentUser || !session || session.mode !== 'company') return;
    const payload = this._entryPayload(session); const key = JSON.stringify(payload);
    const existing = this.queue.entries[session.id];
    if (!existing || existing.key !== key) this.queue.entries[session.id] = {payload, key, sentKey: existing?.sentKey ?? null};
    if (session.activityTrackingEnabled === true && Array.isArray(session.activitySlices)) {
      for (const slice of session.activitySlices) {
        if (!slice || typeof slice.startedAt !== 'string') continue;
        if (!this.queue.activity.some(item => item.entryClientId === session.id && item.slice?.startedAt === slice.startedAt)) this.queue.activity.push({entryClientId: session.id, slice, key: `${session.id}|${slice.startedAt}`});
      }
    }
    this._saveQueue(); this._scheduleFlush(session.endedAt ? 200 : 3000);
  }
  async addManualEntry({projectId = null, taskId = null, taskLabel = '', startAt, endAt, note = ''} = {}) {
    if (!this.token) throw new Error('Sign in to your company account before adding manual time.');
    if (this.needsConsent) throw new Error('Read and accept your organization\'s monitoring notice first.');
    if (this.queue.manual.length >= 1000) throw new Error('Your offline manual-time queue is full. Sync before adding more entries.');
    if (typeof taskLabel !== 'string' || !taskLabel.trim() || taskLabel.trim().length > 120) throw new Error('Describe the work in 1 to 120 characters.');
    if (typeof note !== 'string' || note.trim().length > 500) throw new Error('The reviewer note must be 500 characters or fewer.');
    if (projectId !== null && typeof projectId !== 'string') throw new Error('Choose a project from the list.');
    if (taskId !== null && typeof taskId !== 'string') throw new Error('Choose a task from the list.');
    const project = projectId ? this.projects.find(item => item.id === projectId) : null;
    if (projectId && !project) throw new Error('Choose a project from the list.');
    if (taskId && !project?.tasks.some(item => item.id === taskId)) throw new Error('Choose a task that belongs to the project.');
    if (this.policy?.requireProject && !projectId) throw new Error('Your organization requires choosing a project.');
    const start = Date.parse(startAt), end = Date.parse(endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Choose a valid start and end time.');
    if (end - start > 24 * 60 * 60_000) throw new Error('A manual entry cannot be longer than 24 hours.');
    if (end > this.now() + 5 * 60_000) throw new Error('Manual time cannot be in the future.');
    if (start < this.now() - 60 * 24 * 60 * 60_000) throw new Error('Manual time is too old to add.');
    const payload = {clientId: crypto.randomUUID(), projectId, taskId, taskLabel: taskLabel.trim(), startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString()};
    if (note.trim()) payload.note = note.trim();
    this.queue.manual.push({payload, key: payload.clientId}); this._saveQueue(); this._changed();
    await this.flush();
    const failure = this.queue.failed.find(item => item.kind === 'manual' && item.id === payload.clientId);
    if (failure) throw new Error(failure.reason);
    return {clientId: payload.clientId, queued: this.queue.manual.some(item => item.key === payload.clientId)};
  }
  async getMyManualEntries() {
    if (!this.token) throw new Error('Sign in to your company account first.');
    const from = new Date(this.now() - 60 * 24 * 60 * 60_000).toISOString();
    const res = await this._request('GET', `/api/time-entries?from=${encodeURIComponent(from)}`);
    if (res.status === 401) { this._authFailed(); throw new Error('Your session ended. Please sign in again.'); }
    if (res.status !== 200) throw this._fail(res, 'Could not load your submitted time.');
    return (res.json?.entries ?? []).filter(entry => entry.source === 'manual').slice(0, 100);
  }
  enqueueScreenshot({captureId, takenAt, entryClientId}) {
    if (!this.canQueueForCurrentUser) return;
    this.queue.shots.push({captureId, takenAt, entryClientId: entryClientId ?? null, attempts: 0});
    this._saveQueue(); this._changed(); this._scheduleFlush(500);
  }
  _scheduleFlush(ms) {
    if (this.shuttingDown || this.debounce) return;
    this.debounce = this.timers.setTimeout(() => { this.debounce = null; this.flush().catch(() => {}); }, ms);
    this.debounce?.unref?.();
  }
  _moveToFailed(kind, id, reason) {
    this.queue.failed.unshift({kind, id, reason, at: new Date(this.now()).toISOString()});
    this.queue.failed.length = Math.min(this.queue.failed.length, MAX_FAILED_KEPT);
  }
  _backoff() {
    if (this.shuttingDown) return;
    this.failures++;
    const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(this.failures, 8));
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => { this.retryTimer = null; this.flush().catch(() => {}); }, delay);
    this.retryTimer?.unref?.();
  }

  /** Upload queued time and screenshots. Safe to call at any time; one flush runs at a time. */
  async flush({deadlineAt = Infinity} = {}) {
    if (!this.token || this.flushing) return {skipped: true};
    const bounded = Number.isFinite(deadlineAt);
    let progressed = false, stop = false, timedOut = false;
    const requestOptions = normalTimeout => {
      if (!bounded) return {timeoutMs: normalTimeout};
      const remaining = Math.ceil(deadlineAt - Date.now());
      return remaining > 0 ? {timeoutMs: Math.min(normalTimeout, remaining)} : null;
    };
    const deadlinePassed = () => {
      if (bounded && Date.now() >= deadlineAt) { stop = true; timedOut = true; return true; }
      return false;
    };
    this.flushing = true;
    try {
      for (const [id, item] of Object.entries(this.queue.entries)) {
        if (stop || deadlinePassed()) break;
        if (item.sentKey === item.key) { if (item.payload.endAt) delete this.queue.entries[id]; continue; }
        const options = requestOptions(20_000); if (!options) { deadlinePassed(); break; }
        let res;
        try { res = await this._request('POST', '/api/time-entries/sync', {body: item.payload, ...options}); }
        catch (error) { this.status = 'offline'; this.lastError = error.message; if (!bounded) this._backoff(); else deadlinePassed(); stop = true; break; }
        if (res.status === 401) { this._authFailed(); stop = true; break; }
        if (res.status >= 500) { this.lastError = `Server error (${res.status}).`; if (!bounded) this._backoff(); stop = true; break; }
        if (res.status >= 200 && res.status < 300) { this.queue.entries[id].sentKey = item.key; if (item.payload.endAt) delete this.queue.entries[id]; progressed = true; }
        else { this._moveToFailed('time', id, res.json?.error || `Rejected (${res.status}).`); delete this.queue.entries[id]; }
        this._saveQueue();
      }
      while (!stop && this.queue.manual.length) {
        if (deadlinePassed()) break;
        const item = this.queue.manual[0];
        const options = requestOptions(20_000); if (!options) { deadlinePassed(); break; }
        let res;
        try { res = await this._request('POST', '/api/time-entries', {body: item.payload, ...options}); }
        catch (error) { this.status = 'offline'; this.lastError = error.message; if (!bounded) this._backoff(); else deadlinePassed(); stop = true; break; }
        if (res.status === 401) { this._authFailed(); stop = true; break; }
        if (res.status >= 500) { this.lastError = `Server error (${res.status}).`; if (!bounded) this._backoff(); stop = true; break; }
        if (res.status >= 200 && res.status < 300) { this.queue.manual.shift(); progressed = true; }
        else { this._moveToFailed('manual', item.key, res.json?.error || `Rejected (${res.status}).`); this.queue.manual.shift(); }
        this._saveQueue();
      }
      while (!stop && this.queue.activity.length) {
        if (deadlinePassed()) break;
        const item = this.queue.activity[0];
        const options = requestOptions(20_000); if (!options) { deadlinePassed(); break; }
        let res;
        try { res = await this._request('POST', '/api/activity-slices/sync', {body: {entryClientId: item.entryClientId, slice: item.slice}, ...options}); }
        catch (error) { this.status = 'offline'; this.lastError = error.message; if (!bounded) this._backoff(); else deadlinePassed(); stop = true; break; }
        if (res.status === 401) { this._authFailed(); stop = true; break; }
        if (res.status >= 500) { this.lastError = `Server error (${res.status}).`; if (!bounded) this._backoff(); stop = true; break; }
        if (res.status >= 200 && res.status < 300) { this.queue.activity.shift(); progressed = true; }
        else { this._moveToFailed('activity', item.key, res.json?.error || `Rejected (${res.status}).`); this.queue.activity.shift(); }
        this._saveQueue();
      }
      while (!stop && this.queue.shots.length) {
        if (deadlinePassed()) break;
        const shot = this.queue.shots[0];
        // readCapture returns a Buffer (PNG) or {bytes, type, thumb}: WebP/PNG screenshot plus an optional ready-made thumbnail.
        let file = null; try { const read = this.readCapture(shot.captureId); file = Buffer.isBuffer(read) ? {bytes: read, type: 'image/png', thumb: null} : read; } catch { file = null; }
        if (!file?.bytes) { this._moveToFailed('screenshot', shot.captureId, 'Local file is missing.'); this.queue.shots.shift(); this._saveQueue(); continue; }
        const bytes = file.bytes;
        const q = new URLSearchParams({clientId: shot.captureId, takenAt: shot.takenAt}); if (shot.entryClientId) q.set('entryClientId', shot.entryClientId);
        let res;
        const options = requestOptions(60_000); if (!options) { deadlinePassed(); break; }
        try { res = await this._request('POST', `/api/screenshots?${q}`, {raw: bytes, contentType: file.type || 'image/png', ...options}); }
        catch (error) { shot.attempts++; this.status = 'offline'; this.lastError = error.message; this._saveQueue(); if (!bounded) this._backoff(); else deadlinePassed(); stop = true; break; }
        if (res.status === 401) { this._authFailed(); stop = true; break; }
        if (res.status >= 500) { shot.attempts++; this.lastError = `Server error (${res.status}).`; this._saveQueue(); if (!bounded) this._backoff(); stop = true; break; }
        if (res.status === 200 || res.status === 201) {
          this.queue.shots.shift(); progressed = true; this._saveQueue();
          const thumb = file.thumb ? {bytes: file.thumb, type: 'image/jpeg'} : (file.type === 'image/webp' ? null : this._thumbFor(bytes)); // WebP cannot be decoded here
          const thumbOptions = requestOptions(20_000);
          if (thumb && res.json?.id && !res.json.duplicate && thumbOptions) await this._request('PUT', `/api/screenshots/${res.json.id}/thumb`, {raw: thumb.bytes, contentType: thumb.type, ...thumbOptions}).catch(() => {});
        } else { this._moveToFailed('screenshot', shot.captureId, res.json?.error || `Rejected (${res.status}).`); this.queue.shots.shift(); this._saveQueue(); }
      }
      if (!stop) { this.failures = 0; this.status = 'online'; this.lastError = null; }
      if (progressed) this.lastSyncAt = new Date(this.now()).toISOString();
    } finally { this.flushing = false; this._changed(); }
    return {progressed, timedOut};
  }
  _thumbFor(bytes) { try { const t = this.makeThumb(bytes); return t && t.bytes ? t : null; } catch { return null; } }

  /** Tell the server what this device is doing so managers see live status. Fire-and-forget. */
  async heartbeat({status, projectId = null, taskLabel = '', trackedMs = 0}) {
    if (!this.token) return;
    const key = `${status}|${projectId}|${taskLabel}`; const now = this.now();
    if (key === this.lastHeartbeat.key && now - this.lastHeartbeat.at < HEARTBEAT_MS) return;
    this.lastHeartbeat = {at: now, key};
    try {
      const res = await this._request('POST', '/api/heartbeat', {body: {status, projectId, taskLabel: String(taskLabel).slice(0, 120), trackedMs: Math.max(0, Math.round(trackedMs)), deviceName: this.deviceName}, timeoutMs: 8000});
      if (res.status === 401) this._authFailed();
      else if (res.status === 200 && res.json?.policy) {
        const changed = JSON.stringify(this.policy) !== JSON.stringify(res.json.policy) || (typeof res.json.needsConsent === 'boolean' && this.needsConsent !== res.json.needsConsent);
        const recovered = this.status === 'offline';
        this.policy = res.json.policy;
        if (typeof res.json.needsConsent === 'boolean') this.needsConsent = res.json.needsConsent;
        if (recovered) this.status = 'online';
        if (changed || recovered) { this._saveConfig(); this._changed(); }
      }
    } catch { /* offline: the next heartbeat will catch up */ }
  }

  // ---------- timers ----------
  start() {
    if (this.interval) return;
    this.interval = this.timers.setInterval(() => {
      if (!this.token) return;
      this.flush().catch(() => {});
      if (this.now() - this.lastRefreshAt > POLICY_REFRESH_MS) this.refresh().catch(() => {});
    }, HEARTBEAT_MS);
    this.interval?.unref?.();
    if (this.token) { this.refresh().catch(() => {}); this.flush().catch(() => {}); }
  }
  stop() {
    for (const [key, clear] of [['interval', 'clearInterval'], ['retryTimer', 'clearTimeout'], ['debounce', 'clearTimeout']]) { if (this[key]) { this.timers[clear](this[key]); this[key] = null; } }
  }
  shutdown() { this.shuttingDown = true; this.stop(); }

  snapshot() {
    const p = this.policy;
    return {
      signedIn: !!this.token, sessionExpired: !this.token && !!this.serverUrl && this.status === 'signed-out', serverUrl: this.serverUrl, serverHost: this.serverUrl ? new URL(this.serverUrl).host : null,
      user: this.user ? {name: this.user.name, email: this.user.email, role: this.user.role} : null,
      status: this.status, lastError: this.lastError, lastSyncAt: this.lastSyncAt, needsConsent: this.needsConsent,
      policy: p ? {screenshotsEnabled: p.screenshotsEnabled, screenshotIntervalSeconds: p.screenshotIntervalSeconds, screenshotBlur: p.screenshotBlur, captureAllScreens: p.captureAllScreens === true, idleTimeoutSeconds: p.idleTimeoutSeconds, activityTrackingEnabled: p.activityTrackingEnabled === true, retentionDays: p.retentionDays, requireProject: p.requireProject, screenshotVisibility: p.screenshotVisibility, consentVersion: p.consentVersion, imageFormat: p.imageFormat === 'png' ? 'png' : 'webp', imageQuality: Number.isInteger(p.imageQuality) ? p.imageQuality : 80,
        breakReminderMinutes: Number.isInteger(p.breakReminderMinutes) && p.breakReminderMinutes >= 0 && p.breakReminderMinutes <= 240 ? p.breakReminderMinutes : 60,
        workScheduleEnabled: p.workScheduleEnabled === true, workDays: (() => { const days = Array.isArray(p.workDays) ? p.workDays.filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : []; return days.length ? days : [1, 2, 3, 4, 5]; })(),
        workTimeZone: validTimeZone(p.workTimeZone) ? p.workTimeZone : 'UTC',
        lateGraceMinutes: Number.isInteger(p.lateGraceMinutes) && p.lateGraceMinutes >= 0 && p.lateGraceMinutes <= 180 ? p.lateGraceMinutes : 0,
        workStartLocal: /^([01]\d|2[0-3]):[0-5]\d$/.test(p.workStartLocal) ? p.workStartLocal : '09:00', workEndLocal: /^([01]\d|2[0-3]):[0-5]\d$/.test(p.workEndLocal) ? p.workEndLocal : '17:00'} : null,
      projects: this.projects, pending: {time: this._unsentEntries(), manual: this.queue.manual.length, screenshots: this.queue.shots.length, activity: this.queue.activity.length}, failed: this.queue.failed.length,
      failedItems: this.queue.failed.slice(0, 5), persistent: this.persistentToken,
    };
  }
}

module.exports = {SyncClient, normalizeServerUrl};
