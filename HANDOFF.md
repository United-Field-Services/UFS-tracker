# UFS Time Tracker: Handoff (read this first)

*Original handoff written 2026-10-26; current state refreshed 2026-10-27. `PROGRESS.md` is the dated evidence log and its newest checkpoint overrides any older historical counts below. For current behavior, code and tests are authoritative; older changelog counts below are historical.*

---

## 1. What this application is

A **Time Doctor-style time and screenshot tracker for UFS staff**, built to be **visible and consent-based** (never covert). It has three parts:

| Part | What it is | Where | Tech |
|---|---|---|---|
| **Desktop app** | Windows app employees run. Visible timer (Start/Pause/Resume/Stop), captures the selected screen by default or all connected screens when the organization enables that policy, only while tracking is visibly on. Can run **locally only** (original prototype modes) or **signed in to a company account** where it syncs time + screenshots to the server under company policy. | `source/` | Electron 44, plain JavaScript (CommonJS) |
| **Tracker server + dashboard** | Backend API and a web dashboard for employees, managers, HR and admins: accounts, roles, time approval, screenshot review, reports, policy, audit log, live status, retention. | `server/` | Node 24, TypeScript (run directly, no build), Express 5, Zod 4, built-in SQLite |
| **UFS People link** (built against fakes; real endpoint pending) | Pull allow-listed people/managers/roles from UFS People through one read-only feed, and sign people in with their **UFS People (Supabase) account**, including the authenticator code for privileged roles. | `server/src/directory.ts`, `supabase-*.ts` | |

**It started as** a zip, "UFS Desktop Tracker 0.2.0 Windows Developer Package": a local-only Electron prototype with 101 tests that had never been run on Windows. The original handoff docs are still in the folder (`WINDOWS-DEVELOPER-HANDOFF.md`, `START-HERE-WINDOWS.txt`, `source/README.md`, `source/QA-CHECKLIST.md`).

**Non-negotiable principles** (do not weaken these):
- Tracking is **always visible** to the employee. There is deliberately **no hidden/silent mode** and the policy validator rejects unknown settings.
- Screenshots use the employee-selected screen by default; an organization-only, default-off policy can capture every connected screen into one joined image. Capture happens only while the app visibly says tracking is on. Optional A9 records keyboard key-down and mouse-click counts only after notice/consent; it never stores key identity, text, coordinates, audio, camera, or app/website data.
- Employees must accept a **monitoring notice** before anything is uploaded; they can see what is recorded about them.
- Least privilege: the tracker never gets UFS People's database or HR data, only an allow-listed directory feed (it **blocks** any feed that contains sensitive-looking fields).
- Idle time is an *estimate*, shown as such, never a pay or productivity decision.
- Never use real employee data or real logins for testing. Staging and synthetic people only.

---

## 2. How far we got

### Overall picture (my estimates)

| Measure | Estimate |
|---|---|
| **A usable internal pilot** (small team on a staging deployment) | **about 75% built.** What is missing is mostly outside the code: real UFS People/Supabase connection, deployment, signing, legal review, real-hardware checks. |
| **Time Doctor feature parity** (their full feature list) | **about 35-40%.** The core loop (track, screenshot, sync, review, approve, report, policy, audit) works; many secondary features are not started (see section 5). |
| **Production readiness** | **about 40%.** Strong on tests and safety guards; not yet deployed, signed, backed up, security-reviewed or legally reviewed. |

### Component status

