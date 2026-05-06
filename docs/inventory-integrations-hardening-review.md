# Inventory + Integrations Hardening Review (Pre‑Production)

This is a **focused risk review** for inventory and integrations routes before scaling integrations or production usage. It is **read‑only**: no code/schema changes are made here.

Scope emphasis:
- `app/api/inventory/*`
- `app/api/documents/*`
- `lib/auth.ts`
- Supplier CSV import routes + supplier pending flows
- POS ingest route(s)
- Upload flows and debug endpoints

---

## Summary (highest impact)

- **Auth model is weak by design** (Bearer token is numeric user id) → *HIGH*.
- **Some non‑inventory routes lack auth / scoping** (notably documents debug endpoints) → *LOW / MONITORED* (now disabled in production).
- **Machine ingest (POS)** accepts `businessId` from body under a shared secret → tenant isolation risk if secret leaks → *HIGH*.
- **No rate limiting** identified on import/webhook/upload endpoints → abuse/DoS risk → *HIGH*.
- **Supplier import dedupe is soft** (race conditions possible under concurrent uploads) → *MEDIUM/HIGH* depending on production load.

---

## 1) Routes ללא auth / auth חלש

### 1.1 `lib/auth.ts` token model
- **Severity**: HIGH
- **Why dangerous**: `Authorization: Bearer <userId>` is effectively guessable/stealable and has no expiry/rotation semantics. Stored in `localStorage` on clients.
- **Recommendation**: migrate to signed sessions/JWT with expiry + rotation; add RBAC for destructive actions; centralize auth parsing.

### 1.2 Documents debug routes (no auth)
Examples:
- `app/api/documents/debug-unified/route.ts` (accepts arbitrary `businessId` from body, defaulting to 1)
- `app/api/documents/debug-extract/route.ts` (runs extraction with hardcoded business id)
- **Severity**: LOW / MONITORED (production disabled) / MEDIUM (dev-only)
- **What was done**: `documents/debug-*` routes now short-circuit in production via a `NODE_ENV === "production"` guard and return **404** immediately (no OCR/AI execution, no body/file parsing).
- **Why still note-worthy**: in development/staging-like environments these endpoints can still be abused if exposed.
- **Recommendation**: keep them disabled in production; consider **auth + admin gating** (or an internal-only secret) for staging/internal tooling if needed.

### 1.3 Inventory routes with “auth but weak token”
Examples reviewed: supplier purchases routes, movements, items, drafts, alerts, insights
- **Severity**: HIGH overall due to token model
- **Why dangerous**: even well-scoped routes become vulnerable if auth token is not secure.
- **Recommendation**: same as 1.1; additionally enforce consistent helper usage.

---

## 2) Routes עם business scoping לא בטוח

### 2.1 POS ingest uses `businessId` from request body
`app/api/inventory/pos/sale/route.ts`
- **Severity**: HIGH
- **Why dangerous**: business scoping is client-controlled for machine calls. If `POS_INGEST_SECRET` leaks, attacker can choose any `businessId`.
- **Recommendation**: tie the secret to a single business (per-business keys) or map `x-pos-key` → businessId server-side; add webhook signature + replay protection.

### 2.2 Document upload now scoped correctly (post-fix)
`app/api/documents/upload/route.ts`
- **Severity**: LOW (after fix)
- **Why safer**: uses `getCurrentUser` and `user.businessId`; ignores any form-provided businessId.
- **Recommendation**: keep; consider file size limits and upload rate limiting.

---

## 3) שימושים מסוכנים ב־`businessId` מה־body

- **POS sale ingest** (`businessId` from JSON body) → see 2.1 (*HIGH*).
- **Documents debug unified** (`businessId` from body) → see 1.2 (*HIGH*).
- **Recommendation**: do not accept tenant identifiers from untrusted callers unless authenticated + authorized and validated against principal.

---

## 4) Hardcoded secrets / values

### 4.1 POS ingest secret moved to env (good)
`POS_INGEST_SECRET` is now read from env.
- **Severity**: MEDIUM
- **Why still risky**: still a single shared secret if not per tenant; no rotation/audit described.
- **Recommendation**: per-business secret + rotation + “needs attention” state when invalid.

### 4.2 Debug endpoints hardcode business id (bad)
`debug-extract` runs with business id `1` in code.
- **Severity**: LOW / MONITORED (production disabled)
- **Recommendation**: acceptable while debug routes are production-disabled; still consider gating for staging/internal tooling.

---

## 5) חוסר rate limiting

- **Severity**: HIGH
- **Why dangerous**: upload/import/webhook endpoints are natural DoS vectors (large CSVs, repeated webhooks, repeated file uploads).
- **Recommendation**: add rate limiting (per IP + per business + per integration); enforce max file size and request body constraints; add backpressure for webhook storms.

---

## 6) Missing idempotency

