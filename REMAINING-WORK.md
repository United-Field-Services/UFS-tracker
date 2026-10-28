# Remaining work: everything left to do

Companion to `HANDOFF.md` (what exists) and `DECISIONS-AND-PLAN.md` (decisions). Items are ordered by what to do first. **"Needs"** says who must supply something before the item can start. Sizes: **S** = hours to 1 day, **M** = 2-5 days, **L** = 1-3 weeks (rough, for one developer).

Current code/test source of truth: `source/` and `server/` plus their automated tests. `PROGRESS.md` is the dated verification log; `HANDOFF.md` is the architecture/current-state map; `WHAT-TO-BUILD.md` is the feature-parity inventory. Historical sections in older notes can have stale counts and are superseded by the latest `PROGRESS.md` entry.

---

## 0. Do these first (30 minutes, no one else needed)

| # | Task | Why |
|---|---|---|
| 0.1 | **Done 2026-10-28:** git initialized (branch `main`) and connected to `https://github.com/United-Field-Services/UFS-tracker` at the owner's request (this replaces the earlier "no git" rule). `.gitignore` excludes synthetic staging credentials, data folders, `node_modules/` and installers. CI runs both suites on push (`.github/workflows/ci.yml`, first run still to be confirmed on GitHub). | Version history and automatic checks. |
| 0.2 | **Run the physical-display end-to-end suite** (`source/e2e/company.e2e.cjs`) only when a synthetic display and disposable app-data path are available; then fix any failures. Its syntax was checked on 2026-10-26. | The suite captures a display and deletes the app-data folder it targets. It remains unrun; a normal desktop is not an acceptable substitute for a synthetic display. |
| 0.3 | **Done 2026-10-27:** latest run of `server/tests-ui/dashboard.ui.cjs` used a fresh temporary synthetic database, fake UFS People and fake Supabase on isolated ports. **72/72 passed**, including all-screens notice-version and organization-only policy controls, timezone-aware policy controls, C5 disclaimer and B11 daily rollup mode. `server/data-demo` was not used. | Confirms dashboard role flows, directory guard/force/recovery, fake Supabase/TOTP, schedule policy controls, report disclaimers and mobile layout without touching the demo database. |

## 1. Finish Phase 2b properly (S-M, no one else needed)

- [x] Write the Phase 2b sign-in documentation: `server/README.md` now documents environment variables, TOTP, identity binding, session lifetimes and token/password handling; `DIRECTORY-FEED.md` already documents optional `identities[].notBefore`.
- [x] **Rebuild the installer** (`cd source; npm run build:win`). It includes desktop TOTP, company idle-timeout and A9 activity counting; unsigned x64 NSIS installer SHA-256: `86C68B44B8986099C24E89635B58B9B893C2AE4CC0BD783BDED4CA6D80D15151` (111,875,833 bytes). Inspected its unpacked contents for the native hook binary, third-party notice and license texts. Not installed or exercised against OS input.
- [ ] Run the source and packaged-build end-to-end suites only on synthetic display content with disposable app-data paths. Neither Phase K run has been completed.
- [ ] Desktop: add the TOTP prompt to `lifecycle.e2e.cjs`? (optional) and a renderer unit test for the two-step sign-in (currently covered only by sync/main unit tests and Phase K).
- [x] Desktop tracker-session expiry: account panel shows expiry and recovery steps; new company time/screenshots remain queued for the same cached account without a token and upload after same-account reauthentication. Tests cover 401, queueing, no unauthenticated network calls, retry, account isolation and renderer notice. Physical-display E2E remains unrun under the safety condition in 0.2.
- [ ] Optional: add the TOTP prompt to `lifecycle.e2e.cjs`; two-step sign-in is covered by sync/main unit tests, while Phase K real-Electron E2E remains blocked on synthetic display and disposable app-data setup.

## 2. Blocked on input from you or your boss (cannot start without these)

