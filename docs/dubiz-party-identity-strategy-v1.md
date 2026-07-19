# Dubiz Party Identity Strategy v1

**Status:** Ratified — binding architectural principle.
**Scope:** System-wide. Governs how every Dubiz domain identifies the counterparties it interacts with (suppliers, customers, vendors, obligees, and any future business party).
**Nature:** This document defines *principles and a decision rule*. It is not an implementation plan and it does not itself change schema or code.

---

## 0. Purpose

Multiple Dubiz domains independently record interactions with the same real-world business parties — a supplier appears as `supplierName` in Purchasing, as `vendorName` in Documents/OCR, and as `obligeeName` in Payments. Left ungoverned, each domain reinvents its own string-based identity, and no two domains agree on "who" a party is.

This document freezes **one** identity model and **one** promotion rule so that, years from now, no domain has to re-decide how it links records to a party, and no migration performed under this strategy ever has to be undone.

---

## 1. The Three-Tier Identity Model

Every reference from a domain record to a business party belongs to one or more of three tiers. The tiers are **layered**: each sits above the one below and never replaces it.

### Tier 1 — Historical Snapshot (Representation)
The raw party name (or identifier) captured **on the domain record itself**, frozen at the moment of the event.

- **Purpose:** preserve *what this record said about the party* — immutable, independent of any entity.
- **Examples in code:** `BillingDocument.customerNameSnapshot`, `PurchaseOrder.supplierName`, `Document.vendorName`, `BusinessObligation.obligeeName`, `InventoryItem.supplierName`.
- **Rule:** a historical snapshot, once written, is **never removed and never mutated**.

### Tier 2 — Entity-FK (Operational Relation)
A nullable foreign key from the domain record to the **operational CRM entity** (`Supplier`, `Customer`), kept **alongside** the Tier-1 snapshot.

- **Purpose:** allow a capability to retrieve, count, aggregate, or relate records **by the entity's stable identity**, correctly across renames and duplicates.
- **Example in code:** `BillingDocument.customerId → Customer` (with index `@@index([businessId, customerId])`), consumed by `lib/services/crm/customer-card.read-model.ts` (double-scoped by `businessId` AND `customerId`).
- **Rules:** the FK is **nullable**; deletion of the entity uses `onDelete: SetNull` (history survives); the Tier-1 snapshot is always retained beside it.

### Tier 3 — Party Resolution (Cross-Domain Canonical Identity)
The canonical `Party` (`prisma/schema.prisma model Party`) plus `PartyResolutionClaim`, which resolve **entities** (not raw records) to a single cross-domain party, evidence-based.

- **Purpose:** unify identity **across domains** — "this vendor in Documents = this supplier in Purchasing = this obligee in Payments."
- **Mechanism:** `PartyResolutionClaim(subjectType: PartyRoleType, subjectId → partyId)` with `signalType`/`signalValue`, `confidence` (`KNOWN`/`BELIEVED`/`SUSPECTED`/`UNKNOWN`), `method`, and `status`. It resolves **entities as subjects**, never domain records directly.
- **Rule:** Party sits **above** the CRM entities. It references them; it does not replace them, and domains do not link to it directly.

---

## 2. The Promotion Rule (Tier 1 → Tier 2) — Binding

> **A domain record is promoted to Entity-FK (Tier 2) the moment a capability is built that retrieves, counts, aggregates, or relates that record by the entity's stable identity over time** — i.e., any read path that answers *"all / latest / count / sum of these records for THIS entity"* and must remain correct across the entity's renames and duplicates.

**The trigger is the entity-keyed read requirement — not the mere presence or importance of the entity.** Until such a read exists, Tier-1 Snapshot alone is correct and an Entity-FK is premature.

**Simple test:** does a read path exist whose `WHERE` / `GROUP BY` is the **entity's id**? If yes → Tier 2. If the record is only ever read in its own standalone context → Tier 1.

A snapshot string can never serve as that key: it is mutable, non-unique, and typo-prone. A stable, rename-proof, collision-free join key requires the FK.

---

## 3. The Two Independent Axes

Tier 1 and Tier 2 are decided by **two different questions** and are therefore **orthogonal**. A record may be Tier-1-only, Tier-2-only, both, or neither.

| Axis | Question | Drives |
|---|---|---|
| **Snapshot (Tier 1)** | Is the record a **standalone artifact** whose historical/legal meaning must survive the entity being renamed or deleted? | Whether to store a Tier-1 name snapshot |
| **Entity-FK (Tier 2)** | Is there an **entity-centric capability** that queries the record by the entity's stable key? | Whether to add a Tier-2 FK |

This explains the two asymmetric cases:
- `BillingDocument` is a standalone legal artifact **and** aggregated by customer → **Tier 1 + Tier 2**.
- `CrmNote` / `CrmAttachment` are meaningless outside their subject entity **and** aggregated by that subject → **Tier 2 only** (a polymorphic `subjectId` key, and correctly **no** name snapshot).

---

## 4. The Tier 2 / Tier 3 Boundary — Binding

> **Entity-FK (Tier 2) is only for within-domain aggregation against the CRM entity** (`Supplier` / `Customer`). **Cross-domain / cross-representation identity** — "this vendor-string = this supplier = this obligee" — is **never** solved by adding a foreign key between domains. That is **Tier 3 (Party resolution)**.

This boundary prevents domains from adding FKs to each other, or to `Party`, for identity purposes.

---

## 5. The Mandatory Resolution Direction

Identity flows in **one direction only**:

```
Raw representation  →  Entity-FK  →  Party
   (Tier 1)             (Tier 2)      (Tier 3)
```

