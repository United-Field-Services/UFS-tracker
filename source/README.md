# UFS Desktop Tracker

The Electron desktop client for UFS's visible, consent-based time and screenshot tracker. It supports local-only sessions and an optional company mode that syncs policy-approved time and screenshots through the configured tracker server. It does not connect directly to the UFS People database.

## Current delivery status

The current implementation is Windows-first. Windows capture, company sync and installer behavior have been exercised on Windows. Organization policy can require all connected screens, joined left to right into one image; that path has synthetic renderer/main coverage but still needs a real two-monitor check. Expired company sessions are called out in the account panel; time/screenshots remain queued for the same cached account and resume after reauthentication. The latest x64 installer includes these paths, is unsigned, and has not been installed or launched. The native input hook has not been exercised against OS events. Mac release verification still requires an authorized Mac running macOS 13 or newer.

The ordinary user should receive a built app and simple instructions, not this source folder.

## What the app implements

- An explicit screen selector and unchecked consent box before capture
- Visible Start, Pause, Resume, and Stop buttons
- Default one-hour test: an immediate screenshot, then fixed five-minute slots, and an automatic stop at one hour
- Visible remaining-time countdown; pauses and sleep do not extend the deadline
- Optional manual mode with 10/30/60/300-second screenshot intervals
- Real PNG frames of the selected screen (or joined connected screens when organization policy requires it), sized to a maximum 4096-pixel edge and 16-megapixel area
- A local screenshot gallery, full-image inspection, and Show original file
- Local session history and an always-visible capture status
- Tracked time, observed idle time after 60 seconds of no system input, and unknown activity accounting
- Optional company sign-in through the tracker server, including the UFS People password and TOTP step when required
- Company policy enforcement, project/task selection, monitoring-notice acceptance, and an encrypted device token where OS secure storage is available
- Offline upload queue for company time and screenshots, with retry and recovery after restart or same-account reauthentication after session expiry; quit stops and saves the active session, then attempts a bounded 10-second sync, keeping unsent items for next launch
- Company manual-time form for missed work, project/task and reviewer note; submissions require sign-in, current-notice acceptance and stopped tracking, then queue offline and sync idempotently for approval
- Company break reminder after a configurable number of tracked minutes, plus optional local weekday/time reminders when tracking is stopped or paused; prompts appear only while the app is open and never change time automatically
- Manual submission history with pending/approved/rejected states; the API enforces overlap, date, project-access and approval rules
- WebP/PNG capture policy, JPEG thumbnails, screenshot blur and server-controlled retention
- Pause on screen disconnect, screen-share end, lock, sleep, hide, minimize, capture failure, or timing gap
- Quit when the last window closes; no background capture after quit

Idle is estimated from the operating system's inactivity timer; no keystroke content or typed text is collected. In company mode, the app asks the employee to keep or discard time classified as idle after the organization's threshold. Discard removes only idle-classified time; time after activity resumes remains tracked. Screenshot saving pauses while the choice is pending. Local test sessions show the estimate without this review prompt.

Count-only activity is an optional company policy, off by default. When enabled and the employee has accepted the current notice, a native system input hook counts key-downs and mouse clicks and marks seconds with keyboard or mouse input in UTC-minute slices. The app never reads key identities, typed text, mouse coordinates, modifiers, app names or window titles. Only aggregate counts and seconds are queued and sent to the tracker server. The hook starts only during a visible, actively tracking company session and stops on pause, idle review, stop, lock, sleep, minimize, hide or quit. Enabling the policy requires a higher monitoring-notice version. Activity percentages are estimates, not productivity or payroll measures.

No audio, camera, keystroke content, application/window-title monitoring, automatic startup, analytics, or background updating is implemented. In local-only mode, screenshots and sessions stay on this computer. In company mode, the app sends time and policy-enabled screenshots and, only when explicitly enabled, activity aggregates to the server the user configured, after sign-in and acceptance of the current monitoring notice. The tracker server proxies UFS People authentication; this app does not connect to UFS People directly. Screen-share frames exist in memory while tracking; only scheduled interval screenshots are persisted. Local files are not encrypted by this app, though the device token uses Electron safeStorage when available.

## Requested one-hour test

The default session mode is **One-hour screenshot test · automatic stop**. It requires choosing a display, checking the consent box, pressing Start one-hour test, and personally granting any macOS screen permission. The one-hour clock begins only after the selected screen is ready.

The normal schedule is at start and then minutes 5, 10, …, 55: at most 12 scheduled screenshots, with none at minute 60. Pause/Resume does not move the deadline or create catch-up screenshots. Sleep/lock/hide/minimize still pauses capture, and it never restarts itself. A relaunch always opens stopped; it does not restore the old test.