### 6.1 Supplier CSV import (soft dedupe only)
`/api/inventory/supplier-purchases/import/csv`
- **Severity**: MEDIUM/HIGH
- **Why dangerous**: dedupe is a pre-check without DB constraint; concurrent requests can still insert duplicates.
- **Recommendation**: add DB uniqueness or transactional upsert for `(businessId, source, externalOrderId)` when product decides strong dedupe.

### 6.2 InventoryMovement manual route is not idempotent
`/api/inventory/movements` creates movements without idempotency key.
- **Severity**: MEDIUM
- **Why dangerous**: client retries can duplicate movements.
- **Recommendation**: add idempotency keys for client-driven writes or move to workflow-based actions.

### 6.3 POS sale idempotency exists (positive)
`InventoryExternalSale` uniqueness used to skip already processed sales.
- **Severity**: LOW
- **Risk note**: ensure the “mark processed” write is in the same transaction semantics as movements if ordering matters.

---

## 7) Race conditions אפשריים

- **Supplier drafts**: concurrent CSV imports with same externalOrderId can race (soft dedupe vs create) → duplicates.
- **POS**: webhook replay storms rely on uniqueness; still needs signature verification + backpressure.
- **Severity**: MEDIUM
- **Recommendation**: transactional patterns + DB constraints + queues where needed.

---

## 8) Duplicate movement risks

### 8.1 Supplier draft approve has hard idempotency
`approveSupplierPurchase` blocks when draft status is not `PENDING_REVIEW`.
- **Severity**: LOW
- **Why safer**: prevents double-approve and duplicate movements for same draft.

### 8.2 Manual movement endpoint duplicates on retries
- **Severity**: MEDIUM
- **Recommendation**: idempotency key or remove from general UI in production without guardrails.

---

## 9) Unsafe error exposure

- **Severity**: MEDIUM
- **Findings**:
  - Many routes log server errors and return generic 500 (good).
  - Some routes return `error.message` for `Error` instances (safe-ish but can leak details if upstream throws sensitive messages).
  - Documents upload returns generic “Server error” (good).
- **Recommendation**: standardize error envelope; never expose raw errors; use internal error codes.

---

## 10) Inconsistent auth patterns

- **Severity**: MEDIUM
- **Findings**:
  - Some routes use `getCurrentUser` (`lib/auth.ts`).
  - Many inventory routes re-implement `getAuthenticatedUser` locally with slightly different behaviors (error types, trimming, messages).
- **Recommendation**: converge on one helper/middleware once production auth is selected.

---

## 11) Missing validation

- **Severity**: MEDIUM
- **Examples**:
  - POS sale ingest validates presence of fields and quantity > 0, but relies on businessId/body trust.
  - Image upload endpoint returns `{ error: err.message }` on 500 path (could leak).
- **Recommendation**: add schema validation (without new deps if constrained: minimal manual validation) + consistent error messages.

---

## 12) Raw payload risks

- **Severity**: MEDIUM
- **Why dangerous**: storing raw payloads (future integrations) can include secrets/PII; logs can leak.
- **Recommendation**: adopt redaction/retention rules; store hashes/pointers by default.

---

## 13) Upload risks

### 13.1 Documents upload
- **Severity**: MEDIUM
- **Risks**: large file uploads; temp file handling; OCR cost amplification; no explicit size limits.
- **Recommendation**: file size limits, content-type allowlist, rate limiting, temp cleanup monitoring.

### 13.2 Inventory image upload
- **Severity**: MEDIUM
- **Risks**: error message exposure; file validation depends on `saveInventoryImage`.
- **Recommendation**: enforce type/size checks; return generic 500 messages.

---

## 14) Webhook risks (POS)

- **Severity**: HIGH
- **Why dangerous**: no signature verification, no replay protection; shared secret; businessId controlled by caller.
- **Recommendation**: signed webhooks (HMAC), timestamp/nonce, per-tenant keys, allowlist if supported; queue ingestion with idempotency.

---

## 15) Audit / logging gaps

- **Severity**: MEDIUM
- **Findings**: logs are mostly `console.error` without correlation ids; no persisted run history for CSV imports; “what happened” not centrally visible.
- **Recommendation**: implement IntegrationRun telemetry (see import-history docs); structured logs with businessId + request id.

---

## 16) Must fix before production

- **HIGH**: replace Bearer userId token model with production-grade auth + RBAC.
- **HIGH**: secure/disable debug document endpoints in production.
- **HIGH**: POS ingest hardening: per-tenant key mapping (don’t accept businessId from caller) + signature/replay protection.
- **HIGH**: rate limiting + file size limits for import/upload/webhook endpoints.

---

## 17) Medium priority fixes

- Supplier import dedupe race hardening (DB constraints / transactional upsert once product decides policy).
- Manual movement endpoint idempotency/guardrails.
- Standardized error envelopes (no `error.message` leakage from unexpected errors).

---

## 18) Can defer (with monitoring)

- Full “Import History / Sync Visibility” UI (but store minimal run telemetry early).
- Deep payload drill-down and advanced metrics dashboards.

---

## Notes

This review intentionally does **not** propose refactors. It highlights where tightening is needed **before** adding more integrations or trusting production traffic.

