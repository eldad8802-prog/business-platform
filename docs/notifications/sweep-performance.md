# Status sweep — performance, measured (before / after)

Owner request 2026-11-13: measure the status sweep (`lib/notifications/producers/status-sweep.ts`) before and after
the coverage changes on the local lab, no guessing; bound its concurrency; avoid duplicate scans; never sweep a
business twice at once; keep partial failure safe; stay well under Vercel's `maxDuration` (60 s); estimate 10×.

## Method

- **Lab**: the Production-topology lab of migration `20261210090000_notification_engine_foundation`
  (`bash .nte/lab.sh <db> --with-nte`, PostgreSQL 18 on the local Windows lab, loopback). The sweep runs **as the
  restricted runtime** (`app_runtime_prod`, NOSUPERUSER NOBYPASSRLS, session time zone Asia/Jerusalem), exactly as the
  DB tests do. Prisma 6.19.3, default connection pool (15 on this machine).
- **Data** (`scripts/notifications/sweep-perf.ts seed <N> <tag>`): N engine-ON businesses, each with a realistic,
  modest mix of every fact the sweep reads — 3 billing documents (waiting for review, PDF failed, issued), 1 supplier
  draft, 3 leads (one overdue follow-up), 2 stock items with 1 critical alert, 4 documents (2 in the review queue,
  1 failed processing, 1 approved), 3 obligations (due today, 3 days overdue, in 20 days), 2 payment requests,
  3 appointments (in 45 min, tomorrow, cancelled), 1 user. N = 1, 50, 500; separate but identical datasets for
  "before" and "after", so neither run meets the other's notifications.
- **Measurement** (`scripts/notifications/sweep-perf.ts run <tag> <passes>`): the sweep over exactly those businesses
  (`opts.businessIds` — the same per-business path the live walk takes), timed per pass. Every SQL statement is
  counted through Prisma `query` events on the client `lib/prisma` picks up (the harness installs it as
  `globalThis.prisma` before the sweep loads) — **queries** include `BEGIN`, `set_config` (tenant GUC), `COMMIT` and
  savepoints; **transactions** = `BEGIN` statements; **peak open tx / connections** = the maximum number of the
  runtime's backends of the lab database inside a transaction / connected at the same moment (`pg_stat_activity`
  sampled every ~5 ms as the lab superuser, since another role's `xact_start` is hidden from the owner).
  `SWEEP_PERF_DUMP=1` prints the statement shapes and counts (used for the breakdown below).
- **Before** = `notify/6-coverage` at `8eff0d61` (its `status-sweep.ts` copied aside and selected with
  `SWEEP_PERF_MODULE`), **after** = this commit. Pass 1 = first pass over fresh data (writes notifications);
  pass 2 = steady state (every fact inside its cooldown: refresh only). The "after" sweep does strictly MORE work:
  the five new state producers (4 events per business in this dataset) on top of everything "before" did.

## Results

| N | Revision | Pass | Wall time | ms / business | Statements / business | Transactions / business | Peak open tx | Peak connections |
|---|---|---|---|---|---|---|---|---|
| 1 | before | 1 / 2 | 849 / 230 ms | — | 147 | 33 | 5–13 | 15 |
| 1 | after (pool 2) | 1 / 2 | 762 / 328 ms | — | 120 / 107 | 17 | 1 | 1 |
| 50 | before | 1 / 2 | 9.2 / 8.4 s | 184 / 168 | 147 | 33 | 13 | 15 |
| 50 | after (pool 2) | 1 / 2 | 6.9 / 5.2 s | 137 / 103 | 120 / 107 | 17 | 2 | 2 |
| 500 | before | 1 / 2 | **87.0 / 85.9 s** | 174 / 172 | 152 / 147 | 33 | **14** | **15 (pool exhausted)** |
| 500 | after, pool 2 (default) | 1 / 2 | 80.7 / **54.5 s** | 161 / 109 | 120 / 107 | **17** | **2** | 3 |
| 500 | after, pool 1 | 2 | 79.4 s | 159 | 107 | 17 | 1 | 1 |
| 500 | after, pool 4 | 2 | **30.2 s** | 60 | 107 | 17 | 4 | 4 |

(N = 1 wall times are dominated by connection warm-up; the per-business figures come from N = 50 / 500.)

