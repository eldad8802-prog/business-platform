# External Business Events — Architecture (Draft)

## Goals
- Provide a single, consistent ingestion model for external integrations (suppliers, POS, logistics, spreadsheets, etc.).
- Keep **InventoryMovement** as the system-of-record while allowing external signals to be ingested safely (often requiring review).
- Make ingestion **idempotent**, **auditable**, and **reviewable** without letting integrations “directly mutate quantities”.

---

## 1) Event types (future)
Core candidates (expandable):
- **SUPPLIER_PURCHASE**: inbound stock from suppliers (delivery/invoice/order intake).
- **POS_SALE**: outbound stock from point-of-sale transactions.
- **RETURN**: customer returns (inbound stock; may require restock decision).
- **STOCK_COUNT**: physical inventory counts / cycle counts.
- **TRANSFER**: stock moved between locations/warehouses (outbound + inbound paired events).
- **ADJUSTMENT**: manual correction or external reconciliation (rare, guarded).
- **WASTE / SHRINKAGE**: damaged goods, spoilage, theft.

---

## 2) Per-event guidance

### SUPPLIER_PURCHASE
- **Source examples**
  - CSV orders, supplier portals, emailed invoices, Google Sheets order forms, EDI feeds.
- **Normalized contract idea**
  - `externalEventId`, `source`, `occurredAt/orderDate`, `supplierName`, `lines[]` with identifiers (`sku`, `barcode`, free-text `rawName`), and `quantity + unitType`.
- **Creates InventoryMovement?**
  - **Yes**, but only after a review step resolves matching/creation of items.
- **Requires review?**
  - **Usually yes** (matching is non-trivial, new items may be created, unit conversions may be needed).
- **Duplicate/idempotency strategy**
  - Deduplicate by `(source, externalEventId)` when provided; otherwise by a stable derived fingerprint (e.g. supplier + date + totals + line fingerprints).
- **Pending strategy (mismatch)**
  - Create a **pending draft** with lines in `NEEDS_REVIEW` when items cannot be confidently matched.

### POS_SALE
- **Source examples**
  - POS webhooks, daily exports, receipt imports, terminal integrations.
- **Normalized contract idea**
  - `externalEventId`, `source`, `occurredAt`, `receiptId`, `lines[]` with `sku/barcode`, quantity, price optional.
- **Creates InventoryMovement?**
  - **Yes** when mapping is confident (e.g. barcode → item).
- **Requires review?**
  - **Sometimes**: unknown product codes, ambiguous mappings, negative inventory protection.
- **Duplicate/idempotency strategy**
  - Deduplicate by `(source, receiptId)` or transaction id; enforce hard idempotency at the movement layer.
- **Pending strategy (mismatch)**
  - Pending review queue for unknown items; optionally allow partial acceptance (apply matched lines, queue the rest) depending on business policy.

### RETURN
- **Source examples**
  - POS return transactions, refund events, manual return forms.
- **Normalized contract idea**
  - `externalEventId`, `source`, `occurredAt`, reference to original sale if available, lines with item identifiers.
- **Creates InventoryMovement?**
  - **Yes**, but can depend on “restockable” decision.
- **Requires review?**
  - **Often** (restock vs waste; identifying exact item; condition).
- **Duplicate/idempotency strategy**
  - Deduplicate by return transaction id; link to original sale where possible.
- **Pending strategy (mismatch)**
  - Queue for manual decision (restock/waste) and mapping.

### STOCK_COUNT
- **Source examples**
  - Mobile count apps, spreadsheets, warehouse scans, periodic cycle counts.
- **Normalized contract idea**
  - `externalEventId`, `source`, `occurredAt`, count session id, lines with item identifiers and **countedQuantity**.
- **Creates InventoryMovement?**
  - **Yes**, typically as adjustment movements derived from `countedQuantity - currentQuantity`.
- **Requires review?**
  - **Usually yes** for large deltas, unknown identifiers, or partial counts.
- **Duplicate/idempotency strategy**
  - Deduplicate by count session id; only apply once per session.
- **Pending strategy (mismatch)**
  - Pending discrepancies / unknown products / suspicious deltas.

### TRANSFER
- **Source examples**
  - Logistics systems, warehouse transfers, multi-branch operations.
- **Normalized contract idea**
  - `externalEventId`, `source`, `occurredAt`, fromLocation/toLocation, lines with item identifiers and quantity.
- **Creates InventoryMovement?**
  - **Yes**, as paired movements (decrement in origin + increment in destination).
- **Requires review?**
  - **Sometimes**: mapping/location configuration or partial receipts.
- **Duplicate/idempotency strategy**
  - Deduplicate by transfer id; ensure both legs are idempotent.
- **Pending strategy (mismatch)**
  - “In transit” pending state until receipt is confirmed; mismatched counts flagged.

### ADJUSTMENT / WASTE / SHRINKAGE (optional set)
- **Source examples**
  - Manual corrections, spoilage logs, audits.
- **Normalized contract idea**
  - `externalEventId`, `source`, `occurredAt`, reason code, lines with item identifiers and delta.
- **Creates InventoryMovement?**
  - **Yes**, but guarded (roles, thresholds).
- **Requires review?**
  - **Often** for risky deltas.
- **Duplicate/idempotency strategy**
  - Deduplicate by event id or signed document id.
- **Pending strategy (mismatch)**
  - Pending approval workflow.

---

## 3) Why integrations must NOT update quantity directly
- External sources are **not authoritative**: they can be delayed, duplicated, partially missing, or inconsistent.
- Mapping external product identifiers to internal items is **lossy and ambiguous** without business context.
- Direct quantity writes bypass:
  - validation (negative inventory prevention),
  - matching heuristics,
  - auditability and traceability,
  - idempotency guarantees,
  - review workflows for edge cases.

---

## 4) Why InventoryMovement stays the source of truth
- It provides an **append-only audit trail** of why quantity changed (reason, actor, timestamp, source).
- It allows safe recalculation/debugging (“how did we get here?”).
- It supports idempotency: external events map to movements; repeated events do not create double-effects.
- It enables future analytics and intelligence without rewriting domain logic.

---

## 5) How Supplier Connectors and POS Connectors fit the same architecture
- Both produce **raw external events** (CSV rows, webhook payloads, exports).
- Both map into a **normalized event contract** (shared shape, different event type).
- Both may require a **review step** to resolve:
  - unknown items,
  - mismatched identifiers,
  - unit conversions,
  - suspicious deltas.
- Only after review/approval do they produce **InventoryMovement** changes.

---

## 6) Terminology: raw vs normalized vs reviewed vs movement
- **Raw external event**
  - The original payload (CSV record, POS webhook JSON, spreadsheet row).
  - Stored/attached for audit/debug.
- **Normalized event**
  - A canonical internal representation suitable for validation, matching, and routing.
  - Stable across sources.
- **Reviewed event**
  - A normalized event enriched with human decisions (mapping to internal item ids, create-new decisions, restock decisions, etc.).
- **Inventory movement**
  - The final authoritative quantity deltas applied to inventory.
  - Must be idempotent, auditable, and reason-coded.

---

## 7) How this enables future intelligence without breaking runtime
- Intelligence can operate on **normalized + reviewed** layers:
  - better matching, confidence scoring, anomaly detection,
  - supplier/purchase recommendations,
  - reconciliation dashboards.
- Core runtime remains stable because:
  - ingestion is additive (events → normalized → review → movements),
  - movements remain the single point where quantity changes,
  - integrations can evolve without rewriting inventory invariants.

