# Inventory Integrations Hub — UX & Architecture Planning

This document plans a **single, obvious place** for a business owner to connect external systems to inventory workflows. It is **planning only**: no routes, schema, or runtime changes are implied here.

Related foundations: `docs/supplier-connectors-v1-status.md`, `docs/pos-connectors-foundation.md`, `docs/external-business-events-architecture.md`.

---

## 1. Purpose of the Hub

### Working name
**“מרכז חיבורים למלאי”** (Inventory Integrations Hub)

### Goals
- One **canonical entry point** for “what is connected to my inventory?” and “how do I fix it?”
- Separate **configuration & health** from **day‑to‑day operations** (ordering, receiving, selling), while linking clearly into those flows when needed
- Align terminology across **inbound (suppliers)** and **outbound / sales (POS)** so operators are not learning multiple mental models

---

## 2. Future integrations (inventory‑adjacent)

These are **targets over time**, not a commitment order:

| Area | Examples |
|------|-----------|
| **CSV Import** | Supplier CSV uploads (manual file → drafts); later templates per supplier |
| **Google Sheets** | Supplier price/order sheets via Sheets API + OAuth |
| **Supplier APIs** | Wholesale portals, EDI‑lite HTTP APIs |
| **Email ingestion** | Parsed attachments / structured forwards → drafts or tickets for review |
| **POS systems** | Shopify POS, Square, local Israeli ecosystems (exports/APIs/webhooks per vendor) |
| **Webhooks** | Inbound events from POS or middleware (orders closed, inventory deltas — bounded by contract) |
| **Accounting (future)** | iCount / חשבשבת / ריווחית‑style sync — typically **downstream** of inventory truth; treat as export/sync, not primary movement author |

---

## 3. Recommended UX structure

### 3.1 Hub layout
- **Primary Hub page**: grid/list of **integration cards** (similar spirit to `Supplier Purchases` hub cards — clear tiles, RTL, mobile‑first)
- Each card: provider icon/name, short description, **status badge**, optional **last sync**, primary action (**Configure** / **Reconnect** / **Test**)

### 3.2 Status badges (conceptual)
| Badge | Meaning |
|-------|---------|
| **Connected** | Credentials valid; last successful handshake or sync within SLA |
| **Needs attention** | Auth expired, webhook failures threshold, mapping backlog, or repeated ingest errors |
| **Not connected** | Never configured or explicitly disconnected |

### 3.3 Card‑level metadata (when available)
- **Last sync** (timestamp + optional “success/partial/failed”)
- **Errors / warnings** (compact summary; drill‑down to logs)
- **Test connection** — validates credentials + minimal probe call (no inventory side effects)
- **Reconnect** — OAuth refresh flow or API key re‑entry

---

## 4. Supplier connection flow (future)

High‑level wizard (exact screens TBD):

1. **Choose provider** (CSV upload vs Google Sheets vs named API vs Email inbox — provider catalogue)
2. **Provide secrets / URLs**
   - API key / OAuth / **Sheet URL or spreadsheet ID**
   - Email: mailbox linkage rules (future)
3. **Validate**
   - Permissions check (read sheet / call API)
   - Schema sanity (required columns / headers)
4. **Preview orders**
   - Normalized preview rows (`NormalizedSupplierOrder` mental model) — no stock writes
5. **Enable sync**
   - Cadence: manual vs scheduled vs webhook (if applicable)
   - Dedupe policy surfaced in UI (align with supplier drafts soft‑dedupe docs)

---

## 5. POS connection flow (future)

Aligned with `docs/pos-connectors-foundation.md`:

1. **Choose POS / provider**
2. **Webhook + API setup**
   - Register webhook URL (platform provides secret/signature instructions)
   - Optional API keys for backfill
3. **Test event**
   - Send synthetic or sandbox sale → expect normalized receipt in logs / preview
4. **Product mapping**
   - Unmatched external products → mapping UI (see §6)
5. **Pending review**
   - Low confidence / unmatched lines → `InventoryPendingMatch` style queues — **no OUT movements** until reviewed

---

## 6. Product Mapping UX

Cross‑cutting for POS lines (and optionally supplier lines when SKUs diverge):

- Prompt pattern: **“זה אותו מוצר?”** with candidate internal item + confidence
- Actions:
  - **MERGE** — link external identity to existing `InventoryItem` (persistent mapping)
  - **CREATE_NEW** — create internal item then map (policy: who may create master data)
  - **Remember mapping** — persist `POSProductMapping` / supplier equivalent so next events auto‑resolve

Avoid silent auto‑merge on weak signals (name‑only fuzzy); match POS foundation priorities (mapping → SKU → barcode → pending).

---

## 7. Security considerations

- **Secret storage**: API keys and OAuth tokens **never** in client bundles; server‑side vault/KMS pattern when implemented
- **Token refresh**: scheduled refresh + **Needs attention** when refresh fails
- **Permissions**: least privilege per integration (read‑only sheet vs full drive)
- **Webhook validation**: signature (HMAC), timestamp/nonce replay protection, allow‑listed IPs only if vendor supports

---

## 8. Sync architecture (conceptual)

| Mechanism | Use when |
|-----------|-----------|
| **Polling** | APIs without push; rate limits + incremental cursors |
| **Webhooks** | Near‑real‑time POS; still **idempotent** on `externalSaleId` / provider ids |
| **Manual sync** | User‑triggered “Sync now” from Hub or operational pages |
| **Retry behavior** | Exponential backoff; dead‑letter queue for poison payloads |
| **Idempotency** | Business keys (`externalSaleId`, supplier `externalOrderId` + source) — align with existing draft dedupe and POS pending match uniqueness |

---

## 9. Why integrations must not talk directly to `InventoryMovement`

- **InventoryMovement** is the **ledger of truth** after business decisions and matching guardrails
- Raw external feeds are **untrusted**: wrong SKU, duplicate webhook, partial files
- Correct pipeline: **normalize → match/map → human or automated approval gates →** then `inventoryService` creates movements with correct **reason** (`SALE`, `SUPPLIER_PURCHASE`, etc.)
- Skipping gates invites irreversible stock corruption and audit inconsistency

---

## 10. Fit with existing architecture

End‑to‑end mental model (already reflected in supplier & POS docs):

```
External source
    → Connector (provider‑specific I/O)
    → Normalized contract (NormalizedSupplierOrder / NormalizedSaleEvent)
    → Adapter → domain inputs (draft intake / POS ingest payloads)
    → Pending review (SupplierPurchaseDraft / InventoryPendingMatch)
    → Approved actions
    → InventoryMovement (+ accounting exports later)
```

The **Integrations Hub** sits **above connectors**: configuration, credentials, sync schedules, health — while **operational pages** (`supplier-purchases/*`, POS sale routes, etc.) remain where users **act** on pending work.

---

## Risks & open decisions

- **Scope creep**: Accounting sync must not become a second inventory engine — exports only unless explicitly designed otherwise
- **Operator overload**: Too many badges/alerts on Hub → prioritize **Needs attention** with actionable next steps
- **Multi‑location**: Cards may need location scope before POS webhooks scale

---

## Document status

**Planning / UX‑architecture.** Does not modify runtime. Implementation should cross‑reference this doc when adding routes or persistence for integration settings.
