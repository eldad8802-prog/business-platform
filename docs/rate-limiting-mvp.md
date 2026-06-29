# Rate Limiting MVP (Implemented)

This document describes the **currently implemented** MVP rate limiting layer in this repo.

> **P1 UPDATE (Documents):** The Documents upload/processing/read paths now use a
> shared, production-grade limiter backed by **Upstash Redis** (see §7 below).
> The in-memory `Map` is now **dev/test only** and is refused in production. The
> legacy raw-key routes (auth / pos / content / csv) keep their exact limits but
> route through the same shared store via a compatibility shim.

Implementation note: the legacy shim is in `lib/security/rate-limit.ts`; the
production limiter lives in `lib/security/rate-limiter/`.

---

## 1) Protected routes (current)

### Auth
- `POST /api/auth/login`
- `POST /api/auth/register`

### Documents
- `POST /api/documents/upload`

### Inventory (Supplier CSV import)
- `POST /api/inventory/supplier-purchases/import/csv`

### Content
- `POST /api/content/upload`

### POS ingest
- `POST /api/inventory/pos/sale`

---

## 2) Limits per route (current)

### `POST /api/auth/login`
- Per IP: **10 requests / minute**

### `POST /api/auth/register`
- Per IP: **3 requests / hour**

### `POST /api/documents/upload`
- Per userId: **10 uploads / hour**
- Per businessId: **30 uploads / day**

### `POST /api/inventory/supplier-purchases/import/csv`
- Per userId: **5 imports / hour**
- Per businessId: **20 imports / day**

### `POST /api/content/upload`
- Per userId: **30 uploads / hour**
- Per businessId: **200 uploads / day**

### `POST /api/inventory/pos/sale`
- Per IP: **120 requests / minute**
- Per businessId: **600 requests / minute**

### Over-limit response (all routes above)
- HTTP **429**
- Body: `{ error: "Too many requests. Please try again later." }`

---

## 3) IP derivation (where applicable)

When limiting by IP, the IP is derived from request headers (first match wins):
- `x-forwarded-for` (first IP in the comma-separated list)
- `x-real-ip`
- `cf-connecting-ip`
- fallback: `"unknown"`

---

## 4) MVP constraints / limitations

This is suitable only for **single-instance / early MVP**:
- Resets on **process restart**
- Does **not** work correctly in **multi-instance** deployments (no shared state)
- No shared store (Redis/Upstash/DB) → per-instance counters diverge
- IP limiting depends on proxy headers being set correctly; otherwise many callers may collapse into `"unknown"`

---

## 5) Production path (future)

Recommended next step for production:
- Use a **shared-store** limiter (Redis / Upstash / DB-backed)
- Add **audit logs** and observability for throttling decisions (so limits can be tuned safely)

---

## 6) POS required ENV

POS ingest requires:
- `POS_INGEST_SECRET`
- `POS_INGEST_BUSINESS_ID`

---

## 7) P1 — Production-grade limiter (Upstash Redis)

Module: `lib/security/rate-limiter/` (`index.ts` orchestrator, `buckets.ts`
config, `redis-backend.ts`, `memory-backend.ts`, `http.ts` response builder).

### Required ENV (add in Vercel — production)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RATE_LIMIT_BACKEND` (optional override: `redis` | `memory`; default = `redis`
  in production, `memory` in dev)
- `RATE_LIMIT_FAIL_MODE` is **not** a global env — fail mode is per-bucket (see below).

If `RATE_LIMIT_BACKEND` resolves to `redis` and the Upstash vars are missing, the
limiter **throws `RateLimiterConfigError` (fail hard)** — a misconfigured deploy
does not silently run unprotected.

### Buckets (Documents)
| Bucket | Keyed by | Rules | Fail mode |
|---|---|---|---|
| `UPLOAD_ACCEPT` | user + business | 30/min & 300/h per user; 120/min & 2000/day per business | closed |
| `DOCUMENT_PROCESSING` | business + global | 60/min per business; 600/min global | closed |
| `DOCUMENTS_API` (reads) | user | 120/min per user | open |

Hybrid fail mode: writes (upload/processing) **fail-closed** → controlled **503**
on a Redis blip (never a silent memory fallback). Reads **fail-open** → a blip
does not break document viewing, but the degradation is logged + recorded.

### Over-limit / unavailable responses (Documents)
- `429` — body `{ error (Hebrew), code: "rate_limited", scope, bucket, retryAfterSeconds, resetAt }`
  plus `Retry-After` + `RateLimit-*` headers.
- `503` — body `{ error (Hebrew), code: "rate_limit_unavailable", retryAfterSeconds }`
  plus `Retry-After`, when a fail-closed bucket cannot reach Redis.

### Observability
Every blocked Documents upload records a `throttled` product-usage event
(`PRODUCT_USAGE_ACTIONS.THROTTLED`) and a stable `[rate-limit] throttled` log line.

### Verify
`RATE_LIMIT_BACKEND=memory npx tsx lib/security/rate-limiter/rate-limiter.verify.test.ts`

### Not in P1 (P2)
No background queue yet — OCR/extraction is still synchronous inside the upload
request. The `DOCUMENT_PROCESSING` bucket is positioned so it relocates verbatim
to the worker dequeue step in P2.

