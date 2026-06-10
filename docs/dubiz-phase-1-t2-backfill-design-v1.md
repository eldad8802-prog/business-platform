# Dubiz Phase 1 / T2 Backfill — Design v1

> **Design only.** No code, no migration creation/run, no backfill run, no runtime
> wiring, no intake/Billing/Production-DB changes.
>
> Goal: design how to backfill `Party` + `PartyResolutionClaim` for **existing**
> Customers/Leads — idempotent · tenant-scoped · non-destructive · additive ·
> conflict-safe · Billing-safe · no role-row mutation · no runtime wiring.
>
> **Leans entirely on T1 (`679f71d`) + self-anchor (`3bad602`).** No new resolution
> logic. No new direction. Still Phase 1 Reality layer only.

## Core principle

> **Backfill = drive the *already-built* `resolvePartyForRoleRowTx` over existing
> role-rows, per business, idempotently.** All resolution behavior (taxId-first,
> phone, singleton+anchor, conflict fail-safe, idempotency) already exists and is
> tested (40/40). T2 adds only a **read-iterate-and-call** runner — zero new
> resolution rules.

---

## 1. Scope of T2 Backfill

**IN**
- A one-time, **re-runnable** runner that, per business, reads existing Customers
  and Leads and calls `resolvePartyForRoleRowTx(... source: "BACKFILL")` for each.
- Read-only access to Customer/Lead; additive writes to Party/PartyResolutionClaim only.
- A **dry-run** mode (transaction rollback) + post-run verification counts.

**OUT (explicit)**
- ❌ No migration creation/run. (T1+T2 migrations exist, unapplied; applying them
  in a target env is a **separate ops gate**, not part of this design.)
- ❌ No mutation of Customer / Lead / BillingDocument / FinancialEvent.
- ❌ No Supplier / Vendor / counterparty / supplierName.
- ❌ No fuzzy / name matching · no priors · no Situation/Attention/Recommendation/Learning.
- ❌ No runtime wiring (intake unchanged) · no production execution (gated separately).
- ❌ No new resolution logic — service reused as-is.

> **Precondition (not part of this design):** backfill execution requires the
> Party tables to exist in the target env (migrations applied). That ops step is
> out of scope here.

---

## 2. Input set

| Source | Fields read (read-only) | Signals passed to service |
|---|---|---|
| **Customer** | `id, businessId, phone, taxId, name` | `{ phone, taxId }` (name passed, ignored as signal) |
| **Lead** | `id, businessId, phone, customerName` | `{ phone }` — **Lead has no taxId field** |

- **phone:** passed raw; the service re-normalizes via `normalizeCustomerPhone`
  (Customer.phone is already canonical; Lead.phone may be raw — re-normalize is safe).
- **taxId:** Customers only; trimmed by the service.
- **name-only / no-signal** (no phone & no taxId) → service `SINGLETON` path →
  singleton Party + **anchor claim** (`SELF_ANCHOR`, `UNKNOWN`, null signal).
- Iterated **per businessId**, paged; **never written**.

---

## 3. Backfill algorithm (steps)

```
for each business B (deterministic order):
  for each role-row R in (Customers of B, then Leads of B), stable order by id:
    signals = Customer ? {phone, taxId} : {phone}        # name never a signal
    resolvePartyForRoleRowTx(tx, {
      businessId: B.id,
      subjectType: CUSTOMER | LEAD,
      subjectId: R.id,
      signals,
      source: "BACKFILL",
    })
    # service internally (already built & tested):
    #   - NOOP if R already has an ACTIVE claim (idempotent)
    #   - taxId exact → KNOWN ; else phone exact → BELIEVED
    #   - no candidate → create singleton Party + claim(s)
    #   - no signal → singleton Party + anchor claim (UNKNOWN)
    #   - signals point to different parties → isolated Party + anchor (fail-safe)
    #   - NEVER mutates Customer/Lead
```

- **Per-row transaction** (or small batches): a failure on one row does not roll
  back others; re-run resumes (idempotent).
- **Determinism:** stable order (businessId, then id) → reproducible re-runs.
- **End-state for exact-match is order-independent:** all rows sharing a phone (or
  taxId) value converge on one Party regardless of order (first creates, rest link).
