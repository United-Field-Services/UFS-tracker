import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send, isoDate } from './ctx.ts';
import type { Row } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError, audit, currentUser, requireRole } from './auth.ts';
import { csvCell } from './routes-reports.ts';

const HOUR = 3_600_000;
const money = (cents: number) => (cents / 100).toFixed(2);

/** Pay-rate history and a payroll export of APPROVED time only. Owners/admins set rates; HR can view and export. */
export function payrollRoutes(ctx: Ctx) {
  const r = Router();
  const view = requireRole('owner', 'admin', 'hr');

  const rateOut = (x: Row) => ({ id: x.id, userId: x.user_id, hourlyRate: money(x.hourly_cents), currency: x.currency, effectiveFrom: x.effective_from, createdAt: x.created_at });
  /** The rate in force on a UTC date (latest effective_from on or before it). */
  const rateOn = (rates: Row[], date: string) => { let found: Row | undefined; for (const x of rates) if (x.effective_from <= date) found = x; return found; };

  r.get('/api/payroll/rates', view, (req, res) => {
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId) return send(res, 200, { rates: (ctx.db.prepare('SELECT * FROM pay_rates WHERE user_id = ? ORDER BY effective_from DESC, created_at DESC').all(userId) as Row[]).map(rateOut) });
    const today = new Date(ctx.cfg.now()).toISOString().slice(0, 10);
    const users = ctx.db.prepare('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all() as Row[];
    const all = ctx.db.prepare('SELECT * FROM pay_rates ORDER BY effective_from, created_at').all() as Row[];
    send(res, 200, { people: users.map(u => { const mine = all.filter(x => x.user_id === u.id); const cur = rateOn(mine, today); return { userId: u.id, name: u.name, email: u.email, role: u.role, current: cur ? rateOut(cur) : null, changes: mine.length }; }) });
  });

  r.post('/api/payroll/rates', requireRole('owner', 'admin'), (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ userId: z.string().min(1).max(64), hourlyRate: z.number().min(0).max(10_000), currency: z.string().regex(/^[A-Z]{3}$/), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(), req.body);
    if (!Number.isFinite(Date.parse(`${b.effectiveFrom}T00:00:00Z`))) throw new HttpError(400, 'effectiveFrom must be a real date.');
    if (b.userId === u.id && u.role !== 'owner') throw new HttpError(403, 'Another admin must set your own pay rate.');
    if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(b.userId)) throw new HttpError(404, 'Person not found.');
    const cents = Math.round(b.hourlyRate * 100);
    const id = crypto.randomUUID();
    ctx.db.prepare('DELETE FROM pay_rates WHERE user_id = ? AND effective_from = ?').run(b.userId, b.effectiveFrom); // one rate per start date: the newest entry replaces it
    ctx.db.prepare('INSERT INTO pay_rates (id,user_id,hourly_cents,currency,effective_from,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, b.userId, cents, b.currency, b.effectiveFrom, u.id, nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, u.id, 'payroll.rate_set', 'user', b.userId, { currency: b.currency, effectiveFrom: b.effectiveFrom });  // the amount itself is not copied into the audit log
    send(res, 201, { id });
  });

  r.get('/api/payroll/export', view, (req, res) => {
    const u = currentUser(res);
    const from = isoDate(req.query.from, 'from'), to = isoDate(req.query.to, 'to');
    if (Date.parse(to) <= Date.parse(from)) throw new HttpError(400, 'to must be after from.');
    if (Date.parse(to) - Date.parse(from) > 93 * 86_400_000) throw new HttpError(400, 'Choose a range of at most 93 days.');
    const format = String(req.query.format ?? 'json'); if (!['json', 'csv'].includes(format)) throw new HttpError(400, 'format must be json or csv.');
    const entries = ctx.db.prepare(`SELECT e.user_id, e.start_at, e.tracked_ms, e.status, u.name, u.email FROM time_entries e JOIN users u ON u.id = e.user_id WHERE e.end_at IS NOT NULL AND e.start_at >= ? AND e.start_at < ? ORDER BY u.name COLLATE NOCASE, e.start_at`).all(from, to) as Row[];
    const rates = new Map<string, Row[]>(); for (const x of ctx.db.prepare('SELECT * FROM pay_rates ORDER BY effective_from, created_at').all() as Row[]) { (rates.get(x.user_id) ?? rates.set(x.user_id, []).get(x.user_id)!).push(x); }
    type Line = { userId: string; name: string; email: string; approvedMs: number; pendingMs: number; rejectedMs: number; amounts: Map<string, { currency: string; hourlyCents: number; ms: number; cents: number }>; missingRate: boolean };
    const people = new Map<string, Line>();
    for (const e of entries) {
      const line = people.get(e.user_id) ?? { userId: e.user_id, name: e.name, email: e.email, approvedMs: 0, pendingMs: 0, rejectedMs: 0, amounts: new Map(), missingRate: false };
      people.set(e.user_id, line);
      if (e.status === 'pending') { line.pendingMs += e.tracked_ms; continue; }
      if (e.status === 'rejected') { line.rejectedMs += e.tracked_ms; continue; }
      line.approvedMs += e.tracked_ms;
      const rate = rateOn(rates.get(e.user_id) ?? [], String(e.start_at).slice(0, 10));
      if (!rate) { line.missingRate = true; continue; }
      const key = `${rate.currency}:${rate.hourly_cents}`; const part = line.amounts.get(key) ?? { currency: rate.currency, hourlyCents: rate.hourly_cents, ms: 0, cents: 0 };
      part.ms += e.tracked_ms; part.cents += Math.round(e.tracked_ms / HOUR * rate.hourly_cents); line.amounts.set(key, part);
    }
    const rows = [...people.values()].map(l => ({
      userId: l.userId, name: l.name, email: l.email, approvedHours: Math.round(l.approvedMs / HOUR * 100) / 100, pendingHours: Math.round(l.pendingMs / HOUR * 100) / 100, rejectedHours: Math.round(l.rejectedMs / HOUR * 100) / 100, missingRate: l.missingRate,
      lines: [...l.amounts.values()].map(a => ({ currency: a.currency, hourlyRate: money(a.hourlyCents), hours: Math.round(a.ms / HOUR * 100) / 100, amount: money(a.cents) })),
    }));
    const totals: Record<string, string> = {}; const cents: Record<string, number> = {};
    for (const l of people.values()) for (const a of l.amounts.values()) cents[a.currency] = (cents[a.currency] ?? 0) + a.cents;
    for (const [c, v] of Object.entries(cents)) totals[c] = money(v);
    audit(ctx.db, ctx.cfg, u.id, 'payroll.exported', 'payroll', undefined, { from, to, format, people: rows.length });
    const note = 'Calculated from APPROVED tracked time and the pay rates entered here. Pending and rejected time is excluded. This is a working sheet, not payroll advice; review it before paying anyone.';
    if (format === 'csv') {
      const lines = [['Name', 'Email', 'Approved hours', 'Rate (per hour)', 'Currency', 'Hours at this rate', 'Amount', 'Pending hours (not included)', 'Note'].map(csvCell).join(',')];
      for (const l of rows) {
        if (!l.lines.length) lines.push([l.name, l.email, l.approvedHours, '', '', '', '', l.pendingHours, l.missingRate ? 'No pay rate set for approved time' : ''].map(csvCell).join(','));
        for (const x of l.lines) lines.push([l.name, l.email, l.approvedHours, x.hourlyRate, x.currency, x.hours, x.amount, l.pendingHours, l.missingRate ? 'Some approved time has no pay rate' : ''].map(csvCell).join(','));
      }
      lines.push('', csvCell(note));
      return void res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="payroll-export.csv"', 'Cache-Control': 'no-store' }).send(lines.join('\r\n') + '\r\n');
    }
    send(res, 200, { from, to, people: rows, totals, missingRateCount: rows.filter(x => x.missingRate).length, note });
  });

  return r;
}
