# UFS People directory feed: specification for the endpoint UFS People would add

**Purpose:** let the Time Tracker know who works at UFS, who manages whom, each person's role, and which Supabase login belongs to which employee, **without giving the tracker any access to UFS People's database or HR records**. The tracker only *pulls* this one read-only document. Nothing in UFS People is written by the tracker.

This document is for the person who owns UFS People. It is a proposal: nothing has been changed in the UFS People project, and the tracker side is already built and tested against a fake feed of synthetic people (`src/fake-directory.ts`).

## The endpoint

```
GET <https URL of your choice>/directory
Authorization: Bearer <long random secret, 32+ characters>
Accept: application/json
```

- Read-only. No request body. No query parameters.
- Respond **401** for a missing or wrong token (compare in constant time). Respond **200** with the JSON below.
- The secret is dedicated to this endpoint (create a new one; do not reuse any Supabase, Cloudflare or session secret) and is stored as a Worker secret. It goes in the tracker's `DIRECTORY_TOKEN` environment variable. Rotating it is a one-line change on both sides.
- Rate-limit it (the tracker calls it once every 15 minutes, plus an occasional manual "Sync now").
- Serve it over **https**. The tracker refuses plain http except for localhost.
- Do not add redirects (the tracker refuses to follow them, so the token can never be forwarded).

## The response (version 1)

```json
{
  "version": 1,
  "generatedAt": "2026-10-26T09:30:00.000Z",
  "employees": [
    {
      "id": "emp_8f3a",
      "email": "ana.garza@ufs.example",
      "name": "Ana Garza",
      "managerId": "emp_41cc",
      "role": "employee",
      "active": true,
      "department": "Engineering",
      "location": "Head office",
      "title": "Engineer"
    }
  ],
  "identities": [
    { "subject": "6f2d3a1e-9c4b-4d2a-8f10-5b7e2c9a1d44", "employeeId": "emp_8f3a", "enabled": true }
  ]
}
```

| Field | Rules |
|---|---|
| `version` | must be `1` |
| `generatedAt` | ISO time the snapshot was produced (not cached); must be within the last 48 h and never older than the previous feed |
| `employees[].id` | UFS People `employees.id`; `[A-Za-z0-9_-]{1,64}`; unique |
| `email` | work email, unique |
| `name` | display name, 1-120 chars |
| `managerId` | `employees.manager_id`, or `null` |
| `role` | UFS People role exactly: `employee`, `manager`, `hr_manager`, `hiring_manager`, `admin` |
| `active` | **true only if the person may sign in today**: your existing `loginEligibleSql` (active, not demo, employment eligible). Leavers must be listed with `false` (or simply omitted), never kept as `true` |
| `department`, `location`, `title` | optional text, max 100/100/120 chars |
| `identities[].subject` | the Supabase user id (`sub`) from your **`employee_identities`** table (`issuer` = your Supabase issuer, `enabled` as stored) |
| `identities[].employeeId` | the `employee_id` of that row |
| `identities[].notBefore` | **optional**, ISO time: your per-subject password-reset cutoff (`auth_password_resets.not_before`). The tracker revokes that person's tracker sessions created before it and refuses logins issued before it. Omit or `null` if not applicable |

### What to include

- Only employees with `data_scope = 'live'` and `demo = 0`. **Never** the QA/test scope (`qa-bots-v1`) or demo people.
- Only enabled **and** disabled identity rows for the real issuer, so the tracker never links a login by email. The tracker maps a Supabase login to an employee **only** through this identity list, exactly like UFS People does.

### What must NEVER be in the feed

Salary or compensation, birth date, gender, marital status, nationality/citizenship, personal email or phone, home address, emergency contacts, identifiers (passport, national id, tax, bank), benefits, medical or HR notes, documents, photos, leave balances, performance data, passwords or tokens.

The tracker **enforces this**: if any field name that looks sensitive appears anywhere in the response, the whole sync is **blocked** (nothing is applied) and an administrator sees the field name (never its value). Unknown harmless fields are ignored and only their names are reported.

## How the tracker uses it (so you know what a change in UFS People causes)

- A new person with `active: true` gets a tracker account (no password; they sign in with their UFS People login in Phase 2b).
- A rename, role change, manager change or department change shows up in the tracker at the next sync (15 minutes or "Sync now").
- A person who is `active: false` or missing is deactivated: their tracker sessions are revoked immediately and uploads stop. Their already-recorded data stays until the retention period ends.
- Roles: `admin` becomes tracker admin; `hr_manager` becomes tracker HR (read-only: sees everyone's time and screenshots, edits nothing); `manager` becomes tracker manager (sees direct reports through `managerId`); `employee` and `hiring_manager` become employee. A configured employee id (`DIRECTORY_OWNER_EMPLOYEE_ID`) is the tracker owner. Unknown roles become employee and are reported.
- Departments become tracker teams (so policy can differ per department).
- Safety guards on the tracker side: an empty feed, or one that would deactivate more than 30% of people, is **blocked** and only a tracker owner can force it; stale or time-travelling feeds, duplicate ids/emails/identities, and feeds with more than 10% invalid rows are blocked; manager loops are broken and reported.

## Suggested implementation in UFS People (a sketch to review, not applied anywhere)

UFS People already has everything needed: the `employees` table, `employee_identities`, and `loginEligibleSql('e')` in `lib/policy.ts`.

```ts
// app/api/directory/route.ts (sketch). Add a dedicated secret binding, e.g. env.UFS_DIRECTORY_TOKEN.
export async function GET(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!timingSafeEqual(token, env.UFS_DIRECTORY_TOKEN)) return new Response('Unauthorized', { status: 401 });
  const employees = await env.DB.prepare(
    `SELECT e.id, e.email, e.name, e.manager_id AS managerId, e.role,
            CASE WHEN ${loginEligibleSql('e')} THEN 1 ELSE 0 END AS active,
            e.department, e.location, e.title
       FROM employees e WHERE e.data_scope = 'live' AND e.demo = 0`).all();
  const identities = await env.DB.prepare(
    `SELECT i.subject, i.employee_id AS employeeId, i.enabled
       FROM employee_identities i JOIN employees e ON e.id = i.employee_id
      WHERE i.issuer = ? AND e.data_scope = 'live' AND e.demo = 0`).bind(SUPABASE_ISSUER).all();
  return Response.json({
    version: 1, generatedAt: new Date().toISOString(),
    employees: employees.results.map(r => ({ ...r, active: !!r.active })),
    identities: identities.results.map(r => ({ ...r, enabled: !!r.enabled })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
```

Notes for the owner: use an explicit column list (as above) rather than `SELECT *`; keep the route outside the normal session/cookie middleware but behind the bearer check; log requests without logging the token; return `Cache-Control: no-store`; add a test that the response never contains keys other than those in the table above.

## Test it before connecting anything real

The tracker repo includes a fake directory with synthetic people:

```
node src/fake-directory.ts            # serves http://127.0.0.1:4310/directory.json
```

Point a **staging** tracker at your staging endpoint first (`DIRECTORY_URL`, `DIRECTORY_TOKEN`), check the People page shows "Synced", and only then switch to production. Use a separate staging Supabase project and synthetic employees for any sign-in testing; never real people.
