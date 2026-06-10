# Dubiz Phase 1 / Stage-1A.4 — Dev Seed Plan for Party Backfill Test v1

> **PLAN ONLY.** No seed code, no SQL, no DB writes, no dry-run, no execute, no
> schema change, no Billing/intake/runtime. This designs a minimal, marked,
> **dev-only** seed that exercises the 6 resolution scenarios so the backfill can
> be validated on real-but-controlled data. Executing the seed is a **separate,
> explicitly-approved** write step (not authorized by this document).

## Context

Stage-1A.3 dry-run succeeded technically but the dev branch (`ep-square-grass`,
`neondb`) has **0 Customers / 0 Leads**, so a backfill there is a no-op and does
not validate Party Resolution. This seed fills that gap with representative data.

## Approved scope notes (confirmed)

- The seed does **not** need `BillingDocument`.
- The seed creates **only** `Business` / `Customer` / `Lead`.
- The seed must be **marked** with `__PARTY_SEED_…`.
- `Party` / `PartyResolutionClaim` are **not** created by the seed — only by the backfill.
- Cleanup is by **deleting the seed businesses only**, dev-only, after printing the IDs for approval.
- The post-seed dry-run stays **dry-run only** — no execute without separate approval.

## Revision — conflict scenario removed (schema-constraint correction)

