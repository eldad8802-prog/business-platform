# POS Connectors Foundation (Planning)

## 1) How POS systems should integrate (safe pipeline)
**POS → NormalizedSaleEvent → Matching → PendingMatch / InventoryMovement**

- **Connector layer (POS)** ingests raw sales from an external source (webhooks, API, CSV exports).
- Connector outputs a **NormalizedSaleEvent** (contract) that is stable and provider-agnostic.
- A **matching layer** resolves each sale line to an internal `InventoryItem` (or leaves it unresolved).
- If all lines are resolvable with high confidence → create **InventoryMovement OUT** entries (reason: `SALE`).
- If any line is not resolvable (or violates guardrails) → create **PendingMatch** and do **not** change inventory until reviewed.

This mirrors the Supplier Purchases flow (drafts pending review → approved → movements), but tailored to sales/outbound events.

---

## 2) Likely POS sources to support
- **Shopify POS** (webhooks + APIs)
- **Square** (webhooks + APIs)
- **Israeli POS / accounting ecosystems** (varies by vendor):
  - iCount / חשבשבת / ריווחית (where relevant, typically exports/APIs)
  - other local POS providers via CSV exports / APIs
- **CSV exports** (daily sales exports, receipts exports)
- **Webhooks** (near-real-time transaction feed)
- **Pull APIs** (periodic sync / backfills)

---

## 3) Initial normalized contract (POS sale event)
**Idea: `NormalizedSaleEvent`**

Core fields (v1 draft):
- `externalSaleId` (required): provider transaction/receipt id
- `source` (required): provider identifier (e.g. `SHOPIFY`, `SQUARE`, `CSV`, `POS`)
- `soldAt` (optional): event time (string/Date)
- `businessId` (not inside event; carried by ingestion context)
- `currency` (optional)
- `locationId/locationName` (optional; future multi-location)
- `rawPayload` (required): original event payload for audit/debug
- `lines[]` (required):
  - `externalProductId` (optional)
  - `externalSku` (optional)
  - `barcode` (optional)
  - `name` (optional)
  - `quantity` (required, > 0)

Normalized contract is intentionally minimal: enough to match items and compute OUT movements.

---

## 3.1) POS sale ingest payloads (route compatibility)

### Payload v1 (current)
- `externalSaleId`
- `businessId`
- `source`
- `items[]`
  - item: `quantity`, `sku?`, `barcode?`, `name?`

### Payload v2 (recommended; backward compatible)
- `externalSaleId`
- `businessId`
- `source` / `provider`
- `soldAt`
- `rawPayload`
- `items[]`
  - item: `externalProductId`, `sku`, `barcode`, `name`, `quantity`, `unitPrice?`, `rawPayload?`

---

## 4.1) Future matching priority (POSProductMapping-first)
Recommended deterministic priority:
1. **`POSProductMapping`** lookup by `(businessId, source, externalProductId)`
2. **SKU** fallback
3. **Barcode** fallback
4. **Name/fuzzy** as suggestion only (never auto-apply)
5. **Unmatched** → `InventoryPendingMatch`

### Compatibility rule
- If `externalProductId` is missing, do **not** use the primary mapping path and continue with legacy matching (SKU → barcode → pending).

### Key risks
- Inconsistent `source/provider` values across ingests will break mapping lookups.
- Missing `externalProductId` prevents stable mapping; fallback matching may increase pending volume.
- Non-unique SKUs across providers/locations can cause wrong matches.
- Barcode conflicts (duplicates, reused barcodes) require guardrails.
- Pending duplicates before resolve: ensure idempotent behavior when the same sale is retried while already pending.

---

## 4) Matching strategy (prioritized)
Matching should be deterministic and conservative:
1. **Barcode match** (highest priority)
2. **External mapping table** (e.g. `POSProductMapping` by `(businessId, source, externalProductId)`)
3. **SKU match**
4. **Exact name match** (only when safe; beware collisions)
5. **Fuzzy suggestion only** (never auto-apply; used to propose a review decision)

