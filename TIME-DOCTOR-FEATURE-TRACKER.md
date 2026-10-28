# Time Doctor feature tracker: where we are

Written 2026-10-28. **Source: Time Doctor's public website only** (features, pricing, integrations and help pages, plus third-party reviews), read through ordinary web pages. Nothing here was observed inside the Time Doctor product, so it is a good public checklist but not a verified inventory; the clean-room discovery run (`TIME-DOCTOR-DISCOVERY-PROMPT.md`) is still blocked on the terms-of-service check. Update this file whenever a feature changes state.

Legend: ✅ done (tested against fakes/synthetic data) · 🟡 partial · ❌ not started · ⛔ deliberately not planned as Time Doctor does it, because it conflicts with our rules (visible, consent-based, no content capture). Tier = the Time Doctor plan that includes it (B Basic, S Standard, P Premium, E Enterprise). IDs refer to `WHAT-TO-BUILD.md`.

## Time tracking
| Time Doctor feature | Tier | Us | Notes / next step |
|---|---|---|---|
| Manual start/stop, projects and tasks | B | ✅ | A1, A5 |
| Automatic tracking (starts without a click) | B | ⛔ | We never start tracking by ourselves; schedule reminders only (A11). A visible, consented "start on sign-in" option could be reviewed with HR/legal. |
| Online and offline tracking | B | ✅ | A6 queue with retry |
| Groups / teams | B | ✅ | teams, org chart from UFS People |
| Break tracking | S | 🟡 | A11 reminders only; no break records. Next: dedicated break entries. |
| Work scheduling, time approvals | S | 🟡 / ✅ | schedule policy + approvals done; leave source missing |
| Manual time entry with approval | S | ✅ | A10 |
| Time management tools / wellness reminders | S | 🟡 | break reminders in-app only; closed-app reminders missing |

## Screenshots and recording
| Feature | Tier | Us | Notes |
|---|---|---|---|
| Interval screenshots, optional | B | ✅ | selected screen or org policy "all screens" (joined image) |
| Privacy controls (blur, who can view, delete, retention) | B | ✅ | blur, employee-only option, 90-day retention |
| Multiple monitors | B | ✅ code / ❌ hardware test | org-only, notice-gated; real two-monitor check pending |
| Video screen recording | P | ⛔ | Not planned; would need explicit visible consent, storage and legal review |

## Activity and productivity
| Feature | Tier | Us | Notes |
|---|---|---|---|
| Idle time tracking | S | ✅ | A8 keep/discard prompt |
| Activity summary (keyboard/mouse levels) | S | 🟡 | A9 counts only; no content |
| Web and app usage reports | S | ❌ | A12/C7; only with visible disclosure and consent |
| Productivity ratings (productive/unproductive apps) | S | ⛔ | We label activity as an estimate, never a productivity or pay score |
| Poor-time-use / distraction alerts | S | ❌ | depends on app/website usage |
| Work-life balance metrics | S | ❌ | could be built from tracked hours (overtime, weekend work) once policy is agreed |
| Mouse jiggler / clicker and irregular keyboard detection | P | ⛔ | needs reading input patterns; conflicts with the count-only rule |
| Unusual Activity report, Benchmarks AI, Office vs Remote | P | ❌ | later analytics, not before the basics |
| Meeting Insights, Software Cost Insights, internet connectivity report | P | ❌ | need app/meeting/network data; deferred |

## Attendance and reports
| Feature | Tier | Us | Notes |
|---|---|---|---|
| Attendance, missing-hours capture | S | 🟡 | C5 evidence report; no leave/holiday source |
| Real-time notifications for missed hours | S | ❌ | B10 notifications and email |
| Timeline and hours reports | B/S | ✅ | hours report + CSV; per-day timeline view could be richer |
| Real-time dashboard | S | ✅ | live status |
| Executive and custom dashboards, BI | P/E | ❌ | later |
| Custom data exports | S | 🟡 | CSV only; no scheduled email reports (C8) |

## Payroll and integrations
| Feature | Tier | Us | Notes |
|---|---|---|---|
| Payroll-ready reports, pay rates | S | ❌ | B14/C11 |
| Payroll/HRIS links (ADP, Gusto, Deel, BambooHR, Workday, Rippling) | add-on | ❌ | B13; UFS People link is our own HR source |
| Project tools (Jira, Asana, Trello, ClickUp, GitHub, ...) | S | ❌ | B13 |
| Help desk, CRM, communication integrations | S | ❌ | low priority for an internal tool |
| Open API, webhooks | P | ❌ | B12 |
| MCP connection, Ask AI | all | ❌ | optional later |

## Admin, security and platform
| Feature | Tier | Us | Notes |
|---|---|---|---|
| Users, groups, roles | B | ✅ | owner/admin/HR/manager/employee |
| Single sign-on | P | 🟡 | UFS People (Supabase) sign-in with authenticator codes; tested on a staging project |
| Automatic user provisioning | P | ✅ | UFS People directory pull (tested against a fake feed) |
| Historical tracking data, audit | P | ✅ | audit log, retention |
| Client login access | P | ❌ | not needed for an internal tool |
| Private cloud deployment | E | ❌ | hosting plan in `HOSTING-CLOUDFLARE.md` |
| Auto-update of the desktop app | (n/a) | ✅ | signed manifest, in place, keeps local data; tested 0.2.1 to 0.2.2 |
| Windows app | all | ✅ | unsigned installer; no app icon yet |
| Mac / Linux apps | all | ❌ | build config exists, never verified |
| Chrome extension, mobile apps | all | ❌ | A14 |

## Where we are (counting the rows above)
Counted from the 43 rows above: **15 done, 7 partial, 17 not started, 4 deliberately not planned.** Of the 39 features we intend to build that is roughly **47% covered** (partials counted as half). The biggest gaps are app/website usage (consented), payroll and integrations, notifications and email, Mac/Linux/mobile, and the premium analytics. The strong side is core time tracking, screenshots, approvals, roles, reports and the HR directory link.

## Suggested order (parallel tracks)
1. **Track A, product:** notifications and email (B10) and scheduled reports (C8); break records (A11); leave/holiday source (C5); then payroll exports and pay rates (B14, C11); data export/deletion (B15).
2. **Track B, platform:** open API and webhooks (B12); Jira/Asana integrations (B13); Mac and Linux verification (A14).
3. **Track C, privacy-reviewed:** app/website usage (A12/C7) only after HR/legal approve visible, employee-readable disclosure; analytics (unusual activity, benchmarks) after that.
4. **Track D, release/ops (blocking for any real use):** hosting, signed installer and icon, production update-signing key, legal review of the notice, real-hardware checks.