| # | Needed | From | Unblocks |
|---|---|---|---|
| 2.1 | **Approval to add the directory endpoint to UFS People** and a place in his release order (migration 0011 and password reset are in flight). Give him `server/DIRECTORY-FEED.md`. He builds it (about a day) or approves that someone else does. | Boss / UFS People owner | everything real in Phase 2 |
| 2.2 | Confirmation that the `employees` and `employee_identities` tables will not change shape in his release. | Boss | stable feed |
| 2.3 | **Partly done 2026-10-28:** staging project `ufs-tracker-staging` exists with 4 synthetic users and TOTP for admin/HR (see `server/STAGING-SUPABASE.md`); still to do: turn off sign-ups and enable leaked-password protection in its dashboard, add more synthetic roles if wanted. Original ask: A **separate staging Supabase project** (or approved test scope) with **synthetic** employee, manager, `hr_manager` and `admin` accounts, with TOTP enrolled for admin/HR. Never real people. | Supabase owner | realistic sign-in tests |
| 2.4 | Supabase **URL and publishable key** for staging and production, supplied as **environment variables** (public by design, still keep out of chat). | Supabase owner | real login |
| 2.5 | A **domain name** and HTTPS for the tracker (staging and production). | You / IT | deployment |
| 2.6 | Which UFS employee is the **tracker owner** (`DIRECTORY_OWNER_EMPLOYEE_ID`), and whether tracker "HR" means `hr_manager` only (recommended) or also `admin`. | You | role mapping |
| 2.7 | The remaining Phase 2 answers (recommended answers are already assumed): keep SQLite; pull-based feed; hosting on a small host with backups vs Cloudflare Worker rewrite; **R2 vs S3** for the bucket; TOTP required for owner/admin/HR. | You | hosting and storage work |
| 2.8 | A **real bucket** (AWS S3, Cloudflare R2, or Supabase S3 endpoint) and its credentials as environment variables, to smoke-test the S3 store (never paste keys in chat). | You / IT | confirms S3 for real |
| 2.9 | **Terms-of-service check** on Time Doctor before anyone runs the discovery prompt; a company trial account created by a human with synthetic users. | You / legal | Time Doctor discovery |
| 2.10 | **HR/legal review of the monitoring notice** text (it is draft wording in `server/public/app.js` and `source/renderer/app.js`) and local-law / works-council requirements. | HR / legal | any employee use |

## 3. Phase 2c-2e: go from fakes to the real UFS People (M each)

- [ ] **Keep the option to sync UFS People and this tracker (owner request, 2026-10-28; do not forget).** For now the tracker uses its own separate staging Supabase project (`ufs-tracker-staging`) with synthetic users and separate passwords. Later, a switch must exist to use UFS People's real Supabase project (`SUPABASE_URL` + publishable key) so staff sign in with their UFS People accounts, with the directory feed (`DIRECTORY_URL`) supplying who is who. Design notes: tracker identities are bound by Supabase `sub`, so a separate project's accounts will not match UFS People's ids; moving to the shared project means switching env vars and the feed's identities together and retiring the staging accounts. Real staff are never loaded into the staging project.

- [ ] **2c Staging integration:** point a staging tracker at the staging directory endpoint (`DIRECTORY_URL`, `DIRECTORY_TOKEN`) and staging Supabase; run the e2e with synthetic people; fix the differences from the fakes (field names, token claims, rate limits, MFA flow details).
- [ ] Confirm the real Supabase behaviors the fake only approximates: TOTP challenge/verify responses, `GET /user` on revoked sessions, banned users, factor listing in the password response, rate limits (429), signing-key rotation.
- [ ] **2e Pilot** with 3-5 volunteers on production; then retire tracker-only passwords (keep **one break-glass owner** with a strong password and 2FA plan).
- [ ] Decide what "password reset elsewhere" should do to tracker sessions (the `notBefore` feed field handles it once UFS People exposes its per-subject cutoff).

## 4. Hosting and operations (M-L)

- [ ] Choose and set up hosting: small VM/Railway/Fly with a **persistent disk** and automated backups (for example Litestream to S3/R2), **or** rewrite for Cloudflare Workers + D1 + R2 (best long-term fit with UFS People; larger rewrite).
- [ ] HTTPS reverse proxy, correct Express `trust proxy` setting (otherwise the per-IP login limiter sees the proxy address), secrets management, log shipping, uptime monitoring and alerts.
- [ ] Backups and **restore drills**; bucket **lifecycle rule** = retention + 1 day (command in `server/README.md`).
- [ ] Rate limiting beyond login; request size limits review; dependency audit routine (`npm audit` in both projects); automated CI running both test suites.
- [ ] Separate **staging and production** configs and data.
- [ ] Optional: move SQLite to Postgres *only if* scale demands it before the merge (not recommended).

## 5. Release hardening for the desktop app (M)

- [ ] **Code signing** certificate and signing in the build; **app icon**; installer branding.
- [ ] **Auto-update** channel and rollback plan.
- [x] **Optional local-data deletion on Windows uninstall:** interactive NSIS uninstall asks before removing `%APPDATA%\UFS Desktop Tracker\Local Tracker Data`; No is the default and preserves screenshots, sessions and pending uploads. The installer compiled and the choice/path are covered by a regression test. Still verify both choices with disposable synthetic app data; the uninstaller has not been run here.
- [x] On quit, stop and persist the active session, then run a bounded 10-second best-effort queue flush before exit. Timed-out/offline items stay durable for the next launch; shutdown prevents new retries from being scheduled. Main-process and sync tests cover ordering, bounded timeout, queue retention and late failures.
- [ ] Interactive installer test (wizard, custom folder, SmartScreen on first run).
- [ ] Mac and Linux builds verified (Mac needs signing and notarization; both are untested here).

