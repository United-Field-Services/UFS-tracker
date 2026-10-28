import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send } from './ctx.ts';
import type { Row } from './db.ts';
import { HttpError, currentUser, requireRole } from './auth.ts';
import { directoryStatus, runDirectorySync } from './directory.ts';

export function directoryRoutes(ctx: Ctx) {
  const r = Router();
  const admin = requireRole('owner', 'admin');

  r.get('/api/directory/status', admin, (_req, res) => send(res, 200, directoryStatus(ctx)));

  // Manual sync. Forcing past the safety guards (empty feed, >30% deactivations) is owner-only and always audited.
  r.post('/api/directory/sync', admin, async (req, res) => {
    const u = currentUser(res);
    const { force } = parse(z.object({ force: z.boolean().optional() }).strict(), req.body ?? {});
    if (force && u.role !== 'owner') throw new HttpError(403, 'Only an owner can force a directory sync past its safety checks.');
    if (!ctx.directory) throw new HttpError(409, 'No directory is configured on this server.');
    if (ctx.directoryState.running) throw new HttpError(409, 'A directory sync is already running.');
    const report = await runDirectorySync(ctx, { trigger: 'manual', force: !!force, actorId: u.id });
    send(res, report.status === 'failed' ? 502 : 200, report);
  });

  r.get('/api/directory/log', admin, (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const rows = ctx.db.prepare('SELECT * FROM directory_sync_log ORDER BY id DESC LIMIT ?').all(limit) as Row[];
    send(res, 200, { entries: rows.map(x => ({ id: x.id, at: x.at, trigger: x.trigger, status: x.status, message: x.message, feedGeneratedAt: x.feed_generated_at, added: x.added, updated: x.updated, deactivated: x.deactivated, reactivated: x.reactivated, unchanged: x.unchanged, warnings: JSON.parse(x.warnings ?? '[]') })) });
  });

  return r;
}
