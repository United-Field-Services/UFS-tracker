import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { assertSafeKey, type BlobStore } from './storage.ts';

export interface S3Options {
  bucket: string;
  region?: string;               // 'auto' for Cloudflare R2
  endpoint?: string;             // set for R2, MinIO, Supabase Storage (S3 protocol); omit for AWS S3
  accessKeyId?: string;          // omit to use the SDK's default chain (IAM role, env, profile)
  secretAccessKey?: string;
  forcePathStyle?: boolean;      // MinIO and most self-hosted gateways
  prefix?: string;               // key prefix, e.g. "screenshots/"
  serverSideEncryption?: boolean; // adds AES256 SSE for AWS S3 (leave off for R2)
}

/** S3-compatible object storage. Works with AWS S3, Cloudflare R2, Supabase Storage, MinIO and similar. */
export class S3Store implements BlobStore {
  private client: S3Client; private bucket: string; private prefix: string; private sse: boolean;
  constructor(options: S3Options) {
    if (!options.bucket) throw new Error('S3 bucket is required.');
    if ((options.accessKeyId && !options.secretAccessKey) || (!options.accessKeyId && options.secretAccessKey)) throw new Error('Set both S3 access key id and secret, or neither.');
    this.bucket = options.bucket; this.sse = !!options.serverSideEncryption;
    this.prefix = (options.prefix ?? '').replace(/^\/+/, ''); if (this.prefix && !this.prefix.endsWith('/')) this.prefix += '/';
    this.client = new S3Client({
      region: options.region ?? 'us-east-1', endpoint: options.endpoint, forcePathStyle: options.forcePathStyle,
      credentials: options.accessKeyId ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey! } : undefined,
      // Only send checksums when a service requires them: keeps R2, MinIO and older gateways happy.
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }
  private key(userId: string, fileName: string) { assertSafeKey(userId, fileName); return `${this.prefix}${userId}/${fileName}`; }
  async put(userId: string, fileName: string, bytes: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(userId, fileName), Body: bytes, ContentLength: bytes.length, ServerSideEncryption: this.sse ? 'AES256' : undefined, CacheControl: 'private, no-store' }));
  }
  async get(userId: string, fileName: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(userId, fileName) }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
  async remove(userId: string, fileName: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(userId, fileName) })); // S3 returns success for missing keys
  }
}
