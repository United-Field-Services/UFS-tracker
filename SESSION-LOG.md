# Session log: from a zip file to a working tracker (2026-10-22 to 2026-10-26)

How the project went, in order, so a new person can see *why* things are the way they are. Overview: `HANDOFF.md`. What is left: `REMAINING-WORK.md`.

---

## Stage 1: Bring up the original prototype on Windows (22 Oct)

**Ask:** extract the "UFS Desktop Tracker 0.2.0 Windows Developer Package" zip into a new folder under `Desktop\ufs`, run it locally, learn it, test everything, fix flaws and finish what is pending.

1. Extracted the zip (35 files, source only, no dependencies vendored). Read the handoff and README: a **visible, consent-based, local-only Electron screenshot tracker** with 101 automated tests that had only ever run on Linux with mocks. The app had never been run on Windows or with real screen capture.
2. `npm ci` (Node 24.16). `npm run check`: **95 passed, 0 failed, 6 skipped** (the 6 are Linux launcher tests).
3. The Electron binary was **not** downloaded by `npm ci`; ran the README's `node node_modules/electron/install.js`.
4. Built a **real end-to-end test**: Playwright driving the actual Electron app (installed outside the project so the lockfile stayed untouched).
5. **First real run found a blocker:** every Start ended in "Permission denied", so no screenshot could ever be saved. Cause: on Electron 44 / Windows, `getDisplayMedia()` raises permission `media` with an **empty `mediaTypes` list**, while the code only accepted `display-capture`. The original unit test mocked Electron and even asserted `media` must be denied, so it never matched reality. **Fix:** accept `media` only when `mediaTypes` is empty (camera/mic requests list `video`/`audio` and stay denied), keeping every other gate (trusted window and URL, `starting` phase, before deadline). Test rewritten to the real behavior.
6. After the fix: real capture works; **25/25**, then a lifecycle suite **28/28** on source and on the packaged exe: no capture at launch, consent and display required, pause/resume/stop, minimize pauses, quit and hard-kill recovery, second instance, no non-local requests, second monitor at 125% scaling.
7. The one-hour deadline cannot be waited out, so a **scaled-down copy** (50 s limit, 10 s slots) proved the real expiry logic: slots saved, missed slot skipped after a pause, auto-stop at 50.0 s, nothing afterwards, fresh start creates a new session.
8. Replaced a macOS-only error message ("allow screen recording in System Settings") with a Windows-appropriate one.
9. **Built the Windows installer** (`npm run build:win`, NSIS, unsigned), ran the packaged exe through the same suite (28/28), then **silent per-user install, uninstall, reinstall**: program files, shortcut and registry entry removed on uninstall; **screenshots and session data are kept after uninstall** (documented as a privacy item to fix); reinstall picked the old gallery up again. One check missed once on a fixed 3 s wait; measured resume latency 1.2-1.9 s in 5 of 5 attempts (not reproduced).
10. Test data (which contained real screenshots of the user's desktop) was deleted after every run.

## Stage 2: "How close are we to Time Doctor?" (22-23 Oct)

- Honest gap analysis: the prototype was about **10-15%** of a Time Doctor-like product (no accounts, server, dashboard, reports, projects, idle prompts, integrations...).
- The boss wanted bots to study Time Doctor's application. Wrote **`TIME-DOCTOR-DISCOVERY-PROMPT.md`**: a **clean-room, black-box feature inventory** by **one** agent, on a trial account created by a human with synthetic users; no decompiling, no traffic interception, no scraping, no copying of their assets. Flagged that Time Doctor's terms of service likely forbid reverse engineering and automated access, so someone must check the terms first. **Not run.**
- Wrote **`WHAT-TO-BUILD.md`**: the full feature list (desktop, backend, dashboard, privacy, operations) with phases and sizes.

## Stage 3: Backend, dashboard, company sync (24-26 Oct)

Used my recommended defaults without waiting for answers: standalone TypeScript/Express/SQLite server, email+password device tokens, disk storage behind an interface, employee + direct manager visibility, 30-day retention (later changed to 90).

- **Server** (`server/`): accounts, roles, device tokens, throttling; idempotent time sync with tamper limits; manual time, approval, edit-with-reason, locked approved time; screenshot upload/thumbnail/view/delete with visibility policy; retention; live presence; hours report with spreadsheet-safe CSV; audit log; policy org>team>user; consent gate. **53 API tests.**
- **Dashboard** (`server/public`): employee, manager, admin views. **37 browser checks.**
- **Desktop company mode** (`source/src/sync.cjs` and friends): sign-in with encrypted device token, project/task picker, policy enforced in the *main* process (the renderer cannot override it), monitoring-notice gate, offline queue with retry/backoff, heartbeats, honest wording whenever data leaves the PC. **137 unit tests.**
- **Real end-to-end** (real Electron + real server + real capture): **44/44**, including a server outage with automatic recovery and no lost or duplicated screenshots.

**Bugs the tests found (all fixed):**
| Bug | Found by |
|---|---|
| Audit label for rejecting time was written as `time.rejectd` | API test |
| Login lockout used the same low limit per IP as per account, so one shared office IP could lock out everyone | API test |
| **Main-process freeze:** every gallery refresh decoded up to 60 full-size screenshots (about 4 s), close enough to the app's 5 s "timing gap" safety to pause tracking silently | real end-to-end (a session ended "paused after a timing gap") plus a stall measurement; fixed with cached, capped thumbnail work (stall about 0.2 s) and a regression test |
| "N items waiting to upload" counted an already-uploaded running entry | real end-to-end |
| Dashboard overflowed sideways on a phone; missing favicon 404 | browser test |

## Stage 4: Decisions (26 Oct)

The assistant asked the five open design decisions; the owner answered: **separate service now, merge into UFS People later (sharing people data)**; **desktop login = UFS People (Supabase) account**; **S3-compatible storage, S3 default**; **employee + manager + HR, 90 days**; **internal to UFS only**; **image format admin-chosen, WebP default**. Researched storage cost: Time Doctor keeps screenshots 6 months on active servers then cold storage; Supabase free storage is 1 GB; a real 1080p PNG is about 0.5 MB. Recorded in `DECISIONS-AND-PLAN.md`.

## Stage 5: Phase 1: storage, HR role, retention, image policy (26 Oct)

- **S3-compatible storage** (AWS SDK; works with S3, R2, MinIO, Supabase via endpoint + path style) behind an async `BlobStore`; failed uploads leave nothing, failed deletes keep the record so they are retried.
- **HR role** (migration 2 rebuilds the `users` table safely): reads everyone, edits nothing; every view audited.
- **Retention default 90 days.** **Image policy** (`webp`/`png` + quality). Because Electron cannot decode WebP, the renderer encodes WebP and a JPEG thumbnail at capture time. Real measurement: **WebP about 90-104 KB vs PNG about 580-593 KB**. Blur verified by decoding the uploaded image (edge energy 0.10 vs 4.3).
- Upgraded **zod 3 to 4** to clear a high-severity advisory (`npm audit` clean).
- **Result:** server 74, dashboard 45, desktop 153, real end-to-end **54/54** (source and packaged exe). Fake-S3 tests only; real bucket untested.

## Stage 6: Reading UFS People changes the plan (26 Oct)

Read-only look at `C:\Users\venky\Desktop\ufs\UFS-People` (Next.js on Cloudflare): **all HR data is in Cloudflare D1 (SQLite) + R2; Supabase is only for sign-in** (password + TOTP; ES256 tokens with a published JWKS, which I checked with a public unauthenticated request; `employee_identities` maps Supabase user to employee with **no email auto-linking**; roles employee/manager/hr_manager/hiring_manager/admin; test data scoped `qa-bots-v1`). Consequences: **no Postgres and no direct database link** (a Cloudflare token would expose all HR data); keep SQLite so the later merge is a data copy; **pull a minimal read-only directory feed** from an endpoint UFS People will add; match logins by approved identity. Phase 2 was rewritten into 2a-2e.

## Stage 7: Phase 2a: directory sync (26 Oct)

Wrote **`server/DIRECTORY-FEED.md`** (the spec and a code sketch for the UFS People owner, who has not been asked or built anything). Built: feed contract and validation, tracker users as **projections** of directory people (locked fields, no passwords), role mapping, teams from departments, leavers/returners, manager links, identities, and **safety guards** (empty feed, >30% deactivations, stale/older feeds, duplicates, >10% invalid rows, any sensitive-looking field blocked by name; owner-only force; transactional apply with rollback; last-owner protection; token never logged). Fake directory with synthetic people for tests and demos. Dashboard directory panel. **Server 112, dashboard 57, real end-to-end 54/54 (no regression).** The tests found one gap (`personalEmail` was not recognized as sensitive); fixed.

## Stage 8: Phase 2b: Supabase sign-in (26 Oct, interrupted)

Built (against a **fake Supabase Auth** with real ES256 keys, real TOTP, session revocation and a hostile-token generator): the tracker performs the password grant, enforces the authenticator code for owner/admin/HR, **verifies the ES256 token itself** (fixed algorithm, issuer, audience, role, ids, anonymity, expiry; JWKS caching, rotation, rate-limited refetch, fail closed), does a **live session check**, binds the login by **approved identity (never email)**, issues its own tracker session and **closes the temporary Supabase session**; no Supabase token or password is ever stored. Directory identity changes (disabled/moved/removed, password-reset cutoff `notBefore`) revoke the matching tracker sessions. Dashboard login got the code step; the desktop app got the code field. **Server 138/138, dashboard 65/65, desktop 157 pass.** A new real-app test phase was written but not run (see `HANDOFF.md` section 8).

---

## Test growth

| Point in time | Server | Dashboard (browser) | Desktop unit | Real end-to-end |
|---|---|---|---|---|
| Start (zip) | none | none | 101 (95 pass, 6 skip) | none |
| After bring-up | | | | 28 + 25 |
| After backend/sync | 53 | 37 | 137 | 44 |
| After Phase 1 | 74 | 45 | 153 | 54 |
| After Phase 2a | 112 | 57 | 153 | 54 |
| After Phase 2b (now) | **138** | **65** | **163 (157 pass)** | 54 (+11 new checks not yet run) |

## Lessons worth keeping

- **Mocked tests can encode a wrong assumption** (the permission bug). Always run the real thing; most real bugs this session came from the real end-to-end tests.
- **Prove behavior by measuring** (blur by decoding pixels, WebP size on a real screen, main-loop stalls with a lag monitor) rather than inferring it.
- **Safety guards need tests in both directions**: that bad input is blocked *and* that nothing changed afterwards.
- **Read the neighbouring system before designing the integration.** Reading UFS People changed Phase 2 completely and avoided a wrong database migration.
- Process rule the user set: keep `PROGRESS.md` current, ask before assuming language/framework, minimal changes, verify before claiming done.
