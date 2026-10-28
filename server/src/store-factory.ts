import type { Config } from './config.ts';
import { DiskStore, type BlobStore } from './storage.ts';
import { S3Store } from './s3-store.ts';

/**
 * STORAGE_DRIVER=disk (default) keeps screenshots under the data directory.
 * STORAGE_DRIVER=s3 uses any S3-compatible service:
 *   S3_BUCKET (required), S3_REGION (default us-east-1; "auto" for R2), S3_ENDPOINT (R2/MinIO/Supabase),
 *   S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (omit to use an IAM role), S3_FORCE_PATH_STYLE=1,
 *   S3_PREFIX (optional key prefix), S3_SSE=1 (AES256 server-side encryption on AWS S3).
 */
export function createStore(cfg: Config, env: NodeJS.ProcessEnv = process.env): BlobStore {
  const driver = (env.STORAGE_DRIVER ?? 'disk').toLowerCase();
  if (driver === 'disk') return new DiskStore(cfg.screenshotsDir);
  if (driver === 's3') {
    return new S3Store({
      bucket: env.S3_BUCKET ?? '', region: env.S3_REGION, endpoint: env.S3_ENDPOINT || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined, secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === '1', prefix: env.S3_PREFIX, serverSideEncryption: env.S3_SSE === '1',
    });
  }
  throw new Error(`Unknown STORAGE_DRIVER "${driver}". Use "disk" or "s3".`);
}
