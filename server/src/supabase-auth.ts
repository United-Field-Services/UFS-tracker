import crypto from 'node:crypto';
import type { Role } from './auth.ts';

/**
 * Sign-in with the UFS People (Supabase) account. The tracker server performs the password grant (and the TOTP step
 * for privileged roles) on the user's behalf, verifies the resulting access token itself (ES256 signature against the
 * project's published JWKS, plus the same claim checks UFS People applies), confirms the session is still alive with a
 * live /user call, and then DISCARDS every Supabase token. Nothing from Supabase is ever stored.
 */

export interface SupabaseConfig { url: string; publishableKey: string; issuer: string; mfaRoles: Role[]; deviceSessionDays: number; }

const ROLES: Role[] = ['owner', 'admin', 'hr', 'manager', 'employee'];
const isLocal = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function loadSupabaseConfig(env: NodeJS.ProcessEnv): SupabaseConfig | null {
  const rawUrl = env.SUPABASE_URL?.trim(), key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!rawUrl && !key) return null;
  if (!rawUrl || !key) throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or neither).');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('SUPABASE_URL is not a valid URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('SUPABASE_URL must be a plain origin (no credentials, query or fragment).');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname))) throw new Error('SUPABASE_URL must use https (http is only allowed for localhost).');
  if (/service_role/i.test(key) || /^sb_secret_/i.test(key)) throw new Error('SUPABASE_PUBLISHABLE_KEY must be the PUBLISHABLE (anon) key, never a service/secret key.');
  if (key.length < 20) throw new Error('SUPABASE_PUBLISHABLE_KEY looks too short.');
  const raw = (env.SUPABASE_REQUIRE_AAL2_ROLES ?? 'owner,admin,hr').trim();
  const mfaRoles = raw === '' || raw.toLowerCase() === 'none' ? [] : raw.split(',').map(s => s.trim()) as Role[];
  for (const r of mfaRoles) if (!ROLES.includes(r)) throw new Error(`SUPABASE_REQUIRE_AAL2_ROLES has an unknown role "${r}".`);
  const days = Number(env.SUPABASE_DEVICE_SESSION_DAYS ?? 30);
  const origin = url.origin;
  return { url: origin, publishableKey: key, issuer: `${origin}/auth/v1`, mfaRoles, deviceSessionDays: Number.isFinite(days) ? Math.min(365, Math.max(1, Math.round(days))) : 30 };
}

