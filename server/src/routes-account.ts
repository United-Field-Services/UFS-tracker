import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send } from './ctx.ts';
import { nowIso } from './db.ts';
import type { Row } from './db.ts';
import {
  HttpError, audit, currentUser, dummyVerify, hashPassword, isAdmin, issueToken, requireRole,
  validatePasswordStrength, verifyPassword, visibleUserIds, type AuthUser,
} from './auth.ts';
import { effectivePolicy, getScopePolicy, setScopePolicy, clearScopePolicy, PartialPolicySchema } from './policy.ts';
import { supabaseLogin } from './supabase-login.ts';

const publicUser = (r: Row) => ({
  id: r.id, email: r.email, name: r.name, role: r.role, managerId: r.manager_id, teamId: r.team_id,
  active: !!r.active, mustChangePassword: !!r.must_change_password, consentVersion: r.consent_version ?? null, consentAt: r.consent_at ?? null, createdAt: r.created_at,
  source: (r.source ?? 'local') as 'local' | 'directory', directoryId: r.directory_id ?? null,
});

/** Public routes (no token). */
export function publicRoutes(ctx: Ctx) {
  const r = Router();
  const LoginBody = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200), kind: z.enum(['web', 'device']).default('web'), deviceName: z.string().trim().max(80).optional(), totp: z.string().trim().regex(/^\d{6,8}$/, 'must be the 6-digit code').optional() });
  // Tells clients how people sign in (used only for wording and for showing the authenticator-code field).
  r.get('/api/auth/config', (_req, res) => { send(res, 200, { signIn: ctx.supabase ? 'ufs-people' : 'local', authenticatorRoles: ctx.supabase?.cfg.mfaRoles ?? [] }); });
  r.post('/api/auth/login', async (req, res) => {
    const body = parse(LoginBody, req.body);
    const keys = [`email:${body.email}`, `ip:${req.ip}`];
    if (ctx.limiter.blocked(...keys)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const user = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as Row | undefined;
    // UFS People sign-in applies to everyone except local tracker accounts (the break-glass owner), which keep their own password.
    if (ctx.supabase && user?.source !== 'local') {
      const result = await supabaseLogin(ctx, { email: body.email, password: body.password, totp: body.totp, kind: body.kind, deviceName: body.deviceName }, req.ip ?? 'unknown');
      return void send(res, 200, { token: result.token, expiresAt: result.expiresAt, user: publicUser(result.user) });
    }
    const ok = user ? verifyPassword(body.password, user.password_hash) : (dummyVerify(body.password), false);
    if (!user || !ok || !user.active) { ctx.limiter.failure(...keys); audit(ctx.db, ctx.cfg, user?.id ?? null, 'auth.login_failed', 'user', user?.id); throw new HttpError(401, 'Incorrect email or password.'); }
    ctx.limiter.success(...keys);
    const issued = issueToken(ctx.db, ctx.cfg, user.id, body.kind, body.deviceName ?? null);
    audit(ctx.db, ctx.cfg, user.id, 'auth.login', 'user', user.id, { kind: body.kind, device: body.deviceName ?? null });
    send(res, 200, { token: issued.token, expiresAt: issued.expiresAt, user: publicUser(user) });
  });
  return r;
}

