# UFS Time Tracker: project rules for Claude

**Sources of truth:** current behavior is in `source/` and `server/` and their tests; `PROGRESS.md` is the dated evidence log with newest checkpoint first; `HANDOFF.md` is the architecture/current-state map; `REMAINING-WORK.md` is the open-work/blocker list; `WHAT-TO-BUILD.md` is the parity inventory; `DECISIONS-AND-PLAN.md` records locked design choices. Read those before trusting older notes. `SESSION-LOG.md` is historical context.

## What this is
A visible, consent-based, Time Doctor-style tracker for UFS staff: Windows Electron app (`source/`) + Node/TypeScript server and web dashboard (`server/`), being integrated with UFS People (read-only directory feed + Supabase sign-in). Currently built and tested against **fakes** (fake S3, fake UFS People directory, fake Supabase). Nothing real is connected.

## Non-negotiable rules
- Tracking stays **visible and consent-based**. Never add a covert/silent mode, audio, camera, keystroke content logging, or app/website tracking without visible consented disclosure. Screenshots use the selected screen by default; an organization-only, default-off, notice-gated policy may capture all connected screens. The A9 exception is limited to org-enabled key-down/mouse-click counts and active seconds per minute; it must never read or retain event payloads.
- Never use real employee data or log in as a real person. Synthetic people and staging only. Never put keys/passwords in chat, code, logs or docs; use environment variables.
- **Do not modify `C:\Users\venky\Desktop\ufs\UFS-People`** (the boss's project). Read-only. The tracker only ever receives the allow-listed directory feed, never UFS People's database or HR data.
- The renderer has **no network**; all network runs in the desktop main process, only after explicit sign-in. Keep the main process free of heavy synchronous work (a 5 s stall pauses tracking).
- Safety guards (blocked syncs, owner-only force, audit trail, last-owner protection) must stay and stay tested.
- Do not mark anything done without running it. Real behavior beats mocks: most real bugs here were found by the real end-to-end test.

## Working agreements (from the user)
- Keep `PROGRESS.md` updated at every checkpoint (date, what was done, files changed, next steps).
- Minimal diffs; no scope creep; ask when requirements are ambiguous; present options with trade-offs when several approaches exist.
- Report outcomes faithfully: say what failed, what was skipped, what was not verified.

## Commands
- Server: `cd server && npm run check` (type-check + 145 API tests). Demo stack: `powershell -File server\reset-demo.ps1`. Dashboard browser test: `server\tests-ui\dashboard.ui.cjs` (72 checks; use a temporary synthetic database and endpoint overrides when isolating it).
- Desktop: `cd source && npm run check` (188 tests, 182 pass and 6 Linux-only skipped); `npm start`; `npm run build:win`.
- Real end to end (real screenshots, wipes `%APPDATA%\UFS Desktop Tracker\Local Tracker Data`): `E2E_WIPE_DATA=1 PW_PATH=<playwright-core> node source\e2e\company.e2e.cjs`.
- Node 24 required. Playwright is not a project dependency; install `playwright-core` in a **short path** (Windows 260-character limit).

## Gotchas
- Server TypeScript runs directly (Node type stripping): explicit `.ts` import extensions, no enums or constructor parameter properties. Zod is v4.
- `source/tests/main.test.cjs` runs `main.cjs` in a VM realm: compare returned objects as JSON.
- Tests that move the fake clock past 12 h must log in again.
- Git: the owner (2026-10-28) chose `https://github.com/United-Field-Services/UFS-tracker` (branch `main`) for version control; this folder is the repo. Commit/push only when asked. `.gitignore` keeps `server/.staging-local/` (synthetic staging credentials), data folders, `node_modules/` and `source/release/` out; never commit secrets. CI is `.github/workflows/ci.yml`.
- Shell heredocs with backslashes/apostrophes get mangled: write patch scripts to a file or use the editor tool.

## Current state (2026-10-27)
Phase 2b (Supabase sign-in through the tracker), A8 idle review, A9 count-only activity estimates, A10 desktop manual time submission, the in-app portion of A11 reminders, grouped C6 estimates with B11 daily UTC rollups, partial C5 timezone-aware tracker evidence, org-only all-screens capture, visible expired-session queue recovery, and the optional Windows uninstall data-deletion prompt are implemented against fakes/synthetic tests. A9 and all-screens remain off by default and require notice versions. Latest checks: desktop 182 passed/6 platform skips; server 145/145; latest isolated dashboard 72/72. The unsigned Windows installer includes all-screens, expired-session recovery and the uninstall choice but remains uninstalled. Verify both uninstall choices only with disposable data. A11 still has no app-closed reminders or dedicated break record. C5 cannot prove absence/payroll hours and needs schedule zones configured. Real UFS People, Supabase, object storage, hosting, legal review, and physical-device acceptance remain open. `PROGRESS.md` is the latest evidence; see `REMAINING-WORK.md` for the next parity work.
