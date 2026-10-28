# UFS Tracker server

Backend and manager dashboard for the UFS Desktop Tracker: accounts and roles, time sync, screenshot storage, live status, reports, policy and an audit log. TypeScript on Node 24 (runs `.ts` directly, no build step), Express 5, Zod, and Node's built-in SQLite.

> **Status: working pilot, not production-ready.** See "Known gaps" before putting real employee data in it.

## Run it

```
npm install
npm run seed:demo      # optional: synthetic demo people and placeholder screenshots (empty data dir only)
npm start              # http://127.0.0.1:4300  (set PORT / TRACKER_DATA_DIR to change)
```

First start with an empty database needs an owner account from the environment (never from code):

```
set TRACKER_OWNER_EMAIL=you@company.com
set TRACKER_OWNER_PASSWORD=<10+ chars, letters and a number>
npm start
```

`reset-demo.ps1` re-seeds `data-demo/` and starts the server in the background (dev helper). Demo sign-ins are `owner@`, `admin@`, `maria@` (manager), `ana@` (employee) `@demo.example`; the shared demo password is the `DEMO_PASSWORD` constant in `src/seed-demo.ts` (synthetic data only; change before any real use).

## Screenshot storage (disk or any S3-compatible service)

Default is local disk under the data directory (fine for a pilot). For real use, point it at object storage:

```
set STORAGE_DRIVER=s3
set S3_BUCKET=ufs-tracker-screenshots
set S3_REGION=us-east-1                 # "auto" for Cloudflare R2
set S3_ENDPOINT=                        # leave empty for AWS S3; set for R2 / MinIO / Supabase Storage (S3 protocol)
set S3_ACCESS_KEY_ID=...                # omit both keys to use an IAM role
set S3_SECRET_ACCESS_KEY=...
set S3_FORCE_PATH_STYLE=1               # MinIO and most self-hosted gateways
set S3_PREFIX=screenshots/              # optional
set S3_SSE=1                            # AES256 server-side encryption (AWS S3; leave off for R2)
```

- Keep the bucket **private** (block public access). Images are only served through this API, which checks role, visibility policy and writes the audit log.
- Objects are keyed `<prefix><user id>/<screenshot id>.webp|png` (+ `.thumb.jpg`). Names are validated so an id can never become a path or key traversal.
- **Retention backstop:** the server deletes expired screenshots hourly, but also add a bucket lifecycle rule that expires objects after *retention days + 1* (default policy: 91 days). AWS example: `aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration '{"Rules":[{"ID":"expire-screenshots","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":91}}]}'`.
- A failed delete or purge keeps the database record, so it is retried instead of leaving data behind unnoticed.
- Tested against an in-process fake S3 (signature header, path-style, encryption header, error handling, full upload/view/delete/retention flow). **Not yet verified against real AWS S3, R2, MinIO or Supabase**: do a smoke test with your bucket before relying on it.

## UFS People directory (Phase 2a)

The tracker can pull who works at UFS, who manages whom and each person's role from **UFS People**, instead of keeping its own copy. It never connects to UFS People's database; UFS People exposes one read-only endpoint with an allow-listed set of fields. Full contract and a suggested implementation for the UFS People owner: **`DIRECTORY-FEED.md`**.

```
set DIRECTORY_URL=https://people.example.com/directory      # https required (http only for localhost)
set DIRECTORY_TOKEN=<long random secret, 16+ chars>         # a dedicated secret for this endpoint
set DIRECTORY_OWNER_EMPLOYEE_ID=emp_xxx                     # optional: this UFS employee becomes tracker owner
set DIRECTORY_SYNC_MINUTES=15                               # optional, 1-1440
```

