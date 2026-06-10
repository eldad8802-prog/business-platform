# Dubiz Phase 1 / T2 Backfill Runner — Design & Implementation Plan v1

> **Planning the *execution mechanism* only.** No code, no migration, no backfill
> run, no production. The resolution **logic is already built & closed**
> (T1 `679f71d` + self-anchor `3bad602`); this doc plans the **runner** that drives
> it over existing data per `dubiz-phase-1-t2-backfill-design-v1.md`.
>
> Scope guard: no new schema · no new resolution logic · no scope expansion ·
> **no T3** (anchor-upgrade / sync / runtime resolution stay out). Phase 1 Reality only.

## Orienting principle

> The runner is a **thin orchestrator**: iterate businesses → role-rows → call the
> existing `resolvePartyForRoleRowTx(... source:"BACKFILL")`, accumulate counts,
> render a report. **All correctness lives in the service.** The runner owns only
> *control flow, batching, dry-run/execute, verification, and reporting.*

---

## 1. Runner Architecture

| Component | Responsibility | Notes |
|---|---|---|
| **`party-backfill.service.ts`** | the runner logic (pure, testable) | new file; no route/UI |
| `runBackfill(db, opts)` | top-level orchestrator: mode, business set, batch size, accumulate report | `opts: { mode: "dry-run"\|"execute", batchSize, businessIds? }` |
| `backfillBusiness(db, businessId, mode, batchSize)` | per-business execution + per-business counts | tenant unit |
| `iterateRoleRows(db, businessId, cursor, batchSize)` | paged read of Customers then Leads (read-only) | stable order by (subjectType, id) |
| `resolvePartyForRoleRowTx` | **reused as-is** — per-subject resolution | ❌ no changes |
| `collectHealthMetrics(db, businessId)` | post-state health checks (§3/§4) | read-only queries |
| `renderReport(accumulator)` | structured dry-run / post-run report | console + JSON |
| **operator entrypoint** | manual invocation (tsx script), args = mode/businessIds/batchSize | **not** wired to runtime/intake/UI |

> **Separation of concerns:** *orchestration* (runner) vs *resolution* (service,
> untouched) vs *reporting/health* (read-only) vs *persistence boundary*
> (dry-run = rolled-back tx; execute = per-batch commit).

---

## 2. Execution Strategy

- **Business-by-business:** outer loop over `businessIds` (all, or an explicit
  subset for pilots). Tenant isolation **by construction** — each business is
  independent and `businessId`-scoped.
- **Batch size:** within a business, process role-rows in batches (suggested
  **200**, tunable/reportable) to bound tx size & memory.
- **Transaction boundaries:**
  - **Dry-run:** one tx per business (or per run), **rolled back** → zero persistence.
  - **Execute:** **one tx per batch**, committed after each batch. *Not* one giant
    tx (lock/bloat), *not* per-row (chatty). Per-batch is the balance.
- **Restart safety:** the service **NOOPs already-resolved subjects** → a crashed
  run resumes correctly with no special checkpoint. (Optional: a per-business
  "done" marker for *efficiency* only — not required for correctness.)
- **Idempotent rerun:** full re-run → all-NOOP for processed subjects; only
  missing subjects get written. Converges.
- **Ordering:** stable `(businessId, subjectType, id)` → reproducible runs.

---

## 3. Dry-Run Design

- **Mechanism:** run the **same** orchestration inside a transaction, then **roll
  back** — the service's writes land in the tx, are counted, then discarded. A true
  projection with **zero persistence**. (Health metrics are computed *inside* the tx
  before rollback, against the would-be state.)
- **Computed (per business + grand totals):**
  - Parties to create · signal claims · anchor claims · conflicts · NOOPs ·
    no-signal count · rows read (Customers/Leads).
  - **Health metrics** (from design §7): signals→>1 Party · Parties >N members
    (N=10) · members-per-Party histogram · anomaly count · top-K outliers.
- **Report shape (structured):**
  ```
  { mode, startedAt, finishedAt, batchSize,
    totals: { businesses, customers, leads, partiesToCreate,
              signalClaims, anchorClaims, conflicts, noops, noSignal },
    perBusiness: [ { businessId, ...counts } ],
    health: { multiPartySignals, oversizedParties, memberHistogram,
              anomalyCount, topOutliers: [...] } }
  ```
- **Dry-run is the gate artifact:** operator reviews this before approving execute.

---

## 4. Verification Pipeline

**Before run (pre-flight gates — all must pass to enter Execute Mode):**
- ✅ Migrations applied in target env (Party tables exist). *(separate ops gate)*
- ✅ Baseline captured: row counts + content checksum of Customer / Lead /
  BillingDocument (to prove untouched after).
- ✅ **Dry-run completed and reviewed**; health metrics acknowledged.
- ✅ Explicit operator sign-off (and env order respected — §7).

**During run (in-flight):**
- Per-batch: only `party` / `partyResolutionClaim` written (assertable via counts).
- Running **conflict count** and **anomaly count**; **invariant-violation watch**
  (a signal mapping to >1 Party should be ~0).

