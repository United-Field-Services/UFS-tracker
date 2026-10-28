# Testing heads-up (read before you start testing)

Written 2026-10-28. **Everything here is for synthetic test people only.** Do not sign in with a real employee account, do not point this at UFS People's real Supabase, and do not test on a PC whose local tracker data matters (see "Things that can bite").

## What you can download and run
| Item | Where | Notes |
|---|---|---|
| Windows installer (per-user, unsigned) | `source/release/UFS Desktop Tracker Setup 0.2.0.exe` (built 2026-10-28 10:31 PM) | 111,881,414 bytes, SHA-256 `B2578F29DB0196D6DB1F28EBA1FAEDEDE647943F4D8E6D37A0CDC7169B4B1B1E`, **NotSigned**: Windows SmartScreen will warn ("More info", "Run anyway"). Not installed or launched by Claude. The file is git-ignored; share it by file transfer, not through git. |
| Run from source instead | `cd source; npm start` | needs `npm ci` and `node node_modules/electron/install.js` once |
| Test server + dashboard | `powershell -File server\start-staging.ps1` (stop: `server\stop-staging.ps1`) | Dashboard and API on `http://127.0.0.1:4301`; fake UFS People feed on 4311; uses the **real staging Supabase project** `ufs-tracker-staging`. Add `-Fresh` to wipe `server\data-staging`. |

There is **no hosted server yet**, so the desktop app can only sign in to the server running on the same PC (`http://127.0.0.1:4301`). Hosting on Cloudflare is planned: `HOSTING-CLOUDFLARE.md`.

## Test accounts
24 synthetic people: emails and the shared test password are in `server/.staging-local/accounts.json` (local file, not in git, never paste it in chat). Roles to try: `emp-001` admin (becomes the tracker **owner**), `emp-002`/`emp-003` HR, `emp-004`/`emp-005`... managers, the rest employees. Owner, admin and HR need an **authenticator code**; their secrets are in the same file (use any TOTP generator that takes a base32 secret). Supabase limits sign-ins to about 30 per 5 minutes per IP: if you see "sign-in service unavailable", wait a few minutes.

## Suggested first test pass
1. Start the staging stack, open `http://127.0.0.1:4301`, sign in as the employee, then as a manager, HR and the owner (with code). Check each role sees only what it should (screenshots, reports, policy, directory).
2. In Policy (owner), try: screenshot interval 10 s, blur, WebP/PNG, **capture all connected screens** (needs a higher notice version; verify with two monitors), idle prompt, break reminders, keyboard/mouse counts (off by default, needs a notice version).
3. Install the desktop app, sign in as an employee (server `http://127.0.0.1:4301`), accept the notice, pick a project, Start, watch screenshots reach the dashboard. Pause, Stop, close and reopen; try offline (stop the server, keep tracking, restart the server, watch the queue drain).
4. Manual time from the desktop, idle keep/discard, session-expiry message (revoke the device in the dashboard while tracking).
5. Uninstall and choose No and then Yes at the "delete local data?" prompt (use a PC or VM you can afford to wipe).

## Known limits right now
Not tested on real hardware: two physical monitors, 60-minute run, sleep/lock/unplug, Windows file permissions. Not available yet: hosting, real UFS People feed, real UFS People login, **in-place app updates** (a new build today means reinstalling; see `REMAINING-WORK.md` 10b, including a data-deletion prompt that must be fixed first), signed installer, app icon, emails, payroll exports.

## Things that can bite
- The real-Electron end-to-end test (`source/e2e/company.e2e.cjs`) **captures the real screen and deletes `%APPDATA%\UFS Desktop Tracker\Local Tracker Data`**. Do not run it on a normal desktop.
- Installing the app on this PC and then testing will keep screenshots under `%APPDATA%\UFS Desktop Tracker\Local Tracker Data` until you delete them.
- Everything in the staging Supabase project and the fake feed is fake; never add real staff to it.
