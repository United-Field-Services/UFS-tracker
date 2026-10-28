# Web dashboard: audit and re-engineering plan

Written 2026-10-28 after running the dashboard against the synthetic demo stack as owner, reading `server/public/` (about 66 KB: `app.js` 57 KB, `style.css` 9 KB) and the screenshot/report routes. Update this file as phases land.

## 1. What I observed (before this change)
| Area | Finding | Effect |
|---|---|---|
| Landing page | "Overview" was four numbers and a flat list of every person (39 rows) | No sense of trend, health or what needs action; unreadable at 200+ people |
| Admin view | None. Stats were scattered over Overview, Reports, People and Audit | The admin portal you asked for did not exist |
| Screenshots | Grid only; hard cap 60/120/200; no paging; no project filter; delete one at a time inside the viewer; no download; no storage numbers; no keyboard navigation | Not manageable beyond a few dozen images |
| Storage | No visibility of count, size, per-person use or retention | Admins cannot plan or clean up |
| People table | Action buttons clip off the right edge at 1360 px | Hidden controls (still open, see 3) |
| Code shape | One 57 KB `app.js` mixing helpers, API, views and dialogs; no components; no UI unit tests (only the Playwright run) | Hard to extend safely |
| Security | Strict CSP (`style-src 'self'`) blocks inline `style=""`; the new browser test caught my first draft doing that | Fixed: widths are set through the CSS object model |
| Server scale | Screenshot list reads up to 2000 rows then filters by visibility in memory; per-user policy lookups in loops | Fine for hundreds of people; needs SQL-side visibility and rollups for thousands |
| Design system | Colour tokens and dark mode exist; spacing, empty/loading states and tables are ad hoc; no toasts or skeletons | Looks consistent but plain |

## 2. Done in this slice (2026-10-28)
- **Admin portal** (owner, admin, HR read-only): `GET /api/admin/overview` + new "Admin portal" page: needs-attention list (pending approvals, people without notice consent, failed directory sync, stale devices), eight key numbers, two charts (tracked hours per day, screenshots per day; 14/30/60-day period; accessible SVG, no libraries), most-tracked people, time by project, screenshot storage and retention facts with largest-storage people, system health (directory, devices, notice acceptance, audit counts). Aggregates only; every view is audited; labelled "not a productivity, attendance or pay measure".
- **Screenshot manager:** `GET /api/screenshots/summary` (visibility-scoped counts, bytes, per person, per day), project filter and cursor paging on the list (`projectId`, `before`, `hasMore`), `POST /api/screenshots/bulk-delete` (up to 100 per call, per-item permission check, partial success, storage object removed first, audit per item plus summary, optional reason). Dashboard: storage summary and per-person usage, filters (person, project, dates), group by day or person, Load more, select mode with select-all and confirmed bulk delete, full viewer with previous/next (arrow keys), download, position counter.
- **Verification:** server 154/154 (9 new tests: roles, numbers, timezone buckets, visibility, paging, bulk delete rules, limits, audit); full browser suite 88/88 on a fresh synthetic stack (16 new checks, charts, select mode, bulk delete through the UI, audit trail, no CSP errors).

## 2b. Design-system pass (done 2026-10-28)
- **Shared UI module:** `server/public/ui.js` (loaded before `app.js`, no build step) now holds the helpers and components: `h`, dialogs, banners, badges, stats, SVG helper, plus new `icon`, `toast`, `skeleton`, `rowMenu`, table-to-card annotation (`watchTables`) and an `emptyState` with icon and hint. `app.js` keeps the API, sign-in and views.
- **Look and behaviour:** nav icons, spacing and focus tokens, row hover, toasts (bulk delete), loading placeholder while a page fetches, empty states with an icon, a skip link and focus moved to the page on menu navigation, reduced-motion support.
- **People table fixed:** actions are now `Edit` plus a keyboard-friendly "More" menu (Reset password, Sign out everywhere); the menu is fixed-position so the scrolling table cannot clip it; the table fits at 1360 px without sideways scrolling.
- **Phones:** tables show as labelled cards, the menu scrolls sideways instead of wrapping, no horizontal page scroll.
- **Verified:** browser suite **99/99** on a fresh synthetic stack (11 new design checks), server 154/154; light theme reviewed from the test screenshots (dark theme was not re-reviewed visually). Not done from the original list: converting `app.js` views into separate modules, a custom confirm dialog to replace the browser's `confirm()`, and a screen-reader walkthrough.

## 3. Still to do, in order
1. **Design follow-ups:** split `app.js` views into modules, replace native `confirm()` with the shared dialog, screen-reader and dark-theme review, per-page skeletons and column priorities on very wide tables.
2. **Per-person day timeline:** entries, idle, screenshots and (if enabled) activity estimates on one day view; manager team dashboard; saved filters.
3. **Time Doctor Track A** (see `TIME-DOCTOR-FEATURE-TRACKER.md`): notifications and email (B10), scheduled report emails (C8), break records (A11), leave/holiday source (C5), payroll exports and pay rates (B14, C11), data export and deletion on request (B15).
4. **Track B:** API keys, webhooks, open API (B12); Jira/Asana (B13).
5. **Track C (privacy review first):** app/website usage with visible employee disclosure (A12/C7).
6. **Scale:** visibility enforced in SQL, rollup tables for the portal, pagination everywhere, load test at a few thousand people.
7. **Release/ops:** hosting, signed installer, production update key, legal review (unchanged, see `REMAINING-WORK.md`).

## 4. Rules kept
No hidden tracking, no content capture, no productivity scoring; screenshot visibility policy and consent still gate everything; HR stays read-only; every view of someone else's data and every deletion is audited.
