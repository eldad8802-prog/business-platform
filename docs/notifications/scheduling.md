# Notification engine — scheduling

> **THIS BRANCH ACTIVATES SCHEDULING.** `notify/10-schedule` is the ONE place that schedules the notification
> engine's routes (`vercel.json` `crons`). Every other notifications branch keeps its routes unscheduled. Merge it
> **LAST** — after the migrations (#1143, 2b, #1155) are applied in Production and every code PR of the track is
> merged — and only on the owner's explicit go. Until then nothing here runs. Merging it starts three Vercel crons on
> the Production deployment; the routes still do nothing for a business until `notifications_engine` is ON for it.

Owner decision 2026-11-13: prepare scheduling in code only — no cron / worker activation now.

## 1. The schedule

The single source is `lib/notifications/engine/schedule.ts`; `schedule.test.ts` pins that `vercel.json` says the same.

| Route | Cron (UTC) | Cadence | What a pass does |
|---|---|---|---|
| `/api/notifications/status-sweep` | `7,22,37,52 * * * *` | 15 min, off the quarter hour | state-based notifications (status-sweep.ts): the **stateless rotation** over every live business under the 45 s budget (§3) |
| `/api/notifications/worker` | `*/5 * * * *` | 5 min | owed pushes whose `nextAttemptAt` has come: quiet-hours ends, retries, and appointment reminders (§5); the backstop behind the after()-response trigger |
| `/api/notifications/digest` | `*/15 * * * *` | 15 min, on the quarter hour | per business / user: has the local clock reached the digest minute (default 08:00) and is there no digest yet that local day? One cheap read per business decides; the same stateless rotation under a 40 s budget (§5, §6) |

All three: `GET` (what Vercel cron sends), `CRON_SECRET` through `decideCronAuth` (Vercel adds the bearer itself; the
cron authority registry `settlement-recovery-auth.test.ts` already lists the three routes), `maxDuration = 60`,
counts-only answers and logs. The seven existing crons are unchanged (10 entries in all).

## 2. Vercel constraints (this project)

- **Plan.** The team is on **Vercel Pro** (commit `fbc8ef15`, PR #771: "The team is on Vercel Pro, so the old 'Hobby
  crons are daily' reason no longer holds"); `vercel.json` already runs two `*/10` crons in Production
  (transactional email, booking sweep), which a Hobby project cannot deploy. Pro accepts any cron expression with
  per-minute precision, so `*/5` and `*/15` are allowed. The per-project cron limit (40 on Pro historically; Vercel
  documents 100 per project today) is far away: 10 entries. `node_modules/vercel` is not installed in this repo, so
  the plan facts come from the repository's own record above, not from the CLI's docs.
- **If the project were ever on Hobby** (crons at most once a day, a sub-daily expression fails the deployment):
  do not merge this branch as is. Fallback, cheapest first: (a) keep the worker on the after()-response trigger
  only (every producer already kicks it) and run the sweep / digest from the existing GitHub Actions or Upstash
  QStash scheduler pattern (`docs/business-intake-m6-qstash-scheduler.md`, same `CRON_SECRET` routes, no code
  change); (b) on Pro but if 5-minute crons were refused: `*/10` for the worker (reminder precision 10 min, §5).
- **Delivery semantics.** Vercel calls the Production deployment only, does not retry a failed invocation, may
  deliver the same event more than once, and starts a new invocation even if the previous one is still running.
  §4 shows why each route is safe under all of that.
- **Duration.** `maxDuration = 60` (Pro allows more; we do not need it). Vercel ends the function at 60 s.

## 3. The status sweep's rotation (why a cron needs it)

A cron calls the route without `?after`. Before this branch that meant "walk from the first business until the 45 s
budget ends" — at 500 businesses (54.5 s steady state, `sweep-performance.md`) the last ~90 would **never** be swept,
because nobody calls the continuation. Now a call without `after` runs the **rotation** (`rotationOrder`): live
businesses are split into `ceil(n / 200)` groups by `id mod groups`; pass *k* walks group *k mod groups* first, then
the next ones, wrapping around, until the budget ends (within a group ascending ids on even cycles, descending on odd
ones, so an overfull group never loses the same tail twice). No cursor is stored (no schema change); a business's
group does not move when others are added or removed. `?after=<id>` keeps the keyset continuation for manual runs.
Guarantee (schedule.test.ts §3): every business is swept within `groups` passes while a group fits one pass, within
`2 × groups` while it fits two.

## 4. Overlap protection

A run **cannot outlive its interval**: Vercel kills it at 60 s and the shortest cadence is 5 min (pinned by
`schedule.test.ts` §2 for each route). So no run-level lock is added — it would need either a session-level advisory
lock (unsafe behind Neon's transaction pooler: the server connection is shared) or a transaction held open for the
whole run on a second connection (a new client site for ast-security-guard, and a deadlock with `connection_limit=1`).
Overlap still happens for other reasons — a duplicated cron event, the after() trigger, the digest's own worker pass,
a manual call — and every route absorbs it at the row level:

| Route | Guard | Proof |
|---|---|---|
| worker | CLAIM = conditional `UPDATE … SET leaseUntil = now + 2 min WHERE status = PENDING AND lease free AND due` — one winner per owed row. The lease (120 s) **outlives any run** (60 s), so a live run's claim can never lapse under it, and is shorter than the 5-min cadence, so a crashed run's rows are retried by the next pass | `scheduling-overlap.db.test.ts` (3 racing passes ⇒ each owed row claimed once); `notification-engine.db.test.ts` "claim / lease" (racing workers send to a device once); `schedule.test.ts` (lease > maxDuration, ≤ cadence) |
| status sweep | the state producers run behind `pg_try_advisory_xact_lock(namespace, businessId)` (the loser counts `leaseBusy` and skips); the writer's and `notify()`'s unique dedupe-key claims make every write idempotent; a business is never twice in one pass | `scheduling-overlap.db.test.ts` (2 concurrent rotation passes ⇒ one notification, one owed push); `state-producers.db.test.ts` |
| digest | the unique dedupe key `digest:u<userId>:<YYYY-MM-DD>` (local day) — a second digest that day is impossible | `scheduling-overlap.db.test.ts` (3 passes of the same tick ⇒ one digest per user, one owed push each; the next tick writes nothing) |

## 5. Load (measured on the local lab, PostgreSQL 18, loopback, the restricted runtime)

Harness: `.nte/sweep-perf.ts schedule <tag>` (this branch) — one pass of each scheduled route exactly
as the cron runs it, on N = 500 seeded engine-ON businesses (the sweep-performance dataset: every fact the sweep
reads, one user each), as `app_runtime_prod` (NOSUPERUSER NOBYPASSRLS, session TZ Asia/Jerusalem), statements counted
through Prisma query events, connections sampled from `pg_stat_activity` every ~5 ms. Two runs (first / steady); the
lab machine is shared, so wall times vary ~2× between runs — the statement counts are the stable figure.

| Route (cadence) | N = 500, measured | Statements / business | Peak connections | N = 5,000 (linear: no cross-business query besides the id walk) | maxDuration headroom |
|---|---|---|---|---|---|
| status sweep (15 min, rotation, 45 s budget, pool 2) | 301–340 businesses swept per pass (≈ 135–150 ms each); 3 groups of ≈ 168 ⇒ **every business within 2 passes (30 min)** | 61–78 (first pass writes) | 2 open tx / 2 connections (+ the walk) | ≈ 300 per pass ⇒ 25 groups of 200; full coverage in ≈ 17 passes of capacity, guaranteed within 25 (≈ 4 h 15 – 6 h 15); raise the pool to 4 (`NOTIFICATIONS_SWEEP_CONCURRENCY`, measured 2× in sweep-performance.md) to halve it | budget 45 s + at most one chunk (< 1 s) ⇒ ≈ 14 s |
| digest, not-due pass (15 min, 40 s budget) — 95 of the 96 daily passes | 5.4–9.4 s (11–19 ms / business) — **before this branch: 37.4 s** (per-user transactions on every pass) | 6 (one tenant tx: zone, users, settings, today's digests) | 1 tx / 2 | 54–94 s ⇒ the rotation finishes a full round in 2–3 passes | budget 40 s ⇒ ≥ 20 s |
| digest, the 08:00 pass | 24–26 s (48–53 ms / business; 336 digests, 164 empty) — **before: 75.9 s, i.e. killed at 60 s with the tail never served** | 11–23 | 1 / 2 | ≈ 240–265 s ⇒ ≈ 7 passes: the last business's digest by ≈ 09:45 local (each user still exactly once) | 40 s + its worker pass (§ worker) |
| push worker (5 min, limit 100 owed rows) | 4.5–22.6 s for 100 owed whole-business rows (fan-out + decide; no device — a real send adds the provider's latency, FCM ≈ 0.1–0.3 s per device) | ≈ 22 per owed row (4.5 / business here) | 1 / 2 | independent of N: 100 owed rows per pass (≥ 1,200 / h from the cron alone) on top of the after()-response trigger every producer fires | 100 rows ≈ 5–25 s + sends ⇒ ≥ 15 s; a run killed mid-way leaves leased rows that the next pass retries (lease 2 min < 5 min) |

**Neon connections at the same moment** (each Vercel invocation has its own Prisma pool, and every route works
sequentially): sweep ≤ 3 (pool 2 + the walk), digest 1 (+1 during its worker pass), worker 1. The sweep runs at :07 /
:22 / :37 / :52 for ≤ 46 s, so it never meets the digest (:00 / :15 / :30 / :45, ≤ 60 s); the worker (every 5 min)
can meet either: worst case ≈ 5 connections from the engine, far under Neon's pooler limits.

**Appointment-reminder precision.** Today (status sweep producer E, `feature-coverage.md` §0) a reminder is created by
the first sweep visit of the business inside [start − 60 min, start − 30 min], so it needs every business visited at
least every 30 min: true at N = 500 (≤ 2 passes = 30 min, borderline), **not** at N = 5,000 (hours). The other
agent's branch `notify/9-docs-appointments` makes reminders ride the worker instead — the owed push is written ahead
with `nextAttemptAt` = start − lead and the 5-minute worker (plus the after() trigger) sends it — so the precision
becomes **≤ 5 min late, independent of N**. That branch must merge before this one (this one is last anyway); with it,
the sweep's rotation latency only affects slow state facts (billing PDF failures, overdue obligations, lead
follow-ups, allocation problems), where minutes-to-hours is acceptable.

## 6. The digest at a 15-minute cadence (DST)

`digestMoment(now, tz, minute)` is due once the local clock has reached the digest minute; the dedupe key is the local
day. With a pass on every quarter hour, `schedule.test.ts` §4 simulates every tick across ±36 h of: Asia/Jerusalem
and Europe/London, on Fri 2026-03-27 (Israel springs forward 02:00 → 03:00), Sun 2026-10-25 (Israel falls back
02:00 → 01:00; London too), Sun 2026-03-29 (London springs forward) and a normal day (2026-06-15): **exactly one
digest per local day, at 08:00 local**, none skipped or doubled on the neighbouring days. A digest minute inside the
skipped hour (02:30 on 03-27) fires once at 03:00; inside the repeated hour (01:30 on 10-25) once, at its first
occurrence; a minute off the quarter hour (08:05) at the next pass (08:15 — at most 15 min late). A day with nothing to
report writes no digest, so a later pass the same day may still write one when something surfaces (still once).