**Before**, each business opened 33 tenant transactions, ~14 of them at once (the home snapshot's `Promise.all` over 14
loaders, plus the paperwork insight, the accountant and intake attention), so a single business could take every
connection of the pool; and the billing / supplier / lead predicates were scanned twice per business (the capped
snapshot loader, then the uncapped selector), the lead queue being evaluated twice.

**After**, per business (steady state, from `SWEEP_PERF_DUMP`): 17 transactions × (BEGIN + set_config + COMMIT) =
51 statements; the engine gate 4; the owned scopes 4 reads (billing ×2, lead queue ×1, supplier ×1 — the uncapped
selector only when a capped loader hit its cap); the existing writer / resolvers / reconcilers ~30; the five state
producers 1 lock + 1 time-zone read + 7 reads + 2 savepoint statements each. Never more than ONE open transaction
per business, and never more than `pool` businesses at once.

## What changed (and why it is safe)

| Change | Where | Effect |
|---|---|---|
| The sweep reads only its OWN scopes with the home snapshot's own loaders / translators / finalize, one read at a time, instead of the full 14-loader snapshot | `status-sweep.ts` `loadOwnedFacts` | −16 transactions per business; peak open tx 14 → 1 per business. The DB test pins that the narrow reads produce exactly the full snapshot's owned items (`state-producers.db.test.ts` §8) |
| No duplicate scans: a capped loader below its cap IS the complete set (same predicate — pinned by the pure test); the lead queue is read once for both the items and the present keys | `status-sweep.ts`, `exhaustive-facts.ts` `loadLeadAttentionForSweep` | billing / supplier / leads each scanned once per business in the normal case |
| Bounded business concurrency: a pool (default **2**, `NOTIFICATIONS_SWEEP_CONCURRENCY` 1–8, or `opts.concurrency`) | `runStatusSweep` | peak connections = pool (+1 for the walk) instead of the whole Prisma pool |
| Same business never twice in a pass (ids de-duplicated); the state producers run behind `pg_try_advisory_xact_lock(namespace, businessId)` — a concurrent pass skips them (`leaseBusy`) instead of doing the same work twice | `runStatusSweep`, `state-producers.ts` | no duplicated producer work across overlapping passes; nothing lost (the next pass reads the state again) |
| Partial failure: a failing business is counted and the pass continues; each state producer runs in a SAVEPOINT (one failing read never loses another's events); the continuation cursor is the last id of the last FULLY finished chunk | `sweepBusiness`, `runStateProducers` | no business skipped, none half-applied |
| Counters race fixed for the pool (`x += await …` overwrote a concurrent business's count) | `sweepBusiness` | exact report counts (pure test "pooled counters add up") |

Why not a lease spanning the WHOLE business sweep: without a schema change it needs either a session advisory lock
(Prisma's pool gives no connection affinity) or a transaction held open for the whole business on a second connection
— which deadlocks a deployment whose `connection_limit` is 1. Correctness does not depend on it: every write is
idempotent (the writer's and `notify()`'s atomic claim has one winner; resolution is idempotent), so an overlapping
pass can only repeat reads. Follow-up if wanted: a lease column (migration).

## Budget and 10×

- The route keeps `maxDuration = 60` and the 45 s budget; the budget is checked between chunks, so the worst overrun
  is one chunk (≈ pool × the slowest business, well under 15 s).
- 500 businesses, steady state: 54.5 s at the default pool 2 ⇒ **two invocations** (`?after=<nextAfter>`); 30.2 s at
  pool 4 ⇒ one invocation. Before: 86 s ⇒ two invocations while exhausting the connection pool.
- **10× (5,000 businesses)**, linear in businesses (per-business cost is constant: no cross-business query):
  ≈ 545 s of work at pool 2 ⇒ ~13 invocations of 45 s; ≈ 300 s at pool 4 ⇒ ~7 invocations. A full pass therefore
  takes ~10 min of cron chain at pool 2, ~5–6 min at pool 4. With E (appointment reminders) needing a cadence ≤ 30 min
  (see `feature-coverage.md` §0), 5,000 businesses fit at pool 2; at ~10,000+ raise the pool (4) or split the walk.
  Businesses with the engine OFF cost only the gate (no tenant work).
- Caveat: the lab is loopback; a hosted database adds round-trip latency per statement (~107 per business), which is
  exactly why the statement count, not the lab's wall time, is the figure to carry forward: e.g. at 2 ms RTT,
  ≈ +0.2 s per business sequentially, divided by the pool.
