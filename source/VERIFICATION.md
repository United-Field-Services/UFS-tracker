# Verification record — 18 October 2026

## Delivery status

Built a runnable Linux x64/X11 AppImage with the Electron runtime included. **Native graphical launch, actual OS screen capture, and a real one-hour run remain unverified. No installable Mac or Windows app has been delivered.**

## Checks performed in Linux cloud workspace

- JavaScript syntax checks pass for application and packaging scripts.
- Automated state/storage/security/renderer race tests pass. See `outputs/checks.log` for the current exact count.
- Electron 44.9.0 downloads and its native executable reports the expected version.
- The electron-builder 26.15.3 release configuration passes its installed JSON schema.
- `npm run build:mac` correctly refuses a Linux build before any signing/distribution claim.
- Production npm audit: zero reported vulnerabilities.
- Full development-tool audit: eight moderate dependency-path findings, all rooted in the current sprintf-js 1.1.3 denial-of-service advisory GHSA-hp3w-g68c-fv3c used by build tooling. No high/critical findings. Latest published sprintf-js remains 1.1.3; no unreviewed major/downgrade audit fix was applied. Build dependencies are not bundled as runtime dependencies. Full JSON: `outputs/dependency-audit.json`.

## One-hour test addition

Implemented the explicitly requested one-hour test preset. It shows a remaining-time countdown and fixes the capture cadence at five minutes, with an initial image and at most 12 scheduled slots. The immutable main-process monotonic deadline includes pauses and is never reset by Resume. The pinned Mac runtime uses libuv's sleep-inclusive monotonic clock. A separate wall-clock check can only end early, never extend the test.

Automated coverage includes the exact cutoff, delayed permission completion, paused expiry, backward/forward wall-clock changes, sleep/restart boundaries, fixed-slot scheduling, stale tokens, late queued capture authorization, and storage rollback when writes cross the deadline. All timing tests are simulated; no screenshot run was started.

Main refuses expired save requests. Renderer reauthorizes each frame before reading pixels and rejects an authorization reply whose remaining duration elapsed during its round trip. A final narrow synchronous main-process authorization immediately before drawing closes the queued-response race across Linux suspend and backward wall-clock changes. The storage transaction gates before and after staging, publication, and index persistence, removing any late PNG. Final closing metadata or cleanup may still be written afterward.

## Independent review fixes

- A cancelled start's delayed permission rejection can no longer stop a newer capture stream.
- A cancelled start's delayed playback completion can no longer stop a newer stream.
- A stream ending during startup is not confirmed as tracking.
- Each start attempt owns its stream and stale callbacks cannot overwrite a later session UI.
- Interrupted-session recovery uses the latest durable checkpoint and reconciles screenshot counts.
- Screenshot metadata and session screenshot count are committed in the same atomic index update.
- Downloadable Mac releases require code signing and post-build signature, Gatekeeper, and notarization-ticket checks.

## What could not be run here

The cloud execution sandbox disallows the local sockets required for an X server and Chromium/Electron's application singleton. A dummy virtual display could not start. The approved escalation route failed during environment setup. Headless Electron likewise exited with `socket() failed: Operation not permitted`. These failures are environment-level and do not verify or disprove actual OS capture.

Mac packaging, native window launch, Screen Recording permission, selected-display content, periodic screenshot persistence, visible gallery layout, lock/sleep behavior, and downloadable-app signing/notarization remain unverified on macOS. Windows packaging and capture remain unverified too.

## Linux package verification

The custom executable AppRun replaces electron-builder's launcher, rejects root, command-line flags, Electron sandbox/Node environment overrides, missing DISPLAY and Wayland, and never inserts sandbox-disable flags. The final desktop entry invokes AppRun without injected flags. Extracted runtime source is checked against the build input. Linux uses /proc/uptime for sleep-inclusive monotonic timing, with sticky fail-closed handling on read, parse or monotonicity failure; no wall-clock or performance.now fallback follows a clock failure. Linux timing reference: https://man7.org/linux/man-pages/man5/proc_uptime.5.html .

Give the AppImage and Linux Start Here guide to an authorized Linux x64/X11 test desktop with normal sandbox and FUSE support. First use only synthetic display content. A real launch and full-hour run are still required to verify native capture.

## Mac next exact step

Use an authorized Mac running macOS 13 or newer to build and test `package:mac:local`. This local developer-test route does not need Apple Developer enrollment and does not change Gatekeeper settings. The user must personally choose the screen and grant the requested OS Screen Recording permission. Complete `QA-CHECKLIST.md` with harmless test content before claiming screenshots work.

For a friction-free downloadable release, configure Developer ID signing and Apple notarization securely on an authorized Mac, run `build:mac`, inspect `MAC-RELEASE-VERIFIED.json`, and test the actual delivered DMG. No passwords or signing keys should be sent through chat.