Key principle: **never decrease inventory based on fuzzy-only matches**.

---

## 5) How PendingMatch fits
Use `InventoryPendingMatch` as the safety valve:
- **When to open pending**
  - Any line cannot be matched confidently
  - Suspicious quantity (guardrails)
  - Conflicting identifiers (barcode mismatch, multiple candidates)
  - Negative stock risk if applied automatically
- **Why no stock decrement without match**
  - Protects inventory integrity; a wrong match creates irreversible business damage.
- **Future learning**
  - Once a pending match is resolved, we can persist mapping (`POSProductMapping`) so subsequent events auto-match safely.

Existing behavior in code already follows this pattern: if any unmatched item exists, the sale is moved to pending and no movements are created.

---

## 6) Duplicate / idempotency strategy
Goals:
- Handle retries/replays safely (webhook retries, offline POS replay, backfills).

Proposed strategy:
- Primary idempotency key: `(businessId, source/provider, externalSaleId)`
- Store processed sales in a dedicated table (already exists: `InventoryExternalSale`)
- On ingest:
  - If a sale with the same key is already processed → return success + skipped.
  - If pending exists for same key → return success + pending reference (avoid duplicates).

---

## 7) Why POS must NOT update quantity directly
- POS data can be duplicated, delayed, or corrected after the fact (refunds/voids).
- Mapping from external products to internal items is uncertain without context.
- Direct quantity mutation bypasses:
  - audit trail
  - negative stock protection
  - idempotency
  - review workflows and safe learning

---

## 8) How POS events translate to InventoryMovement (OUT only)
- After matching and acceptance:
  - For each matched line, create movement: `movementType=OUT`, `reason=SALE`, `quantityDelta = -quantity`.
- The movement layer remains the **source of truth**, and inventory quantity is a derived running total.

---

## 9) Existing services/models to reuse (already in system)
Concrete assets already present:
- **`InventoryPendingMatch` model** (schema + service `lib/services/inventory/pending-match.service.ts`)
- **`InventoryExternalSale` model** for processed sale idempotency
- **`POSProductMapping` model** for stable provider→internal item mapping
- **`inventoryService.createMovement/removeStock`** for authoritative movements + negative stock protection
- **POS ingest route already exists**: `app/api/inventory/pos/sale/route.ts`  
  - Uses `InventoryExternalSale` for replay protection
  - Uses `createPendingMatch` when any item is unmatched
  - Uses `inventoryService.removeStock` only when everything matches

---

## Adapter notes (NormalizedSaleEvent → POS sale payload)
- Added an adapter from `NormalizedSaleEvent` to the existing payload shape of `POST /api/inventory/pos/sale`.
- The adapter is a **pure function** (no matching, no DB access, no movements, no pending creation).
- It **filters out** lines with invalid/non-positive `quantity`.
- It returns `{ valid: false, reason }` instead of throwing.
- Smoke validation was executed for the adapter and the temporary smoke script was removed afterwards.
- Intended future connection point:
  - `POS Connector → NormalizedSaleEvent → Adapter → POS Route`

---

## 10) Architectural risks / edge cases
Key risks to design for:
- **Duplicate sales**: webhook retries, provider replay, offline sync
- **Delayed sync**: sales arriving after stock counts or adjustments
- **Deleted/renamed products**: external ids may disappear; mapping must remain stable
- **Barcode conflicts**: same barcode used by multiple products; must be guarded
- **Offline POS replay**: burst ingestion and race conditions
- **Negative stock**: must be prevented or explicitly policy-gated
- **Race conditions**: concurrent ingests for same item/sale
- **Partial matches**: decide policy (all-or-pending vs partial apply)
- **Refunds/voids**: model as separate events (RETURN) rather than mutating the original sale
- **Unit inconsistencies**: sales usually in units; but weight-based items may appear

---

## Summary
POS connectors should follow the same principles as supplier connectors:
**raw → normalized → match/review → movements**, with strict idempotency and inventory safety as first-class requirements.