## 6. Real-hardware verification (needs a person at the PC) (S-M)

- [ ] **Full 60-minute one-hour test run** (real clock, not simulated).
- [ ] **Sleep/wake, lock screen, unplugging the selected monitor, Windows clock change**: capture must pause and never silently resume.
- [ ] Multi-monitor with mixed scaling (one extra 125% screen was tested), disk-full and denied-write errors visible to the user.
- [ ] **Windows file permissions (ACLs)** on screenshots and `sessions.json` (the `0600` Unix tests do not apply on Windows).
- [ ] Verify network behavior with an authorized network inspection (no calls except to the configured server).

## 7. Time Doctor parity features (L overall; see `WHAT-TO-BUILD.md` for IDs)

- [x] **A9 count-only activity foundation (2026-10-27):** opt-in org policy, consent-version bump guard, minute aggregates, offline queue, API persistence, employee/manager estimate column and audit on non-owner views. Desktop/server suites and isolated dashboard run use synthetic events/accounts. Native global hook is packaged but has not been exercised against real OS input.
- [x] **A10 desktop manual time (2026-10-27):** signed-in/notice-accepted/stopped-only form, project/task and reviewer note, durable offline queue, stable retry id, employee history and server approval flow. Server and desktop suites plus synthetic renderer/IPC checks pass. A10 is in the rebuilt unsigned Windows installer; it was inspected but not installed or launched.
- [x] **A11 in-app reminders (2026-10-27; partial feature):** inherited break interval and local work schedule policy, server validation/rollback, admin controls and employee-visible desktop prompts. Desktop, server and dashboard checks pass; A11 installer rebuilt and inspected. Still missing app-closed notifications, a dedicated break record/timesheet and C5 attendance reports.
- [x] **B11/C6 daily rollups (2026-10-27; partial scope):** migration backfills per-entry UTC-day aggregates from authorized minute slices; insert/update/delete triggers maintain them transactionally and entry deletion cascades. Added `/api/reports/activity/daily` and a dashboard mode with UTC dates, scoped access, view/export audit, CSV note and no productivity/attendance/pay claim. Server typecheck/tests **144/144** and isolated browser suite **70/70** pass. App/website usage is not collected; any such feature needs transparent consent and defined privacy review.
- [x] **C6 activity-estimate report (2026-10-27; partial reporting):** grouped by person/project/day with consented sampled seconds, count-only key-down/click totals, audit events, role scoping, CSV and explicit no-pay/no-productivity disclaimer. Daily UTC rollup mode is also tested in API and dashboard.
- [ ] Review the A9 native dependency's licensing and relinking obligations before any rollout; notice and license texts are bundled, but legal review remains open.

Order suggested after the pilot works, subject to what the Time Doctor discovery run finds:

1. **Done 2026-10-26:** idle "were you working?" prompt with keep/discard (A8) for company sessions. **Done 2026-10-27:** activity levels from keyboard/mouse *counts only* (A9) and desktop manual-time submissions for approval (A10). M.
2. **C5 partial (2026-10-27):** per-person IANA timezone and late-grace policy, tracker-only attendance evidence, late/no-tracker/in-progress/upcoming statuses, prorated within/outside-schedule estimates, scope/audit and CSV are implemented. The full dashboard suite is 70/70 and the unsigned C5 installer is rebuilt/inspected. Confirm UFS work zones before relying on schedule data; decide a leave/holiday source before presenting absence; do not call prorated time payroll overtime. Full attendance/payroll parity remains open. M.
3. **C6/B11 partial:** activity report and daily UTC aggregate/report are implemented. Remaining: verify the new daily-report dashboard mode end-to-end and keep the existing limitations explicit; **scheduled email reports** (C8) remain. M.
4. **Notifications and email** (B10). M.
5. **Payroll and invoice exports**, pay rates, approvals (B14, C11). L.
6. **Data export and deletion on request** (GDPR-style) (B15). M.
7. **Public API, API keys, webhooks** (B12); **integrations** such as Jira/Asana (B13). L.
8. **App and website usage** (A12, C7): *only if kept visible and consented*, with employee-facing disclosure. L.
9. **Mac, Linux, mobile, browser extension** (A14). L.
10. Reconcile with UFS People's existing manual `time_entries` (decide whether tracked time feeds its timesheets). M.

