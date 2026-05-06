# Supplier Connectors v1 — Status

## What we built
- A minimal “Supplier Connectors” foundation layer with a v1 contract, a connector interface, and a simple in-memory registry.
- Two connector skeletons (CSV, Google Sheets) that return a valid `SupplierConnectorResult` with `orders: []` and **no external side effects**.

## Existing files
### Foundation
- `lib/services/supplier-connectors/types.ts`
- `lib/services/supplier-connectors/connector.interface.ts`
- `lib/services/supplier-connectors/connector-registry.ts`
- `lib/services/supplier-connectors/supplier-order-to-draft.adapter.ts`

### Connectors (skeletons)
- `lib/services/supplier-connectors/csv/csv-supplier.connector.ts`
- `lib/services/supplier-connectors/google-sheets/google-sheets.connector.ts`

## Central contract
- **Connector identity**: `SupplierConnectorType`
- **Normalized data model**: `NormalizedSupplierOrder`, `NormalizedSupplierOrderLine`
- **Connector output**: `SupplierConnectorResult` (includes `success`, `connectorType`, `orders`, optional `errors/meta`)
- **Connector behavior**: `SupplierConnector.fetchOrders(context)` returns `SupplierConnectorResult`

## What must not change right now
- No new packages, no auth/OAuth, no Google APIs, no filesystem access, no network requests.
- No DB usage, no routes, no UI wiring, no scheduler/polling, no inventory/supplier-purchases integration.
- No contract refactors unless a real compile error forces it.

## Recommended next step
- Add a minimal “source input” shape to the connector context (e.g. a CSV raw string or a Google Sheet id) **without** performing I/O.
- Add deterministic mapping from a provided input payload to `NormalizedSupplierOrder[]` (still no DB / no routes).
- Introduce a dedicated route that calls a connector, passes results through the adapter, and only then calls `createSupplierPurchaseDraft()` to create pending drafts.

## Deferred (future work)
- Real CSV parsing (format validation, column mapping, encoding edge-cases).
- Google Sheets API integration + OAuth + permissions + network layer.
- Deduplication strategy (externalOrderId/source), idempotency, and ingestion into supplier purchase drafts.
- Observability (structured errors, telemetry) and admin tooling.

## Adapter notes
- Added an adapter from `NormalizedSupplierOrder` → `CreateSupplierPurchaseDraftInput` as a **pure function** (no DB access).
- The adapter **filters out** lines with invalid/non-positive `quantity` and returns `{ valid: false, reason }` when no valid lines remain.
- Smoke validation was executed for the adapter and the temporary smoke script was removed afterwards.

## CSV Supplier Import Route (planned; no runtime yet)

### 1) Proposed route
- `POST /api/inventory/supplier-purchases/import/csv`

### 2) End-to-end flow
CSV Upload  
→ CSV Parser  
→ `NormalizedSupplierOrder[]`  
→ Adapter (`NormalizedSupplierOrder` → `CreateSupplierPurchaseDraftInput`)  
→ `createSupplierPurchaseDraft()`  
→ Drafts appear under **Pending Review**

### 3) What the route should accept
- `multipart/form-data`
- `file` (CSV file; required)
- `source` / `provider` (optional; default should be a safe constant like `CSV`)

### 4) What the route should return
- `draftsCreated`: number + minimal identifiers (draft id, externalOrderId, supplierName)
- `skippedOrders`: list of orders skipped due to duplicates/idempotency
- `invalidOrders`: list of orders rejected (with reasons)
- `warnings`: non-blocking warnings (e.g. missing supplierName fallback, unknown unitType mapping)
- `previewSummary`: basic counts (orders parsed, valid orders, valid lines, invalid rows)

### 5) Validation rules (v1)
- File is required
- CSV must not be empty (empty → 400 or success with `draftsCreated=0`, but no crash)
- Each order must contain **at least one** valid line
- `quantity > 0` for valid lines; invalid rows/lines are skipped safely
- If an order ends up with zero valid lines → classify as `invalidOrders` (no throw)

