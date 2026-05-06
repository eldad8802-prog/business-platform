# Rate Limiting & Abuse Protection Review (Planning)

This review checks whether the repo already has **rate limiting / throttling / abuse protections** and maps the most critical gaps before production. No code changes are made here.

Scope emphasis:
- Upload routes (documents, inventory images, content)
- Import routes (CSV supplier import, Gmail import)
- POS/webhook ingest routes
- Auth routes (login/register)
- Any middleware/global protection
- `package.json` for relevant libraries

---

## 1) Is there rate limiting today?

- **Finding**: No explicit rate limiting implementation was found (no `middleware.ts`, and no code references to common limiter/throttle patterns in a quick scan).
- **Severity**: HIGH
- **Recommendation**: plan a first protection layer before production traffic (see §§7–10).

---

## 2) Is there abuse protection today?

- **Finding**: Very limited. Some endpoints have **idempotency-ish** checks (e.g. POS external sale uniqueness, supplier CSV soft-dedupe), and some have input validation, but no systematic protections (rate limits, bot mitigation, replay protection, IP allowlists).
- **Severity**: HIGH
- **Recommendation**: introduce a threat model per endpoint class (auth, ingest, upload) and add layered protections.

---

## 3) Upload / file size protections

### 3.1 Documents upload (OCR/unified)
- **Finding**: Upload endpoints accept `formData()` and read bytes into memory / temp files. No explicit max file size guard was observed in the route itself.
- **Severity**: HIGH (cost amplification / DoS)
- **Recommendation**: enforce max upload size, content-type allowlist, and per-IP/per-user quotas; consider background job for large inputs.

### 3.2 Inventory item image upload
- **Finding**: Accepts `formData()` and passes `file` to `saveInventoryImage`. No visible size limit at route layer.
- **Severity**: MEDIUM
- **Recommendation**: limit file size and types; rate limit.

### 3.3 Content upload
- **Finding**: `app/api/content/upload/route.ts` writes directly to `public/uploads` with no auth and no size/type checks in-route.
- **Severity**: HIGH
- **Recommendation**: protect with auth and strict file constraints; rate limit heavily; consider disabling in production if not needed.

### 3.4 Gmail import has size limits (positive pattern)
- **Finding**: `app/api/integrations/gmail/import/route.ts` enforces `MAX_ATTACHMENT_BYTES = 15MB` and rejects with `413`, plus MIME allowlist and dedupe before download.
- **Severity**: LOW (relative)
- **Recommendation**: reuse this pattern for other file ingestion endpoints.

---

## 4) Most risky endpoints (where to focus)

### OCR / AI compute
- Documents OCR/unified routes, debug OCR/unified (even if production-disabled, still dev abuse risk)
- **Severity**: HIGH
- **Recommendation**: rate limit + quotas + max sizes + disable debug in prod (already done) + consider background processing.

### Imports
- CSV supplier import (`/api/inventory/supplier-purchases/import/csv`)
- Gmail import (already has partial protections)
- **Severity**: HIGH
- **Recommendation**: per-business/per-user limits; idempotency enforcement; progress UX for long runs.

### Auth: login/register
- **Finding**: no sign of brute-force protection / lockout / rate limiting on `/api/auth/login` and `/api/auth/register`.
- **Severity**: HIGH
- **Recommendation**: per-IP throttling, per-identifier backoff (email), and generic 401 messaging.

### Webhooks / POS ingest
- POS ingest (`/api/inventory/pos/sale`) is an ingest surface; currently no signature/replay protection beyond shared secret.
- **Severity**: HIGH
- **Recommendation**: signature validation + replay protection + rate limiting + backpressure queue.

---

## 5) What can happen without rate limiting

- Credential stuffing / brute-force against login
- Upload/compute **cost amplification** (OCR/AI) leading to runaway bills
- Webhook storm / replay causing DB pressure and queue starvation
- Large CSV uploads causing memory pressure/timeouts and cascading failures
- Denial of service against a single tenant (or all tenants) by repeated requests

---

## 6) Rate limiting dimensions we will need (future)

- **Per IP**: baseline bot/DoS control
- **Per user**: protect authenticated abuse (e.g. repeated imports)
- **Per business**: tenant fairness; prevent one business from starving others
- **Per integration**: provider quotas (Sheets/API) and noisy integrations

Severity: MEDIUM (planning requirement), but critical for production reliability.

---

## 7) Endpoints to protect first (priority)

1. **`/api/auth/login`**, **`/api/auth/register`** (brute force / enumeration)
2. **`/api/documents/upload`** (OCR/AI cost + file upload)
3. **`/api/inventory/supplier-purchases/import/csv`** (large uploads + DB writes)
4. **`/api/inventory/pos/sale`** (webhook ingest / replay storms)
5. Any unauthenticated upload endpoints (e.g. `content/upload`) if they must exist at all

---

## 8) Do we need queue/backpressure?

- **Finding**: For heavy workloads (OCR, large imports, webhook bursts), synchronous request handling is fragile.
- **Severity**: HIGH (for production scale)
- **Recommendation**: eventually move heavy ingest to a **queue/worker** model with idempotency keys, retries, and dead-letter visibility. Until then: strict limits + timeouts.

---

## 9) Packages/patterns suitable for Next.js App Router (future)

No rate limiting library is currently included in `package.json`. Options (conceptual):
- **Edge middleware limiting** (if running at edge) for IP-based coarse throttling
- **Server-side DB/Redis-backed limiter** for per-user/business precision
- **In-route guard** pattern (simple counters) only for MVP, but needs shared store to work across instances

Severity: MEDIUM
Recommendation: choose based on deployment topology (single instance vs multi, edge vs node runtime).

---

## 10) Gradual rollout recommendation

### Do first
- Add **coarse per-IP rate limiting** to auth + ingest surfaces
- Add **max file size** checks + MIME allowlists to file endpoints (copy Gmail import pattern)
- Add **per-business quotas** for expensive operations (OCR/import)
- Add **basic replay protection** for webhook/POS (idempotency + signature later)

### Avoid too early
- Complex per-route tuning without telemetry (you’ll block legitimate usage)
- Aggressive global limits without tenant-aware policies

Severity: HIGH (because delaying this while expanding integrations increases blast radius).

