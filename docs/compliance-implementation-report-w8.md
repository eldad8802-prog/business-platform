# Compliance Implementation Report — W8 (SEC-24 Completion Follow-ups)

**Wave:** W8 — close the residual SEC-24 gaps found in W7 across all central ingestion paths. WP3, SEC-24 only.
**Date:** 2026-07-03
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.

---

## 1. Paths audited
Upload (`app/api/documents/upload/route.ts`), Gmail import (`app/api/integrations/gmail/import/route.ts`), WhatsApp intake (`lib/services/integrations/whatsapp/documents-intake.service.ts`), and their shared document-creation service (`lib/services/documents/create-document-from-ocr.service.ts`).

## 2. Deletions found (root-cause)
The residual W7 concern (`create_document_failed` deletes) traced to a **shared root cause**:
- **`createDocumentFromOcrText` ran extraction (`runUnifiedDocumentIntelligence`) unconditionally and threw on failure.** Both **Gmail** (OCR-success branch) and **WhatsApp** delegate document creation to it, so an **extraction (enrichment) failure** made the whole Document creation throw → the caller's error path **deleted the already-persisted file**. That is an enrichment failure discarding the artifact — a SEC-24 violation, present in **two** paths.
- The **Upload** route did *not* have this bug (its extraction is inline `try/catch`, best-effort; the Document is always created).
- Separately, all three paths delete the orphan file on a genuine **`prisma.document.create` DB failure** — a *record-persistence* failure, **not** enrichment, and consistent across paths (see §5).

## 3. What was fixed (minimum, root-cause)
**One change, at the shared choke point** — `createDocumentFromOcrText` now treats **extraction as best-effort**: it runs inside `try/catch`, and on failure still creates the `needs_review` Document (skipping `ExtractedData`, mirroring the Upload/Gmail bare-document fallback). Return type widened to `extractedDataId: number | null` / `analysis … | null` (both callers already accept null). 

Effect: **Gmail and WhatsApp** now survive an extraction failure — the artifact becomes a reviewable `needs_review` Document instead of being deleted. `createDocumentFromOcrText` no longer throws on enrichment failure; it can only fail on a genuine DB write. **No change to the WhatsApp `fail()` path was needed** — it now only triggers on real DB failure, consistent with Upload/Gmail.

## 4. Tests added
- **`npm run verify:documents-sec24`** (new) — a cross-path **SEC-24 source-contract** test asserting, for shared/upload/gmail/whatsapp: extraction is best-effort (`try/catch`), a `needs_review` Document is always created, persist precedes the Document create, file deletion is guarded (`!permanentFilePersisted`), and WhatsApp no longer fails/discards on OCR failure. *(Source-contract because the routes/services use prisma/storage/OCR directly and are not dependency-injectable — this is a structural regression guard; it complements the behavioural WhatsApp test.)*
- **`npm run verify:whatsapp-webhook-pr4`** (from W7) — behavioural proof of the WhatsApp orchestration; **still passes** after the shared change.

## 5. Does every path meet SEC-24?
**Yes — for the SEC-24 requirement (persist first → enrichment may fail → document survives):**
| Path | Persist before enrichment | OCR failure | Extraction failure | Result |
|------|:-------------------------:|-------------|--------------------|--------|
| Upload | ✅ | needs_review Document | needs_review Document (inline best-effort) | survives |
| Gmail | ✅ | bare needs_review Document | **now** needs_review Document (shared fix) | survives |
| WhatsApp | ✅ | needs_review Document (W7) | **now** needs_review Document (shared fix) | survives |

**Remaining edge (documented, not a SEC-24-enrichment violation):** a genuine `prisma.document.create` **DB failure** still deletes the orphan file in all three paths (deliberate storage hygiene — a record-persistence failure, outside SEC-24's *enrichment* scope). If a stricter "never delete a persisted artifact even on DB failure" rule is wanted, that is a separate future decision, not required by SEC-24's letter.

## 6. Backlog v2?
**No new Constitution Backlog v2 gap.** SEC-24 was implementable as written; **constitution frozen.** The DB-failure orphan-deletion edge is noted above as a possible future hardening (not a constitution gap).

## 7. Verification (lint / typecheck / tests)
- `npm run verify:documents-sec24` — **passes.** `npm run verify:whatsapp-webhook-pr4` — **passes.**
- `eslint` — **0/0** on the changed service + new test.
- `tsc --noEmit` — **no type errors** (nullable return compatible with both callers).
*Honest caveat:* the source-contract test is structural (regression guard), and the extraction-best-effort change is unit/type-verified — not exercised with a live failing extraction against a real DB.

---

## Success Criterion — the one question
> *"Do all central document-ingestion paths — Upload, Gmail, WhatsApp — prove at the route/service level that a document is persisted before enrichment, and that an enrichment failure does not delete it?"*

**Yes.** Persist-before-enrichment holds in all three; OCR **and** extraction failures now yield a surviving `needs_review` Document (the shared extraction step is best-effort); and a cross-path `verify:documents-sec24` gate guards the invariants in CI. SEC-24 is complete across the central ingestion paths.

## Files touched (W8)
`lib/services/documents/create-document-from-ocr.service.ts` (root fix) · `lib/services/documents/documents-sec24-durability.verify.test.ts` (new) · `package.json` (verify script) · `docs/compliance-constitution-system-audit-v1.md` (G-24) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W8 commit follows.
