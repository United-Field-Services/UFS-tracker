# Hosting the tracker on Cloudflare (plan, not done)

Status 2026-10-28: **nothing is deployed.** The Cloudflare MCP was connected later the same day; only read-only list calls were made. The account holds the production **`ufs-people`** Worker and **`ufs-people-db`** D1 database (not to be touched from this project), and **R2 is not enabled** ("Please enable R2 through the Cloudflare Dashboard"), so no bucket could be created. Decide where tracker resources live (same account or a separate one) before creating anything.

## What the server needs
Node 24 running TypeScript directly, Express, `node:sqlite` (one SQLite file, single process), screenshots in S3-compatible storage (the S3 store already speaks Cloudflare R2), outbound HTTPS to Supabase and to the UFS People directory endpoint, and one `listen` port. Cloudflare Workers cannot run this as is (no `node:sqlite`, no long-lived Express process).

## Options (trade-offs)
| # | Option | Effort | Notes |
|---|---|---|---|
| 1 | **Node host (small VM, or an office PC) behind a Cloudflare Tunnel**; screenshots in **R2**; DNS, HTTPS and WAF from Cloudflare; SQLite on a persistent disk with Litestream backup to R2 | S-M | Fastest path to a pilot and no code change. Needs one always-on machine. Recommended for the pilot. |
| 2 | Cloudflare Containers | M | Runs the Docker image; persistent SQLite disk is the open question. Evaluate only if the disk story is confirmed. |
| 3 | **Rewrite for Workers + D1 + R2** | L | Best long-term fit with UFS People (also Cloudflare D1/R2); needed for the later merge. The server uses plain SQL, so the data layer is the main port. |

## Steps for option 1 (when Cloudflare access exists)
1. Domain on Cloudflare; create a Tunnel and a hostname (for example `tracker.<domain>`), HTTPS only.
2. R2 bucket + API token (kept in env vars, never chat): `STORAGE_DRIVER=s3`, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `S3_BUCKET`, `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=1`; add the bucket lifecycle rule (retention + 1 day, command in `server/README.md`).
3. On the host: Node 24, `server/` copied, `TRACKER_DATA_DIR` on a persistent disk, `PORT`, Express `trust proxy` set for Cloudflare so the login limiter sees real client IPs, secrets via the host's secret store.
4. Supabase: staging stays on `ufs-tracker-staging`; production decision is in `REMAINING-WORK.md` section 3 (own project vs UFS People's).
5. Backups: Litestream to R2 and a restore drill; uptime monitor and alerts.
6. Point the desktop at `https://tracker.<domain>` (the sign-in screen takes the server address); rebuild/sign the installer.
7. Smoke test with synthetic users only, then the real-bucket test (`REMAINING-WORK.md` 2.8).

## Needs from you
Cloudflare account + zone/domain, who pays/owns it, the MCP or wrangler login, and the choice of option 1, 2 or 3.
