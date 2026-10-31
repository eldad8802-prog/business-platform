# Production database availability monitor

`GET /api/health/db` answers whether Production can run a query on its database **right now**, through the two
connections the app serves traffic with. It exists because on 2026-10-30/31 Production could not reach its
database for ~40 hours while `/api/health` (static) and the page-latency monitor (`prod-uptime-monitor.yml`)
stayed green.

| | |
|---|---|
| Code | `lib/ops/db-health.ts` (probe), `app/api/health/db/route.ts` (route) |
| Tests | `lib/ops/db-health.test.ts` (pure), `scripts/ops/db-health-lab.ts` (real Postgres) — CI: `health-db-ci.yml` |
| Query | `SELECT 1` on `DATABASE_URL` (runtime) and on `authDb()` (login's client: `AUTH_DATABASE_URL` when the auth plane is active). No table, no write. |
| Auth | `Authorization: Bearer <HEALTH_MONITOR_SECRET>` — dedicated, ≥ 32 chars, must differ from `CRON_SECRET`. Checked before any database work. |
| Bounds | 3 s per check, 4.5 s for the whole probe (checks in parallel), `maxDuration` 10 s |
| Cache | `no-store` for browser, CDN and Vercel CDN on every answer; the route is `force-dynamic` |

## Answers

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"status":"ok","checks":{"runtime":"ok","auth":"ok"},"ms":{…},"checkedAt":"…"}` | both connections answered |
| 503 | `{"status":"down","checks":{"runtime":"<code>","auth":"<code>"},…}` | at least one did not |
| 401 | `{"error":"unauthorized"}` | missing / wrong credential — the database was not contacted |
| 503 | `{"error":"monitor_not_configured"}` | `HEALTH_MONITOR_SECRET` unset, short, or equal to `CRON_SECRET` — the route is inert |

Check codes: `unreachable` (server down / suspended / quota / connection dropped), `timeout` (no answer in 3 s),
`rejected` (credential or role refused), `not_configured` (the client cannot be built — e.g. `AUTH_DATABASE_URL`
missing while the auth plane is active), `error` (anything else). Never an error message, host, role or URL. The
log line is `[health-db] check failed { check, code, error: <class>, code: <machine code> }`.

The shared Prisma client's own `prisma:error` log lines are unchanged by this route (they already appear for every
failing query in Production).

## Monitor settings (the recommended service: UptimeRobot Solo)

- URL `https://promaxgroup.co.il/api/health/db`, method GET, interval 5 min (Solo allows down to 60 s).
- Request header `Authorization: Bearer <HEALTH_MONITOR_SECRET>` (custom headers need a paid plan on UptimeRobot).
- Down = any status other than 200 (a 401/503 `monitor_not_configured` is an alert too: the monitor is blind).
- Alert contacts: the mobile app (push) + email; recovery ("up") notifications on.
- Timeout 10 s.

## Activation (each step is a separate owner go)

1. Merge the PR (no migration; the route is inert without the secret — it answers 503 `monitor_not_configured`).
2. Generate the secret locally (`openssl rand -base64 48`), never paste it in chat, a ticket or a log.
3. Add `HEALTH_MONITOR_SECRET` to **Production** env in Vercel (and nothing else changes). A new deployment is
   needed for the variable to take effect.
4. One manual check from a terminal: `curl -s -H "Authorization: Bearer $S" https://promaxgroup.co.il/api/health/db`
   → `200 … "status":"ok"`; without the header → `401`.
5. Create the monitor (settings above). Use the service's "test notification" to prove the phone receives it.

## Rollback

- Stop alerts: pause or delete the monitor (no deploy).
- Close the route: remove `HEALTH_MONITOR_SECRET` from Vercel and redeploy → 503 `monitor_not_configured`, no DB contact.
- Remove the code: revert the PR. Nothing else depends on it.
- Secret leaked: rotate `HEALTH_MONITOR_SECRET` (new value in Vercel + the monitor). It opens only this read-only route.

## Neon compute

Each probe is one `SELECT 1` per connection (~1 ms of database work), but any query wakes a suspended compute and
keeps it awake for Neon's suspend timeout (5 min). Today the background jobs already keep the compute awake around
the clock, so the probe adds nothing. If the job cadence is later reduced so the compute can sleep, a 5-minute probe
alone would keep it awake permanently; the probe interval must then be decided together with that change.