> Original v1 included scenario #6 (a controlled phone-vs-taxId **conflict** via
> customers C5/C6/C7). On execution preflight this was found **infeasible** against
> the real schema:
>
> - `Customer` has `@@unique([businessId, phone])` → two customers in one business
>   cannot share a phone, so the conflict subject (C7, phone P6 = C5's phone) cannot
>   be inserted.
> - The backfill processes **Customers before Leads**, so a Lead cannot pre-create
>   the phone-party that the conflict subject would clash with; and only a Customer
>   carries both phone+taxId, so a Lead cannot be the conflict subject.
>
> **Therefore the conflict path is not reproducible with real seeded Customer/Lead
> rows.** It remains fully covered by unit tests (`party-resolution` /
> `party-backfill` fake-tx harness). **Decision: option 2** — drop the impossible
> C7, keep C5 (phone) and C6 (taxId) as independent customers. This seed exercises
> **only schema-legal scenarios** (#1–#5); the conflict (#6) is intentionally out of
> the seed and covered elsewhere.

---

## 1. Rows to create + tables

**2 dedicated businesses** (name marker), **7 Customers**, **4 Leads**. Tables touched:
`Business`, `Customer`, `Lead` only. `Party` / `PartyResolutionClaim` are created
**only** by the backfill, never by the seed.

**Businesses:**

| ref | name (marker) |
|---|---|
| BIZ_A | `__PARTY_SEED_A__` |
| BIZ_B | `__PARTY_SEED_B__` |

**Customers** (`name` required; `phone` canonical; `taxId` only where noted):

| ref | biz | name | phone | taxId | scenario |
|---|---|---|---|---|---|
| C1 | A | Seed Cust Phone | P1 | – | #1 (with L1) |
| C2 | A | Seed Cust Tax | – | T1 | #2 |
| C3 | A | Seed Tenant A | P5 | – | #5 (with C4) |
| C4 | B | Seed Tenant B | P5 | – | #5 |
| C5 | B | Seed Cust Phone B | P6 | – | independent (phone) |
| C6 | B | Seed Cust Tax B | – | T2 | independent (taxId KNOWN) |

> _(Original C7 — the phone+taxId conflict subject — removed; infeasible under
> `@@unique([businessId, phone])` + customers-before-leads ordering. See Revision note.)_

**Leads** (`customerName` → name; `phone`):

| ref | biz | customerName | phone | scenario |
|---|---|---|---|---|
| L1 | A | Seed Lead Phone | P1 | #1 (with C1) |
| L2 | A | Seed Lead NoSig | – | #3 |
| L3 | A | Same Name | P3 | #4 |
| L4 | A | Same Name | P4 | #4 |

**Signal values** (valid IL mobiles, distinct): `P1=0501111111`, `P3=0503333333`,
`P4=0504444444`, `P5=0505555555`, `P6=0506666666`. taxIds: `T1=514111111`,
`T2=514222222`.

**Implementation notes (for when the seed is built):**
- `Customer.phone` must be stored **canonical** (run through `normalizeCustomerPhone`);
  `Lead.phone` may be the same number (the service re-normalizes). For #1, the
  canonical form of C1 and L1 must be identical.
- **Ordering:** the backfill processes Customers by ascending `id`, then Leads.
  With the conflict scenario removed, exact id ordering is no longer load-bearing
  (all #1–#5 outcomes are order-independent for exact-match).

---

## 2. Scenario → expected resolution

1. **C1 + L1 same phone** → one Party via PHONE (BELIEVED). 2 subjects, 1 party.
2. **C2 taxId** → `TAX_ID` claim, confidence **KNOWN**, separate party.
3. **L2 no signal** → SINGLETON: party + `SELF_ANCHOR`, confidence **UNKNOWN**, signalType=null.
4. **L3/L4 same name, different phone** → name is not a signal → **two Parties** (no merge).
5. **C3(A)/C4(B) same phone P5** → resolution is businessId-scoped → **two Parties** (tenant isolation).
6. **CONFLICT — excluded from the seed (infeasible).** See the Revision note. C5
   (phone P6) and C6 (taxId T2) remain as **independent** BIZ_B customers → two
   separate parties (PHONE / TAX_ID·KNOWN); they do **not** conflict. The
   phone-vs-taxId conflict path stays covered by unit tests only.

---

## 3. Dev-only assurance (seed guard, fail-closed)

Before any write, the seed must assert **in code**:
- `current_database() = neondb` and host = `ep-square-grass…` (the verified dev
  branch), **not** `ep-flat-brook` / `ep-frosty-pine` (documented production).
- Current dev-branch signature: **3 users / 4 businesses / 56 BillingDocuments** —
  if it does not match, **stop** (possibly wrong target).
- `NODE_ENV !== "production"` and `VERCEL_ENV !== "production"`.
- Runs via `DATABASE_URL` (pooled runtime), not DIRECT_URL.

> The seed is a **DB write** and therefore requires a **separate approval** (like
> execute) — not covered by approving this document.

---

## 4. Marking the seed (for identification + deletion)

- **Primary mechanism:** two dedicated businesses with the prefix `__PARTY_SEED_`.
  All Customers/Leads (and the Parties/claims the backfill will later create) hang
  off these businesses only.
- **Secondary marker (optional):** `notes` / `sourceChannel = "__party_seed__"` on
  rows, for quick lookup.
- Benefit: no contact with the 4 existing businesses or existing data.

---

## 5. Cleanup / deletion in dev

- **Delete by deleting the two seed businesses** → automatic cascade: `Customer`,
  `Lead`, **and** `Party` + `PartyResolutionClaim` (all `onDelete: Cascade` from
  `Business`). Fully clean removal.
- **Safety:** delete **only** businesses where `name LIKE '__PARTY_SEED_%'`, after
  printing the list of IDs to be deleted for approval. Dev only.
- Conservative alternative (if businesses must be preserved): delete in order
  `PartyResolutionClaim` → `Party` → marked `Customer`/`Lead`. But deleting the
  dedicated businesses is simpler and safer.

---

## 6. Does the seed need BillingDocument?

**No.** The backfill reads **only** `Customer`{phone,taxId,name} and
`Lead`{phone,customerName}. No dependency on BillingDocument/FinancialEvent.
Creating no billing data also keeps the seed fully decoupled from Billing.

---

## 7. Running the dry-run after seed

Same as Stage-1A.3: `npx tsx scripts/party-backfill.ts` (default dry-run), with
**DATABASE_URL pooled** injected into the process only, **without** DIRECT_URL,
**without** `--mode execute`. Zero persistence (rollback).

---

## 8. Expected report after dry-run (with the seed)

| metric | expected |
|---|---|
| businesses processed | **6** (4 existing empty + 2 seed) |
| customers / leads read | **6 / 4** |
| projected parties | **9** |
| applied / noop / singleton / conflict | **9 / 0 / 1 / 0** |
| signal claims | **9** |
| anchor claims | **1** (L2 no-signal only) |
| conflicts | **0** |
| failed businesses / batches | **0 / 0** |
| health: multiPartySignals | **0** |
| health: oversized | **0** |
| health: conflictAnchors | **0** |
| health: anomalyCount | **0** |
| invariant violations | **none** |
| PERSISTENCE | **none (rollback)** |

---

## 9. Hard stop

**Stop** if any of these appear (beyond expectation):
- `multiPartySignals > 0` / any `invariant violation` → a signal → >1 party = bug or unexpected data.
- `failed businesses > 0` or `batches failed > 0`.
- the dry-run fails (connection/exception).
- material deviation from the expected signature (e.g. parties ≠ 10, conflict ≠ 1, anchors ≠ 2).

> With the conflict scenario excluded, the expected `conflict = 0` and
> `anomalyCount = 0`. **Any** `conflict > 0`, `anomalyCount > 0`, or
> `multiPartySignals > 0` is now **unexpected** → investigate / hard stop.

---

## 10. After a successful dry-run — execute?

If the report matches §8 exactly and there is no hard stop → execute **may be
considered** (writing 9 parties + 10 claims to the dev branch), followed by
post-run verification (`verifyBackfill`: totality / tenant / no-invariant) + an
idempotency rerun. **Execute requires separate approval** after the dry-run review.

---

## Boundaries

dev-only test data · does not touch Billing · not Production/staging · no runtime
wiring · does not replace a later backfill on real data — this is only a test fixture.
