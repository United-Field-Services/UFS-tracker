import crypto from 'node:crypto';
import { syntheticPng } from '../src/synthetic-png.ts';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import type { BlobStore } from '../src/storage.ts';
import { hashPassword } from '../src/auth.ts';
import type { DirectoryConfig } from '../src/directory.ts';
import type { SupabaseAuth } from '../src/supabase-auth.ts';

export const PASSWORD = 'Test-passw0rd-123';
export const T0 = Date.parse('2026-10-22T09:00:00.000Z');
export const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;

export class MemStore implements BlobStore {
  files = new Map<string, Buffer>();
  /** Make the next operations throw, to test storage outages. */
  failing: { put?: boolean; get?: boolean; remove?: boolean } = {};
  async put(userId: string, name: string, bytes: Buffer) { if (this.failing.put) throw new Error('storage down'); this.files.set(`${userId}/${name}`, bytes); }
  async get(userId: string, name: string) { if (this.failing.get) throw new Error('storage down'); return this.files.get(`${userId}/${name}`) ?? null; }
  async remove(userId: string, name: string) { if (this.failing.remove) throw new Error('storage down'); this.files.delete(`${userId}/${name}`); }
}

/** Minimal WebP containers: enough for the server's header/size checks (it never decodes pixels). */
export function webp(width = 64, height = 48, kind: 'lossy' | 'lossless' | 'extended' = 'lossy'): Buffer {
  const body = Buffer.alloc(40, 7);
  let chunk: Buffer;
  if (kind === 'lossy') { chunk = Buffer.concat([Buffer.from('VP8 '), Buffer.alloc(4), Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]), Buffer.alloc(4), body]); chunk.writeUInt32LE(chunk.length - 8, 4); chunk.writeUInt16LE(width, 14); chunk.writeUInt16LE(height, 16); }
  else if (kind === 'lossless') { chunk = Buffer.concat([Buffer.from('VP8L'), Buffer.alloc(4), Buffer.from([0x2f]), Buffer.alloc(4), body]); chunk.writeUInt32LE(chunk.length - 8, 4); chunk.writeUInt32LE((width - 1) | ((height - 1) << 14), 9); }
  else { chunk = Buffer.concat([Buffer.from('VP8X'), Buffer.alloc(4), Buffer.alloc(10), body]); chunk.writeUInt32LE(chunk.length - 8, 4); chunk.writeUIntLE(width - 1, 12, 3); chunk.writeUIntLE(height - 1, 15, 3); }
  const out = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), chunk]); out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** A small but real, decodable PNG. */
export function png(width = 64, height = 48, shade = 0): Buffer { return syntheticPng(width, height, [shade % 200, 40, 90]); }
export const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);

export interface Resp { status: number; json: any; text: string; buf: Buffer; headers: Headers; }
export interface Harness {
  base: string; clock: { now: number }; store: MemStore; db: ReturnType<typeof openDb>; ctx: ReturnType<typeof createApp>['ctx'];
  call(method: string, path: string, opts?: { token?: string; body?: unknown; raw?: Buffer; contentType?: string }): Promise<Resp>;
  login(email: string, kind?: 'web' | 'device'): Promise<string>;
  users: Record<string, { id: string; email: string }>;
  stop(): Promise<void>;
}

export async function setup(customStore?: BlobStore, extra: { directory?: DirectoryConfig | null; clock?: { now: number }; directoryFetch?: typeof fetch; supabase?: SupabaseAuth | null } = {}): Promise<Harness> {
  const clock = extra.clock ?? { now: T0 };
  const store = (customStore ?? new MemStore()) as MemStore;
  const db = openDb(':memory:');
  const built = createApp({ db, store, now: () => clock.now, directory: extra.directory ?? null, directoryFetch: extra.directoryFetch, supabase: extra.supabase ?? null });
  const server = built.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const iso = new Date(clock.now).toISOString();
  const hash = hashPassword(PASSWORD);
  const users: Harness['users'] = {};
  const add = (key: string, role: string, managerKey: string | null, teamId: string | null) => {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id,email,name,role,manager_id,team_id,password_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, `${key}@test.example`, key[0]!.toUpperCase() + key.slice(1), role, managerKey ? users[managerKey]!.id : null, teamId, hash, iso);
    users[key] = { id, email: `${key}@test.example` };
  };
  db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').run('team-1', 'Team One', iso);
  db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').run('team-2', 'Team Two', iso);
  add('owner', 'owner', null, null);
  add('admin', 'admin', null, null);
  add('hana', 'hr', null, null);               // HR: reads everyone, edits nothing
  add('mia', 'manager', null, 'team-1');       // manages ed + eve
  add('max', 'manager', null, 'team-2');       // manages finn
  add('ed', 'employee', 'mia', 'team-1');
  add('eve', 'employee', 'mia', 'team-1');
  add('finn', 'employee', 'max', 'team-2');
  add('loner', 'employee', null, null);        // no manager

  const h: Harness = {
    base, clock, store, db, ctx: built.ctx, users,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      let body: BodyInit | undefined;
      if (opts.raw) { headers['Content-Type'] = opts.contentType ?? 'image/png'; body = new Uint8Array(opts.raw); }
      else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
      const res = await fetch(base + path, { method, headers, body });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, buf, headers: res.headers };
    },
    async login(email, kind = 'web') {
      const r = await h.call('POST', '/api/auth/login', { body: { email, password: PASSWORD, kind, deviceName: kind === 'device' ? 'Test PC' : undefined } });
      if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
      return r.json.token as string;
    },
    async stop() { await new Promise<void>(resolve => server.close(() => resolve())); built.close(); },
  };
  return h;
}

/** Give every seeded employee consent so screenshot uploads are accepted. */
export function giveConsent(h: Harness, ...keys: string[]) {
  for (const k of keys) h.db.prepare('UPDATE users SET consent_version = 1, consent_at = ? WHERE id = ?').run(new Date(h.clock.now).toISOString(), h.users[k]!.id);
}
export const iso = (ms: number) => new Date(ms).toISOString();
