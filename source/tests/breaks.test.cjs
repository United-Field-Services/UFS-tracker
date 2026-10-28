'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {breaksOf, MAX_BREAKS} = require('../src/breaks.cjs');
const {Tracker} = require('../src/tracker.cjs');

const at = minutes => new Date(Date.UTC(2026, 9, 29, 9, minutes)).toISOString();

test('breaks start at a break pause and end when tracking resumes or the session stops', () => {
  const events = [
    {at: at(0), type: 'tracking-started'},
    {at: at(10), type: 'paused', kind: 'break', reason: 'On a break'}, {at: at(15), type: 'start-request'}, {at: at(16), type: 'tracking-started'},
    {at: at(30), type: 'paused', kind: 'manual', reason: 'Paused'}, {at: at(32), type: 'tracking-started'},          // a normal pause is not a break
    {at: at(40), type: 'paused', kind: 'break'}, {at: at(50), type: 'stopped', reason: 'manual'},
  ];
  assert.deepEqual(breaksOf(events, at(50)), [{startAt: at(10), endAt: at(16)}, {startAt: at(40), endAt: at(50)}]);
});

test('a break still going is reported as open, or closed at the end of a finished session', () => {
  const events = [{at: at(0), type: 'tracking-started'}, {at: at(10), type: 'paused', kind: 'break'}];
  assert.deepEqual(breaksOf(events, null), [{startAt: at(10), endAt: null}]);
  assert.deepEqual(breaksOf(events, at(25)), [{startAt: at(10), endAt: at(25)}]);
});

test('a failed resume keeps the break going; zero-length and malformed events are ignored', () => {
  const events = [{at: at(10), type: 'paused', kind: 'break'}, {at: at(11), type: 'start-request'}, {at: at(11), type: 'paused', kind: 'manual', reason: 'Screen sharing did not start'}, {at: at(20), type: 'tracking-started'},
    {at: at(30), type: 'paused', kind: 'break'}, {at: at(30), type: 'tracking-started'}, null, {type: 'paused', kind: 'break'}, {at: 5, type: 'paused', kind: 'break'}];
  assert.deepEqual(breaksOf(events, at(60)), [{startAt: at(10), endAt: at(20)}]);
  assert.deepEqual(breaksOf(undefined), []); assert.deepEqual(breaksOf('nope'), []);
});

test('the list is capped so a runaway session cannot grow without bound', () => {
  const events = []; for (let i = 0; i < MAX_BREAKS + 50; i++) events.push({at: new Date(Date.UTC(2026, 9, 1, 0, i * 2)).toISOString(), type: 'paused', kind: 'break'}, {at: new Date(Date.UTC(2026, 9, 1, 0, i * 2 + 1)).toISOString(), type: 'tracking-started'});
  assert.equal(breaksOf(events, null).length, MAX_BREAKS);
});

function trackerFixture(mode) {
  let mono = 0, wall = Date.UTC(2026, 9, 29, 9, 0);
  const tracker = new Tracker({now: () => mono, wall: () => new Date(wall).toISOString()});
  const start = () => { const token = tracker.prepare(mode === 'company' ? {displayId: 1, intervalSeconds: 60, consent: true, mode: 'company', screenshots: true, idleTimeoutSeconds: 300, activityTrackingEnabled: false, projectId: null, taskId: null, allScreens: false} : {displayId: 1, intervalSeconds: 10, consent: true, mode: 'manual'}); tracker.confirm(token); };
  return {tracker, start, advance: ms => { mono += ms; wall += ms; }};
}

test('the tracker records the pause kind; only company sessions can record a break', () => {
  const company = trackerFixture('company'); company.start(); company.advance(5000); company.tracker.pause('On a break.', 'break');
  assert.equal(company.tracker.current.events.at(-1).kind, 'break'); assert.equal(company.tracker.phase, 'paused');
  const plain = trackerFixture('company'); plain.start(); plain.tracker.pause(); assert.equal(plain.tracker.current.events.at(-1).kind, 'manual');
  const local = trackerFixture('manual'); local.start(); local.tracker.pause('On a break.', 'break');
  assert.equal(local.tracker.current.events.at(-1).kind, 'manual', 'local sessions are never synced, so a break is just a pause');
});

test('time during a break is not tracked and the break shows up in the derived list', () => {
  const f = trackerFixture('company'); f.start(); f.advance(60_000); f.tracker.tick(0); const before = f.tracker.current.trackedMs;
  f.tracker.pause('On a break.', 'break'); f.advance(10 * 60_000); f.tracker.tick(0);
  assert.equal(f.tracker.current.trackedMs, before, 'paused time is never billed');
  const token = f.tracker.prepare({displayId: 1, intervalSeconds: 60, consent: true, mode: 'company', screenshots: true, idleTimeoutSeconds: 300, activityTrackingEnabled: false, projectId: null, taskId: null, allScreens: false}); f.tracker.confirm(token);
  const list = breaksOf(f.tracker.current.events, null); assert.equal(list.length, 1); assert.equal(Date.parse(list[0].endAt) - Date.parse(list[0].startAt), 10 * 60_000);
});
