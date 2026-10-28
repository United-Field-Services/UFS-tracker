import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, giveConsent, iso, MIN, HOUR, T0, type Harness } from './helpers.ts';

let h: Harness;
let tok: Record<string, string>;
const cid = (n: number) => `break-entry-${String(n).padStart(8, '0')}`;
before(async () => {
  h = await setup();
  tok = {};
  for (const k of ['admin', 'mia', 'max', 'ed', 'eve', 'hana']) tok[k] = await h.login(`${k}@test.example`);
  giveConsent(h, 'ed', 'eve');
});
after(async () => { await h.stop(); });

const sync = (token: string, n: number, over: Record<string, unknown> = {}) =>
  h.call('POST', '/api/time-entries/sync', { token, body: { clientId: cid(n), taskLabel: 'Work', mode: 'company', startAt: iso(T0 - 3 * HOUR), endAt: null, trackedMs: 30 * MIN, idleMs: 0, ...over } });
const brk = (fromMin: number, toMin: number | null) => ({ startAt: iso(T0 - 3 * HOUR + fromMin * MIN), endAt: toMin === null ? null : iso(T0 - 3 * HOUR + toMin * MIN) });
const stored = () => h.db.prepare('SELECT entry_client_id, start_at, end_at FROM breaks ORDER BY start_at').all() as any[];

test('breaks arrive with the company time entry, repeat syncs change nothing and an open break is closed later', async () => {
  const first = await sync(tok.ed, 1, { breaks: [brk(30, 40), brk(60, null)] });
  assert.equal(first.status, 201); assert.equal(first.json.ignoredBreaks, undefined);
  assert.equal(stored().length, 2); assert.equal(stored()[1].end_at, null);
  assert.equal((await sync(tok.ed, 1, { breaks: [brk(30, 40), brk(60, null)], trackedMs: 30 * MIN })).status, 200);
  assert.equal(stored().length, 2, 'a repeat does not duplicate');
  const closed = await sync(tok.ed, 1, { breaks: [brk(30, 40), brk(60, 75)], trackedMs: 40 * MIN });
  assert.equal(closed.status, 200); assert.equal(stored()[1].end_at, iso(T0 - 3 * HOUR + 75 * MIN), 'the open break is closed');
  await sync(tok.ed, 1, { breaks: [brk(30, 50)], trackedMs: 41 * MIN });
  assert.equal(stored()[0].end_at, iso(T0 - 3 * HOUR + 40 * MIN), 'a closed break is never rewritten');
  // finishing the entry keeps the breaks and a retry of the finished entry is accepted
  const done = await sync(tok.ed, 1, { breaks: [brk(30, 40), brk(60, 75)], trackedMs: 45 * MIN, endAt: iso(T0 - 2 * HOUR) });
  assert.equal(done.status, 200); assert.equal((await sync(tok.ed, 1, { breaks: [brk(30, 40), brk(60, 75)], trackedMs: 45 * MIN, endAt: iso(T0 - 2 * HOUR) })).json.duplicate, true);
  assert.equal(stored().length, 2);
});

test('implausible breaks are ignored and reported without failing the time sync', async () => {
  const r = await sync(tok.eve, 2, { breaks: [
    { startAt: iso(T0 - 5 * HOUR), endAt: iso(T0 - 5 * HOUR + 10 * MIN) },            // before the entry began
    { startAt: iso(T0 - 3 * HOUR + 10 * MIN), endAt: iso(T0 - 3 * HOUR + 5 * MIN) },   // ends before it starts
    { startAt: iso(T0 - 3 * HOUR + 10 * MIN), endAt: iso(T0 + 2 * HOUR) },             // runs past the entry (and over 12 h is covered below)
    { startAt: 'not a date' },
    brk(20, 25),                                                                      // the only valid one
  ] });
  assert.equal(r.status, 201); assert.equal(r.json.ignoredBreaks, 4);
  assert.deepEqual(stored().filter(b => b.entry_client_id === cid(2)).map(b => b.start_at), [iso(T0 - 3 * HOUR + 20 * MIN)]);
  assert.equal((await sync(tok.eve, 3, { breaks: Array.from({ length: 201 }, () => brk(1, 2)) })).status, 400, 'at most 200 per entry');
  assert.equal((await sync(tok.eve, 3, { breaks: [{ startAt: iso(T0), endAt: null, secret: 'x' }] })).status, 400, 'no extra fields');
  assert.equal((await sync(tok.eve, 4)).status, 201, 'entries without breaks still work (older apps)');
});