- A raw string may be captured with no entity known (Tier 1 alone).
- When an entity-centric read requires it, the record links to the CRM entity (Tier 2).
- Cross-domain unification resolves **entities** to a canonical `Party` (Tier 3).

Skipping or reversing tiers is prohibited (see §6).

---

## 6. Prohibitions — Binding

1. **No domain record links directly to `Party`.** Records link (at most) to the CRM entity; only entities are resolved to `Party`.
2. **A historical Snapshot is never removed or mutated.**
3. **String matching is never the basis for reliable aggregation.** Grouping records by a raw name (e.g., the way `reorder-suggestions` groups drafts by `supplierName`) is advisory only, never an authoritative rollup.
4. **No foreign key is added between domains for identity resolution.** Cross-representation identity is Tier 3's job.
5. **No Entity-FK is added before a real entity-centric read path exists.** Premature FKs are forbidden — Tier 1 is correct until the read exists.

---

## 7. Verified Examples (Evidence)

Classification of every party-facing surface currently in the system. All verified against `prisma/schema.prisma` and the cited services on `origin/main`.

| Surface | Standalone artifact? (→ T1) | Entity-keyed capability? (→ T2) | Current tier | Consistent |
|---|---|---|---|---|
| **BillingDocument** | Yes (invoice; legal) | Yes — customer card aggregates by `customerId` (`customer-card.read-model.ts`) | **T1 + T2** (`customerId` + `customerNameSnapshot` + `issuedSnapshot`) | ✅ |
| **PurchaseOrder** | Yes (order; preserves supplier-at-time) | Yes — supplier-card purchase history (**S4**) | **T1 today → T1 + T2 via S4** | ✅ (the rule predicts S4) |
| **Document / OCR** | Yes (financial-truth doc; `vendorName` / `vendorBelief` / `vendorFinal` preserved) | No — no "documents by supplier entity" capability; OCR is representation, resolution is downstream | **T1** (OCR is permanently T1) | ✅ (no premature FK) |
| **BusinessObligation** | Yes (payable; `obligeeName` preserved) | No — no "payables by supplier entity" capability | **T1** | ✅ |
| **InventoryItem** | Partial (carries a default `supplierName`) | No — the order-wizard picker is *representation*, not entity aggregation | **T1** | ✅ |
| **CrmNote** | No (born inside the subject; meaningless standalone) | Yes — notes centralized around a subject over time | **T2 only** (polymorphic `subjectId`, no snapshot) | ✅ |
| **CrmAttachment** | No (born inside the subject) | Yes — files centralized around a subject over time | **T2 only** (polymorphic `subjectId`, no snapshot) | ✅ |
| **PartyResolutionClaim** | — (it *is* Tier 3) | Resolves entities → `Party` (`subjectType` = `PartyRoleType`, currently `{CUSTOMER, LEAD}`) | **Tier 3** | ✅ |

**Note on `VendorLearning`.** It groups extraction learning by `vendorNameNormalized` over time, which *looks* entity-centric — but its "entity" is the vendor **as it appears on documents**, not a managed `Supplier`. Its correct promotion is therefore via **Tier 3 (Party resolution)** — resolving the representation to a canonical party — **not** a direct `Supplier` FK. Its normalized key is a domain-local Tier-1.5 placeholder pending Party resolution (already documented as "Gap 2, deferred" in `docs/documents-learning-mechanism-architecture-v1.md §5`). This is consistent with §4, not a violation of it.

**No contradictions:** the rule + the two axes explain all eight party-facing surfaces, including the two asymmetric cases.

---

## 8. The S4 Decision (Purchase History)

Under this strategy, S4 is the **first correct instance** of a Tier-1 → Tier-2 promotion:

- **`PurchaseOrder.supplierId → Supplier`** — a nullable Entity-FK (Tier 2), `onDelete: SetNull`, index `@@index([businessId, supplierId])`.
- **`supplierName` remains the Tier-1 Snapshot** — never removed.
- **Party will later sit above `Supplier`, not in place of it** — when `SUPPLIER` is added to `PartyRoleType`, the `Supplier` **entity** is resolved to a `Party`, without touching `PurchaseOrder.supplierId`. The resolution chain is `PurchaseOrder → Supplier → Party`.

This mirrors `BillingDocument.customerId → Customer` exactly, is additive / nullable / expand-only, and creates no technical debt. It will not need to be undone or re-migrated.

---

## 9. Future Phases (NOT part of S4)

The following are explicitly out of scope for S4 and are governed by — but not implemented by — this strategy. Each, when built, follows the same tiers and the Promotion Rule:

- Adding `SUPPLIER` to `PartyRoleType`.
- `Document.supplierId` (Documents → Supplier, once a documents-by-supplier capability exists).
- `BusinessObligation.supplierId` (Payables → Supplier, once a payables-by-supplier capability exists).
- `InventoryItem.supplierId` (Inventory ↔ Supplier / picker unification).
- `VendorLearning` resolution (via Party, per §7).
- Aligning `CrmSubjectType` (`{CUSTOMER, SUPPLIER}`) with `PartyRoleType` (`{CUSTOMER, LEAD}`).

None of these are required now. They are additions, never corrections of the S4 migration.

---

## 10. Governance

- This document is the **single source of truth** for party identity across Dubiz.
- Any new domain that records an interaction with a business party **must** capture a Tier-1 snapshot, and **must** apply the Promotion Rule before adding an Entity-FK.
- Any change to the tiers, the Promotion Rule, the Tier-2/Tier-3 boundary, or the resolution direction must be made **in this document first**, before any code or schema change.
