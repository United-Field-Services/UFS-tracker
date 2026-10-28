import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './db.ts';
import type { BlobStore } from './storage.ts';
import { createStore } from './store-factory.ts';
import { HttpError, LoginLimiter, authenticate, blockUntilPasswordChanged, requireRole } from './auth.ts';
import type { Ctx } from './ctx.ts';
import { publicRoutes, accountRoutes, adminRoutes } from './routes-account.ts';
import { trackerRoutes } from './routes-tracker.ts';
import { reportRoutes } from './routes-reports.ts';
import { purgeExpiredScreenshots } from './retention.ts';
import { loadDirectoryConfig, type DirectoryConfig } from './directory.ts';
import { directoryRoutes } from './routes-directory.ts';
import { SupabaseAuth, loadSupabaseConfig } from './supabase-auth.ts';

export interface App { app: express.Express; ctx: Ctx; db: Db; close(): void; }

export function createApp(overrides: Partial<Config> & { store?: BlobStore; db?: Db; directory?: DirectoryConfig | null; directoryFetch?: typeof fetch; supabase?: SupabaseAuth | null } = {}): App {
  const cfg = loadConfig(overrides);
  const db = overrides.db ?? openDb(cfg.dbFile);
  const store = overrides.store ?? createStore(cfg);
  const ctx: Ctx = { db, cfg, store, limiter: new LoginLimiter(cfg.now), directory: overrides.directory === undefined ? loadDirectoryConfig(process.env) : overrides.directory, directoryFetch: overrides.directoryFetch ?? fetch, directoryState: { running: false },
    supabase: overrides.supabase !== undefined ? overrides.supabase : (() => { const c = loadSupabaseConfig(process.env); return c ? new SupabaseAuth(c, fetch, cfg.now) : null; })() };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.use(publicRoutes(ctx));

  const authed = express.Router();
  authed.use('/api', authenticate(db, cfg), blockUntilPasswordChanged);
  authed.use(accountRoutes(ctx));
  authed.use(adminRoutes(ctx));
  authed.use(trackerRoutes(ctx));
  authed.use(reportRoutes(ctx));
  authed.use(directoryRoutes(ctx));
  authed.post('/api/admin/retention/run', requireRole('owner', 'admin'), async (_req, res) => { res.json({ removed: await purgeExpiredScreenshots(ctx) }); });
  app.use(authed);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use(express.static(path.resolve(import.meta.dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = error as { status?: number; type?: string; message?: string };
    if (error instanceof HttpError) return void res.status(error.status).json({ error: error.message, code: error.status, ...error.extra });
    if (e?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request is too large.', code: 413 });
    if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON.', code: 400 });
    if (e?.status && e.status >= 400 && e.status < 500) return void res.status(e.status).json({ error: e.message ?? 'Bad request.', code: e.status });
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Something went wrong.', code: 500 });
  });

  return { app, ctx, db, close: () => { try { db.close(); } catch { /* already closed */ } } };
}