### 6) Duplicate / idempotency strategy (v1)
- Primary duplicate key (proposal): `(externalOrderId, supplierName)` when `externalOrderId` exists
- If `externalOrderId` is missing: fall back to a deterministic fingerprint (e.g. supplierName + orderDate + normalized line signatures) **in the future**
- Rule: do not create a new draft if an equivalent draft already exists for the business
- Future: store a dedicated idempotency record keyed by `(businessId, source, externalOrderId)` once available

### 7) UX considerations (future UI)
- Entry point: “העלאת CSV”
- Feedback: “נמצאו X הזמנות”
- Highlight review: “Y שורות דורשות בדיקה”
- Review-first: drafts are created as `PENDING_REVIEW`
- No auto-intake / no automatic inventory updates

### 8) Security considerations
- File size limit (server-side; reject overly large uploads early)
- CSV injection awareness (treat cells as data; escape when exporting/previewing)
- Temp file cleanup if any disk usage is introduced (prefer in-memory where feasible)
- No direct DB writes outside existing services (route orchestrates; service validates/persists)

### 9) Risks / edge cases
- Malformed CSV (broken quotes/columns)
- Duplicated orders across repeated uploads
- Missing `supplierName` (use safe fallback like `Unknown Supplier`)
- Mixed unit types / unknown unit types
- Partial invalid rows (must degrade gracefully)

### 10) Why the route must not create `InventoryMovement` directly
- Stock changes must remain gated by review/approval to prevent wrong matches and irreversible inventory corruption.
- `InventoryMovement` stays the source of truth; import should only create drafts pending review.

### CSV Import Dedupe Policy v1
1. **No schema migrations in v1** (no DB unique constraints yet).
2. The future import route performs **soft dedupe** before creating drafts.
3. If an order has `externalOrderId`, check for an existing draft by:
   - `businessId`
   - `source`
   - `externalOrderId`
4. If an existing draft is found, **do not create a new one**; return it under `skippedOrders`.
5. If `externalOrderId` is missing, do **not** attempt strong dedupe; return a `warning` instead.
6. Do **not** dedupe by `supplierName` alone (supplier names are not always stable/consistent).
7. Future (post-stabilization): consider a DB-level unique constraint to prevent race conditions.

## Known Behavioral Gaps / Deferred Decisions

These behaviors are **known** and **intentionally deferred**. They should not be “fixed” ad hoc without an explicit product/architecture decision.

### 1) `CREATE_NEW` approval path vs movement reason

- Today, approving a supplier draft line via **`CREATE_NEW`** creates an inventory movement with **`InventoryMovementReason.INITIAL_STOCK`**, not **`SUPPLIER_PURCHASE`**.
- This follows the **existing** approval/inventory flow (new item creation seeds stock as initial stock).
- Changing this would be a **business and architectural** decision: movement history semantics (initial intake vs supplier receipt), reporting, and audits all depend on `reason`.
- Any future alignment (e.g. recording supplier receipt as `SUPPLIER_PURCHASE` for new items) needs a deliberate design, not a silent tweak.

### 2) Re-import after `APPROVED`

- **Soft dedupe v1** only considers drafts in **`PENDING_REVIEW`** when matching `(businessId, source, externalOrderId)`.
- A **repeat import after** the prior draft was **`APPROVED`** can still create a **new** pending draft with the **same** `externalOrderId`.
- This is **intentional** for now: it avoids blocking legitimate **re-upload / correction** flows where the business expects another pending review cycle.
- **Future decision** (pick one direction explicitly):
  - Extend dedupe to also treat **`APPROVED`** (or other statuses) as blocking duplicates, **or**
  - Introduce **reopen / import versioning** so repeat uploads are explicit and traceable instead of ambiguous duplicates.

### 3) Process note

- Do **not** resolve the gaps above **ad hoc** without a **documented product decision** (scope, reporting impact, and operator expectations).