## 8. Phase 5: merge into UFS People (L)

Once stable: move routes and dashboard into the Next.js app on Cloudflare, tracker tables into D1 (SQLite dialect, so mostly a data copy), screenshots stay in R2/S3 (the S3 store already speaks R2). Reconcile roles, audit and the time-entry overlap. Needs the boss's agreement and a plan for his release process.

## 9. Time Doctor discovery (S to start, M to finish)

`TIME-DOCTOR-DISCOVERY-PROMPT.md`: after the terms check (2.9), run **one** agent through the admin app and desktop client on a trial account with synthetic users, producing the inventory, flows, gap analysis and risks. Feed `gap-analysis.md` back into item 7.

## 10. Known technical debt and limits (track, do not forget)

- SQLite single process; no clustering; backups manual until section 4 is done.
- Tracker sessions are bearer tokens in the dashboard's `sessionStorage` (mitigated by a strict CSP; no cookies). A password reset or sign-out elsewhere in UFS People does not end tracker sessions until `notBefore`, expiry (12 h web / 30 days device for UFS People logins) or an admin/directory action.
- The directory has no push or webhook; changes appear at the next sync (default 15 minutes).
- The desktop's `main.cjs` stops tracking after a 5-second event-loop stall (a safety feature); keep heavy work off the main thread.
- Older local PNG captures without a saved thumbnail are decoded on demand (2 per refresh); WebP captures without a thumbnail show none (the image still opens).
- Idle time is an input estimate only (the configured company threshold is applied); A8 provides a keep/discard review prompt. A9 optionally reports count-only keyboard/mouse activity estimates; it stays off by default and has not been exercised with real OS input. A11 reminders appear only while the desktop app is open; schedule time is the device-local clock and is not attendance payroll evidence.
- No SSO other than UFS People; no 2FA for local break-glass accounts; no self-service password reset (it lives in UFS People).
- Tests that need a browser or real capture are **not** in `npm test` (they need Playwright, take real screenshots and wipe app data); run them by hand or in a dedicated CI machine.

## 10b. Added 2026-10-28 (owner requests, full to-do)

- [ ] **In-place desktop updates (major requirement):** when a new version is released, installed apps must update themselves and keep all local data (screenshots, sessions, pending uploads, sign-in), never "uninstall then reinstall". Plan: `electron-updater` with the NSIS target; the feed (`latest.yml` + installer) is served from the configured company server (or R2 behind it) so the app still talks only to its own server; visible "update available / restart to update" prompt, never silent without a notice, never while tracking, signed installers required (code signing, section 5) and a rollback plan. **Critical:** `source/build/installer.nsh` shows a "delete local data?" prompt in the uninstall macro, and an in-place NSIS update runs the old uninstaller, so that macro MUST be skipped when `${isUpdated}` is true or an update would ask to delete (or delete) employee data. Add tests and test an update 0.2.0 to 0.2.1 on disposable data.
- [ ] **CI/CD from GitHub to Cloudflare:** CI (tests on push) exists in `.github/workflows/ci.yml`. CD is blocked on the hosting choice in `HOSTING-CLOUDFLARE.md`: the server cannot run on Workers as is. The Cloudflare account visible to the Claude session holds the production `ufs-people` Worker and `ufs-people-db` D1; **R2 is not enabled** there. Needs from you: decide option 1/2/3, enable R2 (billing), and whether tracker resources live in that same Cloudflare account. Never modify the `ufs-people` resources from this project.
- [ ] Release pipeline: tag-triggered GitHub Action that builds the signed installer, publishes it and the update feed, and records the SHA-256.
- [ ] Staging users: more synthetic roles if needed; turn off sign-ups and enable leaked-password protection on `ufs-tracker-staging` (dashboard).
- [ ] Confirm the first GitHub Actions run passes (Windows runner, Node 24).
- [ ] Optional later: sync option with UFS People (section 3) and a decision on repository visibility/branch protection for `United-Field-Services/UFS-tracker`.

## 11. Rough path to a pilot

| Step | Items | Rough effort | Blocked by |
|---|---|---|---|
| A | 0, 1 | 1-2 days | nothing |
| B | 2.1-2.4 (boss builds the endpoint, staging Supabase) | 1-2 weeks elapsed | boss, Supabase owner |
| C | 3 (staging integration) + 4 (hosting, HTTPS, backups) + 5 (signing, icon) | 1-2 weeks | B, 2.5, 2.7 |
| D | 6 (hardware checks) + 2.10 (legal review) | 1 week | C |
| E | Pilot with 3-5 people, then widen | 2-4 weeks | D |

Feature parity work (item 7) can proceed in parallel with B-E once the core is stable.