- **Conflict outcome is order-sensitive** (see §4) — acceptable & corrigible.

---

## 4. Conflict policy

| Case | Behavior (already in service) |
|---|---|
| **same phone, different names** | name ignored → both link to the same phone-Party. ✅ |
| **same taxId, different phones** | taxId-first → both link to the same taxId-Party; each distinct phone becomes a phone-claim **to that same Party** (multiple distinct phone values → one party = legitimate, **not** pollution). ✅ |
| **phone→Party A, taxId→Party B (different existing parties)** | **conflict → isolated Party + anchor claim** (`source: BACKFILL:SIGNAL_CONFLICT`). No merge of A/B. Fail-safe under-merge. |
| **duplicate existing claims** | service idempotency (NOOP per subject) + per-(subject,signalType) dedup → no duplicates. ✅ |
| **existing anchor + later strong signal** | **Out of T2 scope (LOCKED).** A subject is processed once: signals → signal claims, or none → anchor. An **anchor without a signal stays an anchor** — backfill never upgrades it. |

> **Locked decision (T2):** *Anchor without a signal stays an anchor; backfill
> does not upgrade anchors.* The **Anchor → Signal upgrade** (retract anchor,
> re-resolve) belongs to **T3 Runtime Resolution** — upgrading begins a
> Resolution / Correction *lifecycle*, which is runtime behavior, not backfill.
> T2's job is initial population, totality, and safe unification on existing
> strong signals — nothing more.

> **Order-sensitivity note:** a multi-signal row processed *before* its signal
> values are split across other parties will *unify* them; processed *after*, it
> hits a conflict and is isolated. Both outcomes are **fail-safe (no wrong merge)**
> and **corrigible**. A stable order makes the result reproducible; full
> reconciliation is a T3 concern.

---

## 5. Idempotency model

- **Per-subject NOOP:** `resolvePartyForRoleRowTx` checks for an existing ACTIVE
  claim; if present → NOOP (no new Party, no new claim, decision unchanged).
- **Per-(subject, signal) dedup:** `createClaimTx` returns NOOP for an identical
  active claim; raises `ConflictError` for the same signal with a different value
  (subject-level integrity).
- **Re-run = converge:** already-processed subjects → NOOP; only unprocessed rows
  produce writes. No duplicate Parties/claims; existing decisions untouched.
- **T2 is a one-time historical snapshot — not sync, not maintenance.** Backfill
  resolves the data **as it stands at run time**. If new signals arrive *after* an
  anchor/claim is written (e.g. a phone or taxId added later), handling them is
  **out of T2 scope** and belongs to **T3 Runtime Resolution**. Backfill therefore
  neither upgrades existing decisions nor reacts to later data changes — **not
  because an existing claim "wins", but because reacting to post-snapshot change is
  outside what T2 does.** Re-running backfill NOOPs already-resolved subjects; it
  only populates what was missing at snapshot time.

---

## 6. Safety model (proof)

| Guarantee | Why it holds |
|---|---|
| **Billing untouched** | service touches only `party` + `partyResolutionClaim` (T1-verified, grep-clean); backfill issues zero writes to BillingDocument/FinancialEvent |
| **Customer/Lead untouched** | backfill **reads** them; service never writes them (polymorphic `subjectId`, no FK, no partyId column) |
| **Tenant isolation** | every resolve call + candidate lookup is `businessId`-scoped; iteration is per-business; never crosses businessId |
| **No fuzzy / name merge** | `method = DETERMINISTIC_EXACT`; name is never a signal |
| **No priors** | only this business's local phone/taxId; no global/industry priors |
| **No Supplier/Vendor** | `subjectType ∈ {CUSTOMER, LEAD}` only |
| **No FinancialEvent re-anchor** | not referenced |
| **Additive** | only INSERTs into the two new tables; no UPDATE/DELETE on any existing table |

---

## 7. Verification plan

**Before (dry-run — zero persistence):**
- Run the backfill inside a transaction that is **rolled back**, collecting
  projected counts. (Dev only.) Reports, per business:
  - # Customers, # Leads · # with phone · # with taxId · # no-signal
  - projected # Parties · # signal claims · # anchor claims · # conflicts

