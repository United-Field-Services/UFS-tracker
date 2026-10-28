# Decisions and phased plan

Locked 2026-10-26 from the owner's answers. Changing any of these is fine, but change it here first.

> **2026-10-28 decision (owner):** for now use only the separate staging Supabase project `ufs-tracker-staging` (synthetic users, own passwords; real staff not copied in). Keep an explicit option to sync with UFS People later (switch to its Supabase project and directory feed). See `REMAINING-WORK.md` section 3.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Hosting | **Separate service now, merge into UFS People later** (when the tracker is "100%"). Until then it must **share people data** with UFS People (same employees and managers) instead of keeping its own copy. |
| 2 | Desktop login | **UFS People account (Supabase Auth)**: same email and password as the website. |
| 3 | Screenshot storage | **S3-compatible storage, S3 as the default.** Admin can point it at R2, Supabase Storage or MinIO because they speak the same protocol. Retention enforced by a bucket lifecycle rule (cheaper and more reliable than an app job) plus our purge as a backstop. |
| 4 | Visibility and retention | **Employee + direct manager + HR, 90 days.** Every non-owner view audited. |
| 5 | Audience | **Internal to UFS.** Single organization; keep an `org_id` out of scope unless it is free to add. |
| 6 | Image format | **Admin chooses** (policy: PNG or WebP + quality), **WebP default** (~100-150 KB vs ~0.5 MB). |

