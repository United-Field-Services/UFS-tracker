// A fake Supabase Auth (GoTrue) server with SYNTHETIC users only, for tests and local development. It is NOT Supabase:
// it implements just enough of the REST API the tracker uses (password grant, TOTP challenge/verify, /user, /logout,
// JWKS) with real ES256 signatures and real RFC 6238 TOTP, plus hooks to rotate keys, revoke sessions and mint hostile tokens.
//   dev tool:  node src/fake-supabase.ts [port]   (default 4320; users match the fake UFS People directory)
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { syntheticFeed } from './fake-directory.ts';

export const FAKE_PUBLISHABLE_KEY = 'sb_publishable_fake_local_dev_key_0123456789';
export const FAKE_PASSWORD = 'Fake-supabase-password-1';        // shared by all synthetic users; local development only

export interface FakeFactor { id: string; secret: Buffer; status: 'verified' | 'unverified'; }
export interface FakeUser { id: string; email: string; password: string; factors: FakeFactor[]; bannedUntil: string | null; }
interface FakeSession { id: string; userId: string; aal: 'aal1' | 'aal2'; revoked: boolean; createdAt: number; }
interface Challenge { id: string; sessionId: string; factorId: string; expiresAt: number; used: boolean; }
interface KeyPair { kid: string; privateKey: crypto.KeyObject; publicJwk: Record<string, unknown>; }

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const uuid = () => crypto.randomUUID();

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits). */
export function totp(secret: Buffer, atMs: number, stepOffset = 0): string {
  const counter = Math.floor(atMs / 30_000) + stepOffset; const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest(); const o = h[19]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const newKey = (): KeyPair => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }); const kid = uuid();
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'], ext: true } };
};

export interface FakeSupabase {
  url: string; port: number; issuer: string;
  users: Map<string, FakeUser>; sessions: Map<string, FakeSession>;
  behavior: { token?: number; user?: number; jwks?: number; challenge?: number; verify?: number; logout?: number; delayMs?: number; verifyReturnsAal1?: boolean; userReturnsOtherId?: boolean; badJwks?: boolean; accessTokenOverride?: string };
  requests: { method: string; path: string; apikey: string | undefined; bearer: boolean; passwordInBody: boolean }[];
  /** Every access and refresh token this server has handed out (tests prove none is ever stored by the tracker). */
  issued: string[];
  addUser(u: { id?: string; email: string; password?: string; bannedUntil?: string | null }): FakeUser;
  addTotp(userId: string, secret?: Buffer): FakeFactor;
  code(userId: string, offsetSteps?: number): string;
  rotateKey(): void; retireOldKeys(): void; currentKid(): string;
  /** Session + signed tokens without going through HTTP (for crafting scenarios). */
  sessionFor(userId: string, aal?: 'aal1' | 'aal2'): { sessionId: string; accessToken: string };
  /** Signs a token with the current key; overrides change claims, header or signing behaviour (to test attacks). */
  mint(claims?: Record<string, unknown>, opts?: { header?: Record<string, unknown>; sign?: 'current' | 'foreign' | 'none' | 'hs256' | 'garbage'; omit?: string[] }): string;
  revokeSession(id: string): void; close(): Promise<void>;
}