| Component | Status | Notes |
|---|---|---|
| Desktop: tracking, consent, screenshots, gallery, one-hour test, manual mode | **Done**, tested on real Windows (source and packaged exe) | original features, plus a blocker bug fixed (see session log) |
| Desktop: company sign-in, project/task picker, policy enforcement (interval, screenshots on/off, blur, required project, image format/quality, org-only all-screens), monitoring-notice gate | **Done and tested synthetically** | all-screens consent/renderer/main paths covered; physical multi-monitor capture not verified; previous real-app end-to-end 54/54 predates later TOTP/A8/A9/A10 changes |
| Desktop: manual time submission for approval | **Implemented and synthetically tested** | stopped/notice/sign-in gated; durable offline retry; history and server approval status; included in rebuilt Windows package |
| Desktop: break and scheduled-hour reminders | **In-app version implemented; A11 partial** | configurable break interval and weekday/hour schedule in an explicit IANA timezone; prompts only while app is open; no break records or closed-app reminder delivery |
| Desktop: offline upload queue (retry/backoff, idempotent, survives restart), bounded shutdown flush, visible expired-session recovery, live status heartbeat, DPAPI-encrypted device token | **Done and tested synthetically** | shutdown stops and persists tracking before a bounded flush; expired-session queue retention and same-account reauthentication covered; outage test covers idempotent retry |
| Desktop: WebP screenshots + JPEG thumbnails | **Done and tested** | about 6x smaller than PNG on a real 1080p screen |
| Desktop: authenticator-code (TOTP) field for UFS People sign-in | **Implemented + unit-tested; physical-display E2E not run** | see section 8 |
| Server: accounts, roles (owner/admin/hr/manager/employee), device tokens, throttling | **Done and tested** | |
| Server: time sync (idempotent, tamper limits), manual time, approval, edit-with-reason, locks | **Done and tested** | |
| Server: screenshots (PNG/WebP), visibility policy, retention, audit, reports + safe CSV, live view, policy inheritance | **Done and tested** | |
| Server: S3-compatible storage (AWS S3, R2, MinIO, Supabase) + disk | **Done; tested only against a fake S3** | needs a real-bucket smoke test |
| Server: UFS People directory sync (people, managers, roles, teams, identities) | **Done; tested only against a fake feed** | the real endpoint does not exist yet |
| Server: Supabase sign-in (password, TOTP for admin/HR/owner, ES256/JWKS verification, live check, identity binding) | **Done; tested only against a fake Supabase** | 26 server tests pass |
| Server/dashboard: C5 schedule/time evidence | **Implemented partial; synthetic browser tested** | per-person schedule timezone/grace, tracker-only statuses, scoped auditing and CSV; outside-schedule time is prorated estimate; no leave/holiday feed |
| Server/dashboard: B11/C6 daily activity rollups | **Implemented and synthetic-tested** | Migration backfill, insert/delete triggers, report API, UTC day view, role scope, audit and CSV |
| Dashboard: all views for employee/manager/HR/admin/owner, directory panel, TOTP login, A9 and all-screens consent, A11 policy, C5/C6 reports | **72/72 isolated synthetic browser checks pass** | Includes all-screens notice/version and organization-only policy controls plus C5 and daily UTC activity report disclaimers; role, directory and fake-auth flows tested |
| Installer (Windows NSIS, unsigned) | **Rebuilt with all-screens, session-expiry recovery and optional uninstall data deletion; ASAR/NSIS inspected** | `source/release/UFS Desktop Tracker Setup 0.2.0.exe`; 111,880,919 bytes; SHA-256 `94275B9C488F7C519EC467ADA326B0F4C5E692C43597799621979920C86DA30F`; NotSigned; not installed/launched |
| Real UFS People connection, real Supabase, deployment, HTTPS, backups, signing, icon, auto-update | **Not started** | needs input from you/your boss (section 7 of REMAINING-WORK.md) |

### Size of the work
The original 2026-10-26 handoff counted about **7,500 lines** of code/tests (excluding docs). That is a historical estimate, not a current size metric.

---

## 3. Architecture

```
                         EMPLOYEE'S WINDOWS PC
   ┌────────────────────────────────────────────────────────────┐
   │  Desktop app (Electron)                                    │
   │  renderer: UI, screen capture, WebP/JPEG encode (no network)│
   │  main:     tracker state machine, policy enforcement,      │
   │            local store, sync client (ONLY place with network)│
   └───────────────┬────────────────────────────────────────────┘
                   │ https (device token, uploads, heartbeat, sign-in)
                   ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Tracker server (Node/Express/SQLite)   + web dashboard     │
   │  accounts · roles · time · screenshots · reports · policy   │
   │  audit · retention · directory sync · Supabase sign-in      │
   └───┬──────────────────────┬──────────────────────┬──────────┘
       │ BlobStore            │ pull (read-only)      │ password grant + TOTP,
       ▼                      ▼                       ▼ JWKS, live /user check
  Disk or S3/R2/        UFS People directory     Supabase Auth
  Supabase bucket       endpoint (to be built    (UFS People's login)
                        by UFS People owner)
```

