'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createCaptureClock} = require('../src/clock.cjs');
const {Tracker, ONE_HOUR_MS} = require('../src/tracker.cjs');
test('Linux boot clock includes suspend even if wall time moves backward', () => {
  let uptime = 1000, wall = Date.parse('2026-10-18T12:00:00Z');
  const clock = createCaptureClock({platform: 'linux', read: () => `${uptime} 50.00\n`});
  const tracker = new Tracker({now: clock.now, wall: () => new Date(wall).toISOString()});
  const token = tracker.prepare({displayId: 1, intervalSeconds: 300, consent: true, mode: 'one-hour'});
  tracker.confirm(token); tracker.pause('Sleep');
  uptime += ONE_HOUR_MS / 1000; wall -= ONE_HOUR_MS * 2;
  assert.equal(tracker.remainingMs(), 0); assert.equal(tracker.expireIfNeeded().stopReason, 'time-limit');
});
test('Linux clock rejects invalid input, failure is sticky, and no fallback occurs', () => {
  for (const bad of ['', '-1 0', 'NaN 0', 'Infinity 0', '12oops 0', '1', '1 2 3', '1e300 0']) {
    let value = '100.00 1.00', failures = 0;
    const clock = createCaptureClock({platform: 'linux', read: () => value, monotonic: () => {throw new Error('No fallback');}, onFailure: () => {failures++;}});
    assert.equal(clock.now(), 100000); value = bad; assert.throws(() => clock.assertHealthy(), /timing is unavailable/);
    value = '200.00 0.00'; assert.equal(clock.now(), 100000); assert.equal(failures, 1); assert.ok(clock.failure);
  }
});
test('clock read failure or backward uptime stops capture and refuses future starts', () => {
  for (const mode of ['backward', 'read-error']) {
    let value = 100, tracker;
    const clock = createCaptureClock({platform: 'linux', read: () => {if (value < 0) throw new Error('Read failed'); return `${value} 0`;}, onFailure: message => tracker.stop(message, 'clock-unavailable')});
    tracker = new Tracker({now: clock.now});
    const token = tracker.prepare({displayId: 1, intervalSeconds: 300, consent: true, mode: 'one-hour'});
    tracker.confirm(token); const capture = tracker.captureDue();
    value = mode === 'backward' ? 99 : -1;
    assert.throws(() => tracker.canSave(capture), /timing is unavailable/); assert.equal(tracker.canSave(capture), false); assert.equal(tracker.phase, 'stopped');
    assert.equal(tracker.snapshot().lastCompleted.stopReason, 'clock-unavailable');
    assert.throws(() => clock.assertHealthy(), /timing is unavailable/);
  }
});
test('non-Linux clocks preserve monotonic timing without reading procfs', () => {
  const clock = createCaptureClock({platform: 'darwin', read: () => {throw new Error('Should not read');}, monotonic: () => 123.456});
  assert.equal(clock.now(), 123.456); assert.equal(clock.failure, null);
});
test('first clock failure aborts snapshots and outer stops after reentrant shutdown', () => {
  for (const method of ['snapshot', 'stop']) {
    let failed = false, tracker, nested;
    const clock = createCaptureClock({platform: 'linux', read: () => {if (failed) throw new Error('Read failed'); return '100 0';}, onFailure: message => {tracker.stop(message, 'clock-unavailable'); nested = tracker.snapshot();}});
    tracker = new Tracker({now: clock.now});
    tracker.confirm(tracker.prepare({displayId: 1, intervalSeconds: 300, consent: true, mode: 'one-hour'}));
    failed = true;
    assert.throws(() => tracker[method](), /timing is unavailable/);
    assert.equal(nested.phase, 'stopped'); assert.equal(nested.current, null);
    assert.equal(tracker.snapshot().lastCompleted.stopReason, 'clock-unavailable');
    assert.equal(tracker.captureDue(), null); assert.throws(() => clock.assertHealthy(), /timing is unavailable/);
  }
});