**After run (post-run gates):**
- **Totality / KL closure:** every Customer/Lead `lookupPartyForRoleRow` → non-null.
- **Tenant isolation:** no claim's `partyId` → a Party of a different `businessId`.
- **Billing / role-rows unchanged:** checksum match vs baseline.
- **Idempotency:** an immediate second **dry-run** → all-NOOP, zero projected writes.
- **Health report** rendered.

---

## 5. Failure Handling

| Failure | Action |
|---|---|
| **One business fails** | **isolate & continue** — log business + error, move to next; failed business re-runnable later (idempotent). Businesses are independent |
| **A batch transaction fails** | batch **rolls back** (no partial writes); log; **retry once**; still failing → skip that business, continue (or stop — operator flag). Retry safe (idempotent) |
| **Conflict count anomalous (> threshold)** | conflicts are **fail-safe** (isolated anchors), *not* errors → **continue but flag loudly** in report. Threshold reportable, not a hard stop by default |
| **Health metrics anomalous** | **observational → report, do not auto-abort** (per design: not errors). Operator decides |
| **Invariant violation** (signal → >1 Party) | **hard pause** — this should be ~0 for exact-match; indicates a bug or unexpected data. Stop, surface, require investigation |
| **Pre-flight gate fails** | **do not enter Execute Mode** |

> Distinction enforced: *observational health* (report) vs *invariant violation*
> (pause). What's logged: per-business outcome, errors with context, final report —
> structured & auditable.

---

## 6. Operational Safety (proof, applied to the runner)

| Guarantee | Why it holds for the runner |
|---|---|
| **Billing untouched** | runner only calls `resolvePartyForRoleRowTx` (party/claim) + reads; baseline checksum proves BillingDocument/FinancialEvent unchanged |
| **Customer untouched** | read-only; service never writes Customer |
| **Lead untouched** | read-only; service never writes Lead |
| **FinancialEvent untouched** | never referenced |
| **Tenant isolation preserved** | per-business loop; `businessId`-scoped service + health queries; never crosses businessId |
| **Re-run safe** | service idempotency → all-NOOP on re-run; dry-run = rolled back (zero persistence) |
| **No new logic / schema / scope** | orchestration only; resolution reused as-is; no T3 |

---

## 7. Rollout Plan

| Stage | What | Sign-off to advance |
|---|---|---|
| **local (dev)** | migrations applied on dev DB; dry-run + execute on seed/dev data; full verification; free to truncate/reset Party tables | self-review: all gates green |
| **staging** | apply migrations (ops gate); dry-run → review report + health; execute (per-business, resumable); post-run verification | engineering review of dry-run **and** post-run reports |
| **production-candidate (pilot)** | on a **small explicit subset** of prod businessIds: dry-run → review → execute → verify | **owner** sign-off + clean pilot post-run |
| **production (full)** | migrations applied; dry-run on all → review → execute all (business-by-business, resumable) → full post-run verification | **owner** sign-off, contingent on clean staging + pilot |

- **Every transition gate:** dry-run reviewed · baseline checksums · health
  acknowledged · explicit human approval. **Production requires owner sign-off.**
- Migrations-applied is a **precondition** at each env (separate ops step, not the runner's job).

---

## 8. T2 Definition of Done (runner ready to implement)

The runner design is implementation-ready (it is) when it specifies:
1. Components + responsibilities — orchestrator / per-business / iterate / report /
   reused service (§1).
2. Execution strategy — per-business, per-batch tx, idempotent resume, stable order (§2).
3. Dry-run mechanism (rollback) + report shape (§3).
4. Verification pipeline + the **gates required before Execute Mode** (§4).
5. Failure handling — continue-on-business-failure, batch rollback+retry,
   observational-vs-invariant distinction (§5).
6. Operational safety proof (§6).
7. Rollout order + per-stage sign-offs (§7).

**Implementation shape (next step, on approval):**
- `party-backfill.service.ts` (orchestrator + dry-run + health metrics, pure/testable)
- an operator entrypoint (tsx script; not a route/UI)
- unit tests for the orchestrator over the fake-tx harness (counts, dry-run rollback,
  per-business isolation, idempotent rerun, failure isolation)

**Gated behind:** this design approved → implement runner (code) → migrations
applied per env → dry-run reviewed → sign-off → execute. **No production run without
owner sign-off.** Still: no intake, no Billing, no runtime wiring, no T3.

---

## Appendix — what the runner reuses (closed) vs adds (new)

| Reused (closed) | Adds (T2 runner) |
|---|---|
| `resolvePartyForRoleRowTx`, `createAnchorClaimTx`, lookups | orchestrator (`runBackfill` / `backfillBusiness` / `iterateRoleRows`) |
| idempotency, taxId-first, conflict fail-safe, anchors | dry-run (rollback) + report rendering |
| schema (Party, claim, nullable, SELF_ANCHOR — migrations unapplied) | health-metric queries + verification gates |
| T2 backfill *policy* (snapshot, conflict, health) | execution control: batching, tx boundaries, failure isolation, rollout |
