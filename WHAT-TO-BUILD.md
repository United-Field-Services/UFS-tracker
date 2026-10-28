# What we need to build for a Time Doctor-style product

Draft v1, 22 Oct 2026. Based on what time/screenshot-monitoring products generally offer plus what we have today. **Not yet verified against Time Doctor itself**; the discovery run (see `TIME-DOCTOR-DISCOVERY-PROMPT.md`) will confirm and adjust this list.

## Status update 2026-10-27 (current repo state; see `PROGRESS.md`)

The local implementation is an internal UFS pilot foundation, not full Time Doctor parity. Current checks: desktop **182 passed / 6 platform skips**, server **145/145**, isolated synthetic dashboard **72/72** (latest dashboard run; dashboard code did not change in the latest desktop slice). The unsigned Windows x64 installer includes organization-only all-screens policy, visible expired-session queue recovery, and an opt-in local-data deletion prompt on uninstall; it has not been installed or launched. The desktop's real-display end-to-end remains unrun because it captures the physical display and can erase its configured app-data folder. Nothing is connected to real UFS People, Supabase, or an object-storage bucket.

Implemented in this repository: **A1, A2, A4, A5, A6, A7, A8, A9, A10**; partial **A3, A11, A13**. **B1** is partial (local break-glass accounts plus UFS People directory projection and Supabase sign-in; no invitations/SSO/self-service reset). **B2–B9** and **B16** have a tested baseline, with operational hardening still open. **B11** is partial (per-minute source slices plus materialized daily UTC rollups for opt-in counts; app/website use is not collected). **C1–C4, C9, C10** have a tested dashboard baseline; **C6** now has grouped estimates plus a daily UTC rollup view and CSV. Privacy basics include consent, a visible indicator, access scoping, retention and audit.

Still open or partial: A3 release signing/icon/updates, A11 app-closed reminders and break records, A12 transparent app/website use, A14 other platforms, A13 complete employee self-service. B10, B12–B15 and C5 full attendance parity, C7–C8 and C11 are open. A15's optional Windows uninstall deletion prompt is implemented but needs disposable-data install/uninstall verification. C5 now has an opt-in-date-range evidence report with per-schedule IANA timezone, grace threshold, tracker-only statuses, prorated within/outside schedule estimates, scoped audit and CSV; it cannot prove absence or payroll hours. B11/C6 daily aggregates cover consented count-only activity, not application/site usage. A10 desktop manual entry is implemented and synthetic-tested; the existing server approval flow remains authoritative. Production UFS People, Supabase, storage, hosting, legal/security review and real-hardware checks need external setup or review. Full parity remains substantial; see `REMAINING-WORK.md`.

Legend: ✅ have · 🟡 partial · ❌ missing. Phase: **MVP** (first usable company pilot) · **v1** · **v2**.
Size: S (days) · M (1-3 weeks) · L (a month or more).

## A. Desktop tracker app (Windows first)

| # | Feature | Now | Phase | Size |
|---|---|---|---|---|
| A1 | Visible timer: start / pause / resume / stop | ✅ | - | - |
| A2 | Consent-gated screenshots of the chosen screen, interval capture | ✅ | - | - |
| A3 | Fix + package: installer, icon, code signing, auto-update | 🟡 (unsigned installer) | MVP | M |
| A4 | Sign in with a company account; per-device token; sign out | ✅ (fake UFS People/Supabase tested) | MVP | M |
| A5 | Project / task picker synced from the server | ✅ | MVP | M |
| A6 | Upload queue: screenshots + time slices, retry, offline buffer, resume after crash, same-account reauthentication, and bounded best-effort flush on quit | ✅ | MVP | L |
| A7 | Admin-pushed settings (interval, screenshot on/off, blur, idle timeout, org-only all-screens capture) with local enforcement | ✅ (all-screens is off by default and requires a higher notice version; idle timeout classifies the estimate; the employee review prompt is A8) | MVP | M |
| A8 | Idle detection with a "were you working?" prompt and keep/discard choice | ✅ (company mode; only idle-classified time is discarded) | v1 | M |
| A9 | Activity level per minute (optional keyboard/mouse counts only, no event content) | ✅ (default off; admin policy + bumped consent version; bounded aggregate queue and role-scoped estimates) | v1 | M |
| A10 | Manual / offline time entry with approval flow | ✅ (desktop form, durable retry queue, server idempotency and approval; synthetic-tested) | v1 | M |
| A11 | Breaks, scheduled work hours, reminders ("you're not tracking") | 🟡 (in-app break/schedule prompts; no closed-app reminders or break records) | v1 | M |
| A12 | App and website usage (names and URLs, shown transparently to the employee) | ❌ | v2 | L |
| A13 | Employee-side "My data" view: own time, screenshots, delete own screenshot (policy permitting) | 🟡 (web dashboard and local gallery; no complete self-service export/deletion) | v1 | M |
| A14 | Mac and Linux builds verified; Chrome extension; mobile | ❌ | v2 | L |
| A15 | Uninstall offers to delete local data | 🟡 (interactive Windows prompt implemented; test both choices on disposable data) | v1 | S |