export async function startFakeSupabase(opts: { port?: number; now?: () => number; key?: string; dev?: boolean; synthetic?: boolean } = {}): Promise<FakeSupabase> {
  const now = opts.now ?? (() => Date.now()); const apiKey = opts.key ?? FAKE_PUBLISHABLE_KEY;
  let keys: KeyPair[] = [newKey()]; let signer = keys[0]!;
  const s: FakeSupabase = {
    url: '', port: 0, issuer: '', users: new Map(), sessions: new Map(), behavior: {}, requests: [], issued: [],
    addUser(u) { const user: FakeUser = { id: u.id ?? uuid(), email: u.email.toLowerCase(), password: u.password ?? FAKE_PASSWORD, factors: [], bannedUntil: u.bannedUntil ?? null }; s.users.set(user.id, user); return user; },
    addTotp(userId, secret = crypto.randomBytes(20)) { const f: FakeFactor = { id: uuid(), secret, status: 'verified' }; s.users.get(userId)!.factors.push(f); return f; },
    code(userId, offset = 0) { const f = s.users.get(userId)!.factors.find(x => x.status === 'verified')!; return totp(f.secret, now(), offset); },
    rotateKey() { signer = newKey(); keys = [signer, ...keys]; }, retireOldKeys() { keys = [signer]; }, currentKid: () => signer.kid,
    sessionFor(userId, aal = 'aal1') { const id = uuid(); s.sessions.set(id, { id, userId, aal, revoked: false, createdAt: now() }); return { sessionId: id, accessToken: tokenFor(userId, id, aal) }; },
    mint(claims = {}, o = {}) { return mint(claims, o); },
    revokeSession(id) { const x = s.sessions.get(id); if (x) x.revoked = true; },
    close: () => new Promise<void>(r => { server.close(() => r()); (server as any).closeAllConnections?.(); }),
  };

  const baseClaims = (userId: string, sessionId: string, aal: 'aal1' | 'aal2'): Record<string, unknown> => {
    const t = Math.floor(now() / 1000); const u = s.users.get(userId);
    return { iss: s.issuer, aud: 'authenticated', sub: userId, session_id: sessionId, role: 'authenticated', aal, amr: aal === 'aal2' ? [{ method: 'totp', timestamp: t }, { method: 'password', timestamp: t - 1 }] : [{ method: 'password', timestamp: t }], is_anonymous: false, email: u?.email, iat: t, exp: t + 3600 };
  };
  const tokenFor = (userId: string, sessionId: string, aal: 'aal1' | 'aal2') => mint(baseClaims(userId, sessionId, aal));
  function mint(claims: Record<string, unknown>, o: { header?: Record<string, unknown>; sign?: string; omit?: string[] } = {}): string {
    const sample = [...s.users.keys()][0] ?? uuid();
    const merged: Record<string, unknown> = { ...baseClaims(sample, uuid(), 'aal1'), ...claims }; for (const k of o.omit ?? []) delete merged[k];
    const sign = o.sign ?? 'current';
    const header = { alg: sign === 'hs256' ? 'HS256' : sign === 'none' ? 'none' : 'ES256', typ: 'JWT', kid: signer.kid, ...(o.header ?? {}) };
    const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(merged))}`;
    if (sign === 'none') return `${data}.`;
    if (sign === 'garbage') return `${data}.${b64u(crypto.randomBytes(64))}`;
    if (sign === 'hs256') return `${data}.${b64u(crypto.createHmac('sha256', String((signer.publicJwk as any).x)).update(data).digest())}`;   // key-confusion attempt
    const key = sign === 'foreign' ? newKey().privateKey : signer.privateKey;
    return `${data}.${b64u(crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }))}`;
  }
  function parseBearer(req: http.IncomingMessage): { claims: any; session: FakeSession } | null {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? '')); if (!m) return null;
    const [h, p, sig] = m[1]!.split('.'); if (!h || !p || !sig) return null;
    let header: any, claims: any; try { header = JSON.parse(Buffer.from(h, 'base64url').toString()); claims = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
    const k = keys.find(x => x.kid === header.kid); if (!k || header.alg !== 'ES256') return null;
    if (!crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: crypto.createPublicKey({ key: k.publicJwk as any, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))) return null;
    if (claims.exp * 1000 <= now()) return null;
    const session = s.sessions.get(claims.session_id); if (!session || session.revoked) return null;
    return { claims, session };
  }
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c)).on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname; const raw = Buffer.concat(chunks).toString();
      let body: any = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
      s.requests.push({ method: req.method!, path, apikey: req.headers.apikey as string | undefined, bearer: !!req.headers.authorization, passwordInBody: typeof body?.password === 'string' });
      if (s.behavior.delayMs) await new Promise(r => setTimeout(r, s.behavior.delayMs));
      // ---- dev-only helpers ----
      if (opts.dev && path === '/__totp') { const u = [...s.users.values()].find(x => x.id === url.searchParams.get('user') || x.email === url.searchParams.get('user')); return json(res, u ? 200 : 404, { code: u ? s.code(u.id) : null }); }
      if (path === '/auth/v1/.well-known/jwks.json') { if (s.behavior.jwks) return json(res, s.behavior.jwks, { error: 'x' }); if (s.behavior.badJwks) return json(res, 200, { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'rsa-only' }] }); return json(res, 200, { keys: keys.map(k => k.publicJwk) }); }
      if (req.headers.apikey !== apiKey) return json(res, 401, { message: 'Invalid API key' });
      if (req.method === 'POST' && path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        if (s.behavior.token) return json(res, s.behavior.token, { error: 'upstream' });
        const user = [...s.users.values()].find(u => u.email === String(body.email ?? '').toLowerCase());
        if (!user || user.password !== body.password) return json(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        const { accessToken } = s.sessionFor(user.id, 'aal1'); const refresh = b64u(crypto.randomBytes(12)); s.issued.push(accessToken, refresh);
        return json(res, 200, { access_token: s.behavior.accessTokenOverride ?? accessToken, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, user: { id: user.id, email: user.email, is_anonymous: false, factors: user.factors.map(f => ({ id: f.id, factor_type: 'totp', status: f.status })) } });
      }
      const challengeM = /^\/auth\/v1\/factors\/([^/]+)\/challenge$/.exec(path), verifyM = /^\/auth\/v1\/factors\/([^/]+)\/verify$/.exec(path);
      if (req.method === 'POST' && (challengeM || verifyM)) {
        const forced = challengeM ? s.behavior.challenge : s.behavior.verify; if (forced) return json(res, forced, { error: 'upstream' });
        const auth = parseBearer(req); if (!auth) return json(res, 401, { message: 'invalid JWT' });
        const user = s.users.get(auth.session.userId)!; const factor = user.factors.find(f => f.id === (challengeM ?? verifyM)![1]); if (!factor) return json(res, 404, { message: 'factor not found' });
        if (challengeM) { const c: Challenge = { id: uuid(), sessionId: auth.session.id, factorId: factor.id, expiresAt: now() + 300_000, used: false }; challenges.set(c.id, c); return json(res, 200, { id: c.id, expires_at: Math.floor(c.expiresAt / 1000) }); }
        const c = challenges.get(String(body.challenge_id)); const codeOk = [-1, 0, 1].some(o => totp(factor.secret, now(), o) === String(body.code));
        if (!c || c.used || c.expiresAt <= now() || c.sessionId !== auth.session.id || c.factorId !== factor.id || !codeOk) return json(res, 400, { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
        c.used = true; auth.session.aal = s.behavior.verifyReturnsAal1 ? 'aal1' : 'aal2';
        const upgraded = tokenFor(user.id, auth.session.id, auth.session.aal), refresh2 = b64u(crypto.randomBytes(12)); s.issued.push(upgraded, refresh2);
        return json(res, 200, { access_token: upgraded, refresh_token: refresh2, token_type: 'bearer', expires_in: 3600, user: { id: user.id } });
      }
      if (req.method === 'GET' && path === '/auth/v1/user') {
        if (s.behavior.user) return json(res, s.behavior.user, { error: 'upstream' });
        const auth = parseBearer(req); if (!auth) return json(res, 401, { message: 'invalid JWT' });
        const u = s.users.get(auth.session.userId)!; return json(res, 200, { id: s.behavior.userReturnsOtherId ? uuid() : u.id, email: u.email, is_anonymous: false, banned_until: u.bannedUntil });
      }
      if (req.method === 'POST' && path === '/auth/v1/logout') {
        if (s.behavior.logout) return json(res, s.behavior.logout, { error: 'upstream' });
        const auth = parseBearer(req); if (auth) auth.session.revoked = true; res.writeHead(204); return void res.end();
      }
      json(res, 404, { message: 'not found' });
    });
  });
  const challenges = new Map<string, Challenge>();
  await new Promise<void>(r => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  s.port = (server.address() as AddressInfo).port; s.url = `http://127.0.0.1:${s.port}`; s.issuer = `${s.url}/auth/v1`;

  if (opts.synthetic) {   // one Supabase user per identity of the fake UFS People directory; admins and HR get an authenticator
    const feed = syntheticFeed(30, now());
    for (const i of feed.identities) {
      const e = feed.employees.find(x => x.id === i.employeeId)!; const u = s.addUser({ id: i.subject, email: e.email });
      if (e.role === 'admin' || e.role === 'hr_manager') s.addTotp(u.id, crypto.createHash('sha256').update(`totp-${e.id}`).digest().subarray(0, 20));
    }
  }
  return s;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const port = Number(process.argv[2] ?? 4320);
  const sb = await startFakeSupabase({ port, dev: true, synthetic: true });
  console.log(`Fake Supabase Auth (synthetic users) at ${sb.url}`);
  console.log(`Publishable key: ${FAKE_PUBLISHABLE_KEY}   Password for every synthetic user: ${FAKE_PASSWORD}`);
  console.log('Admins and HR managers need a code: GET /__totp?user=<email|id> returns the current one (dev only).');
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => sb.close().then(() => process.exit(0)));
}
