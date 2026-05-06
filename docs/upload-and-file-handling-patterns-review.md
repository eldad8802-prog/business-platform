# Upload & File Handling Patterns Review (Planning)

Goal: map the existing **file upload + temp file** patterns in the repo so future hardening can be consistent (not ad‑hoc). No code changes are made here.

Scope emphasis:
- `app/api/documents/upload`
- `app/api/content/upload`
- Gmail import + temp OCR flows
- OCR/PDF services and temp directories
- cleanup patterns
- MIME allowlists and file size checks
- `public/uploads` usage

---

## 1) Upload flows that exist

### A) Documents upload (file → OCR → unified → DB)
- Route: `POST /api/documents/upload`
- Flow: `formData(file)` → write to `tmp/ocr` → OCR → unified extraction → create `Document` + `ExtractedData`
- **Severity**: HIGH (cost + upload surface)
- **Recommendation**: keep auth (already present), add size limits + MIME allowlist + rate limiting + background processing for large inputs.

### B) Content assets upload (file → public URL)
- Route: `POST /api/content/upload`
- UI caller: `app/content/assets-upload/page.tsx`
- Flow: `formData(file)` → read bytes → write to `public/uploads` → return `{ url }`
- **Severity**: HIGH (storage + public exposure)
- **Recommendation**: auth (added), then add MIME/size limits, quotas, and consider protected storage in future.

### C) Inventory item image upload (image only → public URL)
- Route: `POST /api/inventory/items/[id]/image`
- Service: `lib/services/inventory/inventory-image.service.ts`
- Flow: `formData(file)` → service validates image type + size → write to `public/uploads/inventory` → return URL stored on item
- **Severity**: MEDIUM
- **Recommendation**: keep service‑level validation; consider route‑level generic error message and rate limiting.

### D) Gmail attachment import (API pull → temp file → OCR → DB)
- Route: `POST /api/integrations/gmail/import`
- Flow: JSON request → validate + pre-dedup → download bytes → hash dedup → write temp file (`tmp/ocr`) → OCR → create document
- **Severity**: HIGH (external API + OCR cost), but strongest protections currently
- **Recommendation**: this is the best existing reference pattern for limits/dedup/cleanup.

### E) Documents debug OCR (file → OCR → rawText)
- Route: `POST /api/documents/debug-ocr`
- Flow: temp file in `tmp/ocr` + OCR; returns rawText; **production-disabled**
- **Severity**: LOW / MONITORED (prod disabled), MEDIUM in dev if exposed
- **Recommendation**: keep prod disable; consider auth/admin gating for staging tooling.

---

## 2) How each flow stores files

| Flow | Storage | Visibility |
|------|---------|------------|
| Documents upload | `tmp/ocr/<upload-...>` | temporary (should be deleted) |
| Gmail import | `tmp/ocr/<gmail-...>` | temporary (should be deleted) |
| Content upload | `public/uploads/<timestamp>-<original>` | public static URL |
| Inventory image | `public/uploads/inventory/<generated>` | public static URL |
| Debug OCR | `tmp/ocr/<debug-...>` | temporary (should be deleted) |

---

## 3) Cleanup: where it exists vs not

### Cleanup present
- **Documents upload**: `finally` block attempts `unlink(tempFilePath)` (best‑effort).
- **Debug OCR**: same best‑effort `unlink`.
- **Gmail import**: `writeTempOcrFile` returns an explicit `cleanup()` function that unlinks the temp file (structured cleanup).

### Cleanup missing
- **Content upload**: permanent writes to `public/uploads` with no retention policy.
- **Inventory images**: writes under `public/uploads/inventory` with no retention policy.

**Severity**: HIGH for permanent assets without lifecycle.
**Recommendation**: introduce retention + ownership (business/user) + safe deletion policies.

---

## 4) MIME validation patterns

### Strong allowlist exists (good)
- **Gmail import**: `isAllowedMime()` allows `application/pdf` and `image/*`.

### Service-level allowlist exists (good)
- **Inventory image service**: `file.type.startsWith(\"image/\")` only.

### Weak/implicit MIME handling (risky)
- **Documents upload**: chooses file extension via MIME fallback but does not reject unsupported MIME types.
- **Content upload**: no MIME checks at all.

---

## 5) File size limits

### Present
- **Gmail import**: `MAX_ATTACHMENT_BYTES = 15MB`, rejects with `413`.
- **Inventory image service**: `MAX_SIZE = 5MB`, throws error.

### Missing
- **Documents upload**: no explicit cap.
- **Content upload**: no explicit cap.
- **Debug OCR**: no explicit cap (but production-disabled).

---

## 6) Routes using `public/uploads`

- `POST /api/content/upload` → `public/uploads`
- `POST /api/inventory/items/[id]/image` (via service) → `public/uploads/inventory`

Risk: public hosting of user-provided assets without strong controls.

---

## 7) Routes using `tmp/`

- `POST /api/documents/upload` → `tmp/ocr`
- `POST /api/documents/debug-ocr` → `tmp/ocr`
- `POST /api/integrations/gmail/import` (via `writeTempOcrFile`) → `tmp/ocr`

Risk: disk pressure if cleanup fails; ensure best-effort cleanup + monitoring.

---

## 8) Temporary files vs permanent assets

- **Temporary**: used to feed OCR engines; should be deleted quickly; must be bounded by file size + rate limits.
- **Permanent**: user assets intended for later rendering/UX; require auth, ownership, retention policy, and ideally protected storage.

---

## 9) Flows that are risky today

1. **Content upload**: public, permanent, historically unauthenticated; still lacks MIME/size limits and lifecycle.
2. **Documents upload**: expensive OCR/unified compute without explicit max file size.
3. **Any upload without rate limiting**: can be abused for DoS/cost.

---

## 10) Patterns to unify in the future

- A shared “upload guard” checklist:
  - auth required
  - MIME allowlist
  - size limit
  - rate limiting/quota
  - safe error messages
  - consistent temp file lifecycle (create + cleanup)

- Prefer the **Gmail import pattern** as baseline:
  - validate → pre-dedup → fetch bytes → size check → hash → dedup → temp file → OCR → cleanup

---

## 11) Gradual hardening plan (recommended)

1. **Auth** (done for documents + content upload)
2. **MIME allowlists** (align across content/documents/email)
3. **Size limits** (route-level caps; reuse 413 pattern)
4. **Cleanup** (temp file structured cleanup; permanent asset retention policies)
5. **Protected storage** (move away from public filesystem when production-grade)
6. **Signed URLs** (time-bound access for private assets)

---

## 12) Most critical flows to address first

- **Documents upload** (cost + security)
- **Content upload** (public persistent assets)
- **POS/webhook + imports** (separate doc), but from a file-handling angle: CSV import size + timeouts

Severity: HIGH overall until rate limiting + file constraints exist.

