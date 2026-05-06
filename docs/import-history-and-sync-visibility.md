# Import History & Sync Visibility — Planning

This document defines how a business owner will see **what happened** during imports/syncs (successes, failures, skips, warnings, retries) from **one clear place**. This is **planning only**: no schema, routes, jobs, or UI are created here.

Related: `docs/inventory-integrations-hub.md`, `docs/supplier-connectors-v1-status.md`, `docs/pos-connectors-foundation.md`.

---

## 1. Why Import History matters

- **Auditability**: answer “who imported/synced what, when, and from where?” reliably.
- **Support & debugging**: correlate user reports with concrete runs, errors, and payload summaries.
- **User trust**: make partial success and skipped behavior visible (no “silent nothing happened”).
- **Retry visibility**: users need to know what will be retried automatically, what needs action, and what is permanently failed.

---

## 2. Flows that must be represented

### Supplier / inbound
- **CSV imports** (manual uploads → drafts)
- **Google Sheets syncs** (future polling + OAuth)
- **Supplier API syncs** (future pull APIs / EDI‑lite)
- **Email ingestion** (future attachments/forwards → extraction → drafts)

### POS / outbound
- **POS events** ingest (webhooks + backfills)
- **Webhook failures** (signature failures, 4xx/5xx, payload validation)
- **Retry jobs** (replays, backfills, and remediation)

The key principle: the history is about **sync/import runs and their outcomes**, not about inventory ledger entries.

---

## 3. Status model (v1)

Recommended normalized statuses for any run:

- **SUCCESS**: completed; created/updated expected entities; no blocking issues.
- **PARTIAL_SUCCESS**: completed, but with non‑empty `warnings`, `invalid`, or partial skips (some work done, some rejected).
- **FAILED**: run did not complete or created no outcomes due to errors.
- **SKIPPED**: nothing new was created because everything matched idempotency/duplicates (still a meaningful run).
- **RETRYING**: a failed run is scheduled/in progress for retry.
- **NEEDS_ATTENTION**: requires operator action (auth expired, mapping backlog, repeated failures threshold).

Notes:
- A single UI surface can show a “headline” status, while details show mixed outcomes (created/skipped/invalid).

---

## 4. What data we should persist (future)

Minimum recommended fields to store per run (CSV import or sync job):

- **Identity**
  - `businessId`
  - `source` / `provider` (CSV / GOOGLE_SHEETS / SHOPIFY / SQUARE / EMAIL / API / WEBHOOK)
  - `integrationId` (future, if integrations become first‑class records)
  - `runId` (server generated)

- **Timing**
  - `startedAt`
  - `completedAt`
  - `durationMs` (computed)

- **Actor**
  - `importedByUserId` (for manual runs)
  - `trigger` (MANUAL / SCHEDULED / WEBHOOK / BACKFILL)

- **Counts**
  - `ordersParsed`
  - `draftsCreated`
  - `skippedOrders`
  - `invalidOrders`
  - `warningsCount`

- **Outcome summary**
  - `status` (from §3)
  - `errorSummary` (safe, short string)
  - `errorCode` (internal)

- **Linkage**
  - `createdDraftIds[]` (optional; capped list)
  - `skippedDraftIds[]` (optional; capped list)

Privacy/size constraints:
- Do **not** store full raw payloads by default; prefer hashed pointers + explicit debug mode / retention policy.

---

## 5. UX ideas (single surface)

### 5.1 “Import History” page/section
For each run:
- Provider tile: icon + provider name
- **Status badge** (from §3)
- **“Last import” / “Last sync”** timestamp
- Primary rollup: `draftsCreated`, `skipped`, `invalid`, `warnings`
- Expandable details:
  - Warning lines
  - Sample invalid rows (capped)
  - “View created drafts” deep link (Pending filtered)

### 5.2 Quick actions
- **Retry** button (only when safe/idempotent)
- **Test connection** (for integrations)
- **Reconnect** (OAuth expired / token invalid)
- “Go to Pending review” CTA when drafts exist (created or already pending due to skip)

---

## 6. Sync health concepts (integration‑level)

For each integration card (Hub):
- **lastSuccessfulSyncAt**
- **lastAttemptAt**
- **consecutiveFailures**
- **stale** indicator (no successful sync within SLA window)
- **disconnected** vs “connected but failing”

Guiding UX:
- Keep the Hub actionable: **Needs attention** must come with a next step (Reconnect / Retry / Review mappings).

---

## 7. Architecture: why this is not `InventoryMovement`

