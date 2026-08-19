# Compliance Implementation Report — W7 (SEC-24 Durability Verification)

**Wave:** W7 — implement & prove **SEC-24** (persist-before-enrichment durability). WP3, SEC-24 only — no general security hardening.
**Date:** 2026-07-03
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.
**Owner decision applied:** align the WhatsApp path with the Upload/Gmail reference (recorded — the prior WhatsApp behavior was intentional and tested; changing it was the owner's call, taken in-wave).

---

## 1. What was audited
The persist → enrichment chain in all three ingestion paths:
| Path | Order | On OCR (enrichment) failure | SEC-24 (before) |
|------|-------|-----------------------------|------------------|
| Upload (`app/api/documents/upload/route.ts`) | persist file → OCR | keeps file, creates `needs_review` Document (empty text) — never deletes | ✅ compliant |
| Gmail import | persist → OCR | same ("mirrors the Gmail import path — never discard", per upload's own comment) | ✅ compliant |
| **WhatsApp** (`documents-intake.service.ts`) | persist (`putDocument`) → OCR | `fail()` **deleted the persisted file** + marked import failed + **no Document** | ❌ **violation** |

**Failure points found:** the WhatsApp `fail()` path deleted the already-persisted artifact on OCR failure/empty (`deleteDocument`, service line ~207). The behavior was **intentional and encoded in a test** (`webhook-pr4.intake.test.ts` asserted OCR-fail ⇒ `status:"failed"`), so it was surfaced as an owner decision — resolved: **align with Upload/Gmail**.

## 2. What changed (minimum for SEC-24)
- **`lib/services/integrations/whatsapp/documents-intake.service.ts`** — OCR failure or empty result now **falls through with empty text and creates a `needs_review` Document** (keeping the persisted file), exactly like the Upload/Gmail paths. Removed the `return fail("ocr_failed")` / `return fail("ocr_empty")` discards. **Only genuine persistence failures remain fatal:** `storage_failed` (the `putDocument` itself failed) and `create_document_failed` (the Document row could not be created).
- **`lib/services/integrations/whatsapp/webhook-pr4.intake.test.ts`** — the OCR-fail and OCR-empty cases now **assert SEC-24 durability**: outcome `imported`, a `needs_review` Document created, and — the key proof — **`deleteDocument` was NOT called** (a tracked counter added to the mock).

## 3. WP3 clauses covered
| Clause | Result |
|--------|--------|
| **SEC-24 persist-before-enrichment durability** | **Covered** for all three ingestion paths. WhatsApp now matches Upload/Gmail: an OCR (enrichment) failure never discards the persisted artifact — it survives as a reviewable `needs_review` Document. |

## 4. Automated proof — yes
`npm run verify:whatsapp-webhook-pr4` now includes two **SEC-24 durability** assertions (OCR-fail and OCR-empty): the artifact survives (`imported` + `needs_review` Document) and the stored file is **not** deleted. This is the SEC-24 `*.verify.test.ts` gate for the WhatsApp path, runnable in CI. **Result: passes.** (Upload/Gmail were already compliant; they are HTTP route handlers and are covered by the same durability contract — a route-level test is a follow-up.)

## 5. Did business behavior stay identical?
**Intentionally changed — per the owner's decision** (this is the SEC-24 implementation). WhatsApp documents that fail OCR now become **`needs_review` Documents** (recoverable) instead of failed imports with a deleted file. All other behavior — dedup, media fetch, claim, storage-failure and document-row-failure handling, success path — is unchanged. Verified by `npm run verify:whatsapp-webhook-pr4` (passes), `eslint` (0 errors), `tsc --noEmit` (no type errors). *Honest caveat:* orchestration is unit-verified with injected fakes; the real DB/storage/extraction path and the reviewer UX for these new needs_review docs were not exercised in a live run — a manual check is recommended before production.

## 6. Backlog v2 / follow-ups
- **No new Constitution Backlog v2 gap** — SEC-24 was implementable as written; **WP1/WP3 unchanged, constitution frozen.**
- **Code follow-ups (not constitution gaps):**
  1. `create_document_failed` still deletes the persisted file (a Document-row/DB failure — outside SEC-24's *enrichment* scope, but arguably a residual durability edge). Narrow; a future hardening could keep the orphan file + retry.
  2. On empty/failed OCR the WhatsApp path calls `createDocumentFromOcrText` which runs extraction on empty text; the Upload path skips extraction on empty text (bare create). Aligning WhatsApp to a bare create on empty is a small efficiency/robustness follow-up.
  3. Pre-existing lint: `mockMediaDeps` unused in the PR4 test (warn-only, not W7).
  4. A route-level durability test for Upload/Gmail would round out the SEC-24 gate.

## 7. Verification (lint / typecheck / tests)
- `npm run verify:whatsapp-webhook-pr4` — **passes** (incl. the two new SEC-24 assertions).
- `eslint` — **0 errors** (1 pre-existing unused-var warning).
- `tsc --noEmit` — **no type errors** in the service or the test.

---

## Success Criterion — the one question
> *"Can we prove that a document received by the system is durably persisted before any processing that might fail?"*

**Yes.** For all three ingestion paths the file is persisted before OCR, and — now including WhatsApp — an OCR failure never discards it (it survives as a `needs_review` Document). The WhatsApp path has an **automated, CI-runnable proof** asserting exactly this. SEC-24 is implemented and demonstrable.

## Files touched (W7)
`lib/services/integrations/whatsapp/documents-intake.service.ts` (SEC-24 fix) · `lib/services/integrations/whatsapp/webhook-pr4.intake.test.ts` (durability proof) · `docs/compliance-constitution-system-audit-v1.md` (G-24 status) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W7 commit follows.
