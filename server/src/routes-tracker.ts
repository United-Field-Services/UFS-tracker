import { Router, raw } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send, isoDate } from './ctx.ts';
import { nowIso } from './db.ts';
import type { Row } from './db.ts';
import { HttpError, audit, canSeeUser, currentUser, isAdmin, visibleUserIds, type AuthUser } from './auth.ts';
import { effectivePolicy } from './policy.ts';
import { IMAGE_EXT, IMAGE_MIME, imageKind, inspectScreenshot } from './storage.ts';
import { notify, reviewersOf } from './notifications.ts';
import { emitWebhook } from './webhooks.ts';

const HOUR = 3600_000, DAY = 86400_000;
const PRESENCE_FRESH_MS = 90_000;

const entryOut = (r: Row) => ({
  id: r.id, userId: r.user_id, userName: r.user_name, clientId: r.client_id, projectId: r.project_id, projectName: r.project_name ?? null,
  taskId: r.task_id, taskLabel: r.task_label, source: r.source, mode: r.mode, startAt: r.start_at, endAt: r.end_at,
  trackedMs: r.tracked_ms, idleMs: r.idle_ms, status: r.status, note: r.note, edited: !!r.edited,
  activityTrackedSeconds: r.activity_seconds ?? 0, activityPercent: r.activity_duration_seconds ? Math.round(r.activity_seconds / r.activity_duration_seconds * 100) : null,
  keyboardCount: r.activity_keyboard_count ?? 0, mouseCount: r.activity_mouse_count ?? 0,
  reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, updatedAt: r.updated_at,
});
const ENTRY_SELECT = `SELECT e.*, u.name user_name, p.name project_name,
  COALESCE(a.activity_seconds,0) activity_seconds, COALESCE(a.activity_duration_seconds,0) activity_duration_seconds,
  COALESCE(a.activity_keyboard_count,0) activity_keyboard_count, COALESCE(a.activity_mouse_count,0) activity_mouse_count,
  COALESCE(a.activity_slice_count,0) activity_slice_count
  FROM time_entries e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id
  LEFT JOIN (SELECT user_id, entry_client_id, SUM(active_seconds) activity_seconds, SUM(duration_seconds) activity_duration_seconds,
    SUM(keyboard_count) activity_keyboard_count, SUM(mouse_count) activity_mouse_count, COUNT(*) activity_slice_count FROM activity_slices GROUP BY user_id, entry_client_id) a
    ON a.user_id=e.user_id AND a.entry_client_id=e.client_id`;

