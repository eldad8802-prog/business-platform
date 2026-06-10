# Dubiz Phase 1 / T2 — Verification Gap Analysis v1

> **Analysis only.** No code, no commit, no run. Purpose: decide whether the
> missing verification entrypoint is documentation debt (commit the runbook now)
> or a real break in the operational chain (close T2e first).
>
> **Outcome (resolved):** decision was **B — close T2e first.** The gap is small
> but sits at a sensitive operational point; the runbook should not enter history
> describing a verification process that is only ad-hoc. **T2e is now closed**
> (`scripts/party-verify-backfill.ts`, commit `e7c0788`), so the "missing
> entrypoint" described below **no longer exists** — this document is retained as
> the record of the analysis that led to that decision.

## TL;DR

Both *halves* of post-run verification already exist and are tested: the **logic**
(`verifyBackfill` + helpers) and the **Prisma deps** (`buildPrismaVerificationDeps`
+ migrations guard). What is missing is a single **read-only script** that wires
them together and prints the report. There is **no schema, no migration, no new
service logic, and no Billing/intake/runtime risk** in closing it.

The gap does **not** affect the dry-run review (which uses the backfill report).
It only matters at **execute / post-execute** time — that is when `verifyBackfill`
reads persisted data. So the runbook (a planning doc that already discloses the
gap) is committable now; the closing change (T2e) must land **before any execute**.

---

## 1. What exists today

### Verification capabilities (all read-only, all tested)
In `lib/services/party/party-verification.service.ts` (committed `1ccc41e`, 32/32 tests):
- `verifyBackfill(deps)` → full structured `VerificationReport` with **per-business**
  + **totals**:
  - **Totality** — every Customer/Lead has an ACTIVE claim (`missingSubjects`).
  - **Tenant isolation** — every claim's party belongs to the same business
    (`tenantViolations`, incl. orphan claims).
  - **No-signal-invariant** — no (signalType, signalValue) → >1 party
    (`signalInvariantViolations`).
  - **Summary counts** — customers, leads, parties, claims, signal/anchor claims,
    conflicts (by `:SIGNAL_CONFLICT` source suffix).
  - **Verdict** — `ok` per business + aggregate.
- `rowsChecksum(rows)` — deterministic before/after checksum (Billing-untouched readiness).
- `comparePartyClaimCounts(before, after)` / `snapshotCounts(report)` — idempotency readiness.

### Deps already written
In `lib/services/party/party-backfill.deps.ts` (committed `a1974d1` / T2d, 20/20 tests):
- `buildPrismaVerificationDeps(client)` → real Prisma-backed `VerificationDeps`
  (`listBusinessIds`, `loadCustomers`, `loadLeads`, `loadParties`,
  `loadActiveClaims` with `status = ACTIVE` filter).
- `assertMigrationsApplied(client)` / `listAppliedMigrations(client)` — the same
  fail-closed migrations guard the backfill entrypoint uses.

### What can be run manually today
- **Backfill dry-run / execute** via `scripts/party-backfill.ts` — fully wired,
  gated, prints a report (`renderReport`).
- **Verification** — only via an **ad-hoc programmatic call**: someone would have
  to write throwaway code that imports `prisma`, calls `assertMigrationsApplied`,
  `buildPrismaVerificationDeps`, `verifyBackfill`, and `console.log` the result.
  There is **no command** an operator can run. (Writing throwaway code at run time
  is exactly the unsafe ad-hoc the gated-script approach is meant to avoid.)

---

## 2. What is missing