/** A sign-in problem with a stable reason code (never shown verbatim to the user). */
export class AuthProblem extends Error {
  reason: 'invalid_credentials' | 'unavailable' | 'invalid_token' | 'revoked' | 'banned' | 'mfa_failed' | 'no_factor';
  constructor(reason: AuthProblem['reason'], message?: string) { super(message ?? reason); this.reason = reason; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SupabaseClaims { sub: string; sessionId: string; aal: 'aal1' | 'aal2'; amr: string[]; iat: number; exp: number; email: string | null; }
export interface Factor { id: string; type: string; status: string; }
export interface PasswordSession { accessToken: string; refreshToken: string | null; factors: Factor[]; }

const b64url = (s: string) => Buffer.from(s, 'base64url');
const MAX_TOKEN_CHARS = 8192, JWKS_TTL_MS = 10 * 60_000, JWKS_STALE_OK_MS = 60 * 60_000, JWKS_MIN_REFETCH_MS = 30_000, LEEWAY_S = 30;

export class SupabaseAuth {
  cfg: SupabaseConfig; private fetchImpl: typeof fetch; private now: () => number;
  private keys = new Map<string, crypto.KeyObject>(); private jwksFetchedAt = 0; private jwksAttemptAt = 0;
  constructor(cfg: SupabaseConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) { this.cfg = cfg; this.fetchImpl = fetchImpl; this.now = now; }

  // ---------- HTTP ----------
  private async call(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { apikey: this.cfg.publishableKey, Accept: 'application/json' };
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try { res = await this.fetchImpl(this.cfg.url + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new AuthProblem('unavailable', 'Could not reach the sign-in service.'); }
    let json: any = null; try { json = JSON.parse((await res.text()).slice(0, 200_000)); } catch { /* not JSON */ }
    return { status: res.status, json };
  }

  // ---------- JWKS ----------
  private async refreshKeys(force: boolean) {
    const t = this.now();
    if (!force && t - this.jwksFetchedAt < JWKS_TTL_MS && this.keys.size) return;
    if (t - this.jwksAttemptAt < JWKS_MIN_REFETCH_MS && this.keys.size) return;   // never hammer the provider
    this.jwksAttemptAt = t;
    let res: Response;
    try { res = await this.fetchImpl(`${this.cfg.url}/auth/v1/.well-known/jwks.json`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { if (this.keys.size && t - this.jwksFetchedAt < JWKS_STALE_OK_MS) return; throw new AuthProblem('unavailable', 'Could not load the sign-in keys.'); }
    if (!res.ok) { if (this.keys.size && t - this.jwksFetchedAt < JWKS_STALE_OK_MS) return; throw new AuthProblem('unavailable', 'Could not load the sign-in keys.'); }
    let body: any; try { body = JSON.parse((await res.text()).slice(0, 100_000)); } catch { throw new AuthProblem('unavailable', 'Invalid sign-in keys.'); }
    const next = new Map<string, crypto.KeyObject>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys.slice(0, 20) : []) {
      if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || typeof jwk?.kid !== 'string' || (jwk.alg && jwk.alg !== 'ES256') || (jwk.use && jwk.use !== 'sig')) continue; // only ES256 signing keys
      try { next.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' })); } catch { /* skip a malformed key */ }
    }
    if (!next.size) throw new AuthProblem('unavailable', 'The sign-in service published no usable keys.');
    this.keys = next; this.jwksFetchedAt = t;
  }
  private async keyFor(kid: string): Promise<crypto.KeyObject> {
    await this.refreshKeys(false);
    let key = this.keys.get(kid);
    if (!key) { await this.refreshKeys(true); key = this.keys.get(kid); }    // a rotated key: look once more (rate-limited)
    if (!key) throw new AuthProblem('invalid_token', 'Unknown signing key.');
    return key;
  }

  // ---------- token verification ----------
  /** Verifies an access token exactly as UFS People does (issuer, audience, role, ids, expiry, not anonymous) plus the ES256 signature. */
  async verifyAccessToken(token: string): Promise<SupabaseClaims> {
    const bad = (m: string) => new AuthProblem('invalid_token', m);
    if (typeof token !== 'string' || token.length < 20 || token.length > MAX_TOKEN_CHARS) throw bad('Malformed token.');
    const parts = token.split('.'); if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw bad('Malformed token.');
    let header: any, claims: any;
    try { header = JSON.parse(b64url(parts[0]!).toString('utf8')); claims = JSON.parse(b64url(parts[1]!).toString('utf8')); } catch { throw bad('Malformed token.'); }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') throw bad('Malformed token.');
    // The algorithm is fixed by us, never taken from the token (blocks "none" and RS/HS key-confusion attacks).
    if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 100 || header.crit !== undefined || header.jwk !== undefined || header.jku !== undefined || header.x5u !== undefined) throw bad('Unsupported token header.');
    const signature = b64url(parts[2]!); if (signature.length !== 64) throw bad('Bad signature.');
    const key = await this.keyFor(header.kid);
    const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!ok) throw bad('Bad signature.');
    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== this.cfg.issuer || claims.aud !== 'authenticated' || claims.role !== 'authenticated') throw bad('Wrong issuer, audience or role.');
    if (typeof claims.sub !== 'string' || !UUID.test(claims.sub) || typeof claims.session_id !== 'string' || !UUID.test(claims.session_id)) throw bad('Bad subject or session.');
    if (claims.is_anonymous !== false) throw bad('Anonymous sessions are not accepted.');
    if (!Number.isFinite(claims.exp) || claims.exp + LEEWAY_S <= nowS) throw bad('Token expired.');
    if (!Number.isFinite(claims.iat) || claims.iat > nowS + 60) throw bad('Token issued in the future.');
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowS + LEEWAY_S)) throw bad('Token not valid yet.');
    if (claims.aal !== 'aal1' && claims.aal !== 'aal2') throw bad('Unknown assurance level.');
    const amr = Array.isArray(claims.amr) ? claims.amr.map((a: any) => String(a?.method ?? a)).slice(0, 10) : [];
    return { sub: claims.sub.toLowerCase(), sessionId: claims.session_id.toLowerCase(), aal: claims.aal, amr, iat: claims.iat, exp: claims.exp, email: typeof claims.email === 'string' ? claims.email : null };
  }

  // ---------- Supabase Auth REST ----------
  /** Password grant. Never logs or stores the password or any returned token. */
  async passwordGrant(email: string, password: string): Promise<PasswordSession> {
    const r = await this.call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
    if (r.status === 200 && typeof r.json?.access_token === 'string') {
      const factors: Factor[] = Array.isArray(r.json.user?.factors) ? r.json.user.factors.slice(0, 20).map((f: any) => ({ id: String(f?.id ?? ''), type: String(f?.factor_type ?? ''), status: String(f?.status ?? '') })) : [];
      return { accessToken: r.json.access_token, refreshToken: typeof r.json.refresh_token === 'string' ? r.json.refresh_token : null, factors };
    }
    if (r.status === 400 || r.status === 401 || r.status === 422) throw new AuthProblem('invalid_credentials');
    throw new AuthProblem('unavailable', `Sign-in service returned ${r.status}.`);                    // includes 429 rate limits and 5xx
  }

  /** TOTP second step: challenge + verify a verified TOTP factor. Returns a fresh (aal2) access token. */
  async verifyTotp(accessToken: string, factorId: string, code: string): Promise<string> {
    if (!UUID.test(factorId)) throw new AuthProblem('no_factor');                                      // the id is placed in a URL: must be a UUID
    if (!/^\d{6,8}$/.test(code)) throw new AuthProblem('mfa_failed');
    const challenge = await this.call('POST', `/auth/v1/factors/${factorId}/challenge`, { bearer: accessToken, body: {} });
    if (challenge.status !== 200 || typeof challenge.json?.id !== 'string' || !UUID.test(challenge.json.id)) { if (challenge.status >= 500 || challenge.status === 429) throw new AuthProblem('unavailable'); throw new AuthProblem('mfa_failed'); }
    const verify = await this.call('POST', `/auth/v1/factors/${factorId}/verify`, { bearer: accessToken, body: { challenge_id: challenge.json.id, code } });
    if (verify.status === 200 && typeof verify.json?.access_token === 'string') return verify.json.access_token;
    if (verify.status === 400 || verify.status === 401 || verify.status === 422) throw new AuthProblem('mfa_failed');
    throw new AuthProblem('unavailable');
  }

  /** Live check that the session behind this token still exists and the account is not banned. */
  async liveCheck(accessToken: string, expectedSub: string): Promise<void> {
    const r = await this.call('GET', '/auth/v1/user', { bearer: accessToken });
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new AuthProblem('revoked');
    if (r.status !== 200 || typeof r.json?.id !== 'string') throw new AuthProblem('unavailable');
    if (r.json.id.toLowerCase() !== expectedSub) throw new AuthProblem('invalid_token', 'Session belongs to another user.');
    if (r.json.is_anonymous === true) throw new AuthProblem('invalid_token', 'Anonymous user.');
    const banned = r.json.banned_until ? Date.parse(r.json.banned_until) : NaN;
    if (Number.isFinite(banned) && banned > this.now()) throw new AuthProblem('banned');
  }

  /** Closes the Supabase session this tracker login created (best effort; scope local, other sessions are untouched). */
  async logout(accessToken: string): Promise<void> { try { await this.call('POST', '/auth/v1/logout?scope=local', { bearer: accessToken, body: {} }); } catch { /* best effort */ } }
}