- People from the directory become tracker users with `source = 'directory'`. The directory owns their **name, email, role, manager, team (from department) and active state**; these cannot be edited in the tracker (409). The tracker keeps consent, sessions, policy overrides and all tracked data. Directory users have no tracker password. Phase 2b sign-in through UFS People's Supabase Auth is implemented and tested against the fake provider; a real staging connection is still pending. Local accounts (the break-glass owner, tests) are never touched by a sync.
- Roles: `admin` -> admin, `hr_manager` -> hr (read-only), `manager` -> manager, `employee` and `hiring_manager` -> employee, unknown -> employee (reported). Managers see their direct reports through the synced manager links; moving or demoting someone changes visibility at the next sync.
- Leavers (inactive or missing): deactivated, sessions revoked, uploads stop, data kept until retention. Returners are reactivated. The last active owner is never demoted or deactivated by a sync.
- **Safety guards** (blocked syncs change nothing and are audited): empty feed; more than 30% of people (when 10 or more) would be deactivated; stale (>48 h) or older-than-last feeds; wrong version; duplicate ids/emails/identities; more than 10% invalid rows; **any sensitive-looking field name** (salary, birth, address, phone, bank, medical, personal..., names only are reported, never values). Only an **owner** can force a blocked sync.
- Applying is transactional: a crash halfway rolls everything back. Manager loops and self-management are broken and reported. A directory email that clashes with a local account never merges accounts.
- Sign-in identities (Supabase `sub` to employee) are stored for UFS People sign-in and are never matched by email.
- Admin API: `GET /api/directory/status`, `GET /api/directory/log`, `POST /api/directory/sync` (`{"force":true}` owner only). The dashboard People page shows status, warnings, recent syncs and "Sync now". The token is never logged, audited or returned.
- Try it locally with synthetic people: `reset-demo.ps1` starts `node src/fake-directory.ts` (port 4310, dev mutations via `POST /__mutate`) and the tracker wired to it.

## Sign in with UFS People (Phase 2b)

When Supabase is configured, dashboard and desktop users whose accounts come from the directory sign in with their UFS People email and password. The tracker server proxies the password grant, handles a TOTP challenge for privileged roles, verifies the access token's ES256 signature and claims using the Supabase JWKS, checks the live Supabase session, and maps the token's `sub` through an enabled `directory_identities` row. **Email is never used to link a Supabase account to an employee.**

```powershell
$env:SUPABASE_URL = 'https://<your-project>.supabase.co'
$env:SUPABASE_PUBLISHABLE_KEY = '<publishable key>'
$env:SUPABASE_REQUIRE_AAL2_ROLES = 'owner,admin,hr' # default
$env:SUPABASE_DEVICE_SESSION_DAYS = '30'            # default; bounded to 1-365 days
npm start
```

Set both Supabase variables or neither. The URL must be HTTPS (HTTP is accepted only for localhost); the key must be a publishable key, never a service-role or secret key. The default AAL2 roles require a verified authenticator factor and a successful TOTP challenge. The optional `identities[].notBefore` field in `DIRECTORY-FEED.md` is a password-reset cutoff: directory sync revokes older tracker sessions and login rejects tokens issued before the cutoff.

Supabase access and refresh tokens are used only for the sign-in transaction; the tracker closes the temporary Supabase session and stores neither those tokens nor the password or TOTP code. It issues its own revocable tracker session instead: 12 hours for web sessions and up to 30 days for Supabase device sessions by default. Local tracker accounts (including a break-glass owner) continue to use their local password and can sign in if Supabase is unavailable. Directory users cannot fall back to a tracker password.

This integration has automated coverage against `fake-supabase.ts` with synthetic users only. A real staging Supabase project and real UFS People directory endpoint have not yet been connected or verified.

## Roles

| Role | Sees | Can change |
|---|---|---|
| owner / admin | everyone | users, teams, projects, policy, approvals, deletes (owner-only: owners) |
| **hr** | everyone's users, time, live status, reports and screenshots (subject to the visibility policy; every view audited) | nothing: no edits, approvals, deletes or admin screens |
| manager | self and direct reports | approve/reject and edit (with a reason) their reports' time; delete their reports' screenshots; projects |
| employee | self | own manual time; delete own screenshots if policy allows |

## Image format policy

`imageFormat` (`webp` default, or `png`) and `imageQuality` (40-95, default 80) are policy settings (org > team > user). The desktop app encodes company screenshots accordingly: WebP averaged **90 KB** vs **580 KB** PNG in the real end-to-end run (~6x smaller). The server accepts either, validated by magic bytes and size (never decoded). Default retention is **90 days**.

