'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {ActivityCounter} = require('../src/activity.cjs');

function fixture(start = 120_025) {
  const source = new EventEmitter(); let now = start; let starts = 0, stops = 0;
  const meter = new ActivityCounter({source, now: () => now, startHook: () => { starts++; }, stopHook: () => { stops++; }});
  return {source, meter, setNow: value => { now = value; }, hooks: () => ({starts, stops})};
}

test('activity sampler stores only minute aggregates and never retains supplied event objects', () => {
  const f = fixture(); f.meter.start();
  const hostile = {keycode: 999, x: 100, y: 200, text: 'synthetic secret'};
  f.source.emit('keydown', hostile); f.source.emit('click', hostile); f.source.emit('mousemove', hostile);
  f.setNow(121_025); f.meter.tick();
  f.setNow(122_025); f.meter.tick();
  const slices = f.meter.stop(122_025);
  assert.deepEqual(slices, [{startedAt: new Date(120_000).toISOString(), durationSeconds: 2, keyboardCount: 1, mouseCount: 1, activeSeconds: 1}]);
  assert.equal(JSON.stringify(slices).includes('synthetic secret'), false);
  assert.deepEqual(f.hooks(), {starts: 1, stops: 1});
  assert.equal(f.source.listenerCount('keydown'), 0);
});

test('minute boundary closes an exact aggregate slice and partial start/end duration is bounded', () => {
  const f = fixture(179_500); f.meter.start();
  f.source.emit('keydown', {text: 'synthetic'});
  f.setNow(180_500); f.meter.tick();
  const closed = f.meter.drain();
  assert.deepEqual(closed, []); // the tracked part of that minute was under one second
  f.source.emit('click', {x: 123, y: 456});
  f.setNow(181_500); f.meter.tick();
  const slices = f.meter.stop(182_000);
  assert.deepEqual(slices, [{startedAt: new Date(180_000).toISOString(), durationSeconds: 2, keyboardCount: 0, mouseCount: 1, activeSeconds: 1}]);
});

test('hook startup failure detaches all count-only listeners and leaves sampler stopped', () => {
  const f = fixture();
  f.meter.startHook = () => { throw new Error('synthetic hook failure'); };
  assert.throws(() => f.meter.start(), /synthetic hook failure/);
  assert.equal(f.source.eventNames().length, 0);
  assert.deepEqual(f.meter.stop(), []);
});

test('stopped sampler ignores events; repeated start and stop do not duplicate listeners', () => {
  const f = fixture(); f.source.emit('keydown', {keycode: 1});
  f.meter.start(); f.meter.start();
  assert.equal(f.source.listenerCount('keydown'), 1);
  f.source.emit('keydown', {keycode: 1});
  f.meter.stop(121_025); f.source.emit('keydown', {keycode: 1});
  assert.equal(f.source.listenerCount('keydown'), 0);
  assert.equal(f.hooks().starts, 1); assert.equal(f.hooks().stops, 1);
});
