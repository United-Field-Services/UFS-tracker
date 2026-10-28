import crypto from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { HttpError, audit, issueToken } from './auth.ts';
import type { Row } from './db.ts';
import { AuthProblem, type SupabaseClaims } from './supabase-auth.ts';

export const MSG = {
  invalid: 'Incorrect email or password.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again in a moment.',
  notEnabled: 'This account is not set up for the Time Tracker yet. Ask your administrator.',
  again: 'Please sign in again.',
  code: 'Incorrect code. Check your authenticator app and try again.',
  noFactor: 'Your role requires an authenticator app. Set one up in UFS People first, then sign in again.',
  mfaRequired: 'Enter the 6-digit code from your authenticator app.',
};
const shortId = (sub: string) => crypto.createHash('sha256').update(sub).digest('hex').slice(0, 12);

export interface LoginInput { email: string; password: string; totp?: string; kind: 'web' | 'device'; deviceName?: string }

/**
 * Sign in with a UFS People (Supabase) account. The person is found ONLY through the approved identity list of the
 * directory (Supabase `sub` -> employee); the typed email is never used to find or link an account.
 * Every Supabase session created here is closed again before returning, and no Supabase token is stored anywhere.
 */
export async function supabaseLogin(ctx: Ctx, input: LoginInput, ip: string): Promise<{ token: string; expiresAt: string; user: Row }> {
  const sb = ctx.supabase!; const { db, cfg } = ctx;
  const keys = [`email:${input.email}`, `ip:${ip}`];
  let openToken: string | null = null;      // the Supabase access token whose session must be closed on every path
  const deny = (status: number, message: string, reason: string, sub?: string, extra?: Record<string, unknown>): never => {
    audit(db, cfg, null, 'auth.login_denied', 'user', undefined, { via: 'supabase', reason, subject: sub ? shortId(sub) : null });
    throw new HttpError(status, message, extra);
  };
  try {
    // 1. password grant
    let session; try { session = await sb.passwordGrant(input.email, input.password); }
    catch (error) {
      if (error instanceof AuthProblem && error.reason === 'invalid_credentials') { ctx.limiter.failure(...keys); audit(db, cfg, null, 'auth.login_failed', 'user', undefined, { via: 'supabase' }); throw new HttpError(401, MSG.invalid); }
      return deny(503, MSG.unavailable, 'provider_unavailable');
    }
    openToken = session.accessToken;

    // 2. verify the token ourselves (signature + claims)
    let claims: SupabaseClaims;
    try { claims = await sb.verifyAccessToken(session.accessToken); }
    catch (error) { return deny(error instanceof AuthProblem && error.reason === 'unavailable' ? 503 : 401, error instanceof AuthProblem && error.reason === 'unavailable' ? MSG.unavailable : MSG.again, 'token_rejected'); }

    // 3. identity binding: approved subject -> enabled identity -> active directory person. Never by email.
    const ident = db.prepare('SELECT employee_id, enabled, not_before FROM directory_identities WHERE subject = ?').get(claims.sub) as Row | undefined;
    const user = ident && ident.enabled ? db.prepare("SELECT * FROM users WHERE directory_id = ? AND source = 'directory' AND active = 1").get(ident.employee_id) as Row | undefined : undefined;
    if (!ident || !user) return deny(403, MSG.notEnabled, !ident ? 'no_identity' : !ident.enabled ? 'identity_disabled' : 'person_inactive', claims.sub);
    if (ident.not_before && claims.iat * 1000 < Date.parse(ident.not_before)) return deny(401, MSG.again, 'before_cutoff', claims.sub);

    // 4. authenticator code for privileged roles (same policy UFS People applies to admin and HR managers)
    if (sb.cfg.mfaRoles.includes(user.role) && claims.aal !== 'aal2') {
      if (!input.totp) return deny(401, MSG.mfaRequired, 'mfa_required', claims.sub, { mfaRequired: true });
      const factor = session.factors.find(f => f.type === 'totp' && f.status === 'verified');
      if (!factor) return deny(403, MSG.noFactor, 'no_factor', claims.sub);
      const mfaKey = `mfa:${claims.sub}`;
      if (ctx.limiter.blocked(mfaKey)) throw new HttpError(429, 'Too many incorrect codes. Try again in a few minutes.');
      try {
        const upgraded = await sb.verifyTotp(session.accessToken, factor.id, input.totp);
        const next = await sb.verifyAccessToken(upgraded);
        if (next.aal !== 'aal2' || !next.amr.includes('totp') || next.sub !== claims.sub || next.sessionId !== claims.sessionId) throw new AuthProblem('mfa_failed');
        openToken = upgraded; claims = next;
      } catch (error) {
        if (error instanceof AuthProblem && error.reason === 'unavailable') return deny(503, MSG.unavailable, 'provider_unavailable', claims.sub);
        ctx.limiter.failure(...keys, mfaKey);
        return deny(401, MSG.code, 'mfa_failed', claims.sub);
      }
    }

    // 5. the session must still be alive at the provider and the account must not be banned
    try { await sb.liveCheck(openToken, claims.sub); }
    catch (error) { return error instanceof AuthProblem && error.reason === 'unavailable' ? deny(503, MSG.unavailable, 'provider_unavailable', claims.sub) : deny(401, MSG.again, error instanceof AuthProblem ? error.reason : 'live_check', claims.sub); }

    // 6. issue the tracker's own session
    ctx.limiter.success(...keys, `mfa:${claims.sub}`);
    const issued = issueToken(db, cfg, user.id, input.kind, input.deviceName ?? null, { authSource: 'supabase', sub: claims.sub, aal: claims.aal, maxDeviceDays: sb.cfg.deviceSessionDays });
    audit(db, cfg, user.id, 'auth.login', 'user', user.id, { via: 'supabase', kind: input.kind, device: input.deviceName ?? null, aal: claims.aal });
    return { ...issued, user };
  } finally {
    if (openToken) await sb.logout(openToken);   // the tracker session replaces the Supabase one; nothing is kept
  }
}
