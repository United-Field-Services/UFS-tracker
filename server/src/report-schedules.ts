import type { Ctx } from './ctx.ts';
import type { Row } from './db.ts';
import type { AuthUser, Role } from './auth.ts';
import { audit, visibleUserIds } from './auth.ts';
import { notify } from './notifications.ts';
import { addDateDays, localDateTime, localDateTimeToMs } from './timezone.ts';

export type ReportKind = 'team-hours' | 'approvals' | 'my-hours';
/** Which roles may subscribe to which report. Content always follows the subscriber's own visibility (what they could open in the dashboard). */
export const REPORT_ROLES: Record<ReportKind, Role[]> = {
  'my-hours': ['owner', 'admin', 'hr', 'manager', 'employee'],
  'team-hours': ['owner', 'admin', 'hr', 'manager'],
  approvals: ['owner', 'admin', 'manager'],
};
export const REPORT_TITLES: Record<ReportKind, string> = { 'my-hours': 'Your weekly hours', 'team-hours': 'Weekly team hours', approvals: 'Time waiting for your approval' };

const HOUR = 3_600_000;
const hm = (ms: number) => { const m = Math.round(ms / 60_000); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

interface Built { title: string; body: string; emailBody: string; empty: boolean }

/** The seven full local days before `today` (in the subscriber's timezone) as [fromIso, toIso) plus a label. */
function lastWeek(today: string, timeZone: string) {
  const from = addDateDays(today, -7);
  return { fromMs: localDateTimeToMs(from, '00:00', timeZone), toMs: localDateTimeToMs(today, '00:00', timeZone), label: `${from} to ${addDateDays(today, -1)}` };
}

export function buildReport(ctx: Ctx, kind: ReportKind, user: AuthUser, timeZone: string, nowMs: number): Built {
  const today = localDateTime(nowMs, timeZone).date;
  const week = lastWeek(today, timeZone); const fromIso = new Date(week.fromMs).toISOString(), toIso = new Date(week.toMs).toISOString();
  const footer = 'Idle time is an input estimate. Nothing here is a productivity, attendance or pay measure.';
  if (kind === 'approvals') {
    const visible = visibleUserIds(ctx.db, user);
    const rows = (ctx.db.prepare("SELECT e.user_id, u.name, COUNT(*) c, MIN(e.start_at) oldest FROM time_entries e JOIN users u ON u.id = e.user_id WHERE e.status = 'pending' AND e.end_at IS NOT NULL AND u.active = 1 GROUP BY e.user_id ORDER BY c DESC, u.name COLLATE NOCASE").all() as Row[])
      .filter(r => (visible === null || visible.has(r.user_id)) && (r.user_id !== user.id || user.role === 'owner'));
    const total = rows.reduce((t, r) => t + Number(r.c), 0);
    const lines = rows.map(r => `- ${r.name}: ${r.c} ${Number(r.c) === 1 ? 'entry' : 'entries'} (oldest ${String(r.oldest).slice(0, 10)})`);
    return { title: `${REPORT_TITLES[kind]}: ${total}`, body: lines.slice(0, 5).join('\n'), emailBody: [`${total} time ${total === 1 ? 'entry is' : 'entries are'} waiting for your approval.`, '', ...lines, '', 'Open Timesheets in the dashboard to review them.'].join('\n'), empty: total === 0 };
  }
  const people = kind === 'my-hours' ? [user.id] : (() => { const v = visibleUserIds(ctx.db, user); return (ctx.db.prepare('SELECT id FROM users WHERE active = 1').all() as Row[]).map(r => r.id).filter(id => v === null || v.has(id)); })();
  const names = new Map((ctx.db.prepare('SELECT id, name FROM users').all() as Row[]).map(r => [r.id, r.name]));
  const entries = ctx.db.prepare("SELECT user_id, tracked_ms, idle_ms FROM time_entries WHERE status != 'rejected' AND start_at >= ? AND start_at < ?").all(fromIso, toIso) as Row[];
  const pending = new Map((ctx.db.prepare("SELECT user_id, COUNT(*) c FROM time_entries WHERE status = 'pending' AND end_at IS NOT NULL GROUP BY user_id").all() as Row[]).map(r => [r.user_id, Number(r.c)]));
  const breaks = new Map<string, number>();
  for (const b of ctx.db.prepare('SELECT user_id, start_at, end_at FROM breaks WHERE start_at >= ? AND start_at < ? AND end_at IS NOT NULL').all(fromIso, toIso) as Row[]) breaks.set(b.user_id, (breaks.get(b.user_id) ?? 0) + Date.parse(b.end_at) - Date.parse(b.start_at));
  const per = people.map(id => { let tracked = 0, idle = 0; for (const e of entries) if (e.user_id === id) { tracked += e.tracked_ms; idle += e.idle_ms; } return { id, name: names.get(id) ?? 'Unknown', tracked, idle, breaks: breaks.get(id) ?? 0, pending: pending.get(id) ?? 0 }; })
    .filter(p => p.tracked > 0 || p.pending > 0).sort((a, b) => b.tracked - a.tracked || a.name.localeCompare(b.name));
  const total = per.reduce((t, p) => t + p.tracked, 0);
  const lines = per.map(p => `- ${p.name}: ${hm(p.tracked)} tracked${p.breaks ? `, ${hm(p.breaks)} in breaks` : ''}${p.pending ? `, ${p.pending} waiting for approval` : ''}`);
  const title = `${REPORT_TITLES[kind]} (${week.label})`;
  return { title, body: kind === 'my-hours' ? `${hm(total)} tracked.${per[0]?.pending ? ` ${per[0].pending} entries waiting for approval.` : ''}` : `${per.length} people, ${hm(total)} tracked.\n${lines.slice(0, 3).join('\n')}`,
    emailBody: [title, '', kind === 'my-hours' ? `You tracked ${hm(total)}.` : `${per.length} people, ${hm(total)} tracked in total.`, '', ...(kind === 'my-hours' ? lines : lines.slice(0, 200)), '', footer].join('\n'), empty: per.length === 0 && total === 0 };
}

/** Sends one subscription's report now (in-app, and by email when a mailer exists). Returns false when there was nothing to report. */
export function deliverReport(ctx: Ctx, sub: Row, nowMs: number, opts: { sendEmpty?: boolean } = {}): boolean {
  const user = ctx.db.prepare('SELECT id, email, name, role, manager_id, team_id, active FROM users WHERE id = ?').get(sub.user_id) as Row | undefined;
  if (!user || !user.active || !REPORT_ROLES[sub.kind as ReportKind]?.includes(user.role)) return false;
  const actor = { id: user.id, email: user.email, name: user.name, role: user.role, managerId: user.manager_id, teamId: user.team_id, mustChangePassword: false, sessionHash: '', sessionKind: 'web' } as AuthUser;
  const built = buildReport(ctx, sub.kind, actor, sub.time_zone, nowMs);
  if (built.empty && !opts.sendEmpty) return false;
  notify(ctx, [user.id], { kind: `report.${sub.kind}`, title: built.title, body: built.body, emailBody: built.emailBody, forceEmail: true, link: sub.kind === 'my-hours' ? 'timeline' : sub.kind === 'approvals' ? 'timesheets' : 'team' });
  audit(ctx.db, ctx.cfg, user.id, 'report.sent', 'report', sub.kind, { scheduled: !opts.sendEmpty });
  return true;
}

/** Called every few minutes: sends each due weekly report once (the first run on or after the chosen weekday and hour in the subscriber's timezone). */
export function runDueReports(ctx: Ctx, nowMs = ctx.cfg.now()): number {
  let sent = 0;
  for (const sub of ctx.db.prepare('SELECT * FROM report_subscriptions').all() as Row[]) {
    try {
      const local = localDateTime(nowMs, sub.time_zone);
      if (local.weekday !== sub.weekday || local.minute < sub.hour * 60 || sub.last_period === local.date) continue;
      ctx.db.prepare('UPDATE report_subscriptions SET last_period = ? WHERE id = ?').run(local.date, sub.id); // mark first: a crash must not cause a double send
      if (deliverReport(ctx, sub, nowMs)) sent++;
    } catch (error) { console.error('A scheduled report failed:', (error as Error).message); }
  }
  return sent;
}
void HOUR;
