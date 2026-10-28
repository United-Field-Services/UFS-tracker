# Prompt for the next Claude session (copy everything inside the box)

Open Claude Code **in this folder** (`C:\Users\venky\Desktop\ufs\UFS-Desktop-Tracker\UFS-Desktop-Tracker-0.2.0-Windows-Developer-Package`) with the new account, then paste:

```
You are continuing a project that another Claude session built over several days. You have no memory of it, so everything is in the documents in this folder.

Before doing anything:
1. Read, in order: CLAUDE.md, HANDOFF.md, REMAINING-WORK.md, DECISIONS-AND-PLAN.md, WHAT-TO-BUILD.md, and the top of PROGRESS.md. Skim SESSION-LOG.md for the history. Then verify key claims against the source and tests; these docs point to the sources of truth, and older counts are historical.
2. Tell me in a few lines what the project is, where it stands, and what you think the first steps are. Then wait for my go-ahead unless I already told you to proceed.

Project in one paragraph: an internal UFS time and screenshot tracker aiming for broad Time Doctor feature parity, built as a visible, consent-based product and integrated with UFS People. It has a Windows Electron desktop app (`source/`) and a Node/TypeScript server with a web dashboard (`server/`), a read-only directory pull, and sign-in through UFS People's Supabase accounts. Preserve the privacy rules in `CLAUDE.md`: never add covert tracking or use real employee data for tests, and do not modify the UFS People repository.

Hard rules: never add covert tracking; never use real employee data or real logins; never modify the UFS-People project (C:\Users\venky\Desktop\ufs\UFS-People) - read only; no secrets in chat, code or docs; do not claim anything works until you ran it; keep PROGRESS.md updated; ask before big decisions; report failures and unverified items honestly.

Current checkpoint (2026-10-27): A8 idle review, A9 count-only activity, A10 desktop manual-time submissions for approval, A11 in-app reminders, grouped C6 activity estimates with B11 daily UTC rollups, partial C5 schedule/timezone tracker-evidence reporting, org-only all-screens capture, visible expired-session queue recovery, and the optional Windows uninstall data-deletion prompt are implemented against fakes/synthetic state. Desktop 182 pass / 0 fail / 6 platform skips; server 145/145; latest isolated dashboard 72/72. The Windows x64 installer was rebuilt with all-screens, expired-session recovery and the uninstall choice, inspected, unsigned and not installed. Verify both uninstall choices only with disposable synthetic app data. A11 still lacks app-closed reminders and dedicated break records. C5 cannot establish absence or payroll hours; configure UFS's schedule timezones before use. The latest real-Electron test remains unverified because it captures the selected physical display and can wipe its configured app-data folder.

Next tasks, in order:
 a) Version control is set up (2026-10-28): this folder is the Git repo for `https://github.com/United-Field-Services/UFS-tracker` (branch `main`). Commit/push only when asked; never commit `server/.staging-local/`. Read `REMAINING-WORK.md` section 10b (in-place updates, CI/CD) and `HOSTING-CLOUDFLARE.md`.
 b) Continue the Time Doctor parity backlog from `REMAINING-WORK.md`. C5 currently returns tracker-evidence statuses and prorated schedule estimates, not authoritative attendance or payroll overtime. Configure correct org/team/person IANA zones before relying on it. Packaged UI/Electron testing still needs a disposable synthetic display. The isolated dashboard test supports endpoint overrides for fresh synthetic services; use a fresh DB and fake services.
 c) Do not run the Electron end-to-end test on a normal desktop: it captures the selected physical display and deletes `%APPDATA%\UFS Desktop Tracker\Local Tracker Data`. Run only with a synthetic display and disposable app-data path; otherwise document the unverified boundary.
 d) Continue B11 daily rollups and the remaining reports/exports/integrations after C5 verification. A9 must remain count-only, off by default, notice-gated, and free of event content.
 e) List and track external blockers (real UFS People endpoint, synthetic staging Supabase, storage bucket, hosting, legal/security review) in `REMAINING-WORK.md` without accessing real employee data or modifying the UFS People project.

My environment: Windows 11, Node 24, Microsoft Edge installed. Playwright is not installed in the project; install playwright-core in a short path such as C:\pw.
```

## Notes for you (the human)

- A new Claude account does **not** inherit the old session's memory. These documents are the memory. Keep them updated.
- If the new session cannot find a tool or path mentioned here, tell it; do not let it guess.
- The UFS People folder is the boss's work in progress. Nothing here has changed it, and nothing should.
- Secrets (Supabase keys, directory token, S3 keys) are never stored in these files; they go in environment variables on the machine that runs the server.
