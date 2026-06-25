# Dubiz — Supplier Ordering Ontology · Ratification (v1)

**Status:** RATIFIED — Supplier Ordering Ontology = **CLOSED WITH MINOR GAPS** (2026-06-25)
**Builds on:** `docs/dubiz-supplier-domain-constitution-v1.md` (v1.2, LOCKED)
**Nature:** Domain-level ratification record. No implementation, no API, no UI, no migration.

This document records the outcome of the Supplier Ordering Experience Discovery and
Ratification Audit. It does not reopen any closed area. It is evidence-based: every
conclusion was classified PROVEN / INFERRED / NOT PROVEN against the live domain
model, and every ratified conclusion rests on PROVEN code evidence.

---

## The single coherent ordering chain (PROVEN in the live model)

```
Offer → SupplierProduct → InventoryItem → Draft → PurchaseOrder
```

**The commitment boundary begins at InventoryItem.** Catalog does not participate in
commitment authority. Two convergence functions carry every ordering channel:

- `createSupplierPurchaseDraft` — intake / Purchase-Intent staging
- `createPurchaseOrder` — commitment

---

## Ratified Conclusions (8/8 RATIFIED)

1. **Ordering Ontology already exists** — expressed by the live domain model; not to be invented.
2. **Purchasing is Inventory-Centric** — commitment targets `InventoryItem`; the supplier is a sourcing channel (PO carries `supplierName` string, no `supplierId` FK), not the commitment target.
3. **Catalog Ordering is not a new purchasing model** — any future Catalog Selection flow must converge into the existing Draft → Purchase Order lifecycle; no parallel purchasing model.
4. **Catalog remains advisory** — may inform / suggest / recommend / display; may never become commitment authority (zero write-path, zero FK into PO / Draft / Inventory).
5. **SupplierProduct remains resolution infrastructure** — identity learning + mapping + Measure resolution; never the commitment target (absent from `PurchaseOrderLine`; present only as a Draft forward-link).
6. **Offers are not commitment identities** — Offers represent supplier reality; InventoryItems represent business commitment.
7. **Marketplace drift is already structurally prevented** — passes the "remove all supplier connections tomorrow" test: Draft creation, Purchase Orders, Receiving, and Inventory keep functioning.
8. **Missing capability = Catalog Selection bridge** — not a new purchasing engine; only `Catalog Selection → SupplierPurchaseDraft`, preserving all existing invariants.

---

## Final Architectural Interpretation

Dubiz is **not** becoming a supplier marketplace. Dubiz remains an inventory-centric
business operating system. Supplier information, Catalog information, and Supplier
connections are all **optional**. The purchasing engine remains authoritative even
when supplier-facing capabilities disappear.

---

## Remaining Minor Gap (the only unproven ontology point)

When Catalog Selection eventually exists and a selected Offer references a
`SupplierProduct` that does **not** yet have a `RepresentationMapping`, the exact
resolution path before commitment is **INFERRED, not PROVEN** — only because no code
exercises the catalog→draft path.

This is an **unexercised binding point, not a missing primitive**. The existing
domain already contains everything needed to resolve it: `RepresentationMapping`
(when mapped), or Draft free-text intake + `SupplierLineStatus.NEEDS_REVIEW` +
the approval `MERGE` / `CREATE_NEW` gate + `learnRepresentationMappingTx` (when
unmapped). No new ontology construct is necessary.

---

## Locked boundaries (binding for all future Supplier Commerce work)

Treat the following as locked unless contradictory **code** evidence is discovered:

- **Commitment target = InventoryItem**
- **Catalog = advisory reality** (informs, never authors)
- **SupplierProduct = resolution layer**
- **Offer ≠ commitment identity**
- **Draft → Purchase Order remains the only purchasing lifecycle** (other channels are intake paths converging on `createSupplierPurchaseDraft`)
- **Marketplace-drift protections remain mandatory** — catalog ordering must snapshot-in (copy values into a Draft/PO line), never link-as-authority to a live claim; freshness stays advisory pre-decision, never an order gate; no FK from PurchaseOrder to Catalog.