Key design choices:
- **The renderer has no network at all** (strict CSP). All network runs in the main process, only after explicit sign-in.
- **The tracker never stores a Supabase token or password.** It verifies the login, closes the temporary Supabase session, and issues its **own** revocable tracker session (web 12 h; device 90 days, 30 for UFS People logins).
- **People are matched by approved identity (Supabase `sub` to employee), never by email**, mirroring how UFS People works.
- **Directory-owned fields** (name, email, role, manager, team, active) are locked in the tracker; the directory is the source of truth.
- **Safety guards everywhere:** blocked syncs change nothing, are audited, and only an owner can force one.

---

## 4. Folder map

```
UFS-Desktop-Tracker-0.2.0-Windows-Developer-Package/
├─ HANDOFF.md                  <- this file
├─ SESSION-LOG.md              <- full story of what we did, bugs found, lessons
├─ REMAINING-WORK.md           <- everything left, prioritized, with what each needs
├─ NEXT-SESSION-PROMPT.md      <- paste this into the new Claude session
├─ CLAUDE.md                   <- auto-read by Claude Code in this folder
├─ PROGRESS.md                 <- dated checkpoints (newest first)
├─ DECISIONS-AND-PLAN.md       <- locked decisions + phased plan (Phase 2 revised)
├─ WHAT-TO-BUILD.md            <- full Time Doctor-style feature checklist with status
├─ TIME-DOCTOR-DISCOVERY-PROMPT.md  <- prompt for ONE agent to study Time Doctor (needs ToS check first)
├─ WINDOWS-DEVELOPER-HANDOFF.md, START-HERE-WINDOWS.txt, verification/   <- original package docs
├─ source/                     DESKTOP APP
│  ├─ src/        main.cjs (window, IPC, policy, gallery), tracker.cjs (state machine),
│  │              sync.cjs (sign-in, upload queue, heartbeat), storage.cjs (local PNG/WebP + thumbs),
│  │              clock.cjs, preload.cjs
│  ├─ renderer/   index.html, app.js, style.css
│  ├─ tests/      180 unit tests (security, races, storage, sync, company mode...)
│  ├─ e2e/        lifecycle.e2e.cjs, company.e2e.cjs  (REAL Electron + real server; see section 6)
│  └─ release/    built installer (git-ignored)
└─ server/                     TRACKER SERVER + DASHBOARD
   ├─ src/        app.ts, auth.ts, db.ts (schema + migrations 1-4), routes-*.ts, policy.ts,
   │              storage.ts, s3-store.ts, store-factory.ts, retention.ts,
   │              directory.ts (UFS People sync), supabase-auth.ts, supabase-login.ts,
   │              fake-directory.ts, fake-supabase.ts, seed-demo.ts, server.ts
   ├─ public/     dashboard (index.html, app.js, style.css; no build step)
   ├─ tests/      145 API tests;  tests-ui/ dashboard.ui.cjs (72 browser checks)
   ├─ README.md   server setup, env vars, roles, storage, directory
   ├─ DIRECTORY-FEED.md  spec to hand to the UFS People owner
   └─ reset-demo.ps1     starts the whole demo stack (ports 4300/4310/4320)
```

---

### Where runtime data and build artifacts live

