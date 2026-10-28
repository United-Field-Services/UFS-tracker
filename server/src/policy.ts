import { z } from 'zod';
import type { Db, Row } from './db.ts';
import { nowIso } from './db.ts';
import { validTimeZone } from './timezone.ts';

// Tracking is always visible to the employee; there is intentionally no covert/silent setting.
export const PolicySchema = z.object({
  screenshotsEnabled: z.boolean(),
  screenshotIntervalSeconds: z.number().int().min(10).max(3600),
  screenshotBlur: z.boolean(),
  captureAllScreens: z.boolean(), // false: the screen the employee picks; true: every connected screen, joined in one image
  idleTimeoutSeconds: z.number().int().min(60).max(3600),
  activityTrackingEnabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(365),
  screenshotVisibility: z.enum(['employee_manager', 'employee_only']),
  allowEmployeeDelete: z.boolean(),
  requireProject: z.boolean(),
  consentVersion: z.number().int().min(1),
  imageFormat: z.enum(['webp', 'png']),
  imageQuality: z.number().int().min(40).max(95),   // WebP quality; ignored for PNG
  breakReminderMinutes: z.number().int().min(0).max(240), // zero disables the in-app prompt
  workScheduleEnabled: z.boolean(),
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length), // local weekday: Sunday=0
  workTimeZone: z.string().refine(validTimeZone, 'must be a valid IANA timezone'),
  workStartLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  workEndLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  lateGraceMinutes: z.number().int().min(0).max(180),
});
export type Policy = z.infer<typeof PolicySchema>;
export const PartialPolicySchema = PolicySchema.partial().strict();

export const DEFAULT_POLICY: Policy = {
  screenshotsEnabled: true,
  screenshotIntervalSeconds: 300,
  screenshotBlur: false,
  captureAllScreens: false,
  idleTimeoutSeconds: 300,
  activityTrackingEnabled: false,
  retentionDays: 90,
  screenshotVisibility: 'employee_manager',
  allowEmployeeDelete: true,
  requireProject: false,
  consentVersion: 1,
  imageFormat: 'webp',   // ~100-150 KB per 1080p screenshot instead of ~0.5 MB as PNG
  imageQuality: 80,
  breakReminderMinutes: 60,
  workScheduleEnabled: false,
  workDays: [1, 2, 3, 4, 5],
  workTimeZone: 'UTC',
  workStartLocal: '09:00',
  workEndLocal: '17:00',
  lateGraceMinutes: 0,
};

export function getScopePolicy(db: Db, scope: 'org' | 'team' | 'user', scopeId: string): Partial<Policy> {
  const row = db.prepare('SELECT json FROM policy WHERE scope = ? AND scope_id = ?').get(scope, scopeId) as Row | undefined;
  return row ? PartialPolicySchema.parse(JSON.parse(row.json)) : {};
}
export function setScopePolicy(db: Db, now: number, scope: 'org' | 'team' | 'user', scopeId: string, value: Partial<Policy>) {
  db.prepare(`INSERT INTO policy (scope,scope_id,json,updated_at) VALUES (?,?,?,?)
              ON CONFLICT(scope,scope_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
    .run(scope, scopeId, JSON.stringify(value), nowIso(now));
}
export function clearScopePolicy(db: Db, scope: 'org' | 'team' | 'user', scopeId: string) {
  db.prepare('DELETE FROM policy WHERE scope = ? AND scope_id = ?').run(scope, scopeId);
}

/** defaults < org < team < user. Lower scopes override higher ones. */
export function effectivePolicy(db: Db, user: { id: string; teamId: string | null }): Policy {
  const policy = {
    ...DEFAULT_POLICY,
    ...getScopePolicy(db, 'org', 'org'),
    ...(user.teamId ? getScopePolicy(db, 'team', user.teamId) : {}),
    ...getScopePolicy(db, 'user', user.id),
  };
  if (policy.workScheduleEnabled && policy.workStartLocal >= policy.workEndLocal) throw new Error('Scheduled work end must be later than its start on the same day.');
  return PolicySchema.parse(policy);
}
