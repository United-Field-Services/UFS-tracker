# UFS Desktop Tracker 0.2.0: Windows developer handoff

Prepared: 22 October 2026 (UTC). **Historical record for the original local-only source package.** Current product scope and verification are in `HANDOFF.md`, `PROGRESS.md`, and `REMAINING-WORK.md`; this document and the files under `verification/` do not describe later features.

## Status and scope

At preparation time, this ZIP contained the complete available standalone tracker source, not a ready-to-install Windows application. The original files were preserved under `source/`; handoff documentation and verification records sat alongside them. No source behavior was changed for that original handoff. The repository has since grown into a company-mode desktop client, tracker server, and dashboard; the historical statements below describe only the 2026-10-22 package.

The app is a visible, local-only Electron screenshot and time-tracking prototype. It is separate from the UFS People website and has no employee account login, server synchronization, dashboard upload, payroll connection, automatic startup or updater. This ZIP is not a full UFS People export and is not the commercial Time Doctor software.

The source implements display selection, explicit consent, Start/Pause/Resume/Stop, PNG screenshots, a local gallery and session history. Its default one-hour test takes an initial screenshot and then uses five-minute slots through minute 55, with no capture scheduled at minute 60. There is also manual session mode. Input idle is an estimate, not a wage or productivity determination. No audio, keystroke logging or application/window-title monitoring is implemented.

## Contents

- `source/src/`: Electron main process, capture authorization, timing, local storage and preload API.
- `source/renderer/`: UI, controls, capture stream and screenshot gallery.
- `source/tests/`: complete existing automated test suite.
- `source/scripts/`: syntax checks and existing platform packaging helpers.
- `source/build/`: Linux launcher and macOS entitlements retained so the full existing source tree is intact.
- `source/package.json` and `source/package-lock.json`: exact dependency and installer configuration.
- `source/README.md`, `QA-CHECKLIST.md`, `VERIFICATION.md`: original development documentation and historical verification record. The original README is Mac-focused; use this document for the Windows handoff.
- `verification/automated-checks-2026-10-22.log`: fresh Linux automated check results.
- `verification/PROVENANCE.json`: source/binary identity checks and platform limits.
- `verification/dependency-audit-2026-10-18.json`: historical dependency audit only, not a current audit result.
- `FILE-SHA256SUMS.txt`: current SHA-256 inventory of source and documentation files, excluding the manifest itself and generated dependency/runtime/build data. The original verification records listed here remain historical.

Dependencies are NOT vendored. The lockfile specifies the complete dependency graph, but `npm ci` needs network access to the package registry and Electron/build-tool downloads. A prebuilt Electron runtime and an offline installer are not included.

## Windows build procedure

Use a Windows x64 development/test machine authorized for this work. Keep the current user's normal protections enabled and review the source before running it.

1. Install an approved Node.js/npm toolchain from the official Node.js distribution. The pinned Electron package declares Node.js >=22.12.0 for its install tooling. The handoff's automated tests ran with Node.js 24.19.0 and npm 11.9.0 on Linux, not Windows. Use a supported version and record the exact Windows toolchain.
2. Extract the ZIP to a normal writable development folder. Open a terminal in `source/`.
3. Run `npm ci`. This installs the exact lockfile versions. Do not silently replace the lockfile or apply an unreviewed dependency upgrade. Install scripts may download the Electron runtime. If your organization's security policy blocks a required download or script, have the developer resolve it through the approved process rather than weakening policy.
4. Run `npm run check`. This performs JavaScript syntax checks and the full Node test suite. Some Unix launcher checks intentionally skip on Windows; save the exact pass/fail/skip counts. If the command fails, resolve and record the failure before proceeding.
5. Build using `npm run build:win`. This invokes `electron-builder --win nsis --x64 --publish never`. The installer output directory is `source/release/`. Use the actual returned filename rather than assuming a specific name.
6. Inspect and record the resulting installer's architecture, version, SHA-256, signing status and build logs. Run the acceptance checklist below on the actual installer in an isolated Windows test environment.

For source-only developer launch, `npm start` opens Electron. Do not use a source launch as evidence that the built installer works. Do not run a capture session on a desktop containing private material.

### Existing Windows packaging configuration

- Application: `ufs-desktop-tracker`, version `0.2.0`.
- Product: `UFS Desktop Tracker`.
- App ID: `com.ufs.desktoptracker.local`.
- Electron: `44.9.0`; electron-builder: `26.15.3`.
- Target: Windows x64, NSIS installer, ASAR archive enabled.
- Installer: assisted rather than one-click, per-user, installation-directory choice enabled.
- Publishing: disabled by the build command (`--publish never`).