## B. Backend services

| # | Feature | Phase | Size |
|---|---|---|---|
| B1 | Accounts, organizations, teams, invitations, password reset, 2FA, SSO later | 🟡 (directory projection + Supabase sign-in/TOTP; no SSO or self-service reset) | MVP | L |
| B2 | Roles and permissions: owner / admin / manager / employee, scoped by team and project | MVP | M |
| B3 | Device registration and revocable tokens | MVP | M |
| B4 | Time entries API: create, edit, split, approve, lock periods; idempotent sync | MVP | L |
| B5 | Screenshot ingestion: private storage, signed URLs, size/format validation, thumbnails | MVP | L |
| B6 | Retention jobs: auto-delete screenshots after N days; legal-hold exception | MVP | M |
| B7 | Projects, tasks, clients, assignments, rates | MVP | M |
| B8 | Settings engine with inheritance (org > team > user) and locks | v1 | M |
| B9 | Audit log: who viewed/deleted/exported what | MVP | M |
| B10 | Notifications and email (alerts, digests, approvals) | v1 | M |
| B11 | Activity and usage aggregation (daily rollups for reports) | 🟡 (daily UTC rollups for opt-in counts; no app/website usage) | v1 | M |
| B12 | Public API + webhooks + API keys | v2 | L |
| B13 | Integrations: Jira, Asana, Trello, calendar | v2 | L |
| B14 | Payroll / invoice exports, pay rates, approvals | v1 | L |
| B15 | Data export and deletion on request (GDPR-style) | v1 | M |
| B16 | Observability: logs, metrics, rate limiting, backups | MVP | M |

## C. Manager / admin web dashboard

| # | Feature | Phase | Size |
|---|---|---|---|
| C1 | Team overview: who is tracking now, today's hours, status | MVP | M |
| C2 | Screenshot review: timeline grid, full image, filter by person/date/project, delete | MVP | M |
| C3 | Timesheets: view, edit with reason, approve/reject | MVP | M |
| C4 | Reports: hours by person / project / task / day; export CSV | MVP | L |
| C5 | Attendance and schedule reports, late/absent, overtime | 🟡 (timezone-aware tracker evidence and estimates; no leave/holiday feed or payroll evidence) | v1 | M |
| C6 | Activity / productivity reports (labelled as estimates; no wage decisions) | 🟡 (grouped and daily count-only estimates with CSV; no productivity scoring) | v1 | M |
| C7 | Web and app usage report | v2 | L |
| C8 | Scheduled email reports | v1 | S |
| C9 | User, team, project, role management screens | MVP | M |
| C10 | Policy settings screens (interval, blur, retention, who sees screenshots) | MVP | M |
| C11 | Payroll and invoicing screens | v1 | L |
| C12 | Billing and plan management (only if sold externally) | v2 | L |

## D. Privacy, compliance and trust (build alongside, not after)

- Employee notice and explicit consent record per user and per policy version
- Always-visible tracking indicator; no covert mode
- Employees can see what is collected about them
- Default to least access: employee + direct manager; HR by audited exception
- Retention limits, deletion, encryption in transit and at rest, per-employee storage paths
- Data location and processor documentation; works-council / local-law checklist per country
- Security review: threat model, pen test before rollout

## E. Quality, delivery and operations

- Automated tests per layer (unit, API, real-Electron e2e like `source/e2e/lifecycle.e2e.cjs`), CI on every change
- Staging environment with synthetic data; never test on real employee data
- Signed releases, update channel, rollback plan
- Admin runbooks: lost laptop, revoke device, wrong-person screenshot, deletion request
- Real-hardware checks: full 60-minute run, sleep/lock, unplugged display, Windows clock change

## Suggested phase order

1. **MVP (pilot with a small team):** A3 to A7, B1 to B7, B9, B16, C1 to C4, C9, C10, plus all of section D basics.
2. **v1:** idle prompt, breaks, settings inheritance, payroll exports, attendance and activity reports, notifications, employee "My data".
3. **v2:** app/URL usage, integrations and public API, Mac/Linux/mobile/extension, billing.

## Open decisions (blocking the MVP design)

1. Backend home: inside UFS People, separate service, or standalone
2. Desktop login: UFS People account vs device pairing code
3. Screenshot storage: Supabase Storage, Cloudflare R2 or S3
4. Who sees screenshots and for how long
5. Is this internal-only for UFS, or a product to sell? (decides C12, multi-tenancy, billing and support load)
