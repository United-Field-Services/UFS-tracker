import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';
import { parse, send } from './ctx.ts';
import type { Row } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError, audit, currentUser, requireRole } from './auth.ts';
import { WEBHOOK_EVENTS, WebhookUrlError, emitWebhook, resolvePublic, runWebhookDeliveries, validateWebhookUrl, type RunnerDeps } from './webhooks.ts';

const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

/** Webhook management for owners and admins. The signing secret is shown once (at creation or rotation). */
export function webhookRoutes(ctx: Ctx, deps: RunnerDeps = {}) {
  const r = Router();
  const admin = requireRole('owner', 'admin');
  const out = (h: Row) => {
    const last = ctx.db.prepare('SELECT status, last_status, last_error, created_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(h.id) as Row | undefined;
    const pending = (ctx.db.prepare("SELECT COUNT(*) c FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'").get(h.id) as Row).c;
    return { id: h.id, name: h.name, url: h.url, events: JSON.parse(h.events) as string[], active: !!h.active, disabledReason: h.disabled_reason, createdAt: h.created_at, pending: Number(pending), last: last ? { status: last.status, httpStatus: last.last_status, error: last.last_error, at: last.created_at } : null };
  };
  const load = (id: string) => { const row = ctx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Row | undefined; if (!row) throw new HttpError(404, 'Webhook not found.'); return row; };

  r.get('/api/admin/webhooks', admin, (_req, res) => { send(res, 200, { webhooks: (ctx.db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as Row[]).map(out), events: WEBHOOK_EVENTS.filter(e => e !== 'ping') }); });

  r.post('/api/admin/webhooks', admin, async (req, res) => {
    const u = currentUser(res);
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), url: z.string().trim().min(8).max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length) }).strict(), req.body);
    if (Number((ctx.db.prepare('SELECT COUNT(*) c FROM webhooks').get() as Row).c) >= 20) throw new HttpError(409, 'At most 20 webhooks.');
    let url: URL;
    try { url = validateWebhookUrl(b.url, ctx.cfg.webhookDev); await resolvePublic(url.hostname, ctx.cfg.webhookDev, deps.lookup); }
    catch (error) { throw new HttpError(422, error instanceof WebhookUrlError ? error.message : 'The host name could not be looked up.'); }
    const id = crypto.randomUUID(), secret = newSecret();
    ctx.db.prepare('INSERT INTO webhooks (id,name,url,secret,events,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, b.name, url.toString(), secret, JSON.stringify([...new Set(b.events)]), u.id, nowIso(ctx.cfg.now()));
    audit(ctx.db, ctx.cfg, u.id, 'webhook.created', 'webhook', id, { name: b.name, host: url.host, events: b.events });
    send(res, 201, { id, secret, note: 'Copy the signing secret now. It is shown only once; rotate it if it is lost.' });
  });

  r.patch('/api/admin/webhooks/:id', admin, (req, res) => {
    const u = currentUser(res); const hook = load(String(req.params.id));
    const b = parse(z.object({ active: z.boolean().optional(), name: z.string().trim().min(2).max(80).optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional() }).strict(), req.body);
    if (b.active !== undefined) ctx.db.prepare('UPDATE webhooks SET active = ?, consecutive_failures = 0, disabled_reason = NULL WHERE id = ?').run(b.active ? 1 : 0, hook.id);
    if (b.name) ctx.db.prepare('UPDATE webhooks SET name = ? WHERE id = ?').run(b.name, hook.id);
    if (b.events) ctx.db.prepare('UPDATE webhooks SET events = ? WHERE id = ?').run(JSON.stringify([...new Set(b.events)]), hook.id);
    audit(ctx.db, ctx.cfg, u.id, 'webhook.updated', 'webhook', hook.id, { ...(b.active !== undefined ? { active: b.active } : {}), ...(b.events ? { events: b.events } : {}) });
    send(res, 200, { webhook: out(load(hook.id)) });
  });

  r.post('/api/admin/webhooks/:id/rotate-secret', admin, (req, res) => {
    const u = currentUser(res); const hook = load(String(req.params.id)); const secret = newSecret();
    ctx.db.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(secret, hook.id);
    audit(ctx.db, ctx.cfg, u.id, 'webhook.secret_rotated', 'webhook', hook.id);
    send(res, 200, { secret, note: 'The old secret stops working immediately. Copy the new one now.' });
  });

  r.post('/api/admin/webhooks/:id/test', admin, async (req, res) => {
    const u = currentUser(res); const hook = load(String(req.params.id));
    if (!hook.active) throw new HttpError(409, 'Turn the webhook on first.');
    emitWebhookTo(ctx, hook.id);
    await runWebhookDeliveries(ctx, deps, 5);
    audit(ctx.db, ctx.cfg, u.id, 'webhook.tested', 'webhook', hook.id);
    send(res, 200, { webhook: out(load(hook.id)) });
  });

  r.get('/api/admin/webhooks/:id/deliveries', admin, (req, res) => {
    const hook = load(String(req.params.id));
    send(res, 200, { deliveries: (ctx.db.prepare('SELECT id, event, status, attempts, last_status, last_error, created_at, delivered_at, next_attempt_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(hook.id) as Row[])
      .map(d => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, httpStatus: d.last_status, error: d.last_error, createdAt: d.created_at, deliveredAt: d.delivered_at, nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null })) });
  });

  r.delete('/api/admin/webhooks/:id', admin, (req, res) => {
    const u = currentUser(res); const hook = load(String(req.params.id));
    ctx.db.prepare('DELETE FROM webhooks WHERE id = ?').run(hook.id);
    audit(ctx.db, ctx.cfg, u.id, 'webhook.deleted', 'webhook', hook.id, { name: hook.name });
    send(res, 200, { ok: true });
  });
  return r;
}

/** A ping aimed at one webhook only (the test button), whatever events it subscribed to. */
function emitWebhookTo(ctx: Ctx, webhookId: string) {
  const id = crypto.randomUUID(), now = nowIso(ctx.cfg.now());
  ctx.db.prepare('INSERT INTO webhook_deliveries (id,webhook_id,event,payload,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, webhookId, 'ping', JSON.stringify({ id, event: 'ping', createdAt: now, data: { message: 'This is a test delivery from UFS Tracker.' } }), now, now);
}
export { emitWebhook };
