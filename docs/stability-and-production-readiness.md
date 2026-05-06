# Stability & Production Readiness — Gap Analysis (Planning)

This document maps **risk gaps** before scaling additional inventory integrations. It is **planning only**: no runtime changes are implied.

Cross‑references: `docs/supplier-connectors-v1-status.md` (dedupe & deferred behaviors), `docs/pos-connectors-foundation.md`, `docs/inventory-integrations-hub.md`.

---

## 1. Authentication gaps

### Current token model (inventory‑adjacent APIs observed)
- Several routes resolve **`Authorization: Bearer`** where the token string is the **numeric user id**, parsed as `Number(token)` and loaded from `User` via Prisma (`businessId`, etc.).
- Client pages typically read **`localStorage.getItem("token")`** and attach it as Bearer.

### Risks
- **Not a standard JWT/session model**: predictable if exposed; no rotation/expiry story at the transport layer described here.
- **Shared‑device risk**: token in `localStorage` is XSS‑sensitive (general web risk).
- **No role/permission granularity** in this pattern alone (inventory APIs assume “this user belongs to this business”).

### Production needs (directional)
- Replace or wrap with **signed sessions** (JWT + refresh or secure cookies), **short‑lived access**, server‑side session invalidation.
- **RBAC** for inventory‑destructive actions (approve movements, delete items, integration admin).
- Consider **service‑to‑service** keys for POS/webhooks separate from user Bearer tokens.

---

## 2. API security gaps

### Hardcoded secrets
- POS ingest route documents a **temporary shared secret** in code (`x-pos-key` pattern). **Must not ship** to production as‑is; move to env/secret manager and rotate.

### Webhook validation
- Production webhooks require **signature verification**, replay protection, and **idempotent keys** (see §3).
- POS‑style keys must be **per tenant / per business**, not global constants.

### Rate limiting
- No repo‑wide rate‑limit middleware was identified in a quick scan; **upload/import and webhook endpoints** are natural abuse targets (large CSV, replay storms).

### Permissions
- APIs should enforce **business scoping** on every query (`businessId` from authenticated principal, not from raw body without checks — verify each route passes review).
- Integration Hub (future) needs **least privilege** scopes for OAuth (Sheets read‑only, etc.).

---

## 3. Idempotency gaps

### Supplier imports (CSV)
- **Soft dedupe v1** matches `(businessId, source, externalOrderId)` only for **`PENDING_REVIEW`** drafts (documented). **No DB unique constraint** on supplier drafts for that tuple yet → **race**: parallel uploads could still create duplicates under load until constrained or transactional upsert exists.

### POS sales
- **`InventoryExternalSale`** has **`@@unique([businessId, externalSaleId])`** — good anchor for “already processed” short‑circuit after successful processing path (verify alignment with actual commit order in code paths).

### Pending replay
- External sale replay returns **skipped** when record exists — **safe** if processing is atomic with insert.
- Any future queue must ensure **exactly‑once processing semantics** at the application layer (DB uniqueness + transactional side effects).

### Race conditions
- Supplier draft creation without unique constraint: **parallel imports** can duplicate pending drafts with same external key.
- Approval path documents **hard idempotency** at draft status — replays rejected once processed.

---

## 4. Background processing gaps

### Today
- Connectors / imports are largely **request‑driven** (HTTP upload, mock routes). No durable **job runner** or scheduler is assumed in docs reviewed.

### Gaps for production scale
- **Polling** supplier APIs / Sheets: needs **cron/worker**, backoff, and **checkpoint** (cursor per integration).
- **Retries**: transient Google/API failures should not duplicate business writes — retry must be **idempotent** at ingest boundary.
- **Failed sync recovery**: operator‑visible **dead letters** + “resume” without manual DB edits.
- **Queue needs**: at minimum an **outbox or job table** pattern before heavy integrations (email parsing, multi‑step OCR‑adjacent flows — not all in inventory today but Hub plans reference them).

