import type { Ctx } from './ctx.ts';
import { audit } from './auth.ts';
import { nowIso } from './db.ts';
import type { Row } from './db.ts';
import { effectivePolicy } from './policy.ts';

/**
 * Deletes screenshot objects older than each user's effective retention window. Returns the number removed.
 * A record is only marked deleted after its stored object was removed, so a storage outage is retried next run
 * instead of leaving data behind with no record of it. Also set a bucket lifecycle rule as a backstop (see README).
 */
export async function purgeExpiredScreenshots(ctx: Ctx): Promise<number> {
  const now = ctx.cfg.now();
  const users = ctx.db.prepare('SELECT id, team_id FROM users').all() as Row[];
  let removed = 0, failed = 0;
  for (const user of users) {
    const days = effectivePolicy(ctx.db, { id: user.id, teamId: user.team_id }).retentionDays;
    const cutoff = nowIso(now - days * 86400_000);
    const old = ctx.db.prepare('SELECT * FROM screenshots WHERE user_id = ? AND deleted_at IS NULL AND taken_at < ?').all(user.id, cutoff) as Row[];
    for (const shot of old) {
      try {
        await ctx.store.remove(user.id, shot.file_name);
        if (shot.thumb_file_name) await ctx.store.remove(user.id, shot.thumb_file_name);
      } catch (error) { failed++; console.error('Retention: could not remove a stored screenshot:', (error as Error).message); continue; }
      ctx.db.prepare('UPDATE screenshots SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(now), 'retention', shot.id);
      removed++;
    }
  }
  if (removed || failed) audit(ctx.db, ctx.cfg, null, 'retention.purged', 'screenshot', undefined, { removed, failed });
  return removed;
}