## Break and scheduled-hour reminders (A11 partial)

Policy fields `breakReminderMinutes` (0–240; 0 disables; default 60), `workScheduleEnabled` (default false), `workDays` (Sunday=0 through Saturday=6), `workTimeZone` (IANA timezone, default UTC), `workStartLocal` and `workEndLocal` (24-hour `HH:mm`), and `lateGraceMinutes` (0–180; default 0) inherit from organization to team to person. Set the timezone explicitly for each org/team/person schedule; UTC is only the safe initial default. The desktop schedule prompt uses that timezone and appears only while the app is open and stopped or paused. Break prompts count company-tracked time. Neither reminder starts/pauses tracking automatically or alters time. Dedicated break records and app-closed notification delivery are not implemented. Invalid zones, bounds and effective same-day time ranges are rejected transactionally.

## Schedule and tracked-time evidence (C5 partial)

`GET /api/reports/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD[&userId=...][&format=csv]` returns one row per scheduled person-day for up to 31 inclusive calendar dates. It compares tracker-origin entries (never manual entries) with each person's effective schedule timezone and grace period. Evidence statuses are `tracked`, `late`, `no_tracked_session`, `in_progress` and `upcoming`. “No tracked session” does not establish absence because there is no leave/holiday feed. Within/outside-schedule values are prorated estimates because entries retain aggregate tracked time rather than its exact distribution; they are not payroll evidence. Views of another person's records and all exports are audited. This is an evidence report, not full attendance, leave, payroll or Time Doctor parity.

## Test it

```
  npm run check          # type-check + 145 API tests (in-memory DB, real HTTP, controllable clock, fake S3, fake UFS People directory and Supabase Auth)
```

Browser test of the dashboard (Playwright installed outside the project): `tests-ui/dashboard.ui.cjs`, 72 checks. It accepts `DASH_URL`, `DIRECTORY_URL`, `DIRECTORY_MUTATION_URL` and `FAKE_AUTH_URL` for isolated synthetic runs; use a fresh temporary `TRACKER_DATA_DIR` and fake services, or run the documented `reset-demo.ps1`. The desktop app has its own tests and a real-Electron end-to-end test in `../source/e2e/` that requires a synthetic display and disposable app-data path.

## What it does

| Area | Details |
|---|---|
| Accounts | Email + password (scrypt), per-device revocable tokens (stored hashed), 12 h web sessions / 90 day device sessions, forced password change for admin-created users, per-account and per-IP login throttling, password change signs out other sessions |
| Roles | owner, admin, hr (read-only, sees everyone), manager (sees self + direct reports), employee (sees self). Enforced on every endpoint; unseen records return 404, not 403 |
| Time | Idempotent tracker sync (retries are safe, finished entries cannot be silently rewritten), tamper limits (no more tracked than elapsed time), manual entries with overlap/limit checks and UUID `clientId` retry idempotency (same payload returns the existing entry; changed payload is 409), approve/reject, reviewer edits require a reason and are audited, approved time is locked, edited entries survive tracker re-sync |
| Activity estimate | Optional and off by default. Stores one-minute keyboard key-down and mouse-click counts plus active seconds only. Strict schema has no key identity, typed text, coordinates or app/website field. Activity upload is tied to a company time entry and its recorded consent version; non-owner views are audited. The time-entry table labels the percentage as an estimate. |
| Screenshots | PNG or WebP validation, private storage behind an async `BlobStore` (disk or S3-compatible), thumbnails, per-subject visibility policy (`employee_manager` / `employee_only`), every non-owner view audited, employee delete (policy-controlled), automatic retention purge |
| Consent | Screenshots and activity uploads require authorization from the current notice; enabling activity counts requires raising `consentVersion` above the effective version for affected users |
| Policy | defaults < organization < team < user, validated; includes break/schedule reminders; `activityTrackingEnabled` defaults to false; **there is no hidden/silent tracking option and unknown keys are rejected** |
| Reports | Hours by person / project / day and opt-in count-only activity estimates by person / project / day; audited visibility, CSV export with spreadsheet-formula neutralisation |
| Live | Heartbeat-based status (tracking / paused / offline) scoped by role |
| Audit | Logins, user/policy/project changes, approvals, deletions, exports, screenshot views |
| Dashboard | `public/` single-page app (no build, strict CSP, no inline script/style, safe DOM building) for manager, admin and employee views |