---

## 5. Observability gaps

### Logging
- Route‑level `console.error` exists in several handlers — acceptable for dev; production needs **structured logs** (request id, businessId, integration id, correlation id).

### Structured errors
- Client surfaces user‑safe messages — good direction; ensure **internal codes** for support triage.

### Import history / sync status
- CSV import returns per‑run summary — **no persisted audit trail** of imports was assumed in planning docs → operators cannot answer “who imported what when?” without DB backing.

### Metrics
- No standard metrics hooks assumed for **import latency**, **skip rates**, **webhook failure rates**, **approval funnel**.

---

## 6. Data integrity risks

### Duplicate drafts
- Possible under concurrent supplier imports without uniqueness constraints (see §3). Also **semantic duplicates** when `externalOrderId` missing.

### Duplicate movements
- Approval service blocks double‑approve by draft status; POS path uses external sale uniqueness — **still validate** concurrent paths don’t double‑apply.

### Product mismatches
- POS matching priority documented (mapping → SKU → barcode → pending); fuzzy name misuse remains a **trust** issue.

### Deleted products
- MERGE targets must validate **item still active / belongs to business** at approve time (guardrails belong in services — verify coverage when extending).

### Barcode conflicts
- Multiple items sharing barcode/SKU in messy master data → ambiguous matches; needs UX + deterministic tie‑break rules.

---

## 7. UX / product stability risks

### Confusing states
- Supplier CSV can **silently drop** invalid quantity rows at connector stage → users see **empty parse** without `invalidOrders` (documented behavioral gap).
- Re‑import after **APPROVED** can recreate pending with same external id — intentional but **must be communicated** to avoid “duplicate bug” perception.

### Missing warnings
- Missing `externalOrderId` weak dedupe — warnings exist server‑side when wired; ensure UI always surfaces.

### Long‑running imports
- Large CSV sequential processing may **timeout** HTTP requests without streaming/chunking strategy.

### Partial success
- Mixed valid/invalid rows need clear **rollup** (counts + drill‑down); avoid “success” wording when zero drafts created unless explained.

---

## 8. Priority recommendation

### Must fix before broad production (inventory integrations)
1. **Replace dev auth model** with production‑grade sessions/tokens + RBAC for sensitive actions.
2. **Remove/replace hardcoded POS secrets**; per‑tenant keys + secret storage.
3. **Rate limiting** on import/webhook/public‑ish endpoints.
4. **DB‑level uniqueness or transactional dedupe** for supplier `(businessId, source, externalOrderId)` where product commits to strong dedupe — or explicit decision to accept duplicates under concurrency.

### Can defer (with eyes open)
- Full Integration Hub UI (cards, sync schedules) — after core auth & secrets.
- Accounting export sync — keep downstream only.
- Advanced observability dashboards — start with structured logs + import audit table.

### Dangerous to continue integrations without
- **Production secrets in repo/env drift**
- **No idempotency under concurrency** for supplier drafts
- **No webhook signature story** for external POS producers

---

## 9. Architecture recommendation — extend without breaking runtime

### Preserve pipeline boundaries
Keep the established sequence:

```
External I/O → Connector → Normalized contract → Adapter → Pending/Draft/Match layers → Approved → inventoryService → InventoryMovement
```

### Add new integrations as **horizontal slices**
- New provider = **new connector module** + **same contracts/adapters** where possible.
- **Never** bypass pending/review for trust‑sensitive writes.

### Introduce integration metadata incrementally
- When adding polling/webhooks, store **integration records** and **run logs** first; avoid embedding provider logic inside `inventoryService`.

### Progressive hardening
- Start with **manual triggers** (CSV upload already), add **scheduled jobs** only after audit/idempotency baselines exist.

---

## Document status

**Planning / risk register.** Update when auth, schema constraints, or observability milestones land.
