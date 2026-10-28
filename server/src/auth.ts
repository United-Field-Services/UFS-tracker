import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Db, Row } from './db.ts';
import { nowIso } from './db.ts';
import type { Config } from './config.ts';

export type Role = 'owner' | 'admin' | 'hr' | 'manager' | 'employee';
export interface AuthUser { id: string; email: string; name: string; role: Role; managerId: string | null; teamId: string | null; mustChangePassword: boolean; sessionHash: string; sessionKind: 'web' | 'device'; }

export class HttpError extends Error {
  status: number; extra: Record<string, unknown> | undefined;
  constructor(status: number, message: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

// ---- passwords (scrypt, per-user salt) ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(actual, expected);
}
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 128) return 'Password must be at most 128 characters.';
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain letters and at least one number.';
  return null;
}
// Verified against a dummy hash when the account does not exist, so response time does not reveal valid emails.
const DUMMY_HASH = hashPassword('dummy-password-for-timing-1');
export const dummyVerify = (password: string) => verifyPassword(password, DUMMY_HASH);

// ---- tokens: opaque random, stored only as SHA-256 ----
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export interface SessionOrigin { authSource: 'local' | 'supabase'; sub?: string; aal?: string; maxDeviceDays?: number; }
/** Issues a tracker session token. Only its SHA-256 is stored; Supabase tokens are never stored at all. */
export function issueToken(db: Db, cfg: Config, userId: string, kind: 'web' | 'device', deviceName: string | null, origin: SessionOrigin = { authSource: 'local' }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const created = cfg.now();
  const deviceDays = origin.maxDeviceDays ? Math.min(cfg.deviceSessionDays, origin.maxDeviceDays) : cfg.deviceSessionDays;
  const ttl = kind === 'web' ? cfg.webSessionHours * 3600_000 : deviceDays * 86400_000;
  db.prepare('INSERT INTO sessions (token_hash,user_id,kind,device_name,created_at,last_seen_at,expires_at,auth_source,supabase_sub,aal) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(sha256(token), userId, kind, deviceName, nowIso(created), nowIso(created), nowIso(created + ttl), origin.authSource, origin.sub ?? null, origin.aal ?? null);
  return { token, expiresAt: nowIso(created + ttl) };
}
export const tokenHash = sha256;

// ---- login throttling (in memory; per email and per ip) ----
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  private now: () => number; private max: number; private maxPerIp: number; private windowMs: number;
  // Per-account limit is strict; the per-IP limit is loose so one shared office/NAT address cannot lock everyone out.
  constructor(now: () => number, max = 8, windowMs = 15 * 60_000, maxPerIp = 60) { this.now = now; this.max = max; this.windowMs = windowMs; this.maxPerIp = maxPerIp; }
  private recent(key: string) { const cutoff = this.now() - this.windowMs; const list = (this.fails.get(key) ?? []).filter(t => t > cutoff); this.fails.set(key, list); return list; }
  blocked(...keys: string[]) { return keys.some(k => this.recent(k).length >= (k.startsWith('ip:') ? this.maxPerIp : this.max)); }
  failure(...keys: string[]) { for (const k of keys) this.recent(k).push(this.now()); }
  success(...keys: string[]) { for (const k of keys) this.fails.delete(k); }
}

// ---- request authentication ----
export function authenticate(db: Db, cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
    if (!match) return next(new HttpError(401, 'Sign in required.'));
    const hash = sha256(match[1]!);
    const row = db.prepare(`SELECT s.token_hash, s.kind, s.expires_at, s.revoked_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash) as Row | undefined;
    const now = cfg.now();
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= now || !row.active) return next(new HttpError(401, 'Session expired. Sign in again.'));
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(now), hash);
    res.locals.user = { id: row.id, email: row.email, name: row.name, role: row.role, managerId: row.manager_id, teamId: row.team_id, mustChangePassword: !!row.must_change_password, sessionHash: hash, sessionKind: row.kind } satisfies AuthUser;
    next();
  };
}
export const currentUser = (res: Response): AuthUser => res.locals.user as AuthUser;

export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction) => roles.includes(currentUser(res).role) ? next() : next(new HttpError(403, 'You do not have permission to do that.'));
}
// A user who must change their password may only change it (and read their own profile / sign out).
export function blockUntilPasswordChanged(req: Request, res: Response, next: NextFunction) {
  const allowed = ['/api/me', '/api/auth/change-password', '/api/auth/logout'];
  if (currentUser(res).mustChangePassword && !allowed.includes(req.originalUrl.split('?')[0]!)) return next(new HttpError(403, 'Change your password first.'));
  next();
}

// ---- who may see whom ----
export const isAdmin = (u: AuthUser) => u.role === 'owner' || u.role === 'admin';
/** HR can read everyone's time and screenshots (subject to the screenshot visibility policy) but never edits, approves or deletes. */
export const canViewAll = (u: AuthUser) => isAdmin(u) || u.role === 'hr';
/** null = everyone. Otherwise the set of user ids this actor may see (self + direct reports for managers). */
export function visibleUserIds(db: Db, actor: AuthUser): Set<string> | null {
  if (canViewAll(actor)) return null;
  const ids = new Set<string>([actor.id]);
  if (actor.role === 'manager') for (const r of db.prepare('SELECT id FROM users WHERE manager_id = ?').all(actor.id) as Row[]) ids.add(r.id);
  return ids;
}
export const canSeeUser = (db: Db, actor: AuthUser, targetId: string) => { const v = visibleUserIds(db, actor); return v === null || v.has(targetId); };

export function audit(db: Db, cfg: Config, actorId: string | null, action: string, targetType?: string, targetId?: string, detail?: unknown) {
  db.prepare('INSERT INTO audit_log (at,actor_id,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?)')
    .run(nowIso(cfg.now()), actorId, action, targetType ?? null, targetId ?? null, detail === undefined ? null : JSON.stringify(detail));
}
