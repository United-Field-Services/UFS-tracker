import type { Response } from 'express';
import type { ZodType, z } from 'zod';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { BlobStore } from './storage.ts';
import type { DirectoryConfig } from './directory.ts';
import type { SupabaseAuth } from './supabase-auth.ts';
import { LoginLimiter, HttpError } from './auth.ts';

export interface Ctx {
  db: Db; cfg: Config; store: BlobStore; limiter: LoginLimiter;
  /** UFS People directory pull (null = not configured, tracker runs with local accounts only). */
  directory: DirectoryConfig | null; directoryFetch: typeof fetch; directoryState: { running: boolean };
  /** Sign-in with UFS People accounts (null = local tracker accounts only). */
  supabase: SupabaseAuth | null;
}

export function parse<S extends ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new HttpError(400, `${issue.path.join('.') || 'request'}: ${issue.message}`);
  }
  return result.data;
}
export const send = (res: Response, status: number, body: unknown) => { res.status(status).json(body); };
export const isoDate = (value: unknown, name: string): string => {
  const text = String(value ?? '');
  const ms = Date.parse(text);
  if (!text || !Number.isFinite(ms)) throw new HttpError(400, `${name} must be an ISO date.`);
  return new Date(ms).toISOString();
};