- **Employee desktop data on Windows:** `%APPDATA%\UFS Desktop Tracker\Local Tracker Data\` (Electron `userData` plus `Local Tracker Data`). `Screenshots\` holds local images; `sessions.json` is the local index; company sync configuration and pending queue files are in the same directory. The app shows its exact folder in the footer. Uninstall currently leaves this data in place.
- **Server database and disk screenshots:** `TRACKER_DATA_DIR` controls the location. Default is `server/data/`, with `tracker.sqlite` and `screenshots/` below it. `STORAGE_DRIVER=s3` sends screenshot objects to the configured S3-compatible bucket instead; SQLite remains on disk.
- **Synthetic demo data:** `server/data-demo/` is used by `reset-demo.ps1`; it is disposable demo data and was not used for the latest tests. Isolated browser checks seed a new `%TEMP%` directory.
- **Windows installer/build:** `source/release/`; generated output is not source and is excluded from the source hash inventory. Current installer details are in the newest `PROGRESS.md` checkpoint.

## 5. Feature checklist (what exists today)

**Done:** visible timer; consent gate; selected-screen screenshots; local gallery/sessions; one-hour test mode; local manual mode; company sessions at policy interval; project/task picker; screenshots on/off, blur, WebP/PNG policy; offline queue; live status; company idle review A8; optional count-only activity estimate A9; desktop manual time A10; in-app break/scheduled-hour prompts A11; accounts and 5 roles; device tokens; time sync with tamper limits; server manual time + approval + edit-with-reason + locks; screenshot visibility policy; retention (90-day default); hours reports and C6 count-only activity-estimate reports + safe CSV; audit log; policy org>team>user; HR read-only role; directory sync with guards; Supabase sign-in with TOTP (against fakes); dashboard for every role.

**Still open (from the Time Doctor list):** A11 app-closed reminders and dedicated break records; attendance/lateness/overtime (C5, pending a trusted per-employee timezone); B11 daily activity rollups; app/website usage (only if kept visible and consented); notifications and email; payroll/invoice exports; scheduled report emails; public API, API keys, webhooks; Jira/Asana integrations; data export/deletion on request; Mac, Linux, mobile, browser extension; auto-update, code signing, app icon; SSO beyond UFS People; self-service password reset (that stays in UFS People). A15's optional Windows uninstall data-deletion prompt is implemented; verify it on disposable app data. Full list with sizes: `WHAT-TO-BUILD.md`.

---

## 6. How to run and test everything

**Prerequisites:** Windows 11, Node 24 (needed for TypeScript type stripping and `node:sqlite`), Microsoft Edge (for the dashboard browser test). Playwright is **not** a project dependency; install `playwright-core` in a **short path** such as `C:\pw` (Windows 260-character path limit bites Chromium in long folders).

```
# Server
cd server
npm install
npm run check                    # type-check + 145 API tests (in-memory DB, real HTTP, fake S3/directory/Supabase)
npm start                        # needs TRACKER_OWNER_EMAIL + TRACKER_OWNER_PASSWORD on first start
npm run seed:demo                # synthetic demo data (empty data dir only)
powershell -File reset-demo.ps1  # re-seeds and starts: tracker :4300, fake UFS People :4310, fake Supabase :4320

# Dashboard browser tests (needs the demo stack running)
set DEMO_PASSWORD=<DEMO_PASSWORD constant in server/src/seed-demo.ts>
set PW_PATH=C:\pw\node_modules\playwright-core
node tests-ui/dashboard.ui.cjs   # 72 checks; supports endpoint overrides for isolated synthetic runs

# Desktop app
cd source
npm ci
node node_modules/electron/install.js    # npm ci alone did NOT download the Electron binary here
  npm run check                    # syntax check + 188 unit tests (182 pass, 6 platform-only skipped)
npm start                        # run from source
npm run build:win                # installer in source/release/ (unsigned)

