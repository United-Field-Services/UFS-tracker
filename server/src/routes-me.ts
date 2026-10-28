import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send } from './ctx.ts';
import type { Row } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError, audit, currentUser, requireRole } from './auth.ts';
import { effectivePolicy } from './policy.ts';
import { notify, ownersAndAdmins } from './notifications.ts';
import { REPORT_ROLES, REPORT_TITLES, deliverReport, type ReportKind } from './report-schedules.ts';
import { validTimeZone } from './timezone.ts';

const note = (n: Row) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, readAt: n.read_at });

/** Notifications, "My data" (export and deletion requests) and the admin queue for those requests. */
export function meRoutes(ctx: Ctx) {
  const r = Router();
  const now = () => nowIso(ctx.cfg.now());

  // ---------- notifications ----------
  r.get('/api/notifications', (req, res) => {
    const u = currentUser(res);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
    const unreadOnly = req.query.unread === '1';
    const rows = ctx.db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`).all(u.id, limit) as Row[];
    const unread = Number((ctx.db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(u.id) as Row).c);
    const settings = ctx.db.prepare('SELECT notify_email FROM users WHERE id = ?').get(u.id) as Row;
    send(res, 200, { notifications: rows.map(note), unread, settings: { email: !!settings.notify_email, emailDelivery: false /* no mail provider is configured yet */ } });
  });
  r.post('/api/notifications/read', (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ ids: z.array(z.number().int()).max(200).optional(), all: z.boolean().optional() }).strict(), req.body);
    if (!b.all && !b.ids?.length) throw new HttpError(400, 'Choose notifications to mark as read.');
    const result = b.all ? ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), u.id)
      : ctx.db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${b.ids!.map(() => '?').join(',')})`).run(now(), u.id, ...b.ids!);
    send(res, 200, { marked: Number(result.changes) });
  });
  r.put('/api/me/notification-settings', (req, res) => {
    const u = currentUser(res);
    const { email } = parse(z.object({ email: z.boolean() }).strict(), req.body);
    ctx.db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(email ? 1 : 0, u.id);
    send(res, 200, { email });
  });

  // ---------- weekly report subscriptions ----------
  const subOut = (x: Row) => ({ id: x.id, kind: x.kind, title: REPORT_TITLES[x.kind as ReportKind], weekday: x.weekday, hour: x.hour, timeZone: x.time_zone, lastSentOn: x.last_period });
  r.get('/api/report-subscriptions', (_req, res) => {
    const u = currentUser(res);
    send(res, 200, {
      subscriptions: (ctx.db.prepare('SELECT * FROM report_subscriptions WHERE user_id = ? ORDER BY kind').all(u.id) as Row[]).map(subOut),
      available: (Object.keys(REPORT_ROLES) as ReportKind[]).filter(k => REPORT_ROLES[k].includes(u.role)).map(k => ({ kind: k, title: REPORT_TITLES[k] })),
      emailDelivery: false, // no mail provider is configured yet; reports arrive under the bell until then
    });
  });
  r.post('/api/report-subscriptions', (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ kind: z.enum(['team-hours', 'approvals', 'my-hours']), weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), timeZone: z.string().max(60) }).strict(), req.body);
    if (!validTimeZone(b.timeZone)) throw new HttpError(400, 'timeZone must be a valid IANA timezone, for example America/New_York.');
    if (!REPORT_ROLES[b.kind].includes(u.role)) throw new HttpError(403, 'This report is not available for your role.');
    const existing = ctx.db.prepare('SELECT id FROM report_subscriptions WHERE user_id = ? AND kind = ?').get(u.id, b.kind) as Row | undefined;
    if (existing) { ctx.db.prepare('UPDATE report_subscriptions SET weekday = ?, hour = ?, time_zone = ?, last_period = NULL WHERE id = ?').run(b.weekday, b.hour, b.timeZone, existing.id); audit(ctx.db, ctx.cfg, u.id, 'report.subscription_changed', 'report', b.kind); return send(res, 200, { id: existing.id, updated: true }); }
    const id = crypto.randomUUID();
    ctx.db.prepare('INSERT INTO report_subscriptions (id,user_id,kind,weekday,hour,time_zone,created_at) VALUES (?,?,?,?,?,?,?)').run(id, u.id, b.kind, b.weekday, b.hour, b.timeZone, now());
    audit(ctx.db, ctx.cfg, u.id, 'report.subscribed', 'report', b.kind);
    send(res, 201, { id });
  });
  r.delete('/api/report-subscriptions/:id', (req, res) => {
    const u = currentUser(res);
    const result = ctx.db.prepare('DELETE FROM report_subscriptions WHERE id = ? AND user_id = ?').run(String(req.params.id), u.id);
    if (!result.changes) throw new HttpError(404, 'Subscription not found.');
    audit(ctx.db, ctx.cfg, u.id, 'report.unsubscribed', 'report', String(req.params.id));
    send(res, 200, { ok: true });
  });
  r.post('/api/report-subscriptions/:id/send-now', (req, res) => {
    const u = currentUser(res);
    const sub = ctx.db.prepare('SELECT * FROM report_subscriptions WHERE id = ? AND user_id = ?').get(String(req.params.id), u.id) as Row | undefined;
    if (!sub) throw new HttpError(404, 'Subscription not found.');
    send(res, 200, { sent: deliverReport(ctx, sub, ctx.cfg.now(), { sendEmpty: true }) });
  });

  // ---------- my data: export ----------
  r.get('/api/me/export', (_req, res) => {
    const u = currentUser(res);
    const user = ctx.db.prepare('SELECT u.*, t.name team_name, m.name manager_name FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN users m ON m.id = u.manager_id WHERE u.id = ?').get(u.id) as Row;
    const entries = (ctx.db.prepare('SELECT e.*, p.name project_name, rv.name reviewer FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN users rv ON rv.id = e.reviewed_by WHERE e.user_id = ? ORDER BY e.start_at').all(u.id) as Row[])
      .map(e => ({ id: e.id, startAt: e.start_at, endAt: e.end_at, trackedMs: e.tracked_ms, idleMsEstimate: e.idle_ms, status: e.status, source: e.source, project: e.project_name, taskLabel: e.task_label, note: e.note, editedByReviewer: !!e.edited, reviewedBy: e.reviewer, reviewedAt: e.reviewed_at }));
    const activity = (ctx.db.prepare('SELECT utc_date, SUM(slice_count) slices, SUM(duration_seconds) sampled, SUM(active_seconds) active, SUM(keyboard_count) keys, SUM(mouse_count) clicks FROM activity_daily_rollups WHERE user_id = ? GROUP BY utc_date ORDER BY utc_date').all(u.id) as Row[])
      .map(a => ({ utcDate: a.utc_date, sampledMinuteSlices: a.slices, sampledSeconds: a.sampled, activeSeconds: a.active, keyDownCount: a.keys, mouseClickCount: a.clicks }));
    const shots = (ctx.db.prepare('SELECT id, taken_at, width, height, bytes, file_name FROM screenshots WHERE user_id = ? AND deleted_at IS NULL ORDER BY taken_at').all(u.id) as Row[])
      .map(s => ({ id: s.id, takenAt: s.taken_at, width: s.width, height: s.height, bytes: s.bytes, format: String(s.file_name).endsWith('.webp') ? 'webp' : 'png' }));
    const access = (ctx.db.prepare(`SELECT a.at, a.action, x.name actor FROM audit_log a LEFT JOIN users x ON x.id = a.actor_id
      WHERE (a.action = 'screenshot.viewed' AND a.detail LIKE ?) OR (a.action = 'activity.viewed' AND a.target_id IN (SELECT id FROM time_entries WHERE user_id = ?)) ORDER BY a.id DESC LIMIT 1000`).all(`%"ownerId":"${u.id}"%`, u.id) as Row[])
      .map(a => ({ at: a.at, what: a.action === 'screenshot.viewed' ? 'viewed one of your screenshots' : 'viewed your activity estimate', by: a.actor ?? 'system' }));
    const devices = (ctx.db.prepare("SELECT device_name, created_at, last_seen_at, revoked_at FROM sessions WHERE user_id = ? AND kind = 'device' ORDER BY created_at").all(u.id) as Row[]).map(d => ({ name: d.device_name, signedInAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at }));
    const body = {
      exportedAt: now(),
      about: 'Everything this tracker holds about you, except the screenshot images themselves (download those one by one from Screenshots). Time entries are kept for payroll even after you ask to delete your screenshots and activity data.',
      profile: { id: user.id, email: user.email, name: user.name, role: user.role, team: user.team_name, manager: user.manager_name, signIn: user.source === 'directory' ? 'UFS People' : 'tracker account', createdAt: user.created_at, acceptedNoticeVersion: user.consent_version, acceptedNoticeAt: user.consent_at },
      policyThatAppliesToYou: effectivePolicy(ctx.db, u),
      timeEntries: entries, breaks: (ctx.db.prepare('SELECT start_at, end_at FROM breaks WHERE user_id = ? ORDER BY start_at').all(u.id) as Row[]).map(b => ({ startAt: b.start_at, endAt: b.end_at })), activityDailyCounts: activity, screenshots: shots, whoLookedAtYourData: access, devices,
    };
    audit(ctx.db, ctx.cfg, u.id, 'me.exported', 'user', u.id, { entries: entries.length, screenshots: shots.length });
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="my-tracker-data-${now().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' }).send(JSON.stringify(body, null, 2));
  });

  // ---------- my data: deletion requests ----------
  const requestOut = (x: Row) => ({ id: x.id, userId: x.user_id, userName: x.user_name, note: x.note, status: x.status, createdAt: x.created_at, resolvedAt: x.resolved_at, resolutionNote: x.resolution_note, resolvedBy: x.resolver });
  const REQUEST_SELECT = 'SELECT d.*, u.name user_name, rv.name resolver FROM data_requests d JOIN users u ON u.id = d.user_id LEFT JOIN users rv ON rv.id = d.resolved_by';
  r.get('/api/me/data-requests', (_req, res) => {
    const u = currentUser(res);
    send(res, 200, { requests: (ctx.db.prepare(`${REQUEST_SELECT} WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT 20`).all(u.id) as Row[]).map(requestOut) });
  });
  r.post('/api/me/data-requests', (req, res) => {
    const u = currentUser(res);
    const { note: text } = parse(z.object({ note: z.string().trim().max(500).optional() }).strict(), req.body ?? {});
    if (ctx.db.prepare("SELECT 1 FROM data_requests WHERE user_id = ? AND status = 'open'").get(u.id)) throw new HttpError(409, 'You already have an open deletion request.');
    const id = crypto.randomUUID();
    ctx.db.prepare("INSERT INTO data_requests (id,user_id,kind,note,status,created_at) VALUES (?,?,'delete',?, 'open', ?)").run(id, u.id, text ?? null, now());
    audit(ctx.db, ctx.cfg, u.id, 'data.delete_requested', 'user', u.id);
    notify(ctx, ownersAndAdmins(ctx).filter(x => x !== u.id), { kind: 'data.delete_requested', title: `${u.name} asked to delete their screenshots and activity data`, body: text, link: 'privacy', dedupe: true });
    send(res, 201, { id });
  });

  // ---------- admin queue for those requests ----------
  r.get('/api/admin/data-requests', requireRole('owner', 'admin', 'hr'), (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['open', 'fulfilled', 'declined'].includes(status)) throw new HttpError(400, 'Invalid status.');
    send(res, 200, { requests: (ctx.db.prepare(`${REQUEST_SELECT} WHERE (? IS NULL OR d.status = ?) ORDER BY d.created_at DESC LIMIT 200`).all(status, status) as Row[]).map(requestOut) });
  });
  r.post('/api/admin/data-requests/:id/resolve', requireRole('owner', 'admin'), async (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ action: z.enum(['fulfil', 'decline']), note: z.string().trim().max(300).optional() }).strict(), req.body);
    const row = ctx.db.prepare('SELECT * FROM data_requests WHERE id = ?').get(String(req.params.id)) as Row | undefined;
    if (!row) throw new HttpError(404, 'Request not found.');
    if (row.status !== 'open') throw new HttpError(409, 'This request was already resolved.');
    if (row.user_id === u.id) throw new HttpError(403, 'Another admin must resolve your own request.');
    if (b.action === 'decline' && !b.note) throw new HttpError(400, 'Say why the request is declined.');
    let removed = { screenshots: 0, activitySlices: 0 };
    if (b.action === 'fulfil') {
      // Screenshots: remove the stored object first, then mark deleted (same order as a normal delete).
      const shots = ctx.db.prepare('SELECT * FROM screenshots WHERE user_id = ? AND deleted_at IS NULL').all(row.user_id) as Row[];
      for (const s of shots) {
        await ctx.store.remove(row.user_id, s.file_name); if (s.thumb_file_name) await ctx.store.remove(row.user_id, s.thumb_file_name);
        ctx.db.prepare('UPDATE screenshots SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), u.id, s.id);
      }
      removed = { screenshots: shots.length, activitySlices: Number(ctx.db.prepare('DELETE FROM activity_slices WHERE user_id = ?').run(row.user_id).changes) };
      ctx.db.prepare('DELETE FROM activity_daily_rollups WHERE user_id = ?').run(row.user_id);
    }
    ctx.db.prepare('UPDATE data_requests SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?').run(b.action === 'fulfil' ? 'fulfilled' : 'declined', u.id, now(), b.note ?? null, row.id);
    audit(ctx.db, ctx.cfg, u.id, b.action === 'fulfil' ? 'data.erased' : 'data.delete_declined', 'user', row.user_id, { requestId: row.id, ...removed, ...(b.note ? { note: b.note } : {}) });
    notify(ctx, [row.user_id], b.action === 'fulfil'
      ? { kind: 'data.erased', title: 'Your screenshots and activity data were deleted', body: `${removed.screenshots} screenshots and ${removed.activitySlices} activity samples were removed. Time entries are kept for payroll.`, link: 'privacy' }
      : { kind: 'data.delete_declined', title: 'Your deletion request was declined', body: b.note, link: 'privacy' });
    send(res, 200, { status: b.action === 'fulfil' ? 'fulfilled' : 'declined', removed });
  });

  return r;
}
