import fs from 'node:fs';
import path from 'node:path';

/** Where screenshot bytes live. Disk for local pilots; S3-compatible object storage for real use (see s3-store.ts). */
export interface BlobStore {
  put(userId: string, fileName: string, bytes: Buffer): Promise<void>;
  get(userId: string, fileName: string): Promise<Buffer | null>;
  remove(userId: string, fileName: string): Promise<void>;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_ID = /^[A-Za-z0-9-]+$/;
/** Shared by every store so a bad id can never become a path or object-key traversal. */
export function assertSafeKey(userId: string, fileName: string) {
  if (!SAFE_ID.test(userId) || !SAFE_NAME.test(fileName) || fileName.includes('..')) throw new Error('Invalid storage path.');
}

export class DiskStore implements BlobStore {
  private root: string;
  constructor(root: string) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  private resolve(userId: string, fileName: string) {
    assertSafeKey(userId, fileName);
    const file = path.join(this.root, userId, fileName);
    if (!file.startsWith(this.root + path.sep)) throw new Error('Invalid storage path.');
    return file;
  }
  async put(userId: string, fileName: string, bytes: Buffer) {
    const file = this.resolve(userId, fileName);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await fs.promises.writeFile(temp, bytes);
    await fs.promises.rename(temp, file);
  }
  async get(userId: string, fileName: string) {
    try { return await fs.promises.readFile(this.resolve(userId, fileName)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async remove(userId: string, fileName: string) {
    try { await fs.promises.unlink(this.resolve(userId, fileName)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

// ---- image inspection (magic bytes + dimensions; we never decode pixels on the server) ----
export const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export type ImageKind = 'png' | 'webp' | 'jpeg';
export const IMAGE_MIME: Record<ImageKind, string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg' };
export const IMAGE_EXT: Record<ImageKind, string> = { png: 'png', webp: 'webp', jpeg: 'jpg' };
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

export function imageKind(bytes: Buffer): ImageKind | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_HEADER)) return 'png';
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function webpSize(bytes: Buffer): { width: number; height: number } {
  const chunk = bytes.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const b = bytes.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
  if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
  throw new Error('Unsupported WebP image.');
}

/** Validates a screenshot upload (PNG or WebP only) and returns its format and size. Throws a user-facing message. */
export function inspectScreenshot(bytes: Buffer): { kind: 'png' | 'webp'; width: number; height: number } {
  if (bytes.length < 30 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid image.');
  const kind = imageKind(bytes);
  let size: { width: number; height: number };
  if (kind === 'png') {
    if (bytes.subarray(12, 16).toString() !== 'IHDR' || bytes.length < 45) throw new Error('Invalid PNG image.');
    size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (kind === 'webp') size = webpSize(bytes);
  else throw new Error('Screenshots must be PNG or WebP images.');
  if (!size.width || !size.height || size.width > 4096 || size.height > 4096) throw new Error('Image dimensions are out of bounds.');
  return { kind, ...size };
}
