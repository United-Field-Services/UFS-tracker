'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Tracker} = require('../src/tracker.cjs');

function make() {
  const clock = {mono: 0, wall: Date.parse('2026-10-22T09:00:00Z')};
  const t = new Tracker({now: () => clock.mono, wall: () => new Date(clock.wall).toISOString()});
  return {t, clock, advance(ms) {clock.mono += ms; clock.wall += ms;}};
}
const company = (extra = {}) => ({mode: 'company', displayId: 1, intervalSeconds: 600, consent: true, task: 'Client work', screenshots: true, projectId: 'p1', taskId: null, ...extra});

test('company session accepts any policy interval from 10 to 3600 seconds, manual modes keep the fixed list', () => {
  for (const seconds of [10, 45, 600, 3600]) { const {t} = make(); t.prepare(company({intervalSeconds: seconds})); assert.equal(t.current.intervalSeconds, seconds); }
  for (const seconds of [9, 3601, 1.5, '600', null]) assert.throws(() => make().t.prepare(company({intervalSeconds: seconds})), /valid capture interval/);
  assert.throws(() => make().t.prepare({mode: 'manual', displayId: 1, intervalSeconds: 45, consent: true}), /valid capture interval/);
});

test('company idle accounting uses its configured idle timeout and rejects unsafe values', () => {
  const {t, advance} = make();
  const token = t.prepare(company({screenshots: false, displayId: null, idleTimeoutSeconds: 120}));
  assert.equal(t.current.idleTimeoutSeconds, 120);
  t.confirm(token);
  for (let i = 0; i < 90; i++) { advance(1000); t.tick(90); }
  assert.equal(t.current.idleMs, 0);
  for (let i = 0; i < 30; i++) { advance(1000); t.tick(120); }
  assert.equal(t.current.idleMs, 30_000);
  for (const value of [59, 3601, 120.5, '120', null]) {
    assert.throws(() => make().t.prepare(company({idleTimeoutSeconds: value})), /valid idle timeout/);
  }
});

test('company idle review offers keep or discard, pauses screenshots, and does not repeat in one idle period', () => {
  const makeReview = () => {
    const {t, advance} = make();
    const token = t.prepare(company({screenshots: false, displayId: null, idleTimeoutSeconds: 60})); t.confirm(token);
    for (let i = 1; i <= 60; i++) { advance(1000); t.tick(i); }
    assert.ok(t.current.idleReview); assert.equal(t.current.idleMs, 1000);
    for (let i = 0; i < 5; i++) { advance(1000); t.tick(61 + i); }
    for (let i = 0; i < 5; i++) { advance(1000); t.tick(0); }
    assert.equal(t.current.trackedMs, 70_000); assert.equal(t.current.idleMs, 6_000);
    return {t, advance};
  };
  const discarded = makeReview();
  assert.throws(() => discarded.t.resolveIdleReview('false'), /Choose whether/);
  const discardResult = discarded.t.resolveIdleReview(false);
  assert.deepEqual(discardResult, {kept: false, idleMs: 6000});
  assert.equal(discarded.t.current.trackedMs, 64_000); assert.equal(discarded.t.current.idleMs, 0);

  const samePeriod = make(); const repeatToken = samePeriod.t.prepare(company({screenshots: false, displayId: null, idleTimeoutSeconds: 60})); samePeriod.t.confirm(repeatToken);
  for (let i = 1; i <= 60; i++) { samePeriod.advance(1000); samePeriod.t.tick(i); }
  samePeriod.t.resolveIdleReview(false);
  for (let i = 61; i <= 120; i++) { samePeriod.advance(1000); samePeriod.t.tick(i); }
  assert.equal(samePeriod.t.current.idleReview, undefined, 'same idle period does not reopen the prompt');
  samePeriod.advance(1000); samePeriod.t.tick(0);
  for (let i = 1; i <= 60; i++) { samePeriod.advance(1000); samePeriod.t.tick(i); }
  assert.ok(samePeriod.t.current.idleReview, 'a later idle period asks again');

  const kept = makeReview();
  const keepResult = kept.t.resolveIdleReview(true);
  assert.deepEqual(keepResult, {kept: true, idleMs: 6000});
  assert.equal(kept.t.current.trackedMs, 70_000); assert.equal(kept.t.current.idleMs, 6000);
});

