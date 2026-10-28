import type { Ctx } from './ctx.ts';
import type { Row } from './db.ts';
import { nowIso } from './db.ts';

export interface Note { kind: string; title: string; body?: string; link?: string; dedupe?: boolean /* skip when the person already has an unread one of this kind */; forceEmail?: boolean /* queue an email even if the person did not opt in to email copies (used by report subscriptions) */; emailBody?: string /* full text for the email; body stays short for the bell */ }

/** Adds an in-app notification for each person (and queues an email for those who asked for email). Never throws into the caller. */
export function notify(ctx: Ctx, userIds: Iterable<string>, note: Note) {
  try {
    const at = nowIso(ctx.cfg.now());
    for (const id of new Set(userIds)) {
      const user = ctx.db.prepare('SELECT id, active, notify_email FROM users WHERE id = ?').get(id) as Row | undefined;
      if (!user || !user.active) continue;
      if (note.dedupe && ctx.db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND kind = ? AND read_at IS NULL').get(id, note.kind)) continue;
      ctx.db.prepare('INSERT INTO notifications (user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?)').run(id, note.kind, note.title.slice(0, 160), note.body?.slice(0, 500) ?? null, note.link ?? null, at);
      if (user.notify_email || note.forceEmail) ctx.db.prepare('INSERT INTO email_outbox (user_id,subject,body,created_at) VALUES (?,?,?,?)').run(id, note.title.slice(0, 160), [note.emailBody ?? note.body, note.forceEmail ? 'You get this because you subscribed to it in My account.' : 'You can turn these emails off in My account.'].filter(Boolean).join('\n\n'), at);
    }
  } catch (error) { console.error('Could not create a notification:', (error as Error).message); }
}

/** The people who review someone's time: their manager, or (without one) every active admin and owner. */
export function reviewersOf(ctx: Ctx, userId: string): string[] {
  const user = ctx.db.prepare('SELECT manager_id FROM users WHERE id = ?').get(userId) as Row | undefined;
  if (user?.manager_id) return [user.manager_id];
  return (ctx.db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('owner','admin') AND id != ?").all(userId) as Row[]).map(r => r.id);
}
export const ownersAndAdmins = (ctx: Ctx): string[] => (ctx.db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('owner','admin')").all() as Row[]).map(r => r.id);

export interface Mailer { send(to: string, subject: string, text: string): Promise<void> }

/**
 * Sends queued emails through the configured mailer (none is configured yet: an email provider account is needed, see
 * server/README.md). Failed sends are retried up to 5 times and the error is kept. Returns how many were sent.
 */
export async function flushOutbox(ctx: Ctx, mailer: Mailer | null, limit = 50): Promise<number> {
  if (!mailer) return 0;
  const rows = ctx.db.prepare(`SELECT o.id, o.subject, o.body, u.email FROM email_outbox o JOIN users u ON u.id = o.user_id WHERE o.sent_at IS NULL AND o.attempts < 5 ORDER BY o.id LIMIT ?`).all(limit) as Row[];
  let sent = 0;
  for (const row of rows) {
    try { await mailer.send(row.email, row.subject, row.body); ctx.db.prepare('UPDATE email_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?').run(nowIso(ctx.cfg.now()), row.id); sent++; }
    catch (error) { ctx.db.prepare('UPDATE email_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String((error as Error).message).slice(0, 200), row.id); }
  }
  return sent;
}
