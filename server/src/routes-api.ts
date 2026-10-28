import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send, isoDate } from './ctx.ts';
import type { Row } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError, audit, currentUser, requireRole } from './auth.ts';

export const API_SCOPES = ['users:read', 'projects:read', 'time:read'] as const;
type Scope = typeof API_SCOPES[number];
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const RATE_LIMIT = 300, RATE_WINDOW_MS = 5 * 60_000;

/** Key management for owners and admins (signed-in dashboard session). The key itself is shown once, at creation. */
export function apiKeyRoutes(ctx: Ctx) {
  const r = Router();
  const admin = requireRole('owner', 'admin');
  const out = (k: Row) => ({ id: k.id, name: k.name, prefix: k.key_prefix, scopes: JSON.parse(k.scopes) as Scope[], createdBy: k.created_by_name ?? null, createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at });
  r.get('/api/admin/api-keys', admin, (_req, res) => {
    send(res, 200, { keys: (ctx.db.prepare('SELECT k.*, u.name created_by_name FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC').all() as Row[]).map(out), scopes: API_SCOPES, baseUrl: '/api/v1' });
  });
  r.post('/api/admin/api-keys', admin, (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length) }).strict(), req.body);
    if ((ctx.db.prepare('SELECT COUNT(*) c FROM api_keys WHERE revoked_at IS NULL').get() as Row).c >= 50) throw new HttpError(409, 'Revoke an unused key first: at most 50 active keys.');
    const key = `ufs_${crypto.randomBytes(30).toString('base64url')}`, id = crypto.randomUUID();
    ctx.db.prepare('INSERT INTO api_keys (id,name,key_hash,key_prefix,scopes,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, b.name, sha256(key), key.slice(0, 10), JSON.stringify([...new Set(b.scopes)]), u.id, nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, u.id, 'apikey.created', 'api_key', id, { name: b.name, scopes: b.scopes });
    send(res, 201, { id, key, note: 'Copy this key now. It is shown only once and cannot be recovered; revoke it and create a new one if it is lost.' });
  });
  r.delete('/api/admin/api-keys/:id', admin, (req, res) => {
    const u = currentUser(res);
    const result = ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(ctx.cfg.now()), String(req.params.id));
    if (!result.changes) throw new HttpError(404, 'Key not found or already revoked.');
    audit(ctx.db, ctx.cfg, u.id, 'apikey.revoked', 'api_key', String(req.params.id));
    send(res, 200, { ok: true });
  });
  r.use('/api/v1', (_req, _res, next) => next(new HttpError(404, 'Unknown endpoint. The public API offers /me, /users, /projects and /time-entries.')));
  return r;
}

/**
 * Read-only public API for integrations, mounted before the dashboard API so a session token never works here and a key
 * never works there. It exposes people, projects and time entries only: no screenshots, activity counts, breaks or pay.
 */
export function publicApiRoutes(ctx: Ctx) {
  const r = Router();
  const hits = new Map<string, number[]>();
  const auth = (scope: Scope | null) => (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer (ufs_[A-Za-z0-9_-]{40})$/.exec(req.headers.authorization ?? '');
    const row = match ? ctx.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(match[1]!)) as Row | undefined : undefined;
    if (!row || row.revoked_at) return next(new HttpError(401, 'A valid API key is required.'));
    const now = ctx.cfg.now(), recent = (hits.get(row.id) ?? []).filter(t => t > now - RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) { res.set('Retry-After', String(Math.ceil((recent[0]! + RATE_WINDOW_MS - now) / 1000))); return next(new HttpError(429, 'Rate limit reached: 300 requests per 5 minutes per key.')); }
    recent.push(now); hits.set(row.id, recent);
    const scopes = JSON.parse(row.scopes) as Scope[];
    if (scope && !scopes.includes(scope)) return next(new HttpError(403, `This key does not have the ${scope} scope.`));
    if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000) ctx.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(now), row.id);
    res.locals.apiKey = { id: row.id, name: row.name, scopes }; res.set('Cache-Control', 'no-store'); next();
  };
  r.use('/api/v1', (req, _res, next) => req.method === 'GET' ? next() : next(new HttpError(405, 'The public API is read-only.')));

  r.get('/api/v1/me', auth(null), (_req, res) => { send(res, 200, { key: res.locals.apiKey }); });
  r.get('/api/v1/users', auth('users:read'), (_req, res) => {
    send(res, 200, { users: (ctx.db.prepare('SELECT u.id, u.name, u.email, u.role, u.manager_id, t.name team FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.active = 1 ORDER BY u.name COLLATE NOCASE').all() as Row[]).map(x => ({ id: x.id, name: x.name, email: x.email, role: x.role, managerId: x.manager_id, team: x.team })) });
  });
  r.get('/api/v1/projects', auth('projects:read'), (_req, res) => {
    const tasks = ctx.db.prepare('SELECT id, project_id, name FROM tasks WHERE active = 1 ORDER BY name COLLATE NOCASE').all() as Row[];
    send(res, 200, { projects: (ctx.db.prepare('SELECT id, name, client FROM projects WHERE active = 1 ORDER BY name COLLATE NOCASE').all() as Row[]).map(p => ({ id: p.id, name: p.name, client: p.client, tasks: tasks.filter(t => t.project_id === p.id).map(t => ({ id: t.id, name: t.name })) })) });
  });
  r.get('/api/v1/time-entries', auth('time:read'), (req, res) => {
    const from = req.query.from ? isoDate(req.query.from, 'from') : null, to = req.query.to ? isoDate(req.query.to, 'to') : null;
    if (from && to && Date.parse(to) <= Date.parse(from)) throw new HttpError(400, 'to must be after from.');
    if (from && to && Date.parse(to) - Date.parse(from) > 93 * 86_400_000) throw new HttpError(400, 'Choose a range of at most 93 days.');
    const status = String(req.query.status ?? 'approved'); if (!['approved', 'pending', 'rejected', 'all'].includes(status)) throw new HttpError(400, 'status must be approved, pending, rejected or all.');
    const limit = Math.min(1000, Math.max(1, Math.round(Number(req.query.limit ?? 200)) || 200));
    const after = req.query.after ? isoDate(req.query.after, 'after') : null; // cursor: the startAt of the last item of the previous page
    const userId = req.query.userId ? String(req.query.userId) : null;
    const rows = ctx.db.prepare(`SELECT e.id, e.user_id, e.start_at, e.end_at, e.tracked_ms, e.idle_ms, e.status, e.source, e.project_id, e.task_id, e.task_label, e.updated_at FROM time_entries e
      WHERE (? IS NULL OR e.start_at >= ?) AND (? IS NULL OR e.start_at < ?) AND (? = 'all' OR e.status = ?) AND (? IS NULL OR e.user_id = ?) AND (? IS NULL OR e.start_at > ?) AND e.end_at IS NOT NULL
      ORDER BY e.start_at, e.id LIMIT ?`).all(from, from, to, to, status, status, userId, userId, after, after, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    send(res, 200, { entries: page.map(e => ({ id: e.id, userId: e.user_id, startAt: e.start_at, endAt: e.end_at, trackedMs: e.tracked_ms, idleMs: e.idle_ms, status: e.status, source: e.source, projectId: e.project_id, taskId: e.task_id, taskLabel: e.task_label, updatedAt: e.updated_at })), next: rows.length > limit ? page.at(-1)!.start_at : null });
  });
  r.use('/api/v1', (_req, _res, next) => next(new HttpError(404, 'Unknown endpoint. The public API offers /me, /users, /projects and /time-entries.')));
  return r;
}