The main process uses an immutable monotonic deadline and an independent stop timer, plus synchronous checks before capture authorization and storage. A wall-clock jump may stop early but cannot extend the monotonic hour. Expired or delayed screenshot saves are rejected; a write crossing the cutoff is rolled back rather than retained in the gallery. Final session metadata and cleanup can still be written after cutoff. No JavaScript/OS application can promise hard real-time execution during arbitrary system stalls, so the real-device checklist must verify the actual app behavior.

The one-hour deadline and lifecycle rules have automated timing coverage. A full 60-minute real-clock run remains a separate hardware acceptance check.

## Develop and check

Use an authorized development environment with Node.js and npm:

```
npm ci
npm run check
npm start
```

Synthetic renderer-only checks can run without Electron screen capture:

```
$env:PW_PATH = 'C:\pw\node_modules\playwright-core'
node e2e\idle-review.ui.cjs
node e2e\manual-time.ui.cjs
```

They open the renderer in headless Edge with synthetic company state. Idle review exercises both choices; manual time exercises the form, project/task selection, offline acknowledgement, consent/tracking gates, and safe history rendering. Neither accesses the display or application data. Company time-accounting and screenshot-cancellation cases are in the normal `npm run check` suite.

If dependency install scripts are deliberately disabled in the environment, run Electron's official install script after dependencies are installed:

```
node node_modules/electron/install.js
```

Dependencies are pinned in package-lock.json. The app itself needs no network after installation.

## Build an actual local Mac test app

On the **authorized Mac where the app will be tested**:

```
npm ci
npm run check
npm run package:mac:local
```

The resulting `.app` is under `local-mac-build/`. This is a locally built development bundle, with ad-hoc signing, for testing on that Mac. It is not a notarized public download release. No Gatekeeper settings or quarantine attributes are changed by this workflow. If macOS blocks it, stop and diagnose the signing/build rather than disabling platform protection.

After the app opens, the user selects their screen and explicitly grants macOS Screen Recording permission if requested. Permission may require quitting and reopening the app. Run the full `QA-CHECKLIST.md` on that Mac before calling actual capture verified.

## Build a downloadable Mac release

This release path requires macOS, an Apple Developer ID Application identity, and securely configured Apple notarization authentication. Do not paste private keys, certificates, passwords, or authentication tokens into chat or commit them to source control.

```
npm ci
npm run check
npm run build:mac
```

This builds a universal Intel + Apple Silicon DMG, with hardened runtime, mandatory code signing, and notarization enabled. The preflight fails on Linux or missing signing/notarization setup. Verify the finished app with `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate` before delivery. Then test opening the actual distributed artifact on a supported Mac.

## Windows

The app uses Electron's cross-platform capture, display, idle, and filesystem APIs. `npm run build:win` creates an x64 NSIS installer. Windows source and packaged-app capture have been verified. The current installer includes all-screens policy, expired-session recovery, and an optional prompt to remove local tracker data during uninstall; it has not yet been run through the packaged-build end-to-end suite. Code signing, SmartScreen, interactive verification of both uninstall choices, and several sleep/lock/clock-change hardware checks remain open.

## Data and deletion

The app shows its exact local data folder in the footer. It is typically inside:

- macOS: `~/Library/Application Support/UFS Desktop Tracker/Local Tracker Data`
- Windows: the current user's application data directory

Screenshots live in the `Screenshots` subfolder; session metadata is `sessions.json`; company sync state and its upload queue are stored separately in the same app data directory. Local-only sessions remain on the computer. Company screenshots are uploaded to the configured tracker server and follow its visibility and retention policy; the employee can review the current notice and policy in the app before tracking. During interactive Windows uninstall, the user can choose to delete `%APPDATA%\UFS Desktop Tracker\Local Tracker Data`; No is the default and keeps the folder. Screenshots may contain sensitive screen content, so review before sharing.

## Architecture

- `src/main.cjs`: isolated Electron window, permission/capture gating, IPC, OS events, local persistence
- `src/preload.cjs`: narrow trusted API exposed to the sandboxed renderer
- `src/tracker.cjs`: deterministic session/capture authorization state machine
- `src/storage.cjs`: bounded PNG validation, private local files, atomic JSON-index replacement
- `renderer/`: local UI, screen stream, interval frame capture, local gallery
- `tests/`: state, race, storage, and security checks

Technical references: [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer), [permission handling](https://www.electronjs.org/docs/latest/api/session), [Electron 44 platform requirements](https://www.electronjs.org/blog/electron-44-0), [Mac build/signing requirements](https://www.electron.build/docs/features/multi-platform-build/).
