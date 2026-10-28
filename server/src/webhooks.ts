import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Ctx } from './ctx.ts';
import type { Row } from './db.ts';
import { nowIso } from './db.ts';
import { audit } from './auth.ts';
import { notify, ownersAndAdmins } from './notifications.ts';

/** Events a webhook can subscribe to. Payloads carry ids, times and statuses only: no names, emails, notes, screenshots, activity or pay. */
export const WEBHOOK_EVENTS = ['time.approved', 'time.rejected', 'time.submitted', 'time.edited', 'ping'] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];  // delay before attempt 2..6
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const AUTO_DISABLE_AFTER = 20;                                                      // consecutive failed deliveries
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------------
// SSRF protection. A webhook may only reach PUBLIC internet hosts: https, a real DNS name, ports 443/8443, and every
// address the name resolves to must be public. The connection is then pinned to the address that was checked, so a
// DNS answer that changes between the check and the connection cannot redirect the request inside the network.
// ---------------------------------------------------------------------------------------------------------------
// Separate lists per family: Node maps IPv4 addresses onto IPv6 rules, so a ::ffff:0:0/96 entry in a shared list would block every IPv4 address.
const blockedV4 = new net.BlockList(), blockedV6 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blockedV4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(a, p, 'ipv6');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');

/** True only for globally routable unicast addresses. Anything unparseable is refused. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address); if (!family) return false;
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

export class WebhookUrlError extends Error {}
/** Validates a webhook URL at registration time (and again before each delivery). */
export function validateWebhookUrl(raw: string, dev = false): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new WebhookUrlError('Enter a full web address, for example https://example.com/hooks/ufs.'); }
  if (url.username || url.password) throw new WebhookUrlError('The address must not contain a user name or password.');
  if (url.hash) throw new WebhookUrlError('The address must not contain a # fragment.');
  if (dev) return url;
  if (url.protocol !== 'https:') throw new WebhookUrlError('Webhooks must use https.');
  const host = url.hostname.toLowerCase();
  if (net.isIP(host) || host.startsWith('[')) throw new WebhookUrlError('Use a host name, not an IP address.');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) throw new WebhookUrlError('Only public internet host names are allowed.');
  if (url.port && !['443', '8443'].includes(url.port)) throw new WebhookUrlError('Only ports 443 and 8443 are allowed.');
  return url;
}

type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
const systemLookup: Lookup = async hostname => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Resolves the host and returns one address after checking that EVERY answer is public (or any address in dev mode). */
export async function resolvePublic(hostname: string, dev: boolean, lookup: Lookup = systemLookup) {
  const answers = await lookup(hostname);
  if (!answers.length) throw new WebhookUrlError('The host name did not resolve.');
  if (!dev && !answers.every(a => isPublicAddress(a.address))) throw new WebhookUrlError('The host resolves to a non-public address, so it was not contacted.');
  return answers[0]!;
}

/** One POST with the connection pinned to `address`. Redirects are never followed (a 3xx counts as a failure). */
function post(url: URL, address: { address: string; family: number }, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'POST', servername: net.isIP(url.hostname) ? undefined : url.hostname,
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, timeout: REQUEST_TIMEOUT_MS,
      lookup: (_host: string, options: any, callback: any) => options?.all ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family),
    }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => req.destroy(new Error('The receiver did not answer within 10 seconds.')));
    req.on('error', reject); req.end(body);
  });
}

const sign = (secret: string, timestamp: string, body: string) => `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
export { sign as signWebhook };

/** Queues one delivery for every active webhook subscribed to the event. Cheap and synchronous: sending happens in the runner. */
export function emitWebhook(ctx: Ctx, event: WebhookEvent, data: Record<string, unknown>) {
  try {
    const hooks = (ctx.db.prepare('SELECT id, events FROM webhooks WHERE active = 1').all() as Row[]).filter(h => (JSON.parse(h.events) as string[]).includes(event));
    const now = ctx.cfg.now();
    for (const hook of hooks) {
      const id = crypto.randomUUID();
      ctx.db.prepare('INSERT INTO webhook_deliveries (id,webhook_id,event,payload,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, hook.id, event, JSON.stringify({ id, event, createdAt: nowIso(now), data }), nowIso(now), nowIso(now));
    }
  } catch (error) { console.error('Could not queue a webhook:', (error as Error).message); }
}

export interface RunnerDeps { lookup?: Lookup }

/** Sends due deliveries (at most `limit` per call). Failures back off 1 min, 5 min, 30 min, 2 h, 12 h; a hook that keeps failing is switched off. */
export async function runWebhookDeliveries(ctx: Ctx, deps: RunnerDeps = {}, limit = 20): Promise<number> {
  const due = ctx.db.prepare(`SELECT d.*, h.url, h.secret, h.active FROM webhook_deliveries d JOIN webhooks h ON h.id = d.webhook_id WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT ?`).all(nowIso(ctx.cfg.now()), limit) as Row[];
  let delivered = 0;
  for (const d of due) {
    const now = ctx.cfg.now();
    if (!d.active) { ctx.db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'The webhook was switched off.' WHERE id = ?").run(d.id); continue; }
    let status = 0, error: string | null = null;
    try {
      const url = validateWebhookUrl(d.url, ctx.cfg.webhookDev);
      const address = await resolvePublic(url.hostname, ctx.cfg.webhookDev, deps.lookup);
      const timestamp = String(Math.floor(now / 1000));
      status = await post(url, address, d.payload, { 'Content-Type': 'application/json', 'User-Agent': 'UFS-Tracker-Webhooks/1', 'X-UFS-Event': d.event, 'X-UFS-Delivery': d.id, 'X-UFS-Timestamp': timestamp, 'X-UFS-Signature': sign(d.secret, timestamp, d.payload) });
      if (status < 200 || status >= 300) error = status >= 300 && status < 400 ? `The receiver answered ${status} (redirects are not followed).` : `The receiver answered ${status}.`;
    } catch (e) { error = (e instanceof WebhookUrlError ? e.message : `Could not deliver: ${String((e as Error).message ?? e).slice(0, 150)}`); }
    const attempts = Number(d.attempts) + 1;
    if (!error) {
      ctx.db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?").run(attempts, status, nowIso(now), d.id);
      ctx.db.prepare('UPDATE webhooks SET consecutive_failures = 0 WHERE id = ?').run(d.webhook_id); delivered++;
    } else {
      const last = attempts >= MAX_ATTEMPTS;
      ctx.db.prepare('UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?').run(last ? 'failed' : 'pending', attempts, status || null, error, nowIso(now + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!)), d.id);
      if (last) {
        const hook = ctx.db.prepare('UPDATE webhooks SET consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures, name').get(d.webhook_id) as Row;
        if (hook && hook.consecutive_failures >= AUTO_DISABLE_AFTER) {
          ctx.db.prepare("UPDATE webhooks SET active = 0, disabled_reason = 'Switched off after repeated failed deliveries.' WHERE id = ?").run(d.webhook_id);
          audit(ctx.db, ctx.cfg, null, 'webhook.auto_disabled', 'webhook', d.webhook_id);
          notify(ctx, ownersAndAdmins(ctx), { kind: 'webhook.disabled', title: `Webhook "${hook.name}" was switched off`, body: 'It failed too many deliveries in a row. Fix the receiver, then turn it back on under Integrations.', link: 'integrations', dedupe: true });
        }
      }
    }
  }
  return delivered;
}