No Windows certificate, signing identity or credentials are included, and Windows signing/trust has not been verified. The existing configuration does not require a successful Windows signature. A successful build alone must not be represented as a signed/trusted production release. Developers must use their organization's approved signing/release process for distribution. Do not disable SmartScreen, Defender, the Chromium sandbox or other security protections to force a launch.

## Windows acceptance checklist: all pending

Record Windows edition/build, x64 hardware, Node/npm versions, Electron version, package checksum, tester, date and the exact results. Use only synthetic text/images on the selected test display.

### Installation and lifecycle

- [ ] The actual x64 NSIS installer builds successfully and its signature/trust status is recorded.
- [ ] Per-user installation and chosen install location work without weakening security controls.
- [ ] The installed application opens normally; launching a second instance focuses the first.
- [ ] No screenshot or tracking starts on launch, relaunch or after restarting Windows.
- [ ] Quit stops capture; reopening remains stopped.
- [ ] Uninstall and reinstall behavior is tested. Record whether local screenshots/session data remain; do not assume automatic deletion.

### Capture and controls

- [ ] Starting without display selection or explicit consent is blocked.
- [ ] Any supported system permission denial/cancellation is handled without saving a PNG. Windows may not show a separate system prompt; the app still requires its own display selection and consent.
- [ ] A unique synthetic phrase on the chosen screen appears in a real saved PNG.
- [ ] A second phrase appears in the next scheduled PNG, with the expected timestamp/dimensions.
- [ ] With multiple displays and mixed scaling, only the chosen display is captured correctly.
- [ ] Gallery, full-image view, Show original file and Open local data folder work in Windows Explorer.
- [ ] Pause/Stop prevent new saved screenshots, including callbacks already in flight.
- [ ] Cancel/restart during screen initialization does not affect a later session.
- [ ] Minimize, lock, sleep, display removal and capture failure stop/pause capture and never silently resume it.
- [ ] Disk-full or denied-write errors are visible and do not pretend screenshots are saving.

### One-hour deadline

- [ ] The timer begins only after the selected screen is ready.
- [ ] Initial capture plus five-minute slots produces at most 12 images, with no catch-up frames for missed slots.
- [ ] Pause/Resume does not extend the original deadline.
- [ ] At one hour the app stops and no further PNG is retained. Observe beyond the next five-minute slot.
- [ ] Sleep/wake and Windows clock changes cannot extend the test. Test Windows' real monotonic-clock behavior, not only mocked clocks.
- [ ] A slow or late capture/storage operation crossing the cutoff does not leave a saved image.
- [ ] Reopening after expiry stays stopped until a fresh user action.

### Privacy and local data

- [ ] No microphone, camera, keylogging, automatic startup or unrequested background capture occurs.
- [ ] No screenshot/session uploads or external content requests occur during normal use.
- [ ] Confirm the actual data directory shown by the app; it uses Electron's current-user data path plus `Local Tracker Data`.
- [ ] Verify Windows filesystem ACLs on PNGs and `sessions.json`; Unix `0600`/`0700` tests do not establish Windows access controls.
- [ ] Confirm the data is not encrypted by this application, review retention/manual deletion procedures and test with synthetic data only.

## Verification performed for this package

On 22 October 2026 in Linux: `npm run check` exited 0; 101 tests passed, 0 failed, 0 skipped. Tests use simulated clocks, mock OS interfaces and synthetic PNG fixtures. No GUI, installer or real capture run was performed.

All 8 files in `src/` and `renderer/` match the runtime/UI files in the inspected existing Linux 0.2.0 packaged archive. The local Linux AppImage hash matches the previously delivered Library checksum. This establishes continuity with that standalone tracker source; it is not a Windows certification and not evidence of the latest UFS People website source.

The preserved 18 October dependency-audit snapshot reports 8 moderate findings in development tooling. It is historical. Developers should rerun dependency/security review in their approved environment before release; no current audit or vulnerability remediation was performed for this handoff.

## Known gaps before employee or production rollout

- No Windows installer has been built, installed, launched, signed or runtime-tested for this handoff.
- No actual Windows screenshot or full one-hour run has been verified.
- No UFS People authentication, employee identity, API connection, server uploads, centralized retention, access-controlled review or payroll behavior exists in this standalone app.
- No Windows automatic updates, managed deployment, release-signing verification or production operational monitoring is implemented.
- Windows data protection, permissions, sleep/clock behavior and uninstall retention need explicit validation.

If server synchronization or a complete production Time Doctor replacement is required, treat that as separate implementation and acceptance work. Do not connect this prototype to employee or production data as part of merely reviewing this package.
