'use strict';
// Break records travel with the company time entry. These tests reuse the sync and main-process fixtures' patterns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the sync payload carries the breaks derived from the session events', () => {
  const {breaksOf} = require('../src/breaks.cjs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sync.cjs'), 'utf8');
  assert.match(source, /require\('\.\/breaks\.cjs'\)/); assert.match(source, /breaks: breaksOf\(session\.events, session\.endedAt \?\? null\)/);
  const events = [{at: '2026-10-29T09:10:00.000Z', type: 'paused', kind: 'break'}, {at: '2026-10-29T09:15:00.000Z', type: 'tracking-started'}];
  assert.deepEqual(breaksOf(events, null), [{startAt: '2026-10-29T09:10:00.000Z', endAt: '2026-10-29T09:15:00.000Z'}]);
});

test('the break button and the break reminder ask for a break pause; the main process only honours it in a tracking company session', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(main, /value\?\.break === true && tracker\.current\?\.mode === 'company' && tracker\.phase === 'tracking'/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(renderer, /\$\('break'\)\.addEventListener\('click'[^\n]*api\.pause\(\{break: true\}\)/);
  assert.match(renderer, /\$\('break'\)\.hidden = !\(company && active\)/);
  assert.match(renderer, /await api\.pause\(\{break: true\}\)/, 'the break reminder records a break');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="break"[^>]*hidden/); assert.doesNotMatch(html, /https?:\/\//);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf8');
  assert.match(preload, /pause: value => invoke\('pause', value\)/);
  void vm;
});