test('breaks on a reviewed or edited entry are not changed', async () => {
  await sync(tok.ed, 5, { breaks: [{ startAt: iso(T0 - 2 * HOUR + 10 * MIN), endAt: iso(T0 - 2 * HOUR + 15 * MIN) }], startAt: iso(T0 - 2 * HOUR), endAt: iso(T0 - HOUR) });
  const entry = h.db.prepare("SELECT id FROM time_entries WHERE client_id = ?").get(cid(5)) as any;
  assert.equal((await h.call('POST', `/api/time-entries/${entry.id}/approve`, { token: tok.mia, body: {} })).status, 200);
  const before = stored().length;
  const locked = await sync(tok.ed, 5, { breaks: [{ startAt: iso(T0 - 2 * HOUR + 30 * MIN), endAt: iso(T0 - 2 * HOUR + 40 * MIN) }], startAt: iso(T0 - 2 * HOUR), endAt: iso(T0 - HOUR) });
  assert.equal(locked.json.locked, true); assert.equal(stored().length, before, 'an approved entry takes no new breaks');
});

test('day view and team summary show breaks with the usual visibility; the person can export them; deleting the entry removes them', async () => {
  const day = await h.call('GET', `/api/timeline?userId=${h.users.ed!.id}&date=2026-10-22`, { token: tok.mia });
  assert.equal(day.status, 200); assert.equal(day.json.breaks.length >= 2, true);
  assert.equal(day.json.breaks[0].open, false); assert.equal(day.json.totals.breaks, day.json.breaks.length);
  assert.ok(day.json.totals.breakMs >= 10 * MIN + 15 * MIN, 'closed breaks are summed');
  assert.equal((await h.call('GET', `/api/timeline?userId=${h.users.ed!.id}&date=2026-10-22`, { token: tok.eve })).status, 403, 'a colleague cannot see breaks');
  const team = (await h.call('GET', '/api/team/summary', { token: tok.mia })).json.people;
  const ed = team.find((p: any) => p.name === 'Ed'); assert.ok(ed.breakMs >= 30 * MIN && ed.breaks >= 3, JSON.stringify(ed));
  assert.equal((await h.call('GET', '/api/team/summary', { token: tok.ed })).json.people[0].breaks >= 3, true, 'you see your own');
  const mine = (await h.call('GET', '/api/me/export', { token: tok.ed })).json; assert.ok(mine.breaks.length >= 3); assert.deepEqual(Object.keys(mine.breaks[0]).sort(), ['endAt', 'startAt']);
  // an open break counts up to now (capped at 12 h) and is flagged open
  await sync(tok.ed, 6, { breaks: [brk(150, null)], startAt: iso(T0 - 3 * HOUR) , trackedMs: 10 * MIN });
  const withOpen = (await h.call('GET', `/api/timeline?userId=${h.users.ed!.id}&date=2026-10-22`, { token: tok.ed })).json;
  assert.ok(withOpen.breaks.some((b: any) => b.open), 'the running break is flagged open');
  // removing the time entry removes its breaks
  const row = h.db.prepare('SELECT id FROM time_entries WHERE client_id = ?').get(cid(1)) as any;
  const inBefore = (h.db.prepare('SELECT COUNT(*) c FROM breaks WHERE entry_client_id = ?').get(cid(1)) as any).c; assert.ok(inBefore >= 1);
  assert.equal((await h.call('DELETE', `/api/time-entries/${row.id}`, { token: tok.admin })).status, 200);
  assert.equal((h.db.prepare('SELECT COUNT(*) c FROM breaks WHERE entry_client_id = ?').get(cid(1)) as any).c, 0);
});
