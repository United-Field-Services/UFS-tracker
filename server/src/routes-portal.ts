import { Router } from 'express';
import type { Ctx } from './ctx.ts';
import { send } from './ctx.ts';
import type { Row } from './db.ts';
import { HttpError, audit, currentUser, requireRole } from './auth.ts';
import { effectivePolicy } from './policy.ts';
import { directoryStatus } from './directory.ts';

const MIN = 60_000, DAY = 86_400_000, PRESENCE_FRESH_MS = 90_000;

/** Admin portal: organization-wide numbers for owners, admins and HR. Aggregates only; no screenshot content or key counts. */
export function portalRoutes(ctx: Ctx) {
  const r = Router();
  const count = (sql: string, ...params: any[]) => Number((ctx.db.prepare(sql).get(...params) as Row).c);

  r.get('/api/admin/overview', requireRole('owner', 'admin', 'hr'), (req, res) => {
    const u = currentUser(res);
    const days = Math.min(60, Math.max(7, Math.round(Number(req.query.days ?? 14)) || 14));
    const tz = Math.round(Number(req.query.tzOffsetMinutes ?? 0)) || 0;
    if (tz < -14 * 60 || tz > 14 * 60) throw new HttpError(400, 'tzOffsetMinutes is out of range.');
    const now = ctx.cfg.now();
    const dayKey = (ms: number) => new Date(ms + tz * MIN).toISOString().slice(0, 10);
    const keys: string[] = []; for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * DAY));
    const windowStart = new Date(Date.parse(`${keys[0]}T00:00:00.000Z`) - tz * MIN).toISOString();

    // ---- people ----
    const users = ctx.db.prepare('SELECT id, role, team_id, source, consent_version FROM users WHERE active = 1').all() as Row[];
    const byRole: Record<string, number> = {};
    let withoutConsent = 0, directoryPeople = 0;
    for (const user of users) {
      byRole[user.role] = (byRole[user.role] ?? 0) + 1;
      if (user.source === 'directory') directoryPeople++;
      if ((user.consent_version ?? 0) < effectivePolicy(ctx.db, { id: user.id, teamId: user.team_id }).consentVersion) withoutConsent++;
    }
    const live = { tracking: 0, paused: 0, offline: 0 };
    const presence = new Map((ctx.db.prepare('SELECT user_id, status, last_seen_at FROM presence').all() as Row[]).map(p => [p.user_id, p]));
    for (const user of users) {
      const p = presence.get(user.id);
      const fresh = p && now - Date.parse(p.last_seen_at) <= PRESENCE_FRESH_MS && p.status !== 'stopped';
      if (fresh && p!.status === 'tracking') live.tracking++; else if (fresh && p!.status === 'paused') live.paused++; else live.offline++;
    }

    // ---- time (rejected entries are excluded everywhere) ----
    const entries = ctx.db.prepare(`SELECT e.start_at, e.tracked_ms, e.idle_ms, e.user_id, u.name user_name, e.project_id, p.name project_name
      FROM time_entries e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.status != 'rejected' AND e.start_at >= ? AND u.active = 1`).all(windowStart) as Row[];
    const trend = new Map(keys.map(k => [k, { date: k, trackedMs: 0, idleMs: 0 }]));
    const people = new Map<string, { userId: string; name: string; trackedMs: number }>(), projects = new Map<string, { projectId: string | null; name: string; trackedMs: number }>();
    for (const e of entries) {
      const day = trend.get(dayKey(Date.parse(e.start_at))); if (!day) continue;
      day.trackedMs += e.tracked_ms; day.idleMs += e.idle_ms;
      const person = people.get(e.user_id) ?? { userId: e.user_id, name: e.user_name, trackedMs: 0 }; person.trackedMs += e.tracked_ms; people.set(e.user_id, person);
      const key = e.project_id ?? 'none'; const project = projects.get(key) ?? { projectId: e.project_id ?? null, name: e.project_name ?? 'No project', trackedMs: 0 }; project.trackedMs += e.tracked_ms; projects.set(key, project);
    }
    const trendList = [...trend.values()];
    const top = <T extends { trackedMs: number }>(map: Map<string, T>, n = 8) => [...map.values()].sort((a, b) => b.trackedMs - a.trackedMs).slice(0, n);
    const todayKey = keys[keys.length - 1]!;
    const todayMs = trend.get(todayKey)?.trackedMs ?? 0, last7 = trendList.slice(-7).reduce((t, d) => t + d.trackedMs, 0);

    // ---- approvals ----
    const pending = ctx.db.prepare("SELECT COUNT(*) c, MIN(start_at) oldest FROM time_entries WHERE status = 'pending' AND end_at IS NOT NULL").get() as Row;

    // ---- screenshots and storage ----
    const shots = ctx.db.prepare('SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b, MIN(taken_at) oldest, MAX(taken_at) newest FROM screenshots WHERE deleted_at IS NULL').get() as Row;
    const shotRows = ctx.db.prepare('SELECT taken_at, bytes FROM screenshots WHERE deleted_at IS NULL AND taken_at >= ?').all(windowStart) as Row[];
    const shotTrend = new Map(keys.map(k => [k, { date: k, count: 0, bytes: 0 }]));
    for (const s of shotRows) { const d = shotTrend.get(dayKey(Date.parse(s.taken_at))); if (d) { d.count++; d.bytes += s.bytes; } }
    const topStorage = (ctx.db.prepare(`SELECT s.user_id userId, u.name, COUNT(*) count, SUM(s.bytes) bytes FROM screenshots s JOIN users u ON u.id = s.user_id
      WHERE s.deleted_at IS NULL GROUP BY s.user_id ORDER BY bytes DESC LIMIT 5`).all() as Row[]).map(x => ({ userId: x.userId, name: x.name, count: Number(x.count), bytes: Number(x.bytes) }));
    const orgPolicy = effectivePolicy(ctx.db, { id: '__org__', teamId: null });
    const lastPurge = ctx.db.prepare("SELECT at, detail FROM audit_log WHERE action = 'retention.purged' ORDER BY id DESC LIMIT 1").get() as Row | undefined;

    // ---- devices, audit, directory ----
    const nowIso = new Date(now).toISOString(), staleBefore = new Date(now - 14 * DAY).toISOString();
    const devices = { active: count("SELECT COUNT(*) c FROM sessions WHERE kind = 'device' AND revoked_at IS NULL AND expires_at > ?", nowIso), stale: count("SELECT COUNT(*) c FROM sessions WHERE kind = 'device' AND revoked_at IS NULL AND expires_at > ? AND last_seen_at < ?", nowIso, staleBefore) };
    const dayAgo = new Date(now - DAY).toISOString();
    const auditSummary = { last24h: count('SELECT COUNT(*) c FROM audit_log WHERE at >= ?', dayAgo), views24h: count("SELECT COUNT(*) c FROM audit_log WHERE at >= ? AND action = 'screenshot.viewed'", dayAgo), deletions24h: count("SELECT COUNT(*) c FROM audit_log WHERE at >= ? AND action IN ('screenshot.deleted','screenshot.bulk_deleted','time.deleted')", dayAgo) };
    const directory = directoryStatus(ctx);

    // ---- things that need attention ----
    const alerts: { level: 'warn' | 'info'; text: string; view?: string }[] = [];
    if (Number(pending.c) > 0) alerts.push({ level: 'info', text: `${pending.c} time ${Number(pending.c) === 1 ? 'entry is' : 'entries are'} waiting for approval.`, view: 'timesheets' });
    if (withoutConsent > 0) alerts.push({ level: 'warn', text: `${withoutConsent} ${withoutConsent === 1 ? 'person has' : 'people have'} not accepted the current monitoring notice, so their screenshots and activity are not stored.`, view: 'people' });
    if (directory.enabled && directory.lastSync && directory.lastSync.status !== 'ok') alerts.push({ level: 'warn', text: `The last UFS People directory sync did not apply (${directory.lastSync.status}). Open People to review.`, view: 'people' });
    if (directory.enabled && !directory.lastSuccessAt) alerts.push({ level: 'warn', text: 'The directory has never synced successfully.', view: 'people' });
    if (devices.stale > 0) alerts.push({ level: 'info', text: `${devices.stale} signed-in ${devices.stale === 1 ? 'device has' : 'devices have'} not been seen for 14 days.`, view: 'people' });

    audit(ctx.db, ctx.cfg, u.id, 'admin.overview_viewed', 'org', 'org', { days });
    send(res, 200, {
      generatedAt: nowIso, days, tzOffsetMinutes: tz,
      people: { active: users.length, byRole, live, withoutConsent, fromDirectory: directoryPeople },
      time: { todayMs, last7Ms: last7, trend: trendList, topPeople: top(people), byProject: top(projects) },
      approvals: { pending: Number(pending.c), oldestPendingAt: pending.oldest ?? null },
      screenshots: { total: Number(shots.c), bytes: Number(shots.b), oldestAt: shots.oldest ?? null, newestAt: shots.newest ?? null, trend: [...shotTrend.values()], topStorage, retentionDays: orgPolicy.retentionDays, lastPurgeAt: lastPurge?.at ?? null, imageFormat: orgPolicy.imageFormat },
      devices, audit: auditSummary,
      directory: { enabled: directory.enabled, host: directory.host, lastSuccessAt: directory.lastSuccessAt, lastStatus: directory.lastSync?.status ?? null, counts: directory.counts },
      alerts,
      note: 'Aggregates only. Idle time is an input estimate; none of these numbers is a productivity, attendance or pay measure.',
    });
  });

  return r;
}
