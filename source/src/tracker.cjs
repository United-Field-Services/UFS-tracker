'use strict';
const { randomUUID } = require('node:crypto');
const ONE_HOUR_MS = 60 * 60 * 1000;
const TEST_INTERVAL_SECONDS = 300;
const DEFAULT_IDLE_THRESHOLD_SECONDS = 60;
class Tracker {
  constructor({ now = () => performance.now(), wall = () => new Date().toISOString(), idleThresholdSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS } = {}) {
    this.now = now; this.wall = wall; this.idleThresholdSeconds = idleThresholdSeconds;
    this.phase = 'stopped'; this.current = null; this.lastCompleted = null; this.token = null; this.lastTick = null;
    this.nextCaptureAt = null; this.pendingCapture = null; this.message = 'Ready when you are.';
    this.lastIdleSeconds = NaN;
    this.testStartedMono = null; this.deadlineMono = null; this.deadlineWall = null;
  }
  remainingMs() {
    if (this.deadlineMono === null) return null;
    const monoRemaining = this.deadlineMono - this.now();
    const wallNow = Date.parse(this.wall());
    const wallRemaining = Number.isFinite(wallNow) && Number.isFinite(this.deadlineWall) ? this.deadlineWall - wallNow : Infinity;
    // A wall-clock adjustment can only stop the test sooner; it cannot extend the monotonic limit.
    return Math.max(0, Math.min(monoRemaining, wallRemaining));
  }
  deadlineReached() { return this.deadlineMono !== null && this.remainingMs() <= 0; }
  accrue(idleSeconds, until = this.now()) {
    if (this.phase !== 'tracking' || this.lastTick === null) return;
    this.lastIdleSeconds = idleSeconds;
    const elapsed = Math.max(0, until - this.lastTick); this.lastTick = until;
    if (elapsed > 5000) { this.pause('Tracking paused after a timing gap. Press Resume when ready.'); return; }
    this.current.trackedMs += elapsed;
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) this.current.unknownActivityMs += elapsed;
    else if (idleSeconds < this.idleThresholdSeconds) this.current.idlePeriodReviewed = false;
    else {
      this.current.idleMs += elapsed;
      if (this.current.mode === 'company' && !this.current.idleReview && !this.current.idlePeriodReviewed) {
        this.current.idlePeriodReviewed = true;
        this.current.idleReview = {
          baselineIdleMs: this.current.idleMs - elapsed,
          openedAt: this.wall(),
          thresholdSeconds: this.idleThresholdSeconds,
        };
        this.current.events.push({at: this.wall(), type: 'idle-review-prompted', thresholdSeconds: this.idleThresholdSeconds});
        this.message = 'Idle time needs your review. Choose whether to keep or discard it.';
        // Do not leave a screenshot request in flight while the employee is away or resolving the prompt.
        this.pendingCapture = null;
      }
    }
  }
  expireIfNeeded(idleSeconds = NaN) {
    if (!this.current || !this.deadlineReached()) return null;
    this.accrue(idleSeconds, Math.min(this.now(), this.deadlineMono));
    return this.stop('One-hour test finished. Screenshot capture is off. Review your local gallery.', 'time-limit');
  }
  // 'company' sessions are started from a signed-in company account: the capture interval, whether screenshots
  // are taken at all, and the project come from the organization's policy (applied by the main process).
  prepare({ displayId, intervalSeconds, consent, task, mode = 'manual', screenshots = true, projectId = null, taskId = null, idleTimeoutSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS, activityTrackingEnabled = false, allScreens = false }) {
    if (!['stopped', 'paused'].includes(this.phase)) throw new Error('Finish the current start or stop tracking first.');
    if (this.deadlineReached()) throw new Error('The one-hour test has ended. Start a new test only when ready.');
    if (!['manual', 'one-hour', 'company'].includes(mode)) throw new Error('Choose a valid session mode.');
    const company = mode === 'company';
    if (company && typeof screenshots !== 'boolean') throw new Error('Invalid screenshot setting.');
    const capturing = !company || screenshots;
    if (consent !== true) throw new Error(capturing ? (company && allScreens ? 'Please agree to capture all connected screens under organization policy.' : 'Please agree to capture your selected screen.') : 'Please confirm before tracking starts.');
    if (capturing && !Number.isInteger(displayId)) throw new Error('Choose a screen.');
    if (company ? !(Number.isInteger(intervalSeconds) && intervalSeconds >= 10 && intervalSeconds <= 3600) : ![10, 30, 60, 300].includes(intervalSeconds)) throw new Error('Choose a valid capture interval.');
    if (mode === 'one-hour' && intervalSeconds !== TEST_INTERVAL_SECONDS) throw new Error('The one-hour test saves one screenshot every five minutes.');
    if (company && (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 60 || idleTimeoutSeconds > 3600)) throw new Error('Choose a valid idle timeout.');
    if (company && typeof activityTrackingEnabled !== 'boolean') throw new Error('Invalid activity-counting setting.');
    if (typeof allScreens !== 'boolean' || (allScreens && !(company && capturing))) throw new Error('Invalid all-screens setting.');
    if (company && ![projectId, taskId].every(v => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64))) throw new Error('Invalid project selection.');
    if (this.current && this.current.mode !== mode) throw new Error('Stop this session before changing its mode.');
    this.idleThresholdSeconds = company ? idleTimeoutSeconds : DEFAULT_IDLE_THRESHOLD_SECONDS;
    if (!this.current) {
      this.current = { id: randomUUID(), startedAt: this.wall(), endedAt: null, task: String(task || 'My test session').trim().slice(0, 120), mode, durationLimitMs: mode === 'one-hour' ? ONE_HOUR_MS : null, testStartedAt: null, deadlineAt: null, trackedMs: 0, idleMs: 0, unknownActivityMs: 0, captureCount: 0, displayId: capturing ? displayId : null, intervalSeconds, events: [] };
      if (company) Object.assign(this.current, { screenshots, allScreens, projectId, taskId, idleTimeoutSeconds, activityTrackingEnabled, activitySlices: [] });
    } else if (company && (this.current.screenshots !== screenshots || this.current.allScreens !== allScreens || this.current.projectId !== projectId || this.current.taskId !== taskId || this.current.activityTrackingEnabled !== activityTrackingEnabled)) {
      // Policy or project changed while paused: keep the same session but record the new settings.
      Object.assign(this.current, { screenshots, allScreens, projectId, taskId, activityTrackingEnabled });
    }
    if (company) this.current.idleTimeoutSeconds = idleTimeoutSeconds;
    this.current.displayId = capturing ? displayId : null; this.current.intervalSeconds = intervalSeconds;
    this.phase = 'starting'; this.token = randomUUID(); this.message = 'Waiting for your screen permission…';
    this.current.events.push({ at: this.wall(), type: 'start-request', displayId });
    return this.token;
  }
  confirm(token) {
    if (this.phase !== 'starting' || this.token !== token) throw new Error('This start request was cancelled.');
    if (this.deadlineReached()) throw new Error('The one-hour test has ended.');
    const now = this.now();
    if (this.current.mode === 'one-hour') {
      if (this.deadlineMono === null) {
        this.testStartedMono = now; this.deadlineMono = now + ONE_HOUR_MS;
        this.current.testStartedAt = this.wall(); this.deadlineWall = Date.parse(this.current.testStartedAt) + ONE_HOUR_MS;
        this.current.deadlineAt = new Date(this.deadlineWall).toISOString(); this.nextCaptureAt = now;
      } else if (this.nextCaptureAt === null || this.nextCaptureAt < now) {
        // Keep fixed five-minute slots across pauses. Missed slots are skipped, never replayed.
        const interval = TEST_INTERVAL_SECONDS * 1000;
        this.nextCaptureAt = this.testStartedMono + Math.ceil((now - this.testStartedMono) / interval) * interval;
      }
    } else this.nextCaptureAt = this.capturesScreen() ? now : null;
    this.phase = 'tracking'; this.lastTick = now;
    this.message = this.current.mode === 'one-hour' ? 'One-hour test is on. Screenshots save every five minutes, then stop automatically.'
      : this.current.mode === 'company' ? (this.capturesScreen() ? `Tracking is on. Your time and screenshots of ${this.current.allScreens ? 'all your connected screens' : 'the screen you chose'} are sent to your organization.` : 'Tracking is on. Only your time is tracked; no screenshots are taken.')
      : 'Tracking is on. Your selected screen is being captured locally.';
    this.current.events.push({ at: this.wall(), type: 'tracking-started' });
  }
  fail(token, message) { if (this.token === token) this.pause(message || 'Screen sharing did not start. Please try again.'); }
  tick(idleSeconds) { const completed = this.expireIfNeeded(idleSeconds); if (completed) return completed; this.accrue(idleSeconds); return null; }
  /** False only for company sessions whose policy turns screenshots off (time is tracked, screen is never shared). */
  capturesScreen() { return this.current?.screenshots !== false; }
  captureDue() {
    if (!this.capturesScreen() || this.current?.idleReview || this.deadlineReached() || this.phase !== 'tracking' || this.pendingCapture || this.now() < this.nextCaptureAt) return null;
    this.pendingCapture = { id: randomUUID(), token: this.token, requestedAt: this.now() };
    return { ...this.pendingCapture };
  }
  canSave({ token, id }) {
    return this.capturesScreen() && !this.current?.idleReview && !this.deadlineReached() && this.phase === 'tracking' && token === this.token && this.pendingCapture?.id === id && this.now() - this.pendingCapture.requestedAt <= 12000;
  }
  saved(request, committedBeforeCutoff = false) {
    const matchesPending = this.phase === 'tracking' && request.token === this.token && request.id === this.pendingCapture?.id;
    if (!(committedBeforeCutoff && matchesPending) && !this.canSave(request)) throw new Error('Capture cancelled or the time limit was reached.');
    this.current.captureCount += 1; this.pendingCapture = null;
    const interval = this.current.intervalSeconds * 1000;
    this.nextCaptureAt = this.current.mode === 'one-hour' ? this.testStartedMono + (Math.floor((this.now() - this.testStartedMono) / interval) + 1) * interval : this.now() + interval;
  }
  captureFailed(request, message) { if (this.canSave(request)) this.pause(message || 'Capture failed. Tracking paused to keep the status honest.'); }
  checkCaptureTimeout() { if (this.pendingCapture && this.now() - this.pendingCapture.requestedAt > 12000) this.pause('Screen capture stopped responding. Resume to choose your screen again.'); }
  resolveIdleReview(keep, reason = 'employee') {
    if (typeof keep !== 'boolean') throw new Error('Choose whether to keep or discard the idle time.');
    if (this.phase !== 'tracking' || this.current?.mode !== 'company' || !this.current.idleReview) throw new Error('There is no idle-time review to resolve.');
    const review = this.current.idleReview;
    const idleMs = Math.max(0, this.current.idleMs - review.baselineIdleMs);
    if (!keep) { this.current.idleMs -= idleMs; this.current.trackedMs = Math.max(0, this.current.trackedMs - idleMs); }
    this.current.events.push({at: this.wall(), type: keep ? 'idle-review-kept' : 'idle-review-discarded', idleMs, reason});
    this.current.idlePeriodReviewed = Number.isFinite(this.lastIdleSeconds) && this.lastIdleSeconds >= this.idleThresholdSeconds;
    delete this.current.idleReview;
    this.pendingCapture = null;
    this.nextCaptureAt = this.capturesScreen() ? this.now() + this.current.intervalSeconds * 1000 : null;
    this.message = keep ? 'Idle time kept. Tracking continues.' : 'Idle time discarded. Tracking continues.';
    return {kept: keep, idleMs};
  }
  pause(message = 'Paused. No screenshots are being saved. The one-hour limit, if set, keeps counting down.', kind = 'manual') {
    if (!this.current || this.phase === 'stopped') return;
    if (this.current.idleReview && this.phase === 'tracking') this.resolveIdleReview(false, 'paused');
    this.phase = 'paused'; this.token = null; this.lastTick = null;
    if (this.current.mode !== 'one-hour') this.nextCaptureAt = null;
    this.pendingCapture = null; this.message = message;
    this.current.events.push({ at: this.wall(), type: 'paused', reason: message, kind: kind === 'break' && this.current.mode === 'company' ? 'break' : kind === 'break' ? 'manual' : kind });
  }
  stop(message = 'Session stopped. Your screenshots are saved on this computer.', reason = 'manual') {
    if (!this.current) return null;
    if (this.current.idleReview && this.phase === 'tracking') this.resolveIdleReview(false, 'stopped');
    this.current.events.push({ at: this.wall(), type: 'stopped', reason }); this.current.endedAt = this.wall(); this.current.stopReason = reason;
    if (this.testStartedMono !== null) this.current.testElapsedMs = Math.min(ONE_HOUR_MS, Math.max(0, this.now() - this.testStartedMono));
    const result = this.current; this.lastCompleted = JSON.parse(JSON.stringify(result)); this.current = null; this.phase = 'stopped'; this.token = null; this.lastTick = null; this.nextCaptureAt = null; this.pendingCapture = null; this.message = message;
    this.testStartedMono = null; this.deadlineMono = null; this.deadlineWall = null;
    return result;
  }
  snapshot() {
    return { phase: this.phase, current: this.current ? JSON.parse(JSON.stringify(this.current)) : null, lastCompleted: this.lastCompleted ? JSON.parse(JSON.stringify(this.lastCompleted)) : null, message: this.message, testRemainingMs: this.remainingMs(), nextCaptureIn: this.phase === 'tracking' && !this.current?.idleReview && this.capturesScreen() && this.nextCaptureAt < (this.deadlineMono ?? Infinity) ? Math.max(0, Math.ceil((this.nextCaptureAt - this.now()) / 1000)) : null, idleThresholdSeconds: this.idleThresholdSeconds };
  }
}
module.exports = { Tracker, ONE_HOUR_MS, TEST_INTERVAL_SECONDS, DEFAULT_IDLE_THRESHOLD_SECONDS };