**After (post-run, read-only assertions):**
- **Counts by business:** Parties created · signal claims · anchor claims ·
  conflicts (`source LIKE '%:SIGNAL_CONFLICT'`).
- **Totality / KL closure:** every Customer/Lead resolves via
  `lookupPartyForRoleRow` → non-null (KL-1/KL-2 hold on real data).
- **Tenant isolation:** no claim's `partyId` references a Party with a different
  `businessId`; no Party shared across businesses.
- **Billing/role-rows unchanged:** row counts + a content checksum of
  Customer/Lead/BillingDocument identical before & after.
- **Idempotency:** second run → all-NOOP, zero new Parties/claims.

**Data Health Checks (post-run, observational — a *picture* of the real data, not an error gate):**
- **Signals → multiple Parties:** count of distinct `signalValue` (per `signalType`)
  that map to **>1 active Party**. Exact-match expects ~0; any >0 flags pollution
  or a genuine data oddity worth a look.
- **Oversized Parties:** count of Parties with **> N active members** (suggested
  **N = 10**; the threshold is *reported*, not enforced).
- **Members-per-Party distribution:** histogram of active members per Party
  (e.g. buckets `1 · 2 · 3–5 · 6–10 · >10`).
- **Anomaly count (overall):** sum of {multi-party signals + oversized Parties +
  conflict anchors}.
- **Top outliers (manual review):** the top **K** (e.g. 20) Parties by member count,
  and the top signals mapping to the most Parties — listed for human inspection.

> **Purpose:** a post-run **picture of the real data** to surface unexpected or
> unusual patterns — *not* a correctness gate and *not* an assumption that any
> finding is an error. Findings inform **T3** (runtime resolution / future tuning),
> not T2 correctness.

---

## 8. Rollback / correction

- **Corrigible (preferred):** mark a wrong link `status = RETRACTED` (preserves
  history; the corrigibility the design is built on) rather than delete.
- **Identify backfill output:** by `source = "BACKFILL"` (and conflicts
  `"BACKFILL:SIGNAL_CONFLICT"`) → targeted audit/rollback.
- **Dev reset:** Party + PartyResolutionClaim are new additive tables → may be
  truncated/deleted to fully reset (FKs cascade; no existing table references them).
- **Production — do NOT:** never delete/truncate; never mutate role-rows; use
  RETRACTED + targeted re-resolution only. Production backfill is a separate,
  explicitly-approved ops gate.

---

## 9. Definition of Done (design ready to implement)

The design is implementation-ready when it specifies (it does):
1. Input set + per-subject signal mapping (§2).
2. Per-business, tenant-scoped, stable-order iteration calling the **existing**
   `resolvePartyForRoleRowTx` with `source: "BACKFILL"` (§3) — **no new logic**.
3. Idempotency delegated to the service; re-run converges (§5).
4. Conflict handling delegated to the service (fail-safe), with documented
   order-sensitivity and the anchor-upgrade deferred to T3 (§4).
5. Dry-run + post-run verification counts and safety assertions (§7).
6. Rollback via RETRACTED + dev-only reset; no destructive prod ops (§8).
7. All safety constraints proven (§6); zero scope beyond Phase 1 Reality.

**Implementation shape (next step, on approval):** a `party-backfill.service.ts`
runner (per-business iterate + dry-run mode) + verification queries. Gated behind
explicit approval **and** migrations applied in the target env. Still: no intake,
no Billing, no runtime wiring, no production run without separate sign-off.

---

## Appendix — what backfill reuses (already closed)

| Reused | From |
|---|---|
| `resolvePartyForRoleRowTx` (idempotent, taxId-first, conflict fail-safe) | T1 `679f71d` |
| `createAnchorClaimTx` (no-signal / conflict singleton anchor) | self-anchor `3bad602` |
| `extractStrongSignals` / `normalizeCustomerPhone` | T1 / existing |
| `lookupPartyForRoleRow` / `lookupRoleRowsForParty` (verification) | T1 |
| schema: Party, PartyResolutionClaim, nullable signal, SELF_ANCHOR | T1 + self-anchor migrations (unapplied) |
