import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { audit, type Role } from './auth.ts';
import { nowIso, type Row } from './db.ts';
import { notify, ownersAndAdmins } from './notifications.ts';

/**
 * UFS People directory feed (read-only, pull). The tracker never connects to UFS People's database. UFS People
 * exposes one endpoint that returns ONLY the fields below; this module refuses anything else.
 *
 *   GET <DIRECTORY_URL>   Authorization: Bearer <DIRECTORY_TOKEN>
 *   { "version": 1, "generatedAt": ISO,
 *     "employees":  [{ id, email, name, managerId|null, role, active, department?, location?, title? }],
 *     "identities": [{ subject (Supabase user id), employeeId, enabled, notBefore? }] }   notBefore = password-reset cutoff (optional)
 *
 * Roles use UFS People's names: employee, manager, hr_manager, hiring_manager, admin.
 */

export interface DirectoryConfig { url: string; token: string; intervalMinutes: number; ownerEmployeeId: string | null; }

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function loadDirectoryConfig(env: NodeJS.ProcessEnv): DirectoryConfig | null {
  const rawUrl = env.DIRECTORY_URL?.trim(), token = env.DIRECTORY_TOKEN?.trim();
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) throw new Error('Set both DIRECTORY_URL and DIRECTORY_TOKEN (or neither).');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('DIRECTORY_URL is not a valid URL.'); }
  if (url.username || url.password) throw new Error('DIRECTORY_URL must not contain credentials; use DIRECTORY_TOKEN.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) throw new Error('DIRECTORY_URL must use https (http is only allowed for localhost).');
  if (token.length < 16) throw new Error('DIRECTORY_TOKEN is too short; use a long random secret (16+ characters).');
  const minutes = Number(env.DIRECTORY_SYNC_MINUTES ?? 15);
  return { url: url.toString(), token, intervalMinutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : 15, ownerEmployeeId: env.DIRECTORY_OWNER_EMPLOYEE_ID?.trim() || null };
}

// ---------------- feed contract ----------------
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPLOYEE_KEYS = ['id', 'email', 'name', 'managerId', 'role', 'active', 'department', 'location', 'title'];
const IDENTITY_KEYS = ['subject', 'employeeId', 'enabled', 'notBefore'];
const TOP_KEYS = ['version', 'generatedAt', 'employees', 'identities'];
// A feed that carries anything that looks like HR-sensitive data is refused outright: the endpoint must be fixed at the source.
const FORBIDDEN_KEY = /salary|compens|wage|bonus|pay|birth|dob|passport|national|tax|ssn|bank|iban|account|address|phone|gender|marital|citizen|medical|health|emergency|benefit|pension|insur|visa|religio|ethnic|disab|personal|private|home|contract|identifier|password|secret|token/i;

const EmployeeSchema = z.object({
  id: z.string().regex(ID), email: z.string().trim().toLowerCase().max(200).pipe(z.email()), name: z.string().trim().min(1).max(120),
  managerId: z.string().regex(ID).nullable().optional(), role: z.string().trim().min(1).max(40), active: z.boolean(),
  department: z.string().trim().max(100).default(''), location: z.string().trim().max(100).default(''), title: z.string().trim().max(120).default(''),
});
const IdentitySchema = z.object({ subject: z.string().regex(UUID).transform(s => s.toLowerCase()), employeeId: z.string().regex(ID), enabled: z.boolean(), notBefore: z.string().max(40).nullable().optional() });
export type FeedEmployee = z.infer<typeof EmployeeSchema>;
export type FeedIdentity = Omit<z.infer<typeof IdentitySchema>, 'notBefore'> & { notBefore: string | null };
export interface ParsedFeed { generatedAt: string; employees: FeedEmployee[]; identities: FeedIdentity[]; warnings: string[]; }

export class SyncProblem extends Error {
  kind: 'blocked' | 'failed';
  constructor(kind: 'blocked' | 'failed', message: string) { super(message); this.kind = kind; }
}
const blocked = (m: string) => new SyncProblem('blocked', m);

