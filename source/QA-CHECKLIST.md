# Real-device acceptance checklist

Do not mark a step passed from unit tests, screenshots of the HTML, simulated PNGs, or a different operating system.

## Mac build and launch

- [ ] Record macOS version and CPU; confirm macOS 13+.
- [ ] Build the app in an authorized Mac environment.
- [ ] Open the actual `.app` successfully, with no Gatekeeper/security bypass.
- [ ] For a downloadable release: verify Developer ID signing, notarization/stapling, and the downloaded DMG on a supported Mac.

## Capture and controls

- [ ] Opening the app produces no screenshot before Start.
- [ ] Start without choosing a display is blocked.
- [ ] Start without the consent checkbox is blocked.
- [ ] Deny screen permission. App reports a stopped/paused state and no PNG is saved.
- [ ] Grant OS screen permission personally, reopen if required, choose a display, and start.
- [ ] Display a harmless, unique text phrase on that display. Confirm it appears in a newly saved PNG with the correct timestamp and dimensions.
- [ ] With two displays and the default policy, confirm only the selected screen's contents appear.
- [ ] With the organization all-screens policy enabled and its higher notice accepted, confirm both displays appear left to right in one image; add/remove a display and end one screen share to confirm tracking pauses.
- [ ] Change the phrase and confirm the next screenshot changes.
- [ ] Inspect the full saved image and reveal the file through Finder.
- [ ] Pause for at least two capture intervals. Verify file count and tracked time stay unchanged.
- [ ] Resume. Confirm a new screenshot and continuing session totals.
- [ ] Stop while screen sharing is starting; reject/close the old permission prompt later. Verify a later session is unaffected.
- [ ] End system screen sharing during start and while running. Confirm the app does not keep claiming capture is on.
- [ ] Minimize/hide/lock/sleep. Verify capture pauses and does not restart automatically.
- [ ] Unplug the selected monitor. Confirm it pauses without switching to another screen.
- [ ] Quit with tracking on; wait two capture intervals. No additional files should appear.
- [ ] Reopen. The previous gallery remains, and no capture starts automatically.
- [ ] With only disposable synthetic app data present, uninstall and choose No; verify local tracker data remains. Reinstall, uninstall, choose Yes, and verify only `Local Tracker Data` is removed. Never use a real employee's data for this check.

## Metrics and privacy

- [ ] Leave input untouched for at least 60 seconds, then return. Observed idle appears separately and remains included in tracked time.
- [ ] Verify no wage/productivity judgment or deductions are shown.
- [ ] Confirm microphone/camera permissions are never requested.
- [ ] Verify no outgoing app-content requests or uploads in an authorized network inspection.
- [ ] Verify storage-write failure pauses with a visible error instead of pretending screenshots are saving.
- [ ] Repeat this checklist on Windows before claiming Windows capture support is verified.

## One-hour test acceptance

- [ ] Confirm One-hour screenshot test is selected, with fixed five-minute cadence and an unchecked consent box.
- [ ] Personally choose a harmless screen, grant OS permission, and press Start one-hour test once.
- [ ] Record the actual start; check visible remaining time starts at one hour only after the screen is ready.
- [ ] Inspect the initial real PNG and subsequent five-minute images in the local gallery.
- [ ] Pause and resume without extending the original ending time or generating catch-up shots.
- [ ] At the one-hour limit, confirm the visible stopped status, zero remaining time, and no further screenshot files.
- [ ] Wait past another five-minute slot and verify the screenshot count remains unchanged.
- [ ] Check no new test or capture restarts after reopening the app or waking the Mac.
- [ ] Delayed permission, queued capture, and slow storage callbacks must not retain a PNG after the deadline.
- [ ] Report the actual start/end times and real PNG count. Do not infer success from a simulated test or code review.
