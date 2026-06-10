# Dubiz Phase 1 / T2 — Backfill Ops Runbook v1

> **Runbook only — nothing is executed by reading or approving this document.**
> No migration run · no dry-run · no execute · no Production DB · no
> Billing/intake/runtime changes. This plans the *safe order of operations* for
> applying the Party migrations and running the backfill, once separately approved.

## What is already built (and frozen)

| Piece | Commit | Status |
|---|---|---|
| T1 resolution foundation (Party, claim, service) | `679f71d` | closed |
| self-anchor (KL-1/KL-2) | `3bad602` | closed |
| T2a dry-run skeleton | `5814e03` | closed |
| T2b-1 execute batching | `f49b9a3` | closed |
| T2b-2 health metrics | `437db16` | closed |
| T2b-3 verification checks | `1ccc41e` | closed |
| T2c manual gated entrypoint | `b19072a` | closed |
| T2d prisma deps + migrations guard | `a1974d1` | closed |
| T2e manual verification entrypoint | `e7c0788` | closed |

**Nothing has been run against any DB.** The two Party migrations exist but are
**unapplied** in every environment.

The two migrations (the ONLY ones this runbook applies):
- `20260610140000_party_resolution_foundation_t1` — creates `Party`, `PartyResolutionClaim`, enums.
- `20260610150000_party_anchor_claim_t2_readiness` — `ALTER TYPE PartyResolutionMethod ADD VALUE 'SELF_ANCHOR'`; `PartyResolutionClaim.signalType` / `signalValue` → nullable.

> **Additive only.** Both migrations only CREATE new objects or relax NULLability
> on the new claim table. They MUST NOT alter `Customer`, `Lead`, `BillingDocument`,
> `FinancialEvent`, or any other existing table. Verifying that is a Preflight gate (§2).

---

## 1. Environments & order

Run strictly in this order; never skip ahead. Each stage is a hard gate to the next.

| # | Environment | Purpose | Advance gate |
|---|---|---|---|
| 1 | **local / dev** | first apply + dry-run + (optional) execute on disposable data; full review | self-review: migrations applied cleanly, dry-run report clean, verification green |
| 2 | **staging / prod-candidate** | apply migrations (ops gate) → dry-run → review → execute (resumable) → verify | engineering review of dry-run **and** post-run reports |
| 3 | **production** | migrations applied → dry-run on all → review → execute → full verification | **separate owner sign-off, contingent on clean staging** |

- **Production is a separate decision, not a continuation.** Reaching production
  requires a fresh, explicit owner approval that names the environment and the run.
  The entrypoint additionally **hard-blocks `execute` when `NODE_ENV=production` or
  `VERCEL_ENV=production`** (T2c/T2d), so a production execute via this script is
  refused even if mis-invoked — production execution is intentionally out of the
  current tooling and needs a deliberate later change + owner sign-off.
- Each environment repeats the full §2→§7 cycle independently.

---

## 2. Preflight (before applying any migration)

All read-only; all must pass before touching the target DB.

1. **Branch / hash expected.** Confirm the deploying ref contains the full Party
   stack (the commits in the table above). `git log --oneline | grep party` and
   confirm `a1974d1` (T2d) is present and is the latest party commit.
2. **Clean working tree for the party stack.** `git status` shows no uncommitted
   changes under `lib/services/party/`, `scripts/party-backfill*`, or
   `prisma/schema.prisma` / `prisma/migrations/2026061014…` / `…150000…`.
3. **DB target verified.** Print and confirm the target connection (host / db /
   env) is the intended one. Re-confirm it is **not** production at stages 1–2.
4. **Backup / snapshot.** Stage 1 (dev): not required (data disposable). Stage 2/3:
   take a DB snapshot/backup first, per environment policy. Do not proceed without it.
5. **`prisma migrate status`.** Inspect pending migrations. The pending set MUST
   contain **only** the two Party migrations named above (plus any unrelated
   already-pending ones must be understood — investigate anything unexpected).
6. **Migration content sanity.** Re-read both `migration.sql` files; confirm they
   only CREATE the new Party objects / relax NULLability on `PartyResolutionClaim`
   — no `ALTER`/`DROP`/`UPDATE` against any existing table.

> If any preflight item is ambiguous → **stop**. Do not apply.

---

## 3. Migration apply plan (first non-production environment)