/** Validates an untrusted feed. Throws SyncProblem('blocked') when it must not be applied at all. */
export function parseFeed(raw: unknown, now: number): ParsedFeed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw blocked('The directory feed is not a JSON object.');
  const top = raw as Record<string, unknown>;
  if (top.version !== 1) throw blocked(`Unsupported directory feed version (${String(top.version)}); this tracker understands version 1.`);
  const generated = Date.parse(String(top.generatedAt));
  if (!Number.isFinite(generated)) throw blocked('The directory feed has no valid generatedAt time.');
  if (generated > now + 10 * 60_000) throw blocked('The directory feed is dated in the future.');
  if (generated < now - 48 * 3600_000) throw blocked('The directory feed is more than 48 hours old; refusing to apply a stale snapshot.');
  if (!Array.isArray(top.employees)) throw blocked('The directory feed has no employees list.');
  if (top.employees.length > 5000) throw blocked('The directory feed has more than 5000 employees.');
  const identitiesRaw = top.identities === undefined ? [] : top.identities;
  if (!Array.isArray(identitiesRaw) || identitiesRaw.length > 20000) throw blocked('The directory feed identities list is invalid.');

  const warnings: string[] = []; const unexpected = new Set<string>();
  const check = (obj: Record<string, unknown>, allowed: string[], where: string) => {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      if (FORBIDDEN_KEY.test(key)) throw blocked(`The directory feed contains a field named "${key}" (${where}). Sensitive HR fields must never be shared with the tracker; fix the export on the UFS People side.`);
      unexpected.add(key);
    }
  };
  for (const key of Object.keys(top)) if (!TOP_KEYS.includes(key)) { if (FORBIDDEN_KEY.test(key)) throw blocked(`The directory feed contains a top-level field named "${key}". Sensitive HR fields must never be shared with the tracker.`); unexpected.add(key); }

  const employees: FeedEmployee[] = []; let invalid = 0;
  for (const row of top.employees) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid++; warnings.push('An employee entry was not an object and was skipped.'); continue; }
    check(row as Record<string, unknown>, EMPLOYEE_KEYS, 'employee');
    const parsed = EmployeeSchema.safeParse(row);
    if (!parsed.success) { invalid++; warnings.push(`Employee ${String((row as any).id ?? '?').slice(0, 40)} skipped: ${parsed.error.issues[0]!.path.join('.') || 'entry'} is invalid.`); continue; }
    employees.push(parsed.data);
  }
  if (invalid > 0 && invalid / top.employees.length > 0.1) throw blocked(`${invalid} of ${top.employees.length} employee entries are invalid (more than 10%); refusing to apply the feed.`);
  const ids = new Set<string>(), emails = new Set<string>();
  for (const e of employees) {
    if (ids.has(e.id)) throw blocked(`Duplicate employee id "${e.id}" in the directory feed.`);
    if (emails.has(e.email)) throw blocked(`Duplicate email in the directory feed (employee ${e.id}).`);
    ids.add(e.id); emails.add(e.email);
  }

  const identities: FeedIdentity[] = []; const subjects = new Set<string>();
  for (const row of identitiesRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { warnings.push('An identity entry was not an object and was skipped.'); continue; }
    check(row as Record<string, unknown>, IDENTITY_KEYS, 'identity');
    const parsed = IdentitySchema.safeParse(row);
    if (!parsed.success) { warnings.push('An identity entry was invalid and was skipped.'); continue; }
    let notBefore: string | null = null;
    if (parsed.data.notBefore) { const t = Date.parse(parsed.data.notBefore); if (Number.isFinite(t)) notBefore = new Date(t).toISOString(); else { warnings.push('An identity had an invalid notBefore and was skipped.'); continue; } }
    if (subjects.has(parsed.data.subject)) throw blocked('The same sign-in identity appears more than once in the directory feed.');
    subjects.add(parsed.data.subject);
    if (!ids.has(parsed.data.employeeId)) { warnings.push(`An identity points to an employee that is not in the feed (${parsed.data.employeeId}); skipped.`); continue; }
    identities.push({ subject: parsed.data.subject, employeeId: parsed.data.employeeId, enabled: parsed.data.enabled, notBefore });
  }
  if (unexpected.size) warnings.push(`Ignored unexpected fields (names only, values never stored): ${[...unexpected].sort().slice(0, 12).join(', ')}.`);
  return { generatedAt: new Date(generated).toISOString(), employees, identities, warnings };
}