test('company idle review invalidates an in-flight screenshot and waits before the next capture', () => {
  const {t, advance} = make();
  const token = t.prepare(company({intervalSeconds: 10, idleTimeoutSeconds: 60})); t.confirm(token);
  const request = t.captureDue(); assert.ok(request);
  for (let i = 1; i <= 60; i++) { advance(1000); t.tick(i); }
  assert.equal(t.canSave(request), false); assert.equal(t.captureDue(), null); assert.equal(t.snapshot().nextCaptureIn, null);
  t.resolveIdleReview(true); assert.equal(t.captureDue(), null);
  for (let i = 0; i < 10; i++) { advance(1000); t.tick(0); }
  assert.ok(t.captureDue());
});

test('unresolved company idle review is discarded when tracking pauses or stops', () => {
  for (const finish of ['pause', 'stop']) {
    const {t, advance} = make(); const token = t.prepare(company({screenshots: false, displayId: null, idleTimeoutSeconds: 60})); t.confirm(token);
    for (let i = 1; i <= 60; i++) { advance(1000); t.tick(i); }
    assert.ok(t.current.idleReview);
    if (finish === 'pause') t.pause('test pause'); else t.stop();
    const session = finish === 'pause' ? t.current : t.lastCompleted;
    assert.equal(session.idleReview, undefined); assert.equal(session.idleMs, 0); assert.equal(session.trackedMs, 59_000);
  }
});

test('company session stores project and task and snapshots them', () => {
  const {t} = make();
  t.prepare(company({projectId: 'proj-1', taskId: 'task-1'}));
  assert.equal(t.snapshot().current.projectId, 'proj-1'); assert.equal(t.snapshot().current.taskId, 'task-1'); assert.equal(t.snapshot().current.mode, 'company');
  assert.throws(() => make().t.prepare(company({projectId: 5})), /project selection/);
  assert.throws(() => make().t.prepare(company({projectId: 'x'.repeat(65)})), /project selection/);
  assert.throws(() => make().t.prepare(company({screenshots: 'yes'})), /screenshot setting/);
});

test('company session with screenshots on behaves like a normal capture session at the policy interval', () => {
  const {t, advance} = make();
  const token = t.prepare(company({intervalSeconds: 120})); t.confirm(token);
  const first = t.captureDue(); assert.ok(first);
  t.saved({token, id: first.id});
  assert.equal(t.captureDue(), null);
  for (let i = 0; i < 119; i++) { advance(1000); t.tick(0); }
  assert.equal(t.captureDue(), null);                // 119 s: not yet
  advance(1000); t.tick(0); assert.ok(t.captureDue()); // 120 s: due
  assert.equal(t.phase, 'tracking');
});

test('company session with screenshots off never shares the screen, never asks for a capture, and needs no display', () => {
  const {t, advance} = make();
  const token = t.prepare(company({screenshots: false, displayId: null}));
  assert.equal(t.current.displayId, null);
  t.confirm(token);
  for (let i = 0; i < 20; i++) { advance(1000); t.tick(0); assert.equal(t.captureDue(), null); }
  assert.equal(t.snapshot().nextCaptureIn, null);
  assert.equal(t.canSave({token, id: 'anything'}), false);
  assert.equal(t.current.trackedMs, 20_000);
  assert.match(t.message, /no screenshots are taken/);
  const finished = t.stop(); assert.equal(finished.screenshots, false); assert.equal(finished.captureCount, 0);
});

test('screenshots on still require a display and consent', () => {
  assert.throws(() => make().t.prepare(company({displayId: null})), /Choose a screen/);
  assert.throws(() => make().t.prepare(company({consent: false})), /agree/);
  assert.throws(() => make().t.prepare(company({screenshots: false, displayId: null, consent: false})), /confirm/);
});

test('mode cannot change mid-session, but policy and project can change while paused and are recorded', () => {
  const {t} = make();
  let token = t.prepare(company({projectId: 'a'})); t.confirm(token); t.pause('test');
  assert.throws(() => t.prepare({mode: 'manual', displayId: 1, intervalSeconds: 10, consent: true}), /changing its mode/);
  token = t.prepare(company({projectId: 'b', screenshots: false, displayId: null, intervalSeconds: 900, idleTimeoutSeconds: 180}));
  assert.equal(t.current.projectId, 'b'); assert.equal(t.current.screenshots, false); assert.equal(t.current.intervalSeconds, 900); assert.equal(t.current.idleTimeoutSeconds, 180);
  t.confirm(token); assert.equal(t.captureDue(), null);
});

test('existing local modes are unchanged: they always capture', () => {
  const {t} = make();
  const token = t.prepare({mode: 'manual', displayId: 1, intervalSeconds: 10, consent: true}); t.confirm(token);
  assert.equal(t.capturesScreen(), true); assert.ok(t.captureDue());
});