# REAL end-to-end (takes real screenshots of your screen for ~6 minutes, wipes app data, spawns its own server)
set E2E_WIPE_DATA=1
set PW_PATH=C:\pw\node_modules\playwright-core
node e2e/company.e2e.cjs         # add PACKAGED_EXE=<...>\release\win-unpacked\UFS Desktop Tracker.exe to test the packaged build
```

**Environment variables (server):** `PORT`, `TRACKER_DATA_DIR`, `TRACKER_OWNER_EMAIL/PASSWORD/NAME` (first start only); storage `STORAGE_DRIVER=disk|s3`, `S3_BUCKET/REGION/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE/PREFIX/SSE`; directory `DIRECTORY_URL/TOKEN/SYNC_MINUTES/OWNER_EMPLOYEE_ID`; Supabase `SUPABASE_URL/PUBLISHABLE_KEY/REQUIRE_AAL2_ROLES/DEVICE_SESSION_DAYS`. Details in `server/README.md`.

### Test status (last verified 2026-10-27)

| Suite | Result | Covers |
|---|---|---|
| Server API (`server/tests`) | **142 / 142** | auth, permissions, time, manual retry/idempotency, activity consent/aggregation/reports, screenshots, hours reports, policy inheritance/validation, S3 store, HR, WebP, migrations, directory sync, Supabase sign-in |
| Dashboard browser (`server/tests-ui`) | **68 / 68** | every role's views, forms, directory panel, owner force/recovery, A9 policy consent, A11 policy controls, C6 estimate report, UFS People sign-in + TOTP screens |
| Desktop unit (`source/tests`) | **182 passed, 0 failed, 6 skipped** (platform-only) | tracker state machine, privacy/security rules, races, storage, WebP, sync client, company mode, all-screens, expired-session recovery, uninstall deletion-choice config, A9, A10 manual queue/IPC, TOTP |
| Synthetic desktop renderer | **A11 reminders, manual time, idle review keep/discard passed** | headless Edge with synthetic state; no display capture or app-data access |
| Real-app end to end (`source/e2e/company.e2e.cjs`) | **54 / 54** (last full run before later TOTP/A8/A9 changes; not rerun) | Existing run covered sign-in, consent, capture cadence, WebP, thumbnails, HR view, outage/recovery, policy changes, blur, restart, sign-out |

**Never tested (be honest about this):** desktop native input hook against OS events; a synthetic-display desktop E2E for the latest app; a real AWS/R2/Supabase bucket; the real Supabase project; the real UFS People endpoint (not yet available); a full real 60-minute one-hour run; sleep/wake, lock screen, unplugging a display, clock changes; Windows file permissions (ACLs); the interactive installer wizard and SmartScreen; multi-hundred-user load.

---

## 7. Decisions already made (do not re-ask)

From the owner, 2026-10-26: separate service now and **merge into UFS People later** (sharing people data meanwhile) · desktop login = **UFS People (Supabase) account** · screenshots on **S3-compatible storage, S3 default**, admin can switch · **employee + direct manager + HR** see screenshots, **90-day** retention · **internal to UFS only** · image format **admin-chosen, WebP default**.
Recommended answers used for the rest: keep **SQLite** until the merge (no Postgres), directory is **pulled** from a read-only endpoint UFS People will expose, login goes **through the tracker server**, TOTP required for **owner/admin/HR**. Rationale in `DECISIONS-AND-PLAN.md`.

**Key finding that shaped Phase 2:** UFS People keeps all HR data in **Cloudflare D1 (SQLite) + R2**; **Supabase is used only for sign-in** (password + TOTP, ES256-signed tokens, `employee_identities` maps Supabase user id to employee). The UFS People repo is at `C:\Users\venky\Desktop\ufs\UFS-People` and was only **read**, never changed. It is mid-release (password reset flag off, D1 migration 0011 pending), owned/managed by the user's boss.

---

## 8. Exactly where things stand right now

**The older history below records prior checkpoints; current follow-up status is in the newest `PROGRESS.md` entry.**
- **Done and passing at the 2026-10-27 current checkpoint:** server 145/145; desktop 182 pass/6 platform skips; latest isolated synthetic dashboard 72/72; A11 reminders, B11/C6 daily activity, C5 evidence report, all-screens synthetic paths, expired-session recovery, manual-time and idle-review renderer checks. The rebuilt unsigned Windows installer contains all-screens, session-expiry recovery and an opt-in uninstall data prompt. Prior dependency audits reported zero vulnerabilities; package manifests have not changed.
- **Written but NOT run:** "Phase K" in `source/e2e/company.e2e.cjs` signs synthetic HR in with TOTP, tests wrong and right codes, tests an employee and an unlinked account. `node --check e2e/company.e2e.cjs` now passes. The test still captures the selected physical display and deletes the app-data folder named by `%APPDATA%`; run it only with synthetic display content and a disposable app-data location.
- **Done since that historical checkpoint:** A9 count-only activity, A10 manual time, A11 in-app break/schedule reminders, and C6 grouped activity estimates. The current unsigned Windows installer contains A11 and the native module plus bundled notice/license files; its SHA-256 and exact size are in `PROGRESS.md`. C6 is server/dashboard code and does not change the desktop installer.
- **Still not verified:** physical-display desktop E2E for latest code; OS activity hook; real Supabase and UFS People connections; a real S3/R2 bucket; and production deployment. See `REMAINING-WORK.md` for blockers and safe test requirements.
- **Git:** since 2026-10-28 this folder is a Git repository (branch `main`) connected to `https://github.com/United-Field-Services/UFS-tracker`; CI is `.github/workflows/ci.yml`. Synthetic staging credentials live in the git-ignored `server/.staging-local/`.
- **Staging Supabase:** `ufs-tracker-staging` with 24 synthetic users (see `server/STAGING-SUPABASE.md`); start the whole staging stack with `server\start-staging.ps1`, stop with `server\stop-staging.ps1`.
- The demo stack (ports 4300/4310/4320) was left running by `reset-demo.ps1`; it is stopped at the end of this handoff. Restart it with `powershell -File server\reset-demo.ps1`.