// ---------------- role mapping ----------------
const ROLE_MAP: Record<string, Role> = { admin: 'admin', hr_manager: 'hr', manager: 'manager', employee: 'employee', hiring_manager: 'employee' };
/** UFS People role -> tracker role. Unknown roles get the least privilege and are reported. */
export function mapRole(sourceRole: string): { role: Role; known: boolean } {
  const role = ROLE_MAP[sourceRole];
  return role ? { role, known: true } : { role: 'employee', known: false };
}

// ---------------- sync ----------------
export interface SyncReport { status: 'ok' | 'blocked' | 'failed'; message: string | null; added: number; updated: number; deactivated: number; reactivated: number; unchanged: number; warnings: string[]; feedGeneratedAt: string | null; }
const empty = (status: SyncReport['status'], message: string | null, warnings: string[] = [], feedGeneratedAt: string | null = null): SyncReport => ({ status, message, added: 0, updated: 0, deactivated: 0, reactivated: 0, unchanged: 0, warnings, feedGeneratedAt });
const NO_PASSWORD = 'directory:no-password'; // never matches the scrypt format, so password login is impossible for projected users

export async function fetchFeed(ctx: Ctx): Promise<unknown> {
  const cfg = ctx.directory!;
  let res: Response;
  try { res = await ctx.directoryFetch(cfg.url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new SyncProblem('failed', 'Could not reach the directory.'); }
  if (res.status === 401 || res.status === 403) throw new SyncProblem('failed', 'The directory rejected the access token.');
  if (!res.ok) throw new SyncProblem('failed', `The directory returned HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > 5_000_000) throw blocked('The directory feed is larger than 5 MB.');
  try { return JSON.parse(text); } catch { throw blocked('The directory feed is not valid JSON.'); }
}

/** Fetches, validates and applies the directory. Never throws; always returns (and logs) a report. */
export async function runDirectorySync(ctx: Ctx, opts: { trigger: 'schedule' | 'manual' | 'startup'; force?: boolean; actorId?: string | null } = { trigger: 'manual' }): Promise<SyncReport> {
  if (!ctx.directory) return empty('failed', 'No directory is configured (set DIRECTORY_URL and DIRECTORY_TOKEN).');
  if (ctx.directoryState.running) return empty('failed', 'A directory sync is already running.');
  ctx.directoryState.running = true;
  let report: SyncReport;
  try {
    const parsed = parseFeed(await fetchFeed(ctx), ctx.cfg.now());
    report = applyFeed(ctx, parsed, { force: !!opts.force, actorId: opts.actorId ?? null });
  } catch (error) {
    if (error instanceof SyncProblem) report = empty(error.kind, error.message);
    else { console.error('Directory sync crashed:', (error as Error).message); report = empty('failed', 'The directory sync failed unexpectedly; nothing was changed.'); }
  } finally { ctx.directoryState.running = false; }
  ctx.db.prepare('INSERT INTO directory_sync_log (at,trigger,status,feed_generated_at,added,updated,deactivated,reactivated,unchanged,message,warnings) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(nowIso(ctx.cfg.now()), opts.trigger, report.status, report.feedGeneratedAt, report.added, report.updated, report.deactivated, report.reactivated, report.unchanged, report.message, JSON.stringify(report.warnings.slice(0, 50)));
  audit(ctx.db, ctx.cfg, opts.actorId ?? null, report.status === 'ok' ? 'directory.synced' : report.status === 'blocked' ? 'directory.sync_blocked' : 'directory.sync_failed', 'directory', undefined,
    { trigger: opts.trigger, forced: !!opts.force, added: report.added, updated: report.updated, deactivated: report.deactivated, reactivated: report.reactivated, message: report.message });
  if (report.status !== 'ok') notify(ctx, ownersAndAdmins(ctx), { kind: `directory.${report.status}`, title: report.status === 'blocked' ? 'A UFS People directory sync was blocked' : 'A UFS People directory sync failed', body: report.message ?? undefined, link: 'people', dedupe: true });
  return report;
}

function applyFeed(ctx: Ctx, feed: ParsedFeed, opts: { force: boolean; actorId: string | null }): SyncReport {
  const { db, cfg } = ctx; const now = nowIso(cfg.now()); const warnings = [...feed.warnings];
  const previous = db.prepare("SELECT feed_generated_at FROM directory_sync_log WHERE status = 'ok' AND feed_generated_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as Row | undefined;
  if (previous && feed.generatedAt < previous.feed_generated_at) throw blocked('The directory feed is older than the last applied feed; refusing to go back in time.');

  const byId = new Map(feed.employees.map(e => [e.id, e]));
  const existing = db.prepare("SELECT * FROM users WHERE source = 'directory'").all() as Row[];
  const existingByDir = new Map(existing.map(u => [u.directory_id as string, u]));

  // Guard against a broken export locking everyone out.
  const activeBefore = existing.filter(u => u.active).length;
  const losing = existing.filter(u => u.active && (!byId.has(u.directory_id) || !byId.get(u.directory_id)!.active)).length;
  if (!opts.force) {
    if (feed.employees.length === 0 && activeBefore > 0) throw blocked('The directory feed is empty, which would deactivate everyone. Refusing to apply it (an owner can force it).');
    if (activeBefore >= 10 && losing / activeBefore > 0.3) throw blocked(`This sync would deactivate ${losing} of ${activeBefore} people (more than 30%). Refusing to apply it; an owner can review and force it.`);
  }

  // Manager cycles and self-management are broken (reported), never stored.
  const managerOf = new Map<string, string | null>();
  for (const e of feed.employees) managerOf.set(e.id, e.managerId && e.managerId !== e.id && byId.has(e.managerId) ? e.managerId : null);
  for (const e of feed.employees) {
    if (e.managerId === e.id) warnings.push(`Employee ${e.id} lists themselves as manager; ignored.`);
    else if (e.managerId && !byId.has(e.managerId)) warnings.push(`Employee ${e.id} has a manager (${e.managerId}) who is not in the feed; no manager set.`);
  }
  const inCycle = new Set<string>();
  for (const e of feed.employees) {
    const seen: string[] = []; let cur: string | null | undefined = e.id;
    while (cur && !seen.includes(cur)) { seen.push(cur); cur = managerOf.get(cur) ?? null; }
    if (cur && seen.includes(cur)) for (const id of seen.slice(seen.indexOf(cur))) inCycle.add(id);
  }
  for (const id of inCycle) managerOf.set(id, null);
  if (inCycle.size) warnings.push(`Manager loop among ${[...inCycle].sort().slice(0, 10).join(', ')}; their manager links were cleared.`);

  const report = empty('ok', null, warnings, feed.generatedAt); const changed: string[] = [];
  const teamId = (name: string): string | null => {
    if (!name) return null;
    const found = db.prepare('SELECT id FROM teams WHERE name = ?').get(name) as Row | undefined;
    if (found) return found.id;
    const id = crypto.randomUUID(); db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').run(id, name, now); return id;
  };
  const otherActiveOwners = (exceptId: string) => (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'owner' AND active = 1 AND id != ?").get(exceptId) as Row).c as number;
  const revoke = (userId: string) => {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
    db.prepare("UPDATE presence SET status = 'stopped', last_seen_at = ? WHERE user_id = ?").run(now, userId);
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of feed.employees) {
      const mapped = mapRole(e.role);
      if (!mapped.known) warnings.push(`Employee ${e.id} has an unknown role "${e.role}"; treated as employee.`);
      const isOwner = !!ctx.directory!.ownerEmployeeId && ctx.directory!.ownerEmployeeId === e.id && e.active;
      let desiredRole: Role = isOwner ? 'owner' : mapped.role;
      const desiredTeam = teamId(e.department);
      db.prepare(`INSERT INTO directory_employees (id,email,name,manager_id,source_role,active,department,location,title,first_seen_at,updated_at,removed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, manager_id=excluded.manager_id, source_role=excluded.source_role, active=excluded.active,
          department=excluded.department, location=excluded.location, title=excluded.title, removed_at=NULL,
          updated_at = CASE WHEN directory_employees.email IS excluded.email AND directory_employees.name IS excluded.name AND directory_employees.manager_id IS excluded.manager_id
            AND directory_employees.source_role IS excluded.source_role AND directory_employees.active IS excluded.active AND directory_employees.department IS excluded.department
            AND directory_employees.location IS excluded.location AND directory_employees.title IS excluded.title AND directory_employees.removed_at IS NULL THEN directory_employees.updated_at ELSE excluded.updated_at END`)
        .run(e.id, e.email, e.name, e.managerId ?? null, e.role, e.active ? 1 : 0, e.department, e.location, e.title, now, now);

      const u = existingByDir.get(e.id);
      if (!u) {
        if (!e.active) { report.unchanged++; continue; }                       // never create accounts for people who are already inactive
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(e.email)) { warnings.push(`Employee ${e.id}: the email is already used by another tracker account; no account was created.`); report.unchanged++; continue; }
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO users (id,email,name,role,team_id,password_hash,active,must_change_password,created_at,source,directory_id) VALUES (?,?,?,?,?,?,1,0,?,'directory',?)")
          .run(id, e.email, e.name, desiredRole, desiredTeam, NO_PASSWORD, now, e.id);
        report.added++; changed.push(e.id); continue;
      }
      // existing projected user
      let email = e.email;
      const clash = email !== u.email ? db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, u.id) as Row | undefined : undefined;
      if (clash) { warnings.push(`Employee ${e.id}: the new email is already used by another tracker account; kept the old one.`); email = u.email; }
      let active = e.active ? 1 : 0;
      if (u.role === 'owner' && desiredRole !== 'owner' && otherActiveOwners(u.id) === 0) { desiredRole = 'owner'; warnings.push(`Employee ${e.id} is the last active owner; the owner role was kept.`); }
      if (u.active && !active && u.role === 'owner' && desiredRole === 'owner' && otherActiveOwners(u.id) === 0) { active = 1; warnings.push(`Employee ${e.id} is the last active owner; they were not deactivated.`); }
      const diff = email !== u.email || e.name !== u.name || desiredRole !== u.role || desiredTeam !== u.team_id || active !== u.active;
      if (!diff) { report.unchanged++; continue; }
      db.prepare('UPDATE users SET email=?, name=?, role=?, team_id=?, active=? WHERE id=?').run(email, e.name, desiredRole, desiredTeam, active, u.id);
      if (u.active && !active) { report.deactivated++; revoke(u.id); } else if (!u.active && active) report.reactivated++; else report.updated++;
      changed.push(e.id);
    }
    // people the directory no longer lists are treated as leavers
    for (const u of existing) {
      if (byId.has(u.directory_id)) continue;
      db.prepare("UPDATE directory_employees SET active = 0, removed_at = COALESCE(removed_at, ?), updated_at = ? WHERE id = ? AND removed_at IS NULL").run(now, now, u.directory_id);
      if (!u.active) { report.unchanged++; continue; }
      if (u.role === 'owner' && otherActiveOwners(u.id) === 0) { warnings.push(`Employee ${u.directory_id} is the last active owner and is missing from the feed; they were not deactivated.`); continue; }
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id); revoke(u.id); report.deactivated++; changed.push(u.directory_id);
    }
    // manager links (second pass so managers always exist first, whatever the feed order)
    const userIdOf = new Map((db.prepare("SELECT id, directory_id FROM users WHERE source = 'directory'").all() as Row[]).map(r => [r.directory_id as string, r.id as string]));
    for (const e of feed.employees) {
      const uid = userIdOf.get(e.id); if (!uid) continue;
      const managerUser = managerOf.get(e.id) ? userIdOf.get(managerOf.get(e.id)!) ?? null : null;
      const row = db.prepare('SELECT manager_id FROM users WHERE id = ?').get(uid) as Row;
      if ((row.manager_id ?? null) !== managerUser) { db.prepare('UPDATE users SET manager_id = ? WHERE id = ?').run(managerUser, uid); if (!changed.includes(e.id)) { report.updated++; report.unchanged = Math.max(0, report.unchanged - 1); changed.push(e.id); } }
    }
    // sign-in identities (Supabase subject -> employee): never matched by email; identities missing from the feed are disabled, not deleted.
    // Tracker sessions created from a Supabase login are revoked when their identity is disabled, moved or cut off.
    const revokeSub = (sub: string, before?: string) => {
      const r = before
        ? db.prepare('UPDATE sessions SET revoked_at = ? WHERE supabase_sub = ? AND revoked_at IS NULL AND created_at < ?').run(now, sub, before)
        : db.prepare('UPDATE sessions SET revoked_at = ? WHERE supabase_sub = ? AND revoked_at IS NULL').run(now, sub);
      return Number(r.changes);
    };
    const seen = new Set<string>(); let identitySessionsRevoked = 0;
    for (const i of feed.identities) {
      seen.add(i.subject);
      const old = db.prepare('SELECT employee_id, enabled FROM directory_identities WHERE subject = ?').get(i.subject) as Row | undefined;
      if (old && old.employee_id !== i.employeeId) { warnings.push('A sign-in identity was moved to a different employee in the feed.'); identitySessionsRevoked += revokeSub(i.subject); }
      db.prepare(`INSERT INTO directory_identities (subject,employee_id,enabled,not_before,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(subject) DO UPDATE SET employee_id=excluded.employee_id, enabled=excluded.enabled, not_before=excluded.not_before, updated_at=excluded.updated_at`).run(i.subject, i.employeeId, i.enabled ? 1 : 0, i.notBefore, now);
      if (!i.enabled) identitySessionsRevoked += revokeSub(i.subject);
      else if (i.notBefore) identitySessionsRevoked += revokeSub(i.subject, i.notBefore);
    }
    for (const row of db.prepare('SELECT subject FROM directory_identities WHERE enabled = 1').all() as Row[]) if (!seen.has(row.subject)) { db.prepare('UPDATE directory_identities SET enabled = 0, updated_at = ? WHERE subject = ?').run(now, row.subject); identitySessionsRevoked += revokeSub(row.subject); }
    if (identitySessionsRevoked) warnings.push(`${identitySessionsRevoked} sign-in session(s) were revoked because their identity was disabled, moved or cut off by a password reset.`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
  report.message = `Applied: ${report.added} added, ${report.updated} updated, ${report.deactivated} deactivated, ${report.reactivated} reactivated.`;
  void opts.actorId;
  return report;
}

export function directoryStatus(ctx: Ctx) {
  const db = ctx.db; const last = db.prepare('SELECT * FROM directory_sync_log ORDER BY id DESC LIMIT 1').get() as Row | undefined;
  const lastOk = db.prepare("SELECT at FROM directory_sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as Row | undefined;
  const count = (sql: string) => Number((db.prepare(sql).get() as Row).c);
  return {
    enabled: !!ctx.directory, host: ctx.directory ? new URL(ctx.directory.url).host : null, intervalMinutes: ctx.directory?.intervalMinutes ?? null, ownerConfigured: !!ctx.directory?.ownerEmployeeId, running: ctx.directoryState.running,
    lastSync: last ? { at: last.at, trigger: last.trigger, status: last.status, message: last.message, added: last.added, updated: last.updated, deactivated: last.deactivated, reactivated: last.reactivated, unchanged: last.unchanged, warnings: JSON.parse(last.warnings ?? '[]') } : null,
    lastSuccessAt: lastOk?.at ?? null,
    counts: { employees: count('SELECT COUNT(*) c FROM directory_employees'), activeUsers: count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 1"), inactiveUsers: count("SELECT COUNT(*) c FROM users WHERE source = 'directory' AND active = 0"), identities: count('SELECT COUNT(*) c FROM directory_identities WHERE enabled = 1') },
  };
}

/** Runs a sync at startup and then on the configured interval. Returns a stop function. */
export function startDirectoryScheduler(ctx: Ctx): () => void {
  if (!ctx.directory) return () => {};
  const run = (trigger: 'startup' | 'schedule') => { runDirectorySync(ctx, { trigger }).then(r => { if (r.status !== 'ok') console.error(`Directory sync ${r.status}: ${r.message}`); }).catch(e => console.error('Directory sync error:', (e as Error).message)); };
  run('startup');
  const timer = setInterval(() => run('schedule'), ctx.directory.intervalMinutes * 60_000); timer.unref();
  return () => clearInterval(timer);
}
