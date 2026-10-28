'use strict';

const SLICE_MS = 60_000;

/**
 * Count-only activity sampler. Event objects are deliberately ignored: key codes,
 * coordinates, modifiers, timestamps and text are never read or retained.
 */
class ActivityCounter {
  constructor({source, now = () => Date.now(), startHook = () => source.start(), stopHook = () => source.stop()} = {}) {
    if (!source || typeof source.on !== 'function' || typeof source.removeListener !== 'function') throw new Error('An input event source is required.');
    this.source = source; this.now = now; this.startHook = startHook; this.stopHook = stopHook;
    this.active = false; this.keyboardCount = 0; this.mouseCount = 0; this.activeSeconds = 0;
    this.inputSinceTick = false; this.sliceStart = null; this.sliceTrackingStart = null; this.lastTick = null; this.closed = [];
    this.onKey = () => { if (this.active) { this._roll(this.now()); this.keyboardCount = Math.min(10_000, this.keyboardCount + 1); this.inputSinceTick = true; } };
    this.onClick = () => { if (this.active) { this._roll(this.now()); this.mouseCount = Math.min(10_000, this.mouseCount + 1); this.inputSinceTick = true; } };
    this.onOtherMouse = () => { if (this.active) { this._roll(this.now()); this.inputSinceTick = true; } };
  }

  start() {
    if (this.active) return;
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('Activity clock is unavailable.');
    this.active = true; this.sliceStart = Math.floor(now / SLICE_MS) * SLICE_MS; this.sliceTrackingStart = now; this.lastTick = now;
    this.source.on('keydown', this.onKey); this.source.on('click', this.onClick);
    this.source.on('mousemove', this.onOtherMouse); this.source.on('wheel', this.onOtherMouse);
    try { this.startHook(); }
    catch (error) { this._detach(); this.active = false; this.sliceStart = null; this.sliceTrackingStart = null; this.lastTick = null; throw error; }
  }

  _detach() {
    this.source.removeListener('keydown', this.onKey); this.source.removeListener('click', this.onClick);
    this.source.removeListener('mousemove', this.onOtherMouse); this.source.removeListener('wheel', this.onOtherMouse);
  }

  _close(endAt) {
    if (this.sliceStart === null) return;
    const durationSeconds = Math.max(0, Math.min(60, Math.floor((endAt - this.sliceTrackingStart) / 1000)));
    if (durationSeconds > 0) this.closed.push({
      startedAt: new Date(this.sliceStart).toISOString(), durationSeconds,
      keyboardCount: this.keyboardCount, mouseCount: this.mouseCount,
      activeSeconds: Math.min(durationSeconds, this.activeSeconds),
    });
    this.keyboardCount = 0; this.mouseCount = 0; this.activeSeconds = 0;
  }

  _roll(now) {
    if (!Number.isFinite(now) || this.sliceStart === null) return;
    const bucket = Math.floor(now / SLICE_MS) * SLICE_MS;
    if (bucket !== this.sliceStart) {
      this._close(this.sliceStart + SLICE_MS);
      this.sliceStart = bucket; this.sliceTrackingStart = bucket;
    }
  }

  /** Call once per tracker tick. Only a Boolean activity mark crosses a tick boundary. */
  tick(now = this.now()) {
    if (!this.active) return;
    if (!Number.isFinite(now) || now < this.lastTick) throw new Error('Activity clock moved backwards.');
    const elapsed = now - this.lastTick;
    if (elapsed >= 500 && elapsed <= 5000 && this.inputSinceTick) this.activeSeconds++;
    this.inputSinceTick = false; this.lastTick = now;
    this._roll(now);
  }

  /** Stop the global hook and close the partial minute using only aggregate counts. */
  stop(now = this.now()) {
    if (!this.active) return this.drain();
    let stopError;
    try { this.stopHook(); } catch (error) { stopError = error; }
    this._detach(); this.active = false;
    if (Number.isFinite(now) && this.sliceStart !== null) this._close(Math.min(now, this.sliceStart + SLICE_MS));
    this.sliceStart = null; this.sliceTrackingStart = null; this.lastTick = null; this.inputSinceTick = false;
    if (stopError) throw stopError;
    return this.drain();
  }

  drain() { const result = this.closed; this.closed = []; return result; }
}

module.exports = {ActivityCounter, SLICE_MS};