The dedicated activity report is `GET /api/reports/activity?from=<ISO>&to=<ISO>&groupBy=user|project|day` (optional `userId`, `tzOffsetMinutes`, and `format=csv`). It returns only entries with authorized aggregate slices, follows the caller's existing visibility scope, and audits non-owner views and exports. `GET /api/reports/activity/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=user|project|day` reads the materialized daily UTC rollups; the dashboard labels the UTC basis and retains the same count-only disclaimer. The `activity_daily_rollups` table is backfilled by migration and maintained transactionally by SQLite triggers on slice insert/update/delete. Minute slices remain the source of truth; no minute-level raw event content exists.

## Layout

`src/app.ts` wires middleware and routes · `src/routes-account.ts` auth, users, teams, projects, policy, audit · `src/routes-tracker.ts` heartbeat, time, activity slices, screenshots · `src/routes-reports.ts` · `src/policy.ts` · `src/storage.ts` · `src/retention.ts` · `src/db.ts` (SQLite schema; SQLite is the selected database until the planned UFS People merge into D1).

## Known gaps (do before real rollout)

- **Single process, SQLite.** Suitable for synthetic development and a small pilot. SQLite is the selected database until the planned UFS People merge into D1; production still needs persistent storage, automated backups and restore drills. Object storage is already supported (see above).
- **No TLS in the app.** Run behind an HTTPS reverse proxy. Set Express `trust proxy` appropriately, otherwise the per-IP login limiter sees the proxy's address.
- **Dashboard sessions are bearer tokens in `sessionStorage`** (mitigated by strict CSP). UFS People sign-in and TOTP for owner/admin/HR are implemented, but tested only against fakes; self-service password reset remains in UFS People. Local break-glass accounts use tracker passwords.
- **Notice text is draft wording**; HR/legal must review it (and works-council/local-law requirements) before employees use this.
- No email/notifications, payroll/invoice exports, app/website usage, Jira/Asana integrations, public API keys or webhooks, or scheduled reports yet. Daily count-only activity rollups and CSV are available; they are not productivity, attendance, or pay measures. Company A8 idle review and optional A9 count-only activity are implemented.
- Rate limiting covers login only. No malware scanning (images are validated as PNG, served `nosniff`, never as HTML).
- The retention job runs hourly in-process; there is no external scheduler or legal-hold exception.
- Data is not encrypted at rest by the app (use disk/volume encryption).

## Desktop app updates (in-place, keeps employee data)

The server hosts the installer feed at `/updates/` (public, read-only, allow-listed names only: `latest.yml`, `*.exe`, `*.exe.blockmap`). Files live in `TRACKER_UPDATES_DIR` (default `<TRACKER_DATA_DIR>/updates`). The desktop app checks `<its server>/updates/latest.yml` after sign-in or when the employee clicks **Check for updates**, asks before downloading, installs only when tracking is stopped, and updates in place: local screenshots, sessions, pending uploads and sign-in stay.

Publish a release:
1. Bump `version` in `source/package.json` (must be higher than what is installed), then `cd source; npm run build:win`.
2. Copy `source/release/latest.yml`, `UFS Desktop Tracker Setup <version>.exe` and its `.exe.blockmap` into the updates folder, `latest.yml` last (so clients never see a manifest without its installer).
3. Installed apps offer the update at their next sign-in or check. Keep the previous installer too until everyone has moved.

Notes: the manifest carries the installer's SHA-512, which the app verifies. Installers are **not yet code-signed**, so Windows SmartScreen warns on the first manual install and the update channel is only as trustworthy as the server and its HTTPS; sign installers before any rollout. Apps installed before 2026-10-28 (builds without the update-safe uninstall script) must be uninstalled once by hand and reinstalled; after that updates are in place.

