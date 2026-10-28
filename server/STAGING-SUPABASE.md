# Staging Supabase project (synthetic accounts only)

Created 2026-10-28 in the `unitedffs Org` Supabase organization: project **`ufs-tracker-staging`**, ref `suozrzqorchlvzmqthah`, region `us-east-1`, URL `https://suozrzqorchlvzmqthah.supabase.co`. It is separate from the two older projects (`ufs-newsletter-us` and an inactive one), which were not touched. **It is not UFS People's real Supabase project.** Never put real people in it.

## What exists
- Signing keys: one asymmetric **ES256 (P-256)** key published at `/auth/v1/.well-known/jwks.json`, which is what the tracker verifies against.
- Four **synthetic** users, created with SQL (`auth.users` + `auth.identities`, confirmed, no emails sent). Their ids equal the subjects of the matching people in the tracker's fake directory feed (`server/src/fake-directory.ts`), so a tracker started with that feed maps them to roles:

| Fake employee | Directory role | Tracker role | Authenticator code |
|---|---|---|---|
| emp-001 | admin | owner (via `DIRECTORY_OWNER_EMPLOYEE_ID=emp-001`) | enrolled, required |
| emp-002 | hr_manager | hr | enrolled, required |
| emp-004 | manager | manager | none |
| emp-009 | employee | employee | none |

- **Expanded 2026-10-28 to the whole fake feed:** 24 synthetic users (every identity in `syntheticFeed()`: 1 admin, 2 HR managers, 4 managers, 1 hiring manager, 16 employees; the feed gives 6 people no login on purpose). Authenticator codes are enrolled for the admin (emp-001) and both HR managers (emp-002, emp-003). The other roles (rows above) are examples of the same pattern.
- **Real rate limit found:** Supabase limits sign-ins per IP (about 30 per 5 minutes on a new project). When it trips, the tracker answers 503 ("Sign-in service returned 429") and recovers on its own. Batch bulk sign-in tests and skip negative cases (`SKIPNEG=1` in the scratch script) when running all 24 accounts.
- Local-only credentials file (not for chat, docs or any shared place): `server/.staging-local/accounts.json` (one shared password for the four fake accounts, TOTP secrets for emp-001 and emp-002) and `server/.staging-local/env.ps1` (sets `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`). The publishable key is public by design but is kept out of docs anyway. **No git in this folder, so make sure this folder is never copied or shared.**

## Run the tracker against it
```
. server\.staging-local\env.ps1            # SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY
# fake directory feed (port 4311) + tracker (port 4301) with a fresh data dir:
node server/src/fake-directory.ts 4311
$env:DIRECTORY_URL='http://127.0.0.1:4311/directory.json'; $env:DIRECTORY_TOKEN='fake-directory-token-for-local-dev-only'; $env:DIRECTORY_OWNER_EMPLOYEE_ID='emp-001'
$env:TRACKER_DATA_DIR=<empty temp dir>; $env:PORT='4301'; $env:TRACKER_OWNER_EMAIL=<break-glass email>; $env:TRACKER_OWNER_PASSWORD=<strong password>
node server/src/server.ts
```

## Verified 2026-10-28 against the REAL staging project
- Tracker `SupabaseAuth` (not the fake): JWKS fetch, ES256 verification with the tracker's claim checks, password grant, TOTP enroll/challenge/verify (aal1 to aal2), live `/user` check and logout all worked for all four accounts; token `sub` matched the directory subject for every account.
- Through the tracker's HTTP API (`POST /api/auth/login`): wrong password 401; admin and HR answered `mfaRequired`, a wrong code was rejected (401), the right code signed in (200) as owner and hr; manager and employee signed in directly (200); `/api/me` returned the directory-projected roles.

## Known leftovers
- Supabase advisor warns **leaked-password protection is off** (dashboard setting, not available through the tool). Also **turn off "Allow new users to sign up"** in the dashboard (Authentication, Sign In / Providers) so strangers holding the public key cannot create staging users. Tracker identity binding already rejects any account not in the directory feed.
- Not yet verified against the real service: revoked/banned-session behaviour, 429 rate limits, signing-key rotation, and the real UFS People directory feed.
- The older mock feed passwords, TOTP secrets and keys are for synthetic staging only; rotate by re-running the setup if shared by mistake.
