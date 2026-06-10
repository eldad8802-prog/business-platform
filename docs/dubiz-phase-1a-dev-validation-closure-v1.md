# Phase 1A — Dev Validation Closure Report v1

**Date:** 2026-06-11 · **Branch:** `feat/party-reality-t1` · **Status:** ✅ closed,
validated end-to-end on a dev DB, environment clean.

> Scope: this records the dev-only validation of the Party Reality Layer backfill.
> No production, no staging, no Billing/intake/runtime wiring, no merge.

---

## 1. What was built

**Party Reality Layer** — a corrigible identity layer: `Party` (identity primitive) +
`PartyResolutionClaim` (beliefs carrying confidence / provenance / status), with a
deterministic resolver (taxId→KNOWN, phone→BELIEVED, no-signal→SELF_ANCHOR/UNKNOWN,
conflict→isolated anchor) and the tooling around it:

- **Resolution core** (T1 + self-anchor): `lib/services/party/party-resolution.service.ts`
  — strong-signal-only, additive, polymorphic `subjectId` (no FK), zero mutation of
  Customer/Lead/Billing.
- **Backfill runner**: skeleton + dry-run → execute batching (per-batch commit) →
  health metrics (multi-party-signal / oversized / histogram / anomaly) → verification
  checks (totality / tenant-isolation / no-signal-invariant + checksum + idempotency
  helpers).
- **Entrypoints (gated, script-only)**: `scripts/party-backfill.ts` (dry-run default,
  double-confirm execute, production hard-block) and `scripts/party-verify-backfill.ts`
  (read-only verdict).
- **Prisma deps + guards**: `lib/services/party/party-backfill.deps.ts` — DI wiring,
  migrations-applied guard (fail-closed), dry-run rollback / execute commit, extended
  interactive-tx timeout.
- **Infra**: `directUrl` in `schema.prisma` for migrations (runtime stays pooled).
- **Docs**: ops runbook, verification gap analysis, dev seed plan (+ revision).

## 2. Relevant commits (chronological)

| commit | description |
|---|---|
| `679f71d` | feat(party): party resolution foundation (T1) |
| `3bad602` | feat(party): self-anchor claims (KL-1/KL-2) |
| `5814e03` | feat(party): backfill dry-run skeleton (T2a) |
| `f49b9a3` | feat(party): backfill execute batching (T2b-1) |
| `437db16` | feat(party): backfill health metrics (T2b-2) |
| `1ccc41e` | feat(party): backfill verification checks (T2b-3) |
| `b959e1e` | docs(party): phase 1 wiring design docs |
| `b19072a` | feat(party): manual backfill entrypoint (T2c) |
| `a1974d1` | feat(party): wire backfill prisma deps (T2d) |
| `e7c0788` | feat(party): manual backfill verification entrypoint (T2e) |
| `a56b5c3` | docs(party): phase 1 t2 ops runbook + verification gap analysis |
| `a28fd74` | chore(prisma): add direct url support |
| `32f62ba` / `8f29c34` | docs(party): dev seed plan + revision (schema constraints) |
| `282329c` | fix(party): extend backfill transaction timeout |

_(All on `feat/party-reality-t1`; not yet merged to main.)_

## 3. Which DB was used

**Neon dev branch only** — endpoint `ep-square-grass-amqdtlrl`, db `neondb`, us-east-1.

- Verified unambiguously as **dev** (distinct from documented production `ep-flat-brook`
  and old seed `ep-frosty-pine`; signature 3 users / 4 businesses / 56 BillingDocuments).
- **Runtime / backfill**: `DATABASE_URL` **pooled** (`-pooler`).
- **Migrations**: `DIRECT_URL` **unpooled + Neon SNI** (`options=endpoint%3Dep-square-grass-amqdtlrl`)
  — kept only in the gitignored `.env`, never committed.

## 4. Migrations applied (dev only)

Via `prisma migrate deploy` over the DIRECT connection:

- `20260610140000_party_resolution_foundation_t1` — create `Party`, `PartyResolutionClaim`, enums.
- `20260610150000_party_anchor_claim_t2_readiness` — add `SELF_ANCHOR` to enum;
  `signalType` / `signalValue` → nullable.

Verified read-only: both tables exist, `SELF_ANCHOR` present, nullable applied.
`migrate status` → "up to date" (zero pending). **Additive only** — zero change to
existing tables (BillingDocument stayed 56 throughout).

## 5. Dry-run / execute / verification / idempotency results

**Seed (dev test fixture):** 2 businesses (`__PARTY_SEED_A/B__`), 6 Customers, 4 Leads —
covers scenarios #1–#5. (Conflict #6 was proven **unseedable** under
`@@unique([businessId, phone])` + customers-before-leads ordering; it stays covered by
unit tests only.)

| step | result |
|---|---|
| **dry-run** | businesses 6 · customers/leads 6/4 · applied 9 · singleton 1 · conflict 0 · signal 9 · anchor 1 · projected parties 9 · anomalies 0 · **PERSISTENCE none** — matched expected exactly |
| **execute #1** | committed · **9 Party + 10 Claim** · failed 0 · conflict 0 · BillingDoc 56 |
| **verification #1** | **VERDICT OK** — totality holds · tenant isolation holds · no-signal-invariant holds · missing 0 · tenant viol 0 · signal-invariant 0 |
| **idempotency (execute #2)** | **applied 0 / noop 10** · zero new parties/claims (Party 9 / Claim 10 unchanged) |
| **verification #2** | **VERDICT OK** (identical) |

One deviation en route: the first dry-run failed on Prisma's interactive-tx timeout
(5s default against a remote DB) → fixed in `282329c` (`{maxWait:20000, timeout:120000}`)
→ rerun passed clean.

## 6. Cleanup status

✅ **Done.** Deleted the 2 seed businesses (name-guarded `startsWith __PARTY_SEED_`) →
cascade removed 6 Customers / 4 Leads / 9 Parties / 10 Claims. The dev branch returned
to **exact baseline**: Business 4 · Customer 0 · Lead 0 · Party 0 · Claim 0 ·
BillingDocument 56. Verified read-only — no residual seed.

## 7. What was NOT touched

- **Production** and **staging/prod-candidate** — zero contact (execute to prod is also
  hard-blocked in tooling).
- **Billing** — BillingDocument 56 unchanged throughout; zero writes to Billing/FinancialEvent.
- **intake / runtime wiring** — not connected; the Party layer is not live on any path.
- **schema** — apart from the single `directUrl` line, no change.
- **Customer / Lead** — read-only; never written (polymorphic subjectId, no FK).
- **secrets in git** — `DIRECT_URL` lives only in the gitignored `.env`.

## 8. Recommended next step

**Recommended: open a PR / merge `feat/party-reality-t1` to main** — the stack is mature,
unit-validated (212+ green checks), and validated end-to-end on dev. Merging locks the
foundation before further work.

Then, separately and with dedicated approval:

- **Staging rollout** per `docs/dubiz-phase-1-t2-ops-runbook-v1.md` (needs DIRECT_URL+SNI
  there too; requires owner sign-off).
- **T3 / runtime**: wire Party resolution into the live intake (runtime resolution +
  anchor→signal upgrade) — the step that starts deriving value from the layer.
- Optional: production only after a clean staging + owner sign-off (all gated in the runbook).