---

## 9. Known gotchas (will save you hours)

- **Windows 260-character path limit:** Chromium cannot open files under very long folders (a test copy in a deep temp path failed with ERR_FILE_NOT_FOUND). Keep Playwright and test copies in short paths.
- `npm ci` did not download the Electron binary here; run `node node_modules/electron/install.js`.
- The Playwright launcher **ignores `--user-data-dir`**, so the e2e uses and **wipes** `%APPDATA%\UFS Desktop Tracker\Local Tracker Data` (hence the `E2E_WIPE_DATA=1` guard). Do not run it on a machine whose local tracker data matters.
- **Electron cannot decode WebP** (`nativeImage` supports PNG/JPEG only), which is why the renderer makes the WebP image and a JPEG thumbnail at capture time.
- The desktop app **pauses tracking if its main loop stalls more than 5 seconds** ("timing gap" safety). We fixed one stall (decoding 60 screenshots on every gallery refresh); keep the main process free of heavy synchronous work.
- `source/tests/main.test.cjs` runs `main.cjs` in a separate VM realm: compare returned objects as JSON, not with strict deep equality.
- The server runs `.ts` directly with Node 24: no enums, no constructor parameter properties (`erasableSyntaxOnly`); imports need explicit `.ts` extensions. Zod is v4.
- Tests that jump the fake clock (sessions last 12 h) must log in again afterwards.
- `reset-demo.ps1` starts background processes that keep a PowerShell job open; treat its "timeout" as normal and just check `http://127.0.0.1:4300/api/health`.
- *Tooling note for the AI assistant:* long shell heredocs that contain backslashes or apostrophes get mangled on this setup; write patch scripts to a file or use the editor tool instead.

---

## 10. Document index

| File | Purpose |
|---|---|
| `HANDOFF.md` | this overview |
| `SESSION-LOG.md` | chronological history: what was done, bugs found and fixed, lessons |
| `REMAINING-WORK.md` | everything left, prioritized, with who/what each item needs |
| `NEXT-SESSION-PROMPT.md` | ready-to-paste prompt for the new Claude session/account |
| `CLAUDE.md` | short rules that Claude Code reads automatically in this folder |
| `PROGRESS.md` | dated checkpoints (newest first) |
| `DECISIONS-AND-PLAN.md` | locked decisions and the phased plan (Phase 2 revised after reading UFS People) |
| `WHAT-TO-BUILD.md` | the full feature checklist with status |
| `TIME-DOCTOR-DISCOVERY-PROMPT.md` | prompt for one agent to inventory Time Doctor (clean-room; needs a terms-of-service check first; not yet run) |
| `server/README.md` | server setup, env, roles, storage, directory |
| `server/DIRECTORY-FEED.md` | the endpoint spec to give the UFS People owner |