## Notifications, payroll and my-data endpoints (added 2026-10-29)
- `GET /api/notifications`, `POST /api/notifications/read` (`{ids}` or `{all:true}`), `PUT /api/me/notification-settings` (`{email}`): in-app notifications and the opt-in email copy. Queued emails sit in `email_outbox`; `flushOutbox(ctx, mailer)` in `src/notifications.ts` sends them with up to 5 retries. **No mailer is wired up yet**: connect an SMTP or API provider (needs an account and credentials from you, kept in environment variables) before email works.
- `GET/POST /api/payroll/rates`, `GET /api/payroll/export?from&to&format=json|csv`: owners/admins set rates, HR can view and export; approved time only; at most 93 days per export.
- `GET /api/me/export`, `GET/POST /api/me/data-requests`, `GET /api/admin/data-requests`, `POST /api/admin/data-requests/:id/resolve` (`{action:'fulfil'|'decline', note}`): data export and deletion requests. Fulfilling removes screenshots and keyboard/mouse counts; time entries are kept for payroll.

## Weekly reports and the public API (added 2026-10-29)
- **Weekly reports:** `GET/POST /api/report-subscriptions`, `DELETE /api/report-subscriptions/:id`, `POST /api/report-subscriptions/:id/send-now`. Kinds: `my-hours` (everyone), `team-hours` (manager, admin, owner, HR), `approvals` (manager, admin, owner). Each person picks the weekday, hour and IANA timezone; the report covers the seven full days before the send day and contains only what that person can already see. `runDueReports` runs every 5 minutes (`src/server.ts`) and sends each subscription once per due week. Delivery is an in-app notification plus a row in `email_outbox`; real email needs a mailer (SMTP or an email API account) wired into `flushOutbox`.
- **API keys:** owners and admins create keys under Integrations (`POST /api/admin/api-keys`, shown once, only a SHA-256 hash stored, at most 50 active, revocable). **Public API** (`/api/v1`, `Authorization: Bearer ufs_...`, GET only): `/me`, `/users` (users:read), `/projects` (projects:read), `/time-entries` (time:read; finished entries, approved by default, filters `from`, `to`, `userId`, `status`, paging with `limit` and `after`). 300 requests per 5 minutes per key (429 with Retry-After). It never exposes screenshots, activity counts, breaks or pay. A session token does not work on `/api/v1` and a key does not work on the dashboard API.
- **Webhooks:** see the next section.

## Webhooks (added 2026-10-29)
Owners and admins add webhooks under Integrations (`GET/POST /api/admin/webhooks`, `PATCH`, `DELETE`, `POST /:id/test`, `POST /:id/rotate-secret`, `GET /:id/deliveries`). Events: `time.approved`, `time.rejected`, `time.submitted` (manual time), `time.edited`, plus `ping` for tests. Payloads hold ids, times, statuses and the reviewer's id only (no names, emails, notes, screenshots, activity or pay).
- **Signing:** every request carries `X-UFS-Event`, `X-UFS-Delivery`, `X-UFS-Timestamp` and `X-UFS-Signature: sha256=` + HMAC-SHA256 of `timestamp + "." + raw body` using the webhook's secret (`whsec_...`, shown once, rotatable). Receivers should reject timestamps older than 5 minutes.
- **Safety (SSRF):** https only, real public host names (no IP literals, `localhost`, `.local`, `.internal` or single-label names), ports 443/8443, no credentials. At creation and before every delivery the name is resolved and every address must be a public unicast address (private, loopback, link-local, cloud-metadata, CGNAT, multicast, reserved, IPv4-mapped and NAT64/6to4 IPv6 ranges are refused); the request is then pinned to the checked address so DNS cannot change between check and connection. Redirects are never followed; each request has a 10 second timeout.
- **Delivery:** a queue runs every 30 seconds. A failed delivery retries after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours (six attempts), then is marked failed. A hook with 20 failed deliveries in a row is switched off and owners/admins are notified. Secrets are stored in the database as plain text (they must be to sign), so protect the database file.
- `WEBHOOK_DEV=1` lets hooks use http and private addresses and exists only for local testing (it is set by `reset-demo.ps1`); never set it in production.