| Question | Answer |
|---|---|
| What prevents producing a full Verification Report today? | Only the absence of a wired, runnable entrypoint. |
| Is it just a missing entrypoint? | **Almost entirely, yes.** No `scripts/party-verify-backfill.ts` exists. |
| Is there also a formatting/reporting gap? | **Minor.** `verifyBackfill` returns a structured object but has **no string renderer** (unlike backfill's `renderReport`). `JSON.stringify(report, null, 2)` is sufficient; a tidy human formatter is optional polish, not required. |
| Is any data missing? | **No.** Every field the runbook's review checklist (§5) needs is already computed by `verifyBackfill` / `rowsChecksum` / `comparePartyClaimCounts`. No new query, no new field. |

**Net:** the gap is one missing read-only script (+ optionally a small formatter).
The logic and the DB wiring are done.

---

## 3. Minimum Closing Change (T2e)

The smallest change that closes the gap is **exactly** what you described:

> **A single new file: `scripts/party-verify-backfill.ts`**, that:
> 1. lazily imports the real `prisma` (mirroring `scripts/party-backfill.ts`),
> 2. calls `assertMigrationsApplied(client)` (fail-closed),
> 3. builds deps via `buildPrismaVerificationDeps(client)`,
> 4. calls `verifyBackfill(deps)`,
> 5. prints the report (`JSON.stringify`, or a small renderer) and exits non-zero
>    if `totals.ok === false`.

Nothing more is strictly required. It is **read-only**, so it needs no
dry-run/execute/confirm gating — only the migrations guard. (Optional, low-cost
extras, if desired: a `renderVerificationReport(report)` string formatter +
unit tests for it, and exit-code semantics — but these are polish, not blockers.)

It would mirror `scripts/party-backfill.ts` structure but simpler (no mode, no
persistence, no confirm phrase). A matching `scripts/party-verify-backfill.test.ts`
with a mock client (parse/guard/render, no DB) would match the existing test pattern.

---

## 4. Blast Radius

| Dimension | Impact |
|---|---|
| Files changed | **1 new** script (`scripts/party-verify-backfill.ts`); **+1 optional** test; **0 modified** existing files (it reuses exported functions as-is). |
| Schema | **None.** |
| Migration | **None.** |
| New service logic | **None** — pure wiring of already-tested functions. (Optional: a string renderer, which is presentation only.) |
| Billing / intake / runtime risk | **None.** Read-only; no route/API/UI/cron; never imported by app code; touches only `Party` / `PartyResolutionClaim` reads + `_prisma_migrations`. Does not read or write Billing/Customer/Lead beyond the same read-only loaders verification already defines. |
| Run risk | The script itself performs **no writes** in any mode; running it (later, when approved) is inherently safe even in production (read-only) — though we still gate it behind the migrations guard. |

This is the smallest possible blast radius short of doing nothing.

---

## 5. Recommendation

**Decision: A (with a named condition).**

> **The gap is small documentation/tooling debt, not a break that blocks the
> runbook commit.** Recommend: **commit the Ops Runbook now**, and close **T2e**
> (the one read-only script) **before any `execute`**.

Reasoning:
- The runbook is a **planning document that already discloses the gap** (§5 note +
  §9 "open gap"). Committing it does not run anything and does not depend on T2e.
- The gap **does not affect the dry-run path**: the dry-run review (§4/§5 health
  items — multi-party signals, conflicts, anchors, oversized, invariant) is served
  by the **backfill report** (`renderReport`), which is fully runnable today.
  `verifyBackfill` reads **persisted** data, so it is only meaningful **after an
  execute** — there is nothing for it to verify during a rolled-back dry-run.
- Therefore the gap becomes load-bearing only at **execute / post-execute**. Since
  execute is itself gated behind a separate owner sign-off (Runbook §6) and is not
  imminent, T2e can be closed in that window.

**Binding condition on A:** T2e MUST be closed before the first `execute` (and it
is cheap enough that closing it before even the stage-1 dev run is reasonable, so
the operator has a real verification command in hand). Do not execute relying on
ad-hoc verification.

(Choosing **B** — close T2e before committing the runbook — is also defensible and
only costs a short delay, given how small T2e is. But it is not *necessary*: the
runbook's honesty + the dry-run independence make A safe.)

---

## Appendix — exact reuse map (closing change adds nothing logical)

| Needed by the verify script | Already exists | Where |
|---|---|---|
| migrations guard | `assertMigrationsApplied` / `listAppliedMigrations` | `party-backfill.deps.ts` (T2d) |
| read-only deps | `buildPrismaVerificationDeps` | `party-backfill.deps.ts` (T2d) |
| verification logic + report shape | `verifyBackfill` → `VerificationReport` | `party-verification.service.ts` (T2b-3) |
| untouched / idempotency helpers | `rowsChecksum`, `comparePartyClaimCounts`, `snapshotCounts` | `party-verification.service.ts` (T2b-3) |
| lazy prisma + script pattern | mirror of `scripts/party-backfill.ts` | T2c/T2d |
| **string renderer** | **does not exist** (optional; `JSON.stringify` suffices) | — |
| **entrypoint** | **does not exist** | the one file T2e adds |