/** Routes for any signed-in user. */
export function accountRoutes(ctx: Ctx) {
  const r = Router();

  r.get('/api/me', (_req, res) => {
    const u = currentUser(res);
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as Row;
    const policy = effectivePolicy(ctx.db, u);
    send(res, 200, { user: publicUser(row), policy, needsConsent: (row.consent_version ?? 0) < policy.consentVersion });
  });

  r.post('/api/auth/logout', (_req, res) => {
    const u = currentUser(res);
    ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(ctx.cfg.now()), u.sessionHash);
    audit(ctx.db, ctx.cfg, u.id, 'auth.logout', 'user', u.id);
    send(res, 200, { ok: true });
  });

  r.post('/api/auth/change-password', (req, res) => {
    const u = currentUser(res);
    if (ctx.db.prepare('SELECT source FROM users WHERE id = ?').get(u.id)?.source === 'directory') throw new HttpError(409, 'Your password is managed in UFS People.');
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }), req.body);
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id) as Row;
    if (!verifyPassword(body.currentPassword, row.password_hash)) throw new HttpError(403, 'Current password is incorrect.');
    const weak = validatePasswordStrength(body.newPassword);
    if (weak) throw new HttpError(400, weak);
    if (body.newPassword === body.currentPassword) throw new HttpError(400, 'Choose a different password.');
    ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(body.newPassword), u.id);
    // Sign out every other session after a password change.
    ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL').run(nowIso(ctx.cfg.now()), u.id, u.sessionHash);
    audit(ctx.db, ctx.cfg, u.id, 'auth.password_changed', 'user', u.id);
    send(res, 200, { ok: true });
  });

  r.post('/api/me/consent', (req, res) => {
    const u = currentUser(res);
    const { version } = parse(z.object({ version: z.number().int().min(1) }), req.body);
    const policy = effectivePolicy(ctx.db, u);
    if (version < policy.consentVersion) throw new HttpError(400, 'Please accept the current monitoring notice.');
    ctx.db.prepare('UPDATE users SET consent_version = ?, consent_at = ? WHERE id = ?').run(version, nowIso(ctx.cfg.now()), u.id);
    audit(ctx.db, ctx.cfg, u.id, 'consent.accepted', 'user', u.id, { version });
    send(res, 200, { ok: true });
  });

  r.get('/api/me/devices', (_req, res) => {
    const u = currentUser(res);
    const rows = ctx.db.prepare(`SELECT token_hash, kind, device_name, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`).all(u.id, nowIso(ctx.cfg.now())) as Row[];
    send(res, 200, { sessions: rows.map(s => ({ id: s.token_hash.slice(0, 16), kind: s.kind, deviceName: s.device_name, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.token_hash === u.sessionHash })) });
  });
  r.delete('/api/me/devices/:id', (req, res) => {
    const u = currentUser(res);
    const id = String(req.params.id);
    if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'Invalid session id.');
    const result = ctx.db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(token_hash,1,16) = ? AND revoked_at IS NULL`).run(nowIso(ctx.cfg.now()), u.id, id);
    if (!result.changes) throw new HttpError(404, 'Session not found.');
    audit(ctx.db, ctx.cfg, u.id, 'auth.session_revoked', 'session', id);
    send(res, 200, { ok: true });
  });
  return r;
}

/** People, teams, projects, policy and audit administration. */
export function adminRoutes(ctx: Ctx) {
  const r = Router();
  const admin = requireRole('owner', 'admin');
  const lead = requireRole('owner', 'admin', 'manager');

  // ---- users ----
  r.get('/api/users', (_req, res) => {
    const u = currentUser(res);
    const visible = visibleUserIds(ctx.db, u);
    const rows = ctx.db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all() as Row[];
    send(res, 200, { users: rows.filter(x => visible === null || visible.has(x.id)).map(publicUser) });
  });

  const CreateUser = z.object({
    email: z.string().trim().toLowerCase().email().max(200), name: z.string().trim().min(1).max(120),
    role: z.enum(['owner', 'admin', 'hr', 'manager', 'employee']).default('employee'),
    managerId: z.string().nullable().optional(), teamId: z.string().nullable().optional(),
    temporaryPassword: z.string().max(200),
  });
  const guardRoleChange = (actor: AuthUser, role: string) => { if ((role === 'owner') && actor.role !== 'owner') throw new HttpError(403, 'Only an owner can assign the owner role.'); };
  const checkRefs = (managerId?: string | null, teamId?: string | null) => {
    if (managerId && !ctx.db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(managerId)) throw new HttpError(400, 'Manager not found.');
    if (teamId && !ctx.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw new HttpError(400, 'Team not found.');
  };
  r.post('/api/users', admin, (req, res) => {
    const actor = currentUser(res);
    const b = parse(CreateUser, req.body);
    guardRoleChange(actor, b.role);
    const weak = validatePasswordStrength(b.temporaryPassword);
    if (weak) throw new HttpError(400, weak);
    checkRefs(b.managerId, b.teamId);
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email)) throw new HttpError(409, 'A user with this email already exists.');
    const id = crypto.randomUUID();
    ctx.db.prepare('INSERT INTO users (id,email,name,role,manager_id,team_id,password_hash,must_change_password,created_at) VALUES (?,?,?,?,?,?,?,1,?)')
      .run(id, b.email, b.name, b.role, b.managerId ?? null, b.teamId ?? null, hashPassword(b.temporaryPassword), nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, actor.id, 'user.created', 'user', id, { email: b.email, role: b.role });
    send(res, 201, { user: publicUser(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row) });
  });

  const PatchUser = z.object({
    name: z.string().trim().min(1).max(120).optional(), role: z.enum(['owner', 'admin', 'hr', 'manager', 'employee']).optional(),
    managerId: z.string().nullable().optional(), teamId: z.string().nullable().optional(), active: z.boolean().optional(),
  }).strict();
  r.patch('/api/users/:id', admin, (req, res) => {
    const actor = currentUser(res);
    const id = String(req.params.id);
    const target = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!target) throw new HttpError(404, 'User not found.');
    const b = parse(PatchUser, req.body);
    // Name, role, manager, team and active state of people from UFS People are owned by the directory and change there.
    if (target.source === 'directory' && Object.keys(b).length) throw new HttpError(409, 'This person comes from the UFS People directory. Change their name, role, manager, team or status there; it syncs here automatically.');
    if (target.role === 'owner' && actor.role !== 'owner') throw new HttpError(403, 'Only an owner can change an owner.');
    if (b.role) guardRoleChange(actor, b.role);
    if (b.managerId === id) throw new HttpError(400, 'A user cannot manage themselves.');
    checkRefs(b.managerId, b.teamId);
    const demotes = (b.role && b.role !== 'owner' && target.role === 'owner') || b.active === false && target.role === 'owner';
    if (demotes && (ctx.db.prepare("SELECT COUNT(*) c FROM users WHERE role='owner' AND active=1").get() as Row).c <= 1) throw new HttpError(409, 'The last active owner cannot be demoted or deactivated.');
    const next = { name: b.name ?? target.name, role: b.role ?? target.role, manager_id: b.managerId === undefined ? target.manager_id : b.managerId, team_id: b.teamId === undefined ? target.team_id : b.teamId, active: b.active === undefined ? target.active : (b.active ? 1 : 0) };
    ctx.db.prepare('UPDATE users SET name=?, role=?, manager_id=?, team_id=?, active=? WHERE id=?').run(next.name, next.role, next.manager_id, next.team_id, next.active, id);
    if (b.active === false) ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(ctx.cfg.now()), id);
    audit(ctx.db, ctx.cfg, actor.id, 'user.updated', 'user', id, b);
    send(res, 200, { user: publicUser(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row) });
  });

  r.post('/api/users/:id/reset-password', admin, (req, res) => {
    const actor = currentUser(res);
    const id = String(req.params.id);
    const target = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.source === 'directory') throw new HttpError(409, 'Sign-in for people from UFS People is managed there; the tracker holds no password for them.');
    if (target.role === 'owner' && actor.role !== 'owner') throw new HttpError(403, 'Only an owner can reset an owner.');
    const { temporaryPassword } = parse(z.object({ temporaryPassword: z.string().max(200) }), req.body);
    const weak = validatePasswordStrength(temporaryPassword);
    if (weak) throw new HttpError(400, weak);
    ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(temporaryPassword), id);
    ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(ctx.cfg.now()), id);
    audit(ctx.db, ctx.cfg, actor.id, 'user.password_reset', 'user', id);
    send(res, 200, { ok: true });
  });

  r.post('/api/users/:id/revoke-sessions', admin, (req, res) => {
    const id = String(req.params.id);
    const result = ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(ctx.cfg.now()), id);
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'user.sessions_revoked', 'user', id, { count: Number(result.changes) });
    send(res, 200, { revoked: Number(result.changes) });
  });

  // ---- teams ----
  r.get('/api/teams', (_req, res) => send(res, 200, { teams: (ctx.db.prepare('SELECT id,name FROM teams ORDER BY name COLLATE NOCASE').all() as Row[]) }));
  r.post('/api/teams', admin, (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    if (ctx.db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name)) throw new HttpError(409, 'A team with this name already exists.');
    const id = crypto.randomUUID();
    ctx.db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').run(id, name, nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'team.created', 'team', id, { name });
    send(res, 201, { team: { id, name } });
  });

  // ---- projects & tasks ----
  r.get('/api/projects', (_req, res) => {
    const u = currentUser(res);
    const all = ctx.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as Row[];
    const mine = isAdmin(u) || u.role === 'manager' ? all : all.filter(p => p.active && (!p.team_id || p.team_id === u.teamId));
    const tasks = ctx.db.prepare('SELECT * FROM tasks ORDER BY name COLLATE NOCASE').all() as Row[];
    send(res, 200, { projects: mine.map(p => ({ id: p.id, name: p.name, client: p.client, teamId: p.team_id, active: !!p.active, tasks: tasks.filter(t => t.project_id === p.id && (t.active || isAdmin(u) || u.role === 'manager')).map(t => ({ id: t.id, name: t.name, active: !!t.active })) })) });
  });
  const ProjectBody = z.object({ name: z.string().trim().min(1).max(120), client: z.string().trim().max(120).nullable().optional(), teamId: z.string().nullable().optional() });
  r.post('/api/projects', lead, (req, res) => {
    const b = parse(ProjectBody, req.body);
    if (b.teamId && !ctx.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(b.teamId)) throw new HttpError(400, 'Team not found.');
    const id = crypto.randomUUID();
    ctx.db.prepare('INSERT INTO projects (id,name,client,team_id,created_at) VALUES (?,?,?,?,?)').run(id, b.name, b.client ?? null, b.teamId ?? null, nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'project.created', 'project', id, b);
    send(res, 201, { project: { id, name: b.name, client: b.client ?? null, teamId: b.teamId ?? null, active: true, tasks: [] } });
  });
  r.patch('/api/projects/:id', lead, (req, res) => {
    const id = String(req.params.id);
    const cur = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    if (!cur) throw new HttpError(404, 'Project not found.');
    const b = parse(ProjectBody.partial().extend({ active: z.boolean().optional() }).strict(), req.body);
    ctx.db.prepare('UPDATE projects SET name=?, client=?, team_id=?, active=? WHERE id=?')
      .run(b.name ?? cur.name, b.client === undefined ? cur.client : b.client, b.teamId === undefined ? cur.team_id : b.teamId, b.active === undefined ? cur.active : (b.active ? 1 : 0), id);
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'project.updated', 'project', id, b);
    send(res, 200, { ok: true });
  });
  r.post('/api/projects/:id/tasks', lead, (req, res) => {
    const pid = String(req.params.id);
    if (!ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) throw new HttpError(404, 'Project not found.');
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const id = crypto.randomUUID();
    ctx.db.prepare('INSERT INTO tasks (id,project_id,name,created_at) VALUES (?,?,?,?)').run(id, pid, name, nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'task.created', 'task', id, { projectId: pid, name });
    send(res, 201, { task: { id, name, active: true } });
  });
  r.patch('/api/tasks/:id', lead, (req, res) => {
    const id = String(req.params.id);
    const cur = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (!cur) throw new HttpError(404, 'Task not found.');
    const b = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional() }).strict(), req.body);
    ctx.db.prepare('UPDATE tasks SET name=?, active=? WHERE id=?').run(b.name ?? cur.name, b.active === undefined ? cur.active : (b.active ? 1 : 0), id);
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'task.updated', 'task', id, b);
    send(res, 200, { ok: true });
  });

  // ---- policy (org > team > user) ----
  const scopeOk = (scope: string, id: string) => {
    if (scope === 'org') return id === 'org';
    const table = scope === 'team' ? 'teams' : 'users';
    return !!ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  };
  r.get('/api/policy/:scope/:id', admin, (req, res) => {
    const scope = String(req.params.scope), id = String(req.params.id);
    if (!['org', 'team', 'user'].includes(scope) || !scopeOk(scope, id)) throw new HttpError(404, 'Unknown policy scope.');
    send(res, 200, { overrides: getScopePolicy(ctx.db, scope as 'org', id), effective: scope === 'user' ? effectivePolicy(ctx.db, { id, teamId: (ctx.db.prepare('SELECT team_id FROM users WHERE id = ?').get(id) as Row).team_id }) : undefined });
  });
  r.put('/api/policy/:scope/:id', admin, (req, res) => {
    const scope = String(req.params.scope), id = String(req.params.id);
    if (!['org', 'team', 'user'].includes(scope) || !scopeOk(scope, id)) throw new HttpError(404, 'Unknown policy scope.');
    const value = parse(PartialPolicySchema, req.body);
    if (scope !== 'org' && 'captureAllScreens' in value) throw new HttpError(400, 'Capturing all screens is an organization-wide policy and cannot be overridden by teams or people.');
    // Widening what is collected (key/click counts, every screen instead of one) needs a new notice version so people re-consent.
    const widening = ([['activityTrackingEnabled', 'keyboard and mouse counts'], ['captureAllScreens', 'capturing all screens']] as const).filter(([key]) => value[key] === true);
    if (widening.length) {
      const affected = (scope === 'user'
        ? ctx.db.prepare('SELECT id,team_id FROM users WHERE id = ?').all(id)
        : scope === 'team'
          ? ctx.db.prepare('SELECT id,team_id FROM users WHERE team_id = ?').all(id)
          : ctx.db.prepare('SELECT id,team_id FROM users').all()) as Row[];
      const before = affected.map(user => effectivePolicy(ctx.db, {id: user.id, teamId: user.team_id}));
      const priorVersion = Math.max(0, ...before.map(policy => policy.consentVersion));
      for (const [key, label] of widening) {
        const newlyEnabled = before.some(policy => !policy[key]);
        if (newlyEnabled && (typeof value.consentVersion !== 'number' || value.consentVersion <= priorVersion)) {
          throw new HttpError(422, `Enabling ${label} requires a new monitoring-notice version greater than ${priorVersion}.`);
        }
      }
    }
    try {
      ctx.db.exec('BEGIN IMMEDIATE');
      if (Object.keys(value).length === 0) clearScopePolicy(ctx.db, scope as 'org', id); else setScopePolicy(ctx.db, ctx.cfg.now(), scope as 'org', id, value);
      const affected = (scope === 'user'
        ? ctx.db.prepare('SELECT id,team_id FROM users WHERE id=?').all(id)
        : scope === 'team'
          ? ctx.db.prepare('SELECT id,team_id FROM users WHERE team_id=?').all(id)
          : ctx.db.prepare('SELECT id,team_id FROM users').all()) as Row[];
      for (const user of affected) effectivePolicy(ctx.db, {id: user.id, teamId: user.team_id});
      // Validate this scope even before anyone is assigned to it.
      effectivePolicy(ctx.db, {id: scope === 'user' ? id : '__policy-check__', teamId: scope === 'team' ? id : null});
      ctx.db.exec('COMMIT');
    } catch (error) {
      try { ctx.db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'The policy would create invalid effective settings for one or more employees.');
    }
    audit(ctx.db, ctx.cfg, currentUser(res).id, 'policy.updated', scope, id, value);
    send(res, 200, { overrides: value });
  });

  // ---- audit log ----
  r.get('/api/audit', admin, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const rows = ctx.db.prepare(`SELECT a.id, a.at, a.actor_id, u.name actor_name, a.action, a.target_type, a.target_id, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`).all(limit) as Row[];
    send(res, 200, { entries: rows.map(x => ({ id: x.id, at: x.at, actorId: x.actor_id, actorName: x.actor_name, action: x.action, targetType: x.target_type, targetId: x.target_id, detail: x.detail ? JSON.parse(x.detail) : null })) });
  });

  return r;
}