- `InventoryMovement` is the **ledger** after matching/approval guardrails.
- Imports/syncs are **operational telemetry**: attempts, partial parsing, retries, auth failures.
- Mixing them would pollute the movement history and create false business semantics (“movement happened” vs “sync attempted”).

Separation of concerns:
- **Sync/Import events**: operational layer (runs, attempts, errors).
- **Business movements**: inventory truth (IN/OUT with reasons) only after approval logic.

---

## 8. Edge cases & failure modes

- **Partial imports**: some orders valid, some invalid; ensure UI doesn’t claim “all imported”.
- **Duplicate retries**: double‑click retry + automatic retry → must rely on idempotency keys (supplier `externalOrderId`, POS `externalSaleId`).
- **Webhook storms**: burst traffic; rate limiting + backpressure; collapse duplicate deliveries.
- **Very large imports**: timeouts; progress reporting; chunking; background job conversion.
- **Provider downtime**: classify as `RETRYING` then `NEEDS_ATTENTION` after threshold.
- **Auth expired**: move to `NEEDS_ATTENTION` with reconnect CTA; don’t keep retrying indefinitely.

---

## Future Schema Proposal

This section is a **proposal only**. Do not implement without a product decision and a migration plan.

### Proposed enums

#### `IntegrationRunStatus`
- `SUCCESS`
- `PARTIAL_SUCCESS`
- `FAILED`
- `SKIPPED`
- `RETRYING`
- `NEEDS_ATTENTION`

#### `IntegrationSourceType`
- `SUPPLIER`
- `POS`
- `EMAIL`
- `DOCUMENT`
- `ACCOUNTING`

### Model 1: `IntegrationRun`

**Purpose**: represent a single import/sync run (CSV upload, scheduled sync, webhook batch, backfill, etc.).

**Proposed fields**
- `id`
- `businessId`
- `sourceType` (enum: `IntegrationSourceType`)
- `provider` (string; e.g. `CSV`, `GOOGLE_SHEETS`, `SHOPIFY`, `SQUARE`, `GMAIL`)
- `triggerType` (string; e.g. `MANUAL`, `SCHEDULED`, `WEBHOOK`, `BACKFILL`)
- `status` (enum: `IntegrationRunStatus`)
- `startedAt`
- `completedAt`
- `importedByUserId` (nullable; for manual runs)
- `externalRunId` (nullable; provider cursor/job id)
- `counts` (Json; e.g. ordersParsed/draftsCreated/skipped/invalid/warningsCount)
- `errorCode` (nullable)
- `errorSummary` (nullable; safe, short)
- `warnings` (Json nullable; capped list or structured warnings)
- `metadata` (Json nullable; provider-specific safe metadata)
- `createdAt`
- `updatedAt`

### Model 2: `IntegrationRunItem`

**Purpose**: represent an item/order/row within a run (used for drill‑down and targeted retry).

**Proposed fields**
- `id`
- `runId`
- `status` (string or enum; can reuse `IntegrationRunStatus` or introduce `IntegrationRunItemStatus` later)
- `entityType` (nullable; e.g. `SupplierPurchaseDraft`, `InventoryExternalSale`, `InventoryPendingMatch`, `Document`)
- `entityId` (nullable; internal id created/linked)
- `externalEntityId` (nullable; e.g. `externalOrderId`, `externalSaleId`, `messageId/attachmentId`)
- `rawPayload` (Json nullable; only if retention policy allows)
- `normalizedPayload` (Json nullable; normalized contract snapshot)
- `errorSummary` (nullable; safe string)
- `metadata` (Json nullable; matching/dedupe notes, provider hints)
- `createdAt`

### Notes / constraints

- Do **not** use `InventoryMovement` for import/sync logs.
- These models are **telemetry/audit**, not a business ledger.
- Avoid storing secrets or full raw payloads by default; apply retention/redaction policies.
- A safe v1 could start with **CSV imports only**, then extend to Google Sheets / Supplier APIs / POS / Email ingestion.

---

## 9. Priority recommendation

### Must have before production integrations
- Persisted **run history** with status + counts (audit baseline)
- Integration **health status** (last success + consecutive failures)
- Safe **error summaries** (no secrets), supportable by internal codes
- Idempotency discipline (duplicate prevention) so retries are safe

### Can be deferred
- Full expandable logs with payload drill‑down
- Sophisticated dashboards/metrics UI (start with basic history + actionable states)
- Automatic backfills for long periods

---

## Suggested next steps (non‑binding)

1. Define a minimal “ImportRun/SyncRun” data contract (even before DB) used consistently by CSV and future connectors.
2. Decide retention (e.g. keep last 90 days) and error redaction rules.
3. Wire Import UI to show: **created + skipped** → “Go to Pending” always.