## Why S3 (cost, checked 2026-10-26)
- Time Doctor keeps screenshots on active servers 6 months, then cold storage; restoring costs extra ([help.timedoctor.com](https://help.timedoctor.com/data-retention-policy-in-time-doctor)). Their provider is not named in the public docs.
- Real capture size measured here: ~0.5 MB PNG at 1080p. At 5-minute intervals that is ~3 GB per employee for 90 days as PNG, ~0.75 GB as WebP. 50 employees on WebP is ~40 GB: a dollar or two a month on S3/R2. Supabase free storage is 1 GB (Pro: 100 GB included), so a truly free tier will not hold real volume. S3/R2 prices above are from memory, not re-verified.

## Phases

**Phase 1: storage, roles, retention (no dependency on UFS People): DONE 2026-10-26** (details and test results in `PROGRESS.md`; still to verify against a real S3/R2/Supabase bucket)
- S3-compatible `BlobStore` (env: endpoint, region, bucket, key, secret, path-style), served through our API (keeps audit and visibility checks) with optional short-lived presigned URLs later.
- Image format policy (PNG/WebP + quality); desktop encodes before upload; server accepts PNG/WebP/JPEG by magic bytes.
- Add `hr` role (sees screenshots and time for everyone, never edits); default retention 90 days; docs for the bucket lifecycle rule.
- Tests: store contract tests against MinIO or a fake S3, visibility matrix with HR, retention.

**Phase 2 (REVISED 2026-10-26 after reading UFS People): shared people directory + Supabase login**

*What reading UFS People changed (read-only inspection, nothing modified there):*
- UFS People's data is **not in Supabase or Postgres**. Employees, managers, roles and all HR records are in **Cloudflare D1 (SQLite) + R2**; its own docs say no migration to Supabase is planned. **Supabase is used only for sign-in** (password + TOTP). So "Postgres + a read-only database link" no longer makes sense: there is no Postgres to link to, and a Cloudflare API token that can read D1 would expose *all* HR data (compensation, personal records), which breaks least privilege.
- Because the final home is UFS People on D1 (SQLite dialect), moving the tracker to Postgres now would mean **two migrations** (SQLite to Postgres to D1). Recommendation: **keep the SQLite dialect** until the merge.
- People are linked to logins through an **`employee_identities` table (Supabase user id `sub` to employee id), approved out-of-band; no automatic linking by email**. The tracker must follow the same rule.
- Roles in UFS People: `employee`, `manager`, `hr_manager`, `hiring_manager`, `admin`. Admin and HR manager require **AAL2 (TOTP)** on the website. Managers' reports come from `employees.manager_id`. Records also carry `data_scope` (`live` vs a QA test scope), `active`, `demo` and employment status; only live, active, non-demo, eligible people may be used.
- The Supabase project signs tokens with **ES256 and publishes a JWKS** (checked 2026-10-26), so the tracker can verify tokens locally without any shared secret.
- UFS People already has its own manual `time_entries` (date, minutes, project, manager approval). Phase 5 must reconcile the two; Phase 2 keeps them separate.

*Revised design:*
- **2a Directory foundation: DONE 2026-10-26 (tested against a fake feed; see `PROGRESS.md`, `server/DIRECTORY-FEED.md`).** Tracker tables `directory_employees` (id, email, name, manager id, role, active, department, location) and `directory_identities` (Supabase `sub` to employee id, enabled), filled by a **pull sync** from a small read-only **directory export endpoint** that UFS People exposes (allow-listed fields only, secret bearer token, live and non-demo only). Tracker users become projections of the directory: no passwords, no HR data beyond those fields. Sync is scheduled plus "sync now", audited, and deactivation revokes sessions and uploads. Built and tested against a fake feed first.
- **2b Supabase login (server-side proxy, like UFS People does).** The tracker server (desktop and dashboard both call it) performs the password grant, handles the TOTP challenge, verifies the JWT locally (ES256 via JWKS: issuer, audience, expiry, session id, AAL, AMR) **plus a cached live session check**, maps `sub` to an enabled identity to an eligible employee (never by email), then issues the existing tracker device/web token. Admin and HR require AAL2. Passwords are never stored or logged. The desktop app gains a TOTP field; its security model (talks only to the configured server) is unchanged.
- **2c Roles from the directory.** `admin` maps to tracker admin, `hr_manager` to tracker hr (read-only), `manager` to manager (scope = direct reports via manager id), `employee` and `hiring_manager` to employee. A configured employee id is the tracker owner. Role or manager changes in UFS People apply automatically at the next sync. Leavers are deactivated, sessions revoked, data kept only until retention.
- **2d Hosting and operations.** Stay on SQLite with a persistent disk, automated backups (for example Litestream to S3/R2) and HTTPS, on a small host; **or** rewrite for Cloudflare Workers + D1 + R2 (best long-term fit, larger rewrite). Object storage: R2 (already in your Cloudflare account) or S3, both through the S3 store already built. Separate staging and production.
- **2e Pilot and cutover.** A staging Supabase project with synthetic people for all automated tests; then 3-5 volunteers in production; then retire tracker-only passwords (keep one break-glass owner).
- Tests: JWT verification (expired, wrong issuer/audience, wrong key, replayed or revoked session, anonymous), identity binding (no email auto-link, disabled identity, ineligible employee), AAL2 for admin/HR, directory sync (adds, changes, leavers, bad feed), role and manager scoping from the feed, and a real desktop sign-in end to end against staging.

**Phase 3: deploy and harden**
- HTTPS (reverse proxy), `trust proxy`, backups, monitoring, secrets management, rate limits beyond login, dependency audit.
- HR/legal review of the monitoring notice; works-council/local-law check; security review.
- Signed installer, icon, auto-update, "delete local data on uninstall" option.

**Phase 4: Time Doctor parity features** (order to confirm after the discovery run): A8 idle prompt, A9 count-only activity, and A10 desktop manual-time submissions for approval are implemented. A11 has policy-controlled in-app break and scheduled-hour reminders, but no closed-app notifications or dedicated break records. C5 has partial timezone-aware tracker evidence; C6 has grouped and daily UTC count-only activity estimates backed by B11 rollups. C5 still cannot establish absence or payroll hours, and the source of work schedules/leave must be confirmed before operational use. Continue the remaining backlog in `REMAINING-WORK.md`.

**Phase 5: merge into UFS People** once stable: move routes/dashboard into the Next.js app, keep the tracker schema and storage as is.

## Needs from you for Phase 2 (revised)

**Decisions (my recommendation first)**
1. **Database until the merge:** keep SQLite (recommended, matches UFS People's D1) vs Postgres (two migrations).
2. **How the tracker learns who works at UFS:** a read-only directory export endpoint added to UFS People and pulled by the tracker (recommended) vs UFS People pushing a snapshot vs giving the tracker direct access to D1 (not recommended: exposes all HR data).
3. **Where the tracker server runs:** small host with disk + backups (recommended for speed) vs Cloudflare Worker rewrite (best long-term fit).
4. **Screenshot bucket:** R2 (already in your Cloudflare account) vs S3.
5. **TOTP (AAL2) required for tracker admins and HR**, mirroring UFS People (recommended).

**From your boss / the Supabase owner**
6. Approval to add the small, additive directory export endpoint to UFS People and to fit it into his release order (migration 0011 and the password-reset release are in flight).
7. Confirmation that `employees` and `employee_identities` will not change shape in that release.
8. A **separate staging Supabase project** (or a test scope) with synthetic employee, manager and HR-manager accounts, so automated tests never touch real people. I will not log in as any real employee.
9. The staging/production **Supabase URL and publishable key** supplied through environment variables (the publishable key is public by design, but keep it out of chat anyway), and a domain name for the tracker (HTTPS).
10. Which UFS employee id is the tracker **owner**, and whether tracker "hr" means `hr_manager` only or also `admin`.

**Not needed:** UFS People database credentials, Cloudflare tokens, or any real employee login.

## Not changed by these decisions
Visible, consent-based tracking; no covert mode; employee can see what is collected; screenshots only while tracking is visibly on.
