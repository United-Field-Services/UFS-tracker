import { createApp } from './app.ts';
import { purgeExpiredScreenshots } from './retention.ts';
import { startDirectoryScheduler } from './directory.ts';
import { hashPassword, validatePasswordStrength } from './auth.ts';
import { nowIso } from './db.ts';
import crypto from 'node:crypto';

const { app, ctx } = createApp();

// First run: create the owner from environment variables (never from code or defaults).
const hasUsers = (ctx.db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c > 0;
if (!hasUsers) {
  const email = process.env.TRACKER_OWNER_EMAIL?.trim().toLowerCase(), password = process.env.TRACKER_OWNER_PASSWORD;
  if (!email || !password) {
    console.error('No users exist yet. Set TRACKER_OWNER_EMAIL and TRACKER_OWNER_PASSWORD for the first start (or run `npm run seed:demo` for local demo data).');
    process.exit(1);
  }
  const weak = validatePasswordStrength(password);
  if (weak) { console.error(weak); process.exit(1); }
  ctx.db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,'owner',?,?)")
    .run(crypto.randomUUID(), email, process.env.TRACKER_OWNER_NAME ?? 'Owner', hashPassword(password), nowIso(Date.now()));
  console.log(`Created owner account ${email}.`);
}

startDirectoryScheduler(ctx);
setInterval(() => { purgeExpiredScreenshots(ctx).catch(error => console.error('Retention job failed:', error)); }, 60 * 60_000).unref();
const server = app.listen(ctx.cfg.port, '127.0.0.1', () => console.log(`UFS Tracker server listening on http://127.0.0.1:${ctx.cfg.port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
