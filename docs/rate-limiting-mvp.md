# Rate Limiting MVP (Implemented)

This document describes the **currently implemented** MVP rate limiting layer in this repo.

Implementation note: the limiter is implemented in `lib/security/rate-limit.ts` and is based on an **in-memory `Map`**.

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