export function trackerRoutes(ctx: Ctx) {
  const r = Router();
  const nowMs = () => ctx.cfg.now();

  const requireProjectRefs = (user: AuthUser, projectId?: string | null, taskId?: string | null) => {
    if (projectId) {
      const p = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
      if (!p || !p.active) throw new HttpError(400, 'Project not found or inactive.');
      if (p.team_id && p.team_id !== user.teamId && !isAdmin(user) && user.role !== 'manager') throw new HttpError(403, 'You are not assigned to this project.');
    }
    if (taskId) {
      const t = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
      if (!t || !t.active || t.project_id !== projectId) throw new HttpError(400, 'Task does not belong to the selected project.');
    }
  };

  // ---------- heartbeat & live ----------
  r.post('/api/heartbeat', (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ status: z.enum(['tracking', 'paused', 'stopped']), projectId: z.string().nullable().optional(), taskLabel: z.string().max(120).optional(), trackedMs: z.number().int().min(0).max(2 * DAY).optional(), deviceName: z.string().max(80).optional() }), req.body);
    ctx.db.prepare(`INSERT INTO presence (user_id,status,project_id,task_label,tracked_ms,device_name,last_seen_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, project_id=excluded.project_id, task_label=excluded.task_label, tracked_ms=excluded.tracked_ms, device_name=excluded.device_name, last_seen_at=excluded.last_seen_at`)
      .run(u.id, b.status, b.projectId ?? null, b.taskLabel ?? '', b.trackedMs ?? 0, b.deviceName ?? null, nowIso(nowMs()));
    const policy = effectivePolicy(ctx.db, u);
    const consent = ctx.db.prepare('SELECT consent_version FROM users WHERE id = ?').get(u.id) as Row;
    send(res, 200, { ok: true, policy, needsConsent: (consent.consent_version ?? 0) < policy.consentVersion });
  });

  r.get('/api/team/live', (_req, res) => {
    const u = currentUser(res);
    const visible = visibleUserIds(ctx.db, u);
    const rows = ctx.db.prepare(`SELECT u.id, u.name, u.role, u.team_id, pr.status, pr.project_id, pj.name project_name, pr.task_label, pr.tracked_ms, pr.device_name, pr.last_seen_at
      FROM users u LEFT JOIN presence pr ON pr.user_id = u.id LEFT JOIN projects pj ON pj.id = pr.project_id WHERE u.active = 1 ORDER BY u.name COLLATE NOCASE`).all() as Row[];
    const now = nowMs();
    send(res, 200, { members: rows.filter(x => visible === null || visible.has(x.id)).map(x => {
      const fresh = x.last_seen_at && now - Date.parse(x.last_seen_at) <= PRESENCE_FRESH_MS;
      return { userId: x.id, name: x.name, role: x.role, state: fresh && x.status !== 'stopped' ? x.status : 'offline', projectName: fresh ? x.project_name : null, taskLabel: fresh ? x.task_label : null, trackedMs: fresh ? x.tracked_ms : 0, deviceName: x.device_name, lastSeenAt: x.last_seen_at ?? null };
    }) });
  });

  // ---------- time entries ----------
  const SyncBody = z.object({
    clientId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/), projectId: z.string().nullable().optional(), taskId: z.string().nullable().optional(),
    taskLabel: z.string().trim().max(120).default(''), mode: z.enum(['manual', 'one-hour', 'company']).default('manual'), activityTrackingEnabled: z.boolean().default(false),
    startAt: z.string(), endAt: z.string().nullable().optional(), trackedMs: z.number().int().min(0).max(2 * DAY), idleMs: z.number().int().min(0).max(2 * DAY).default(0),
    breaks: z.array(z.object({ startAt: z.string(), endAt: z.string().nullable().optional() }).strict()).max(200).default([]),
  });
  /** Stores the breaks that belong inside this entry; returns how many were ignored as implausible. An open break is closed once, a closed one never changes. */
  const saveBreaks = (userId: string, clientId: string, entryStartMs: number, entryEndMs: number | null, list: { startAt: string; endAt?: string | null }[]) => {
    let ignored = 0; const limitMs = (entryEndMs ?? nowMs()) + 60_000; const ts = nowIso(nowMs());
    for (const item of list) {
      const s = Date.parse(item.startAt), e = item.endAt ? Date.parse(item.endAt) : null;
      const ok = Number.isFinite(s) && (e === null || Number.isFinite(e)) && s >= entryStartMs - 60_000 && s <= limitMs && (e === null || (e > s && e <= limitMs && e - s <= 12 * HOUR));
      if (!ok) { ignored++; continue; }
      ctx.db.prepare('INSERT INTO breaks (id,user_id,entry_client_id,start_at,end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,entry_client_id,start_at) DO UPDATE SET end_at = excluded.end_at, updated_at = excluded.updated_at WHERE breaks.end_at IS NULL')
        .run(crypto.randomUUID(), userId, clientId, new Date(s).toISOString(), e === null ? null : new Date(e).toISOString(), ts, ts);
    }
    return ignored;
  };
  // Tracker upsert: idempotent by (user, clientId); a finished entry cannot be silently rewritten.
  r.post('/api/time-entries/sync', (req, res) => {
    const u = currentUser(res);
    const b = parse(SyncBody, req.body);
    const startMs = Date.parse(isoDate(b.startAt, 'startAt')), now = nowMs();
    const endMs = b.endAt ? Date.parse(isoDate(b.endAt, 'endAt')) : null;
    if (startMs > now + 5 * 60_000) throw new HttpError(422, 'startAt is in the future.');
    if (startMs < now - 30 * DAY) throw new HttpError(422, 'startAt is too old.');
    if (endMs !== null && endMs < startMs) throw new HttpError(422, 'endAt is before startAt.');
    const elapsed = (endMs ?? now) - startMs;
    if (b.trackedMs > elapsed + 60_000) throw new HttpError(422, 'trackedMs exceeds the elapsed time.');
    if (b.idleMs > b.trackedMs) throw new HttpError(422, 'idleMs exceeds trackedMs.');
    const policy = effectivePolicy(ctx.db, u);
    const userConsent = ctx.db.prepare('SELECT consent_version FROM users WHERE id = ?').get(u.id) as Row;
    if (b.activityTrackingEnabled && b.mode !== 'company') throw new HttpError(400, 'Activity counts are only valid for company sessions.');
    const authorizedActivity = b.activityTrackingEnabled && policy.activityTrackingEnabled && (userConsent.consent_version ?? 0) >= policy.consentVersion;
    if (policy.requireProject && !b.projectId) throw new HttpError(422, 'Your organization requires choosing a project.');
    requireProjectRefs(u, b.projectId, b.taskId);
    const existing = ctx.db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND client_id = ?').get(u.id, b.clientId) as Row | undefined;
    const ts = nowIso(now);
    if (!existing) {
      const id = crypto.randomUUID();
      ctx.db.prepare(`INSERT INTO time_entries (id,user_id,client_id,project_id,task_id,task_label,source,mode,start_at,end_at,tracked_ms,idle_ms,status,activity_enabled,activity_consent_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'tracker',?,?,?,?,?,'pending',?,?,?,?)`).run(id, u.id, b.clientId, b.projectId ?? null, b.taskId ?? null, b.taskLabel, b.mode, new Date(startMs).toISOString(), endMs === null ? null : new Date(endMs).toISOString(), b.trackedMs, b.idleMs, authorizedActivity ? 1 : 0, authorizedActivity ? policy.consentVersion : null, ts, ts);
      const ignoredBreaks = saveBreaks(u.id, b.clientId, startMs, endMs, b.breaks);
      return send(res, 201, { id, created: true, ...(ignoredBreaks ? { ignoredBreaks } : {}) });
    }
    if (existing.status !== 'pending' || existing.edited) return send(res, 200, { id: existing.id, locked: true }); // reviewed/edited by a manager: keep theirs
    if (existing.end_at) {
      const same = endMs !== null && Date.parse(existing.end_at) === endMs && existing.tracked_ms === b.trackedMs;
      if (!same) throw new HttpError(409, 'This entry is already finished.');
      const ignoredBreaks = saveBreaks(u.id, b.clientId, Date.parse(existing.start_at), Date.parse(existing.end_at), b.breaks);
      return send(res, 200, { id: existing.id, duplicate: true, ...(ignoredBreaks ? { ignoredBreaks } : {}) });
    }
    if (b.trackedMs < existing.tracked_ms) return send(res, 200, { id: existing.id, stale: true }); // out-of-order retry
    ctx.db.prepare('UPDATE time_entries SET project_id=?, task_id=?, task_label=?, end_at=?, tracked_ms=?, idle_ms=?, activity_enabled=?, activity_consent_version=?, updated_at=? WHERE id=?')
      .run(b.projectId ?? null, b.taskId ?? null, b.taskLabel, endMs === null ? null : new Date(endMs).toISOString(), b.trackedMs, b.idleMs, authorizedActivity ? 1 : 0, authorizedActivity ? policy.consentVersion : null, ts, existing.id);
    const ignoredBreaks = saveBreaks(u.id, b.clientId, Date.parse(existing.start_at), endMs, b.breaks);
    send(res, 200, { id: existing.id, updated: true, ...(ignoredBreaks ? { ignoredBreaks } : {}) });
  });

  // Aggregate-only activity upload. The client sends one minute slice at a time;
  // this API has no field capable of carrying key identity, text or coordinates.
  const ActivityBody = z.object({
    entryClientId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    slice: z.object({
      startedAt: z.string().datetime({offset: true}),
      durationSeconds: z.number().int().min(1).max(60),
      keyboardCount: z.number().int().min(0).max(10000),
      mouseCount: z.number().int().min(0).max(10000),
      activeSeconds: z.number().int().min(0).max(60),
    }).strict(),
  }).strict();
  r.post('/api/activity-slices/sync', (req, res) => {
    const u = currentUser(res);
    const b = parse(ActivityBody, req.body);
    const consent = ctx.db.prepare('SELECT consent_version FROM users WHERE id = ?').get(u.id) as Row;
    if (b.slice.activeSeconds > b.slice.durationSeconds) throw new HttpError(422, 'Active seconds exceed the slice duration.');
    const entry = ctx.db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND client_id = ?').get(u.id, b.entryClientId) as Row | undefined;
    if (!entry || entry.mode !== 'company') throw new HttpError(404, 'Company time entry not found.');
    if (!entry.activity_enabled || consent.consent_version < entry.activity_consent_version) throw new HttpError(403, 'This session was not authorized to upload activity counts.');
    if (entry.status !== 'pending' || entry.edited) throw new HttpError(409, 'This time entry is locked.');
    const start = Date.parse(isoDate(b.slice.startedAt, 'startedAt'));
    if (start % 60_000 !== 0) throw new HttpError(422, 'Activity slices must begin on a UTC minute boundary.');
    const entryStart = Date.parse(entry.start_at), entryEnd = entry.end_at ? Date.parse(entry.end_at) : nowMs();
    if (start < Math.floor(entryStart / 60_000) * 60_000 || start > entryEnd + 60_000 || start + b.slice.durationSeconds * 1000 > entryEnd + 60_000) throw new HttpError(422, 'Activity slice is outside the time entry.');
    const previous = ctx.db.prepare('SELECT duration_seconds,keyboard_count,mouse_count,active_seconds FROM activity_slices WHERE user_id=? AND entry_client_id=? AND slice_start_at=?').get(u.id, b.entryClientId, new Date(start).toISOString()) as Row | undefined;
    const values = [b.slice.durationSeconds, b.slice.keyboardCount, b.slice.mouseCount, b.slice.activeSeconds];
    if (previous) {
      if (values.every((value, index) => value === [previous.duration_seconds, previous.keyboard_count, previous.mouse_count, previous.active_seconds][index])) return send(res, 200, {duplicate: true});
      throw new HttpError(409, 'This activity minute was already recorded with different counts.');
    }
    ctx.db.prepare('INSERT INTO activity_slices (id,user_id,entry_client_id,slice_start_at,duration_seconds,keyboard_count,mouse_count,active_seconds,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), u.id, b.entryClientId, new Date(start).toISOString(), ...values, nowIso(nowMs()));
    send(res, 201, {created: true});
  });

  r.get('/api/activity-slices', (req, res) => {
    const u = currentUser(res), entryId = String(req.query.entryClientId ?? '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(entryId)) throw new HttpError(400, 'Choose a time entry.');
    const entry = ctx.db.prepare('SELECT id,user_id,client_id FROM time_entries WHERE client_id = ?').get(entryId) as Row | undefined;
    if (!entry) throw new HttpError(404, 'Time entry not found.');
    if (!canSeeUser(ctx.db, u, entry.user_id)) throw new HttpError(403, 'You cannot view this time entry.');
    if (u.role !== 'owner' && entry.user_id !== u.id) audit(ctx.db, ctx.cfg, u.id, 'activity.viewed', 'time_entry', entry.id, {sliceDetails: true});
    const rows = ctx.db.prepare('SELECT slice_start_at,duration_seconds,keyboard_count,mouse_count,active_seconds FROM activity_slices WHERE user_id=? AND entry_client_id=? ORDER BY slice_start_at').all(entry.user_id, entryId) as Row[];
    send(res, 200, {slices: rows.map(row => ({startedAt: row.slice_start_at, durationSeconds: row.duration_seconds, keyboardCount: row.keyboard_count, mouseCount: row.mouse_count, activeSeconds: row.active_seconds, activityPercent: Math.round(row.active_seconds / row.duration_seconds * 100)}))});
  });

  const ManualBody = z.object({ clientId: z.string().uuid().optional(), projectId: z.string().nullable().optional(), taskId: z.string().nullable().optional(), taskLabel: z.string().trim().max(120).default(''), startAt: z.string(), endAt: z.string(), note: z.string().trim().max(500).optional() });
  const checkManualWindow = (startMs: number, endMs: number) => {
    if (endMs <= startMs) throw new HttpError(422, 'End must be after start.');
    if (endMs - startMs > 24 * HOUR) throw new HttpError(422, 'A manual entry cannot be longer than 24 hours.');
    if (endMs > nowMs() + 5 * 60_000) throw new HttpError(422, 'Manual time cannot be in the future.');
    if (startMs < nowMs() - 60 * DAY) throw new HttpError(422, 'Manual time is too old to add.');
  };
  const overlaps = (userId: string, startMs: number, endMs: number, exceptId?: string) =>
    !!ctx.db.prepare(`SELECT 1 FROM time_entries WHERE user_id = ? AND id != ? AND status != 'rejected' AND start_at < ? AND COALESCE(end_at, ?) > ?`).get(userId, exceptId ?? '', new Date(endMs).toISOString(), new Date(endMs).toISOString(), new Date(startMs).toISOString());
  r.post('/api/time-entries', (req, res) => {
    const u = currentUser(res);
    const b = parse(ManualBody, req.body);
    const s = Date.parse(isoDate(b.startAt, 'startAt')), e = Date.parse(isoDate(b.endAt, 'endAt'));
    checkManualWindow(s, e);
    requireProjectRefs(u, b.projectId, b.taskId);
    const clientId = b.clientId ? `manual-${b.clientId}` : null;
    if (clientId) {
      const existing = ctx.db.prepare('SELECT id,project_id,task_id,task_label,start_at,end_at,note,source FROM time_entries WHERE user_id=? AND client_id=?').get(u.id, clientId) as Row | undefined;
      if (existing) {
        const same = existing.source === 'manual' && existing.project_id === (b.projectId ?? null) && existing.task_id === (b.taskId ?? null) && existing.task_label === b.taskLabel && existing.start_at === new Date(s).toISOString() && existing.end_at === new Date(e).toISOString() && existing.note === (b.note ?? null);
        if (!same) throw new HttpError(409, 'This manual-entry request id was already used for different time.');
        return send(res, 200, {id: existing.id, duplicate: true});
      }
    }
    if (overlaps(u.id, s, e)) throw new HttpError(409, 'This time overlaps an existing entry.');
    const id = crypto.randomUUID(), ts = nowIso(nowMs());
    ctx.db.prepare(`INSERT INTO time_entries (id,user_id,client_id,project_id,task_id,task_label,source,start_at,end_at,tracked_ms,idle_ms,status,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'manual',?,?,?,0,'pending',?,?,?)`).run(id, u.id, clientId ?? `manual-${id}`, b.projectId ?? null, b.taskId ?? null, b.taskLabel, new Date(s).toISOString(), new Date(e).toISOString(), e - s, b.note ?? null, ts, ts);
    audit(ctx.db, ctx.cfg, u.id, 'time.manual_added', 'time_entry', id, { ms: e - s });
    notify(ctx, reviewersOf(ctx, u.id), { kind: 'time.manual_pending', title: `${u.name} submitted manual time`, body: `${Math.round((e - s) / 60000)} minutes are waiting for your approval.`, link: 'timesheets' });
    emitWebhook(ctx, 'time.submitted', { entryId: id, userId: u.id, startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString(), trackedMs: e - s, source: 'manual' });
    send(res, 201, { id });
  });

  r.get('/api/time-entries', (req, res) => {
    const u = currentUser(res);
    const from = req.query.from ? isoDate(req.query.from, 'from') : null, to = req.query.to ? isoDate(req.query.to, 'to') : null;
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Invalid status.');
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId && !canSeeUser(ctx.db, u, userId)) throw new HttpError(403, 'You cannot view this user.');
    const visible = visibleUserIds(ctx.db, u);
    const rows = ctx.db.prepare(`${ENTRY_SELECT} WHERE (? IS NULL OR e.start_at >= ?) AND (? IS NULL OR e.start_at < ?) AND (? IS NULL OR e.status = ?) AND (? IS NULL OR e.user_id = ?) ORDER BY e.start_at DESC LIMIT 1000`)
      .all(from, from, to, to, status, status, userId, userId) as Row[];
    const visibleRows = rows.filter(x => visible === null || visible.has(x.user_id));
    if (u.role !== 'owner') for (const row of visibleRows) if (row.activity_slice_count > 0 && row.user_id !== u.id) audit(ctx.db, ctx.cfg, u.id, 'activity.viewed', 'time_entry', row.id, {estimate: true});
    send(res, 200, { entries: visibleRows.map(entryOut) });
  });

  const loadEntry = (id: string) => { const row = ctx.db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as Row | undefined; if (!row) throw new HttpError(404, 'Time entry not found.'); return row; };

  r.patch('/api/time-entries/:id', (req, res) => {
    const u = currentUser(res);
    const row = loadEntry(String(req.params.id));
    const own = row.user_id === u.id;
    const reviewer = !own && (isAdmin(u) || (u.role === 'manager' && canSeeUser(ctx.db, u, row.user_id)));
    const Patch = z.object({ projectId: z.string().nullable().optional(), taskId: z.string().nullable().optional(), taskLabel: z.string().trim().max(120).optional(), startAt: z.string().optional(), endAt: z.string().optional(), trackedMs: z.number().int().min(0).max(2 * DAY).optional(), note: z.string().trim().max(500).optional(), reason: z.string().trim().min(3).max(300).optional() }).strict();
    const b = parse(Patch, req.body);
    if (!own && !reviewer) throw new HttpError(403, 'You cannot edit this entry.');
    if (own && (row.source !== 'manual' || row.status !== 'pending')) throw new HttpError(403, 'You can only edit your own pending manual entries.');
    if (reviewer && !b.reason) throw new HttpError(400, 'A reason is required when editing someone else\'s time.');
    if (reviewer && row.status === 'approved' && !isAdmin(u)) throw new HttpError(409, 'Approved time is locked.');
    const startMs = b.startAt ? Date.parse(isoDate(b.startAt, 'startAt')) : Date.parse(row.start_at);
    const endMs = b.endAt ? Date.parse(isoDate(b.endAt, 'endAt')) : (row.end_at ? Date.parse(row.end_at) : null);
    if (endMs === null) throw new HttpError(409, 'The entry is still running.');
    if (row.source === 'manual' || b.startAt || b.endAt) checkManualWindow(startMs, endMs);
    let tracked = row.source === 'manual' ? endMs - startMs : (b.trackedMs ?? row.tracked_ms);
    if (tracked > endMs - startMs) throw new HttpError(422, 'Tracked time cannot exceed the entry duration.');
    const projectId = b.projectId === undefined ? row.project_id : b.projectId;
    const taskId = b.taskId === undefined ? (b.projectId === undefined ? row.task_id : null) : b.taskId;
    const owner = { id: row.user_id, teamId: (ctx.db.prepare('SELECT team_id FROM users WHERE id = ?').get(row.user_id) as Row).team_id, role: 'employee', email: '', name: '', managerId: null, mustChangePassword: false, sessionHash: '', sessionKind: 'web' } as AuthUser;
    requireProjectRefs(owner, projectId, taskId);
    if (overlaps(row.user_id, startMs, endMs, row.id)) throw new HttpError(409, 'This time overlaps an existing entry.');
    const before = { startAt: row.start_at, endAt: row.end_at, trackedMs: row.tracked_ms, projectId: row.project_id, taskLabel: row.task_label };
    const idle = Math.min(row.idle_ms, tracked);
    ctx.db.prepare(`UPDATE time_entries SET project_id=?, task_id=?, task_label=?, start_at=?, end_at=?, tracked_ms=?, idle_ms=?, note=?, edited=?, status=?, reviewed_by=NULL, reviewed_at=NULL, updated_at=? WHERE id=?`)
      .run(projectId, taskId, b.taskLabel ?? row.task_label, new Date(startMs).toISOString(), new Date(endMs).toISOString(), tracked, idle, b.note ?? row.note, reviewer ? 1 : row.edited, reviewer ? 'pending' : row.status, nowIso(nowMs()), row.id);
    audit(ctx.db, ctx.cfg, u.id, reviewer ? 'time.edited_by_reviewer' : 'time.edited', 'time_entry', row.id, { reason: b.reason ?? null, before, after: b });
    if (reviewer) emitWebhook(ctx, 'time.edited', { entryId: row.id, userId: row.user_id, startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(), trackedMs: tracked, status: 'pending', editedBy: u.id });
    if (reviewer) notify(ctx, [row.user_id], { kind: 'time.edited', title: 'Your time was edited by a reviewer', body: b.reason, link: 'timesheets' });
    send(res, 200, { entry: entryOut(loadEntry(row.id)) });
  });

  for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    r.post(`/api/time-entries/:id/${verb}`, (req, res) => {
      const u = currentUser(res);
      const row = loadEntry(String(req.params.id));
      const allowed = isAdmin(u) ? (row.user_id !== u.id || u.role === 'owner') : (u.role === 'manager' && row.user_id !== u.id && canSeeUser(ctx.db, u, row.user_id));
      if (!allowed) throw new HttpError(403, 'You cannot review this entry.');
      if (!row.end_at) throw new HttpError(409, 'The entry is still running.');
      const { note } = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {});
      ctx.db.prepare('UPDATE time_entries SET status=?, reviewed_by=?, reviewed_at=?, updated_at=?, note=COALESCE(?, note) WHERE id=?').run(status, u.id, nowIso(nowMs()), nowIso(nowMs()), note ?? null, row.id);
      audit(ctx.db, ctx.cfg, u.id, status === 'approved' ? 'time.approved' : 'time.rejected', 'time_entry', row.id, { note: note ?? null });
      emitWebhook(ctx, status === 'approved' ? 'time.approved' : 'time.rejected', { entryId: row.id, userId: row.user_id, startAt: row.start_at, endAt: row.end_at, trackedMs: row.tracked_ms, status, reviewedBy: u.id });
      notify(ctx, [row.user_id], { kind: `time.${status}`, title: `Your time was ${status}`, body: `${new Date(row.start_at).toISOString().slice(0, 10)} · ${Math.round(row.tracked_ms / 60000)} minutes${note ? ` · ${note}` : ''}`, link: 'timesheets' });
      send(res, 200, { entry: entryOut(loadEntry(row.id)) });
    });
  }

  r.delete('/api/time-entries/:id', (req, res) => {
    const u = currentUser(res);
    const row = loadEntry(String(req.params.id));
    const ownManual = row.user_id === u.id && row.source === 'manual' && row.status === 'pending';
    if (!ownManual && !isAdmin(u)) throw new HttpError(403, 'You cannot delete this entry.');
    ctx.db.prepare('DELETE FROM time_entries WHERE id = ?').run(row.id);
    audit(ctx.db, ctx.cfg, u.id, 'time.deleted', 'time_entry', row.id, { userId: row.user_id, trackedMs: row.tracked_ms });
    send(res, 200, { ok: true });
  });

  // ---------- screenshots ----------
  const subjectPolicy = (() => { const cache = new Map<string, ReturnType<typeof effectivePolicy>>(); return (userId: string) => {
    let p = cache.get(userId);
    if (!p) { const row = ctx.db.prepare('SELECT id, team_id FROM users WHERE id = ?').get(userId) as Row | undefined; p = effectivePolicy(ctx.db, { id: userId, teamId: row?.team_id ?? null }); cache.set(userId, p); }
    return p;
  }; });
  /** employee: always own; others need the subject to be in their scope AND the subject's policy to allow it. */
  const mayViewShots = (actor: AuthUser, subjectId: string, policyOf: ReturnType<typeof subjectPolicy>) =>
    actor.id === subjectId || (canSeeUser(ctx.db, actor, subjectId) && policyOf(subjectId).screenshotVisibility === 'employee_manager');
  const shotOut = (x: Row) => ({ id: x.id, userId: x.user_id, userName: x.user_name, clientId: x.client_id, entryClientId: x.entry_client_id, takenAt: x.taken_at, width: x.width, height: x.height, bytes: x.bytes, format: String(x.file_name).endsWith('.webp') ? 'webp' : 'png', hasThumb: !!x.thumb_file_name });

  r.post('/api/screenshots', raw({ type: ['image/png', 'image/webp'], limit: '24mb' }), async (req, res) => {
    const u = currentUser(res);
    const policy = effectivePolicy(ctx.db, u);
    if (!policy.screenshotsEnabled) throw new HttpError(403, 'Screenshots are disabled by your organization.');
    const consent = (ctx.db.prepare('SELECT consent_version FROM users WHERE id = ?').get(u.id) as Row).consent_version ?? 0;
    if (consent < policy.consentVersion) throw new HttpError(403, 'Accept the monitoring notice before screenshots can be saved.');
    const clientId = String(req.query.clientId ?? '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) throw new HttpError(400, 'clientId is required.');
    const takenMs = Date.parse(isoDate(req.query.takenAt, 'takenAt')), now = nowMs();
    if (takenMs > now + 5 * 60_000 || takenMs < now - 7 * DAY) throw new HttpError(422, 'takenAt is outside the accepted window.');
    const entryClientId = req.query.entryClientId ? String(req.query.entryClientId) : null;
    if (entryClientId && !/^[A-Za-z0-9-]{8,64}$/.test(entryClientId)) throw new HttpError(400, 'entryClientId is invalid.');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let info;
    try { info = inspectScreenshot(bytes); } catch (error) { throw new HttpError(415, (error as Error).message); }
    if (String(req.headers['content-type'] ?? '').split(';')[0] !== IMAGE_MIME[info.kind]) throw new HttpError(415, 'Content-Type does not match the image data.');
    const existing = ctx.db.prepare('SELECT id FROM screenshots WHERE user_id = ? AND client_id = ?').get(u.id, clientId) as Row | undefined;
    if (existing) return send(res, 200, { id: existing.id, duplicate: true });
    const id = crypto.randomUUID(), fileName = `${id}.${IMAGE_EXT[info.kind]}`;
    await ctx.store.put(u.id, fileName, bytes);
    try {
      ctx.db.prepare('INSERT INTO screenshots (id,user_id,client_id,entry_client_id,taken_at,width,height,bytes,sha256,file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, u.id, clientId, entryClientId, new Date(takenMs).toISOString(), info.width, info.height, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), fileName, nowIso(now));
    } catch (error) { await ctx.store.remove(u.id, fileName).catch(() => {}); throw error; } // never leave an orphaned object behind
    send(res, 201, { id, format: info.kind });
  });

  r.put('/api/screenshots/:id/thumb', raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '400kb' }), async (req, res) => {
    const u = currentUser(res);
    const row = ctx.db.prepare('SELECT * FROM screenshots WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(String(req.params.id), u.id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Screenshot not found.');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const kind = imageKind(bytes);
    if (!kind) throw new HttpError(415, 'Thumbnail must be a PNG, JPEG or WebP image.');
    const fileName = `${row.id}.thumb.${IMAGE_EXT[kind]}`;
    await ctx.store.put(u.id, fileName, bytes);
    ctx.db.prepare('UPDATE screenshots SET thumb_file_name = ? WHERE id = ?').run(fileName, row.id);
    send(res, 200, { ok: true });
  });

  r.get('/api/screenshots', (req, res) => {
    const u = currentUser(res);
    const policyOf = subjectPolicy();
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId && !mayViewShots(u, userId, policyOf)) throw new HttpError(403, 'You cannot view this user\'s screenshots.');
    const from = req.query.from ? isoDate(req.query.from, 'from') : null, to = req.query.to ? isoDate(req.query.to, 'to') : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60) || 60));
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    const before = req.query.before ? isoDate(req.query.before, 'before') : null; // cursor: the takenAt of the last item already shown
    const rows = ctx.db.prepare(`SELECT s.*, u.name user_name FROM screenshots s JOIN users u ON u.id = s.user_id WHERE s.deleted_at IS NULL AND (? IS NULL OR s.user_id = ?) AND (? IS NULL OR s.taken_at >= ?) AND (? IS NULL OR s.taken_at < ?) AND (? IS NULL OR s.taken_at < ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM time_entries e WHERE e.user_id = s.user_id AND e.client_id = s.entry_client_id AND e.project_id = ?)) ORDER BY s.taken_at DESC LIMIT 5000`)
      .all(userId, userId, from, from, to, to, before, before, projectId, projectId) as Row[];
    const visible = rows.filter(x => mayViewShots(u, x.user_id, policyOf));
    send(res, 200, { screenshots: visible.slice(0, limit).map(shotOut), hasMore: visible.length > limit });
  });

  // Counts and storage the caller may see (same visibility rules as the list), for the screenshot manager.
  r.get('/api/screenshots/summary', (req, res) => {
    const u = currentUser(res);
    const policyOf = subjectPolicy();
    const days = Math.min(60, Math.max(7, Math.round(Number(req.query.days ?? 14)) || 14));
    const since = new Date(nowMs() - days * DAY).toISOString();
    const perUser = (ctx.db.prepare(`SELECT s.user_id, u.name, COUNT(*) c, COALESCE(SUM(s.bytes),0) b, MIN(s.taken_at) oldest, MAX(s.taken_at) newest FROM screenshots s JOIN users u ON u.id = s.user_id WHERE s.deleted_at IS NULL GROUP BY s.user_id`).all() as Row[])
      .filter(x => mayViewShots(u, x.user_id, policyOf));
    const recent = (ctx.db.prepare('SELECT user_id, taken_at, bytes FROM screenshots WHERE deleted_at IS NULL AND taken_at >= ?').all(since) as Row[]).filter(x => mayViewShots(u, x.user_id, policyOf));
    const byDay = new Map<string, { date: string; count: number; bytes: number }>();
    for (let i = days - 1; i >= 0; i--) { const d = new Date(nowMs() - i * DAY).toISOString().slice(0, 10); byDay.set(d, { date: d, count: 0, bytes: 0 }); }
    for (const x of recent) { const d = byDay.get(String(x.taken_at).slice(0, 10)); if (d) { d.count++; d.bytes += Number(x.bytes); } }
    const total = perUser.reduce((t, x) => ({ count: t.count + Number(x.c), bytes: t.bytes + Number(x.b) }), { count: 0, bytes: 0 });
    send(res, 200, {
      total, days,
      byUser: perUser.map(x => ({ userId: x.user_id, name: x.name, count: Number(x.c), bytes: Number(x.b), oldestAt: x.oldest, newestAt: x.newest })).sort((a, b) => b.bytes - a.bytes),
      byDay: [...byDay.values()], retentionDays: effectivePolicy(ctx.db, u).retentionDays,
    });
  });

  const loadShot = (req: { params: Record<string, any> }, res: any) => {
    const u = currentUser(res);
    const row = ctx.db.prepare('SELECT s.*, u.name user_name FROM screenshots s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.deleted_at IS NULL').get(String(req.params.id)) as Row | undefined;
    if (!row || !mayViewShots(u, row.user_id, subjectPolicy())) throw new HttpError(404, 'Screenshot not found.'); // 404, not 403: do not reveal existence
    return { u, row };
  };
  const serveShot = (thumb: boolean) => async (req: any, res: any) => {
    const { u, row } = loadShot(req, res);
    const name = thumb && row.thumb_file_name ? row.thumb_file_name : row.file_name;
    const bytes = await ctx.store.get(row.user_id, name);
    if (!bytes) throw new HttpError(404, 'Screenshot file is missing.');
    if (!thumb && u.id !== row.user_id) audit(ctx.db, ctx.cfg, u.id, 'screenshot.viewed', 'screenshot', row.id, { ownerId: row.user_id });
    res.set({ 'Content-Type': IMAGE_MIME[imageKind(bytes) ?? 'png'], 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' }).send(bytes);
  };
  r.get('/api/screenshots/:id/image', serveShot(false));
  r.get('/api/screenshots/:id/thumb', serveShot(true));

  /** Same rules for one or many: owners may delete their own if policy allows; admins and managers (within scope) may delete others'. */
  const deleteShot = async (u: AuthUser, row: Row, reason?: string) => {
    const own = row.user_id === u.id;
    if (own && !effectivePolicy(ctx.db, u).allowEmployeeDelete) throw new HttpError(403, 'Your organization does not allow deleting your own screenshots.');
    if (!own && !(isAdmin(u) || u.role === 'manager')) throw new HttpError(403, 'You cannot delete this screenshot.');
    // Remove the stored object first: if the store fails the record stays visible and the delete can be retried.
    await ctx.store.remove(row.user_id, row.file_name); if (row.thumb_file_name) await ctx.store.remove(row.user_id, row.thumb_file_name);
    ctx.db.prepare('UPDATE screenshots SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(nowMs()), u.id, row.id);
    audit(ctx.db, ctx.cfg, u.id, 'screenshot.deleted', 'screenshot', row.id, { ownerId: row.user_id, ...(reason ? { reason } : {}) });
  };
  r.delete('/api/screenshots/:id', async (req, res) => {
    const { u, row } = loadShot(req, res);
    await deleteShot(u, row);
    send(res, 200, { ok: true });
  });

  // Bulk delete for the screenshot manager: at most 100 per call, every item checked and audited on its own, partial success reported.
  r.post('/api/screenshots/bulk-delete', async (req, res) => {
    const u = currentUser(res);
    const body = parse(z.object({ ids: z.array(z.string().regex(/^[A-Za-z0-9-]{8,64}$/)).min(1).max(100), reason: z.string().trim().max(200).optional() }), req.body);
    const policyOf = subjectPolicy();
    const deleted: string[] = [], skipped: { id: string; reason: string }[] = [];
    for (const id of new Set(body.ids)) {
      const row = ctx.db.prepare('SELECT * FROM screenshots WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined;
      if (!row || !mayViewShots(u, row.user_id, policyOf)) { skipped.push({ id, reason: 'Not found.' }); continue; }
      try { await deleteShot(u, row, body.reason); deleted.push(id); }
      catch (error) { skipped.push({ id, reason: error instanceof HttpError ? error.message : 'The stored file could not be removed; try again.' }); }
    }
    if (deleted.length) audit(ctx.db, ctx.cfg, u.id, 'screenshot.bulk_deleted', 'screenshot', undefined, { count: deleted.length, skipped: skipped.length, ...(body.reason ? { reason: body.reason } : {}) });
    send(res, 200, { deleted: deleted.length, skipped });
  });

  // ---------- day timeline and team summary ----------
  const tzParam = (value: unknown) => { const tz = Math.round(Number(value ?? 0)) || 0; if (tz < -14 * 60 || tz > 14 * 60) throw new HttpError(400, 'tzOffsetMinutes is out of range.'); return tz; };
  const MIN = 60_000;

  /** One person's day in the viewer's timezone: time blocks, screenshots (if the policy lets this viewer see them) and count-only activity per hour. */
  r.get('/api/timeline', (req, res) => {
    const u = currentUser(res);
    const userId = req.query.userId ? String(req.query.userId) : u.id;
    if (!canSeeUser(ctx.db, u, userId)) throw new HttpError(403, 'You cannot view this person.');
    const date = String(req.query.date ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'date must be a real calendar date, YYYY-MM-DD.');
    const tz = tzParam(req.query.tzOffsetMinutes);
    const startMs = Date.parse(`${date}T00:00:00Z`) - tz * MIN, endMs = startMs + DAY, startIso = new Date(startMs).toISOString(), endIso = new Date(endMs).toISOString();
    const person = ctx.db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId) as Row | undefined;
    if (!person) throw new HttpError(404, 'Person not found.');
    const entries = (ctx.db.prepare(`SELECT e.*, p.name project_name FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id WHERE e.user_id = ? AND e.start_at < ? AND (e.end_at IS NULL OR e.end_at > ?) ORDER BY e.start_at`).all(userId, endIso, startIso) as Row[])
      .map(e => ({ id: e.id, startAt: e.start_at, endAt: e.end_at, running: !e.end_at, trackedMs: e.tracked_ms, idleMs: e.idle_ms, status: e.status, source: e.source, projectName: e.project_name ?? null, taskLabel: e.task_label }));
    const policyOf = subjectPolicy(); const mayShots = mayViewShots(u, userId, policyOf);
    const shots = mayShots ? (ctx.db.prepare('SELECT id, taken_at, thumb_file_name, width, height, bytes, file_name FROM screenshots WHERE user_id = ? AND deleted_at IS NULL AND taken_at >= ? AND taken_at < ? ORDER BY taken_at').all(userId, startIso, endIso) as Row[])
      .map(s => ({ id: s.id, takenAt: s.taken_at, hasThumb: !!s.thumb_file_name, width: s.width, height: s.height, bytes: s.bytes, format: String(s.file_name).endsWith('.webp') ? 'webp' : 'png' })) : null;
    // Count-only activity estimates per local hour (only exists when the organization enabled it and the person consented).
    const slices = ctx.db.prepare('SELECT s.slice_start_at, s.duration_seconds, s.active_seconds, s.keyboard_count, s.mouse_count, s.entry_client_id FROM activity_slices s WHERE s.user_id = ? AND s.slice_start_at >= ? AND s.slice_start_at < ?').all(userId, startIso, endIso) as Row[];
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sampledSeconds: 0, activeSeconds: 0, keyDownCount: 0, mouseClickCount: 0 }));
    for (const s of slices) { const h = hours[Math.min(23, Math.max(0, Math.floor((Date.parse(s.slice_start_at) - startMs) / (60 * MIN))))]!; h.sampledSeconds += s.duration_seconds; h.activeSeconds += s.active_seconds; h.keyDownCount += s.keyboard_count; h.mouseClickCount += s.mouse_count; }
    if (slices.length && userId !== u.id && u.role !== 'owner') audit(ctx.db, ctx.cfg, u.id, 'activity.viewed', 'user', userId, { estimate: true, date });
    // Breaks the person chose to take (a break still going counts up to now, at most 12 h).
    const breaks = (ctx.db.prepare('SELECT start_at, end_at FROM breaks WHERE user_id = ? AND start_at < ? AND (end_at IS NULL OR end_at > ?) ORDER BY start_at').all(userId, endIso, startIso) as Row[])
      .map(b => ({ startAt: b.start_at, endAt: b.end_at, open: !b.end_at }));
    const breakMs = breaks.reduce((t, b) => { const s = Math.max(Date.parse(b.startAt), startMs), e = Math.min(b.endAt ? Date.parse(b.endAt) : Math.min(nowMs(), Date.parse(b.startAt) + 12 * HOUR), endMs); return t + Math.max(0, e - s); }, 0);
    const tracked = entries.reduce((t, e) => t + e.trackedMs, 0), idle = entries.reduce((t, e) => t + e.idleMs, 0);
    send(res, 200, {
      person: { id: person.id, name: person.name, role: person.role }, date, tzOffsetMinutes: tz, dayStartAt: startIso, dayEndAt: endIso, entries, breaks,
      screenshots: shots, screenshotsHidden: !mayShots,
      activity: slices.length ? { hours, note: 'Count-only estimate from keyboard and mouse input (no key identity, text or position). Not a measure of productivity or quality.' } : null,
      totals: { trackedMs: tracked, idleMs: idle, breakMs, breaks: breaks.length, entries: entries.length, pending: entries.filter(e => e.status === 'pending' && !e.running).length, screenshots: shots?.length ?? null, firstStartAt: entries[0]?.startAt ?? null, lastEndAt: entries.filter(e => e.endAt).at(-1)?.endAt ?? null },
    });
  });

  /** Everyone the viewer may see: tracked time per day, status and approvals waiting. Facts only; no scores. */
  r.get('/api/team/summary', (req, res) => {
    const u = currentUser(res);
    const days = Math.min(31, Math.max(1, Math.round(Number(req.query.days ?? 7)) || 7));
    const tz = tzParam(req.query.tzOffsetMinutes);
    const now = nowMs();
    const dayKey = (ms: number) => new Date(ms + tz * MIN).toISOString().slice(0, 10);
    const keys: string[] = []; for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * DAY));
    const windowStart = new Date(Date.parse(`${keys[0]}T00:00:00.000Z`) - tz * MIN).toISOString();
    const visible = visibleUserIds(ctx.db, u);
    const people = (ctx.db.prepare('SELECT u.id, u.name, u.role, t.name team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.active = 1 ORDER BY u.name COLLATE NOCASE').all() as Row[]).filter(x => visible === null || visible.has(x.id));
    const entries = ctx.db.prepare('SELECT user_id, start_at, tracked_ms, idle_ms, status, end_at FROM time_entries WHERE start_at >= ?').all(windowStart) as Row[];
    const presence = new Map((ctx.db.prepare('SELECT user_id, status, last_seen_at FROM presence').all() as Row[]).map(p => [p.user_id, p]));
    const pendingBy = new Map((ctx.db.prepare("SELECT user_id, COUNT(*) c FROM time_entries WHERE status = 'pending' AND end_at IS NOT NULL GROUP BY user_id").all() as Row[]).map(p => [p.user_id, Number(p.c)]));
    const shotsBy = new Map((ctx.db.prepare('SELECT user_id, COUNT(*) c FROM screenshots WHERE deleted_at IS NULL AND taken_at >= ? GROUP BY user_id').all(windowStart) as Row[]).map(p => [p.user_id, Number(p.c)]));
    const policyOf = subjectPolicy();
    const breakBy = new Map<string, { ms: number; count: number }>();
    for (const b of ctx.db.prepare('SELECT user_id, start_at, end_at FROM breaks WHERE start_at >= ?').all(windowStart) as Row[]) {
      const ms = Math.max(0, (b.end_at ? Date.parse(b.end_at) : Math.min(now, Date.parse(b.start_at) + 12 * HOUR)) - Date.parse(b.start_at));
      const t = breakBy.get(b.user_id) ?? { ms: 0, count: 0 }; t.ms += ms; t.count++; breakBy.set(b.user_id, t);
    }
    const rows = people.map(p => {
      const perDay = new Map(keys.map(k => [k, 0])); let idle = 0;
      for (const e of entries) if (e.user_id === p.id && e.status !== 'rejected') { const k = dayKey(Date.parse(e.start_at)); if (perDay.has(k)) { perDay.set(k, perDay.get(k)! + e.tracked_ms); idle += e.idle_ms; } }
      const total = [...perDay.values()].reduce((a, b) => a + b, 0), pr = presence.get(p.id);
      const fresh = pr && now - Date.parse(pr.last_seen_at) <= 90_000 && pr.status !== 'stopped';
      return { userId: p.id, name: p.name, role: p.role, team: p.team_name ?? null, state: fresh ? pr!.status : 'offline', lastSeenAt: pr?.last_seen_at ?? null,
        daily: keys.map(k => ({ date: k, trackedMs: perDay.get(k)! })), trackedMs: total, idleMs: idle, breakMs: breakBy.get(p.id)?.ms ?? 0, breaks: breakBy.get(p.id)?.count ?? 0, activeDays: [...perDay.values()].filter(v => v > 0).length, pendingApprovals: pendingBy.get(p.id) ?? 0,
        screenshots: mayViewShots(u, p.id, policyOf) ? (shotsBy.get(p.id) ?? 0) : null };
    });
    send(res, 200, { days, dates: keys, people: rows, totals: { trackedMs: rows.reduce((t, x) => t + x.trackedMs, 0), pending: rows.reduce((t, x) => t + x.pendingApprovals, 0), tracking: rows.filter(x => x.state === 'tracking').length }, note: 'Facts from tracked time only. Idle time is an input estimate; none of this is a productivity, attendance or pay measure.' });
  });

  return r;
}