1. **Apply** with the project's standard non-interactive deploy:
   `npx prisma migrate deploy`
   (deploy applies pending migrations in order; it does not reset or generate new ones.)
2. **Verify applied:**
   - `npx prisma migrate status` → both Party migrations now show as applied.
   - Spot-check `_prisma_migrations` contains both `migration_name`s with a
     non-null `finished_at` (this is exactly what the entrypoint's guard checks).
   - Confirm tables `Party` and `PartyResolutionClaim` exist.
3. **Prove existing tables unchanged** (additive guarantee):
   - Capture row counts / a content checksum of `Customer`, `Lead`,
     `BillingDocument` **before** apply, and re-check **after** — identical.
     (`rowsChecksum` in `party-verification.service.ts` is the helper for this;
     wrapping it around the snapshot is a small ad-hoc step.)
   - Confirm no schema change landed on those tables (diff `prisma migrate status`
     / DB introspection against expectation).

> Migrations-applied is a **precondition** for any run. The entrypoint refuses to
> build deps (fail-closed) until both migrations are recorded as applied (T2d guard).

---

## 4. Dry-run plan

- **Exact command (default mode is dry-run; nothing persists):**
  `npx tsx scripts/party-backfill.ts`
  Optional tuning: `--batch-size 200` (default 200), `--oversized-threshold 10`
  (default 10). **Do not pass `--mode execute`.**
- **What the report should show** (rendered by `renderReport`): `mode: dry-run`,
  businesses processed, failed businesses, batches (+failed), customers/leads read,
  `applied/noop/singleton/conflict`, signal/anchor claims, a health line
  (anomalies / multiPartySignals / oversized / conflictAnchors), an invariant line,
  and a persistence reminder.
- **How you know nothing persisted:** the final line reads
  `PERSISTENCE: none (dry-run — nothing was written)`. Mechanically, dry-run runs
  inside a transaction that is **rolled back** (`DryRunRollback` sentinel, T2d), so
  zero rows are committed. A post-dry-run `SELECT count(*)` on `Party` /
  `PartyResolutionClaim` must be **unchanged** (e.g. still 0 on a fresh DB).
- **Considered normal:** `failed businesses = 0`, `batches failed = 0`,
  `invariant violations: none` (multiPartySignals = 0), conflicts within an
  understood range (conflicts are fail-safe, not errors), oversized/anomaly counts
  reviewed and explainable.
- **Hard stop (do NOT proceed to execute):** any
  `⚠ INVARIANT VIOLATION DETECTED` (a signal → >1 party), any failed business or
  failed batch you can't explain, persistence reminder not showing `none`, or any
  evidence the DB changed during the dry-run.

---

## 5. Report review checklist

Review the **dry-run** report (and, where wired, the verification report) before
any execute decision. Tick every item:

- [ ] **Totals** — businesses / customers / leads read match expectation for the env.
- [ ] **Failed businesses** = 0 (any >0 → investigate; isolated & re-runnable, but understand why).
- [ ] **Batches failed** = 0.
- [ ] **Conflicts** — count is understood; conflicts are fail-safe isolated anchors, not errors.
- [ ] **Anchor claims** — count plausible (no-signal singletons + conflict anchors).
- [ ] **Multi-party signals** = 0 → **invariant holds**. Any >0 is a **hard stop**.
- [ ] **Oversized parties** — reviewed; threshold is observational, not a gate. Outliers explainable.
- [ ] **Invariant violations** — report line says `none`.
- [ ] **Tenant violations** = 0 (from verification: no claim points to a party of another business).
- [ ] **Billing / Customer / Lead untouched readiness** — before/after `rowsChecksum`
      of `Customer`/`Lead`/`BillingDocument` identical (proves additive, no role-row mutation).

> Verification reference: `verifyBackfill` (totality, tenant isolation,
> no-signal-invariant, counts) + `rowsChecksum` + `comparePartyClaimCounts`, all
> read-only. The verification report is produced by the dedicated read-only
> entrypoint **`scripts/party-verify-backfill.ts`** (T2e, `e7c0788`) — it applies
> the same migrations-applied guard, builds read-only deps, runs `verifyBackfill`,
> prints the report, and exits non-zero if the verdict is not OK. (The
> before/after `rowsChecksum` of `Customer`/`Lead`/`BillingDocument` for
> untouched-readiness is still a small ad-hoc snapshot wrapped around the run.)

---

## 6. Execute approval gate (explicit)

> **No `execute` may run without a separate owner sign-off taken AFTER a clean
> dry-run report has been reviewed.** Approval to proceed with dry-run, or approval
> of this runbook, is **not** approval to execute. The execute sign-off must name
> the environment, reference the reviewed dry-run report, and be recorded.
>
> Production execute additionally requires the tooling block to be deliberately
> lifted (it is hard-blocked today) — a separate, owner-approved change.

---

## 7. Execute plan (PLAN ONLY — not run here)

- **Command (non-production only):**
  `npx tsx scripts/party-backfill.ts --mode execute --confirm-execute PARTY_BACKFILL_EXECUTE`
  (both the `--mode execute` flag **and** the exact confirm phrase
  `PARTY_BACKFILL_EXECUTE` are required; missing either → fail closed.)
- **Confirm phrase:** `PARTY_BACKFILL_EXECUTE` (constant `EXECUTE_CONFIRM_PHRASE`).
- **Expected behavior:** per-business, per-batch committed transactions
  (`batchSize` default 200). A failed batch rolls back atomically, is recorded in
  `batchesFailed` / `batchErrors`, and does **not** undo already-committed batches;
  the run continues. Final report line:
  `PERSISTENCE: COMMITTED (execute mode — changes were written)`.
- **Post-run verification (required)** — run `npx tsx scripts/party-verify-backfill.ts`
  (read-only; exits non-zero if the verdict is not OK):
  - Totality: every Customer/Lead resolves to a Party via an ACTIVE claim (missing = 0).
  - Tenant isolation: tenant violations = 0.
  - No-signal-invariant: multi-party signals = 0.
  - Billing/role-rows untouched: `rowsChecksum` matches the pre-run baseline (ad-hoc snapshot).
- **Idempotency rerun check:** run the **dry-run** again (or compare count
  snapshots via `comparePartyClaimCounts`): a re-run must project **all-NOOP** and
  add **0** parties / **0** claims. Growth on rerun is a hard stop.

---

## 8. Rollback / correction

- **Dev reset (stage 1 only):** `Party` and `PartyResolutionClaim` are new additive
  tables with no inbound FKs from existing tables → safe to `TRUNCATE`/delete to
  fully reset and re-run. Never do this outside dev.
- **Corrigible correction (preferred everywhere):** mark a wrong link
  `status = RETRACTED` (preserves history; this is the corrigibility the design is
  built on) rather than deleting. Backfill output is identifiable by
  `source = 'BACKFILL'` (conflicts: `'BACKFILL:SIGNAL_CONFLICT'`) for targeted audit.
- **In production — do NOT:** never delete/truncate Party data; never mutate
  `Customer`/`Lead`/`BillingDocument`; correct only via RETRACTED + targeted
  re-resolution.
- **Invariant violation (signal → >1 party):** **hard pause.** This should be ~0 for
  exact-match; any occurrence means a bug or unexpected data. Stop, do not execute
  (or if found post-execute, stop further runs), investigate the offending signal
  values via the report samples, and resolve before continuing. Do not "clean up"
  by deletion — use RETRACTED on the incorrect links once understood.

---

## 9. Definition of Done (runbook ready)

This runbook is ready when it specifies (it does):
1. Environment order + production-as-separate-decision (§1).
2. Read-only preflight gates incl. the exact two-migration scope (§2).
3. Migration apply + applied-verification + existing-tables-unchanged proof (§3).
4. Exact dry-run command, expected report, no-persistence proof, normal vs hard-stop (§4).
5. A concrete report-review checklist incl. untouched-readiness (§5).
6. An explicit execute approval gate — owner sign-off after dry-run review (§6).
7. Execute *plan* (command, confirm phrase, expected behavior, post-run + idempotency) — not run (§7).
8. Rollback/correction incl. the invariant-violation hard-pause and prod prohibitions (§8).

**Out of scope (unchanged):** running anything now, production execution, Billing/
intake/runtime wiring, T3 anchor upgrade. (The verification entrypoint gap noted in
the analysis is now **closed** by T2e — `scripts/party-verify-backfill.ts`, `e7c0788`.)

**Next decision after approval:** whether to perform stage 1 (local/dev) first —
apply the two migrations on a dev DB and run a dry-run — under a separate, explicit go-ahead.
