# Dubiz CRM Foundation — Handover (v1)

> **Scope:** the complete CRM Foundation program to date — **Phase 1 (Customer List + Card)**, **Phase 2A (Generic Notes)**, **Phase 2B (Generic Attachments)** — all merged to `main` and released to Production.
>
> **How to read this:** ✅ = verified in code / tests / live checks. ⚠️ = based on code only, not exercised end-to-end, or an open assumption. Every SHA/PR/migration below was confirmed from git / GitHub, not memory.
>
> **Anchor facts (verified from `origin/main`):**
> - CRM merge commits: `1a29d0c` (#108 Customer List+Card) · `1eb50af` (#111 Notes) · `587051b` (#113 Attachments).
> - CRM migrations on main: `20260715120000_add_crm_notes`, `20260716120000_add_crm_attachments`.
> - Schema has `enum CrmSubjectType` + `model CrmNote` + `model CrmAttachment`.
> - `origin/main` HEAD at handover: **`587051ba395534f983d18cf89ffd5532639d710f`** (`587051b`).
> - Committed spec: `docs/dubiz-crm-foundation-spec-v1.md`. The capability-audit doc is **local/untracked** (not on main).

---

## 1. Project purpose
- **Business goal:** give Dubiz a professional, complete CRM surface — manage customers (and later suppliers) with a real card: identity, related documents/payments/conversations/appointments, **notes**, and **file attachments**. Post-benchmark decision: don't copy competitors; ensure baseline business capabilities exist, then build Dubiz's real advantage (Business Brain / insights) on top.
- **Architectural goal:** a **generic**, reusable relationship-management substrate keyed by a polymorphic "CRM subject" (`subjectType` + `subjectId`), so one engine serves Customer, Supplier, and future entities — not a bespoke implementation per entity.
- **Guiding principles:** don't break existing features · no duplicate engines · maximize reuse of existing infra · every capability Generic · Design System v1 only · no added user load · Business Brain explicitly out of scope for the Foundation.

## 2. Background
- A full evidence-based **capability audit** (7 parallel code audits) found the financial core deep (billing, payments, SHAAM, Gmail/WhatsApp, OCR, inventory) but the **CRM surface, read/aggregation layer, and productivity glue missing**: no customer card, no timeline, no per-customer collection status, `notes` scalar unsurfaced, no cross-module search, `Task` model dead, etc.
- Conclusion: most "missing professional features" were a **read/aggregation + thin-UI layer over data that already exists** — the cheap, low-risk foundation for the Brain. CRM Foundation was scoped to build that surface first. (Full findings: local `docs/dubiz-capability-audit-and-roadmap-v1.md`; approved architecture: `docs/dubiz-crm-foundation-spec-v1.md` on main.)

## 3. Working philosophy (held throughout, ✅ observed in the workflow)
- **Code-first / Evidence-first:** every claim anchored to code, tests, or live checks; unverifiable items flagged.
- **Reuse before build; Generic before point-solution:** the subject resolver, storage layer, DS v1 theme, and rate limiter were reused/extended, not re-created.
- **Least privilege / Minimal changes:** storage change derived domain lists from `STORAGE_DOMAINS` instead of a wide refactor; no unrequested refactors.
- **Pipeline per phase:** Audit → Decision → Implementation → Evidence-First report → **PR** → CI → **gated Merge** → **gated Release (release-migrate)** → Smoke. Every merge and prod migration was human-gated.
- **Isolation:** each phase built on a fresh git **worktree** off the latest `origin/main`, never reusing a prior worktree; foreign uncommitted work in the main repo was never touched.

## 4. Architectural decisions
| Decision | Why | Alternatives rejected | Verified in code |
|---|---|---|---|
| **Generic CRM Subject** (`subjectType`+`subjectId`) | one engine for Customer/Supplier/future | per-entity engines (duplication) | ✅ resolver + Notes/Attachments keyed by it; SUPPLIER path integration-tested |
| **`crm-subject.resolver.ts` = single source of truth** | existence + tenant ownership in one place | scattering checks per service | ✅ used by both Notes + Attachments |
| **Do NOT reuse `Party`/`PartyResolutionClaim`** | that's identity-resolution, a different concern | overloading Party | ✅ no Party import in CRM code |
| **`CrmAttachment` separate from `Document`** | user files ≠ financial/OCR docs | merging models; `Document.customerId` | ✅ two models; no `Document` change |
| **Keep scalar `Customer.notes`/`Supplier.notes`** | unbroken "general note" | migrate/convert to CrmNote | ✅ shown separately as "הערה כללית"; untouched |
| **Private `crm` storage domain, server-built key** | private files, no traversal, no user filename in key | public URL; user-filename keys | ✅ domain-policy private; key from MIME |
| **Stream download (no signed URL)** | local adapter throws on signed URL; works on both | signed-URL redirect | ✅ authenticated route streams bytes |
| **Hard delete + reconciliation ordering** | CRM records aren't legal/immutable; avoid silent best-effort | soft-delete; silent best-effort | ✅ delete object→then metadata; failures surface |
| **`canEdit`/`canDelete` from server in DTO** | UI must not infer permissions | client-side permission logic | ✅ DTO fields; UI gates on them |
| **Consolidate the 2 legacy customer-create endpoints** | unify phone normalization/validation | leave divergent | ✅ both delegate to `customer.service` |
| **Migrations additive + gated release** | zero-downtime, no backfill | destructive/backfill | ✅ all CREATE-only; applied via `release-migrate` |

## 5. Chronology per phase

### Phase 1 — Customer List + Customer Card foundation
- **PR #108** · squash **merge `1a29d0cfb89147addc4306e29c83f86910f0a603`** (`1a29d0c`) · pre-merge feature commit `5031620` (rebased from `c498f87`). ✅
- **CI:** all green (`verify`, `release/verify`, Vercel ×2). **Release:** live in Production (Vercel deploy from `1a29d0c`). **No migration** (used existing `Customer` + relations).
- **Goal:** first real CRM surface — customer list + read-only card over existing data.
- **Built:** canonical `customer.service.ts` (create/update/get/list/search, unified phone normalization); `customer-card.read-model.ts` (tenant-scoped aggregation of REAL relations only — billing docs, payment requests, conversations, appointments); `GET/POST /api/customers`, `GET /api/customers/[id]`; DS v1 list page + card page; `lib/design/crm-theme.ts`; `lib/format/phone-display.ts` (display-only IL phone formatter); consolidated `/api/customer` + `/api/billing/customers` to delegate to the service.
- **Files:** 19 (14 new + 4 modified routes/pkg + `docs/dubiz-crm-foundation-spec-v1.md`). ⚠️ exact list is in the PR #108 diff.
- **Tests:** `verify:crm-customer` (service + endpoint-parity), `verify:crm-customer-card` (read-model, tenant, real-relations-only), `verify:crm-phone-format`. ✅
- **Decisions:** show only truthful data (no fabricated balances/last-activity); `lastActivity` derived from real timestamps. **Risks found + fixed pre-merge:** (a) `lastActivity` initially used a **future** appointment `startsAt` → fixed to use `createdAt`; (b) payment item title == badge duplication → title set to "בקשת תשלום"; (c) raw canonical phone shown → `formatPhoneForDisplay`.
- **Navigation:** entry added to the canonical `/tools` ("כל הכלים") menu — **not** the Bottom Bar (which stayed unchanged).

### Phase 2A — Generic Notes
- **PR #111** · squash **merge `1eb50af26068614eb8bc25139247b06cef22c5da`** (`1eb50af`) · pre-merge `226bc03` (rebased from `564a0a6`). ✅
- **CI:** all green. **Migration `20260715120000_add_crm_notes`** applied to Production via gated `release-migrate` **run 29465404929** (success; "Database schema is up to date"). Live in Production. ✅
- **Goal:** generic threaded notes on any CRM subject; first wired to the customer card.
- **Built:** `enum CrmSubjectType {CUSTOMER, SUPPLIER}`; `model CrmNote`; `lib/services/crm/crm-subject.resolver.ts` (validates type/id/existence/tenant; cross-tenant→NotFound); `lib/services/crm/crm-notes.service.ts` (list/create/update/delete/count; author-owned; hard delete; DTO with `canEdit`/`canDelete`); `GET/POST /api/crm/subjects/:subjectType/:subjectId/notes`, `PATCH/DELETE /api/crm/notes/:noteId`; `components/crm/NotesThread.tsx`; wired into card; client `lib/api/crm-notes.ts`.
- **Files:** 13. **Migration:** `add_crm_notes` (enum + table + 2 indexes + FKs).
- **Tests:** `verify:crm-subject`, `verify:crm-notes` (service + API: tenant, ownership, null-author read-only, validation, 401, DTO-no-businessId, cross-tenant 404). ✅
- **Decisions:** hard delete (no soft-delete/tombstones); only author edits/deletes; a cleared author (`null`) → read-only; scalar `Customer.notes` kept separate as "הערה כללית"; `businessId` always from session. **No** `notesCount` added to the read-model (NotesThread self-counts). **Risk (fixed):** future-date issue predated this; Notes had no correctness blockers.

### Phase 2B — Generic Attachments
- **PR #113** · squash **merge `587051ba395534f983d18cf89ffd5532639d710f`** (`587051b`) · pre-merge `3a02515` (feature) + `9e0c79b` (hardening); rebased from `fada666` + `b2a1d0a`. ✅
- **CI:** all green. **Migration `20260716120000_add_crm_attachments`** applied to Production via gated `release-migrate` **run 29509876416** (success; PRE pending = only this migration; POST "up to date"). Live in Production. ✅
- **Goal:** generic file attachments on any CRM subject; first wired to the customer card.
- **Built:** `model CrmAttachment`; new private storage domain **`crm`**; `lib/services/crm/crm-attachment-storage.ts` (MIME allowlist, MIME→ext, server-built key, validation, put/read/delete); `lib/services/crm/crm-attachments.service.ts` (list/upload/getForDownload/delete; compensation on upload; reconciliation-safe delete); rate-limit bucket `CRM_ATTACHMENT_UPLOAD`; `GET/POST /api/crm/subjects/:type/:id/attachments`, `GET /api/crm/attachments/:id/file` (streamed), `DELETE /api/crm/attachments/:id`; `components/crm/AttachmentList.tsx` (real upload progress via XHR); wired into card; client `lib/api/crm-attachments.ts`.
- **Storage changes (minimal, general):** `types.ts` STORAGE_DOMAINS += "crm"; `domain-policy.ts` crm:"private"; `key-validation.ts` regex derived from STORAGE_DOMAINS (supports nested paths); `r2-storage.adapter.ts` `parseDomain` derived from STORAGE_DOMAINS.
- **Files:** 20 (2 commits). **Migration:** `add_crm_attachments` (table + 3 indexes + FKs; reuses existing `CrmSubjectType`, no `CREATE TYPE`).
- **Tests:** `verify:crm-attachment-storage` (key build C/S, nested, traversal, MIME→ext, validation, bucket contract), `verify:crm-attachments` (upload C+S, list, tenant, download, delete author-only/null-readonly/idempotent-missing, API 401/no-file/>1-file/DTO-no-key/cross-tenant-404). Regression: storage + rate-limiter + all Phase 1/2A. `tsc`=0. ✅
- **Risk found + fixed (2nd commit `9e0c79b`):** upload buffered the whole file before size validation → added a `file.size` **pre-check (413)** before `arrayBuffer()`, mirroring the Documents route (service still validates real `buffer.length`).
- **⚠️ Open:** the **real R2 path** was exercised only via the **local storage adapter** in tests; full R2 upload/download/delete not yet run end-to-end.

## 6. Data model
- **Pre-existing (not created by us):** `Customer` (we built the surface + read-model over it), `Supplier` (engine-ready, no UI), plus related `BillingDocument`, `PaymentRequest`, `Conversation`, `Appointment` (read by the card).
- **`enum CrmSubjectType { CUSTOMER, SUPPLIER }`** — Phase 2A. Reused by Notes + Attachments. ✅
- **`model CrmNote`** — `id, businessId, subjectType, subjectId, body, createdByUserId?, createdAt, updatedAt`. Indexes: `(businessId, subjectType, subjectId, createdAt)`, `(createdByUserId)`. FKs: `business` **Cascade**, `createdByUser` **SetNull**. Back-relations: `Business.crmNotes`, `User.crmNotesCreated`. ✅
- **`model CrmAttachment`** — `id, businessId, subjectType, subjectId, storageKey, originalFileName, mimeType, sizeBytes, uploadedByUserId?, createdAt`. Indexes: `@@unique(businessId, storageKey)`, `(businessId, subjectType, subjectId, createdAt)`, `(uploadedByUserId)`. FKs: `business` **Cascade**, `uploadedByUser` **SetNull**. Back-relations: `Business.crmAttachments`, `User.crmAttachmentsUploaded`. ✅
- **Polymorphic by design:** no FK from CrmNote/CrmAttachment to Customer/Supplier — the resolver enforces existence + tenancy.
- **Deliberately NOT changed:** `Document` (no `Document.customerId`), `Customer.notes` / `Supplier.notes` scalars (kept as "general note"). ✅

## 7. Architecture
- **CRM Subject Resolver** (`crm-subject.resolver.ts`): `resolveCrmSubject({businessId, subjectType, subjectId})` → validates type (`parseCrmSubjectType`), id, then existence via `Customer`/`Supplier` `findFirst` scoped to `businessId`. Missing OR cross-tenant → identical `NotFoundError` (no leak). Returns `{businessId, subjectType, subjectId, displayName}`. Single source of truth. ✅
- **Notes:** author-owned threaded notes; `canModify = createdByUserId !== null && === actingUser`. List newest-first, cap 100. Scalar note shown separately.
- **Attachments:** upload → object then DB (compensation deletes orphan on DB failure); download streams via authenticated route; delete: object (idempotent) → metadata, with reconciliation-safe ordering.
- **Storage:** shared `lib/storage` `StorageService` (R2 prod / local dev); domain `crm` private; key `biz/{businessId}/crm/{subjectType}/{subjectId}/att-{ts}-{rand}.{ext}`; domain validation derived from `STORAGE_DOMAINS`.
- **Authorization / Tenant / Ownership:** every query scoped by session `businessId`; read/list/download = any business member; delete = uploader/author only; `businessId` never accepted from the request.
- **DTO design:** returns minimal safe fields + `canEdit`/`canDelete`; **never** `storageKey`/`businessId`/`subjectId`. ✅ (asserted in tests)
- **Rate limiting:** `CRM_ATTACHMENT_UPLOAD` bucket, **fail-closed**, per-user + per-business.
- **Validation:** MIME allowlist + original-extension match + 15MB (server, real byte length) + declared-size pre-check (413).
- **API layer:** `getCurrentUser` + `AppError`/`handleError` + service only (no Prisma in routes). **UI layer:** subject-based components (`NotesThread`, `AttachmentList`), DS v1 via `crm-theme.ts`.

## 8. Security (✅ verified in tests unless noted)
- **Tenant isolation:** cross-tenant list/read/download/delete → NotFound/404, no leak. ✅
- **IDOR:** notes/attachments always loaded via `where {id, businessId}`. ✅
- **Path traversal:** server-built key + `assertSafeStorageKey` rejects `..`/absolute; filename sanitized (control chars + path stripped); extension from validated MIME. ✅
- **MIME validation:** closed allowlist (PDF, JPEG, PNG, WebP, GIF, HEIC, HEIF, DOCX, XLSX, PPTX, TXT, CSV) + extension consistency; blocks octet-stream, `*/*`, SVG, ZIP, EXE, HTML, empty. ✅
- **Size validation:** 15MB, server-side on real byte length + declared-size 413 pre-check. ✅
- **Storage security:** private domain, no public URL for `crm` (`getPublicUrl`→null), streamed download (key never exposed). ✅ code; ⚠️ not exercised against real R2.
- **DTO security:** no `storageKey`/`businessId`. ✅
- **Permissions:** author/uploader-only mutation; null-author read-only. ✅
- **Header safety:** `Content-Disposition` uses sanitized filename (RFC 5987). ✅ code.

## 9. Storage
- **How it works:** `getStorageService()` (lazy singleton) picks adapter by `STORAGE_PROVIDER` (`r2` prod / `local` dev). Domains: documents, billing, content, inventory, offers, **crm**. Visibility per domain (`crm` = private). Keys validated by shared `key-validation.ts` (`biz/{businessId}/{domain}/...`, derived domain set, `..` blocked, nested allowed).
- **Key generation (crm):** server-only, extension from MIME, random basename — no user input in key. ✅
- **R2 adapter:** put/get/head/delete/getSignedDownloadUrl/getPublicUrl; `parseDomain` derived (includes crm); `getPublicUrl` returns null for crm.
- **Local adapter:** sidecar-metadata files; nested dirs via recursive mkdir; **throws on `getSignedDownloadUrl`** (hence streaming download).
- **Verified:** ✅ full flow via **local adapter** (unit + integration in a temp dir); storage regression passed. **⚠️ Not verified:** real **Cloudflare R2** upload/download/delete end-to-end.

## 10. Testing
- **Unit:** `verify:crm-phone-format`, `verify:crm-attachment-storage` (+bucket contract). ✅
- **Integration (real dev DB):** `verify:crm-customer`, `verify:crm-customer-card`, `verify:crm-subject`, `verify:crm-notes`, `verify:crm-attachments`. ✅
- **Regression:** `storage.verify.test`, `rate-limiter.verify.test`, all Phase 1/2A tests re-run each phase. ✅
- **Build/TS/Prisma:** `tsc --noEmit`=0 each phase; `prisma validate`=valid; `prisma migrate diff` confirmed migration↔schema exact match (attachments). ✅
- **CI:** `verify` + `release/verify` + Vercel ×2 green on every PR. ✅
- **Visual (dev, `dev:webpack`, forced local storage):** Notes (add/edit/delete-confirm, author vs non-author, empty/mobile) and Attachments (upload + real progress bar, list, owner vs non-uploader download-only, mobile RTL no-overflow) — screenshots captured. ✅ (some interactions confirmed via API/integration due to Playwright timing).
- **Smoke (Production, unauth):** all CRM routes return 401 (not 404/500); customer card/tools/customers 200. ✅
- **⚠️ Not verified:** authenticated Production flows (no test account); full R2 flow.

## 11. All PRs
| PR | Purpose | Merge SHA | Included | Excluded | CI | Deploy | Release |
|---|---|---|---|---|---|---|---|
| **#108** | Customer List + Card | `1a29d0c` | 19 files (service, read-model, /api/customers, DS v1 pages, phone formatter, spec doc, /tools entry) | Supplier UI, notes, attachments, timeline, Brain | ✅ green | ✅ Vercel ×2 | ✅ live (no migration) |
| **#111** | Generic Notes | `1eb50af` | 13 files (CrmSubjectType, CrmNote, resolver, notes service+API, NotesThread, migration) | Attachments, Document.customerId, Timeline/Activity/Learning | ✅ green | ✅ Vercel ×2 | ✅ migration `add_crm_notes` applied (run 29465404929) |
| **#113** | Generic Attachments | `587051b` | 20 files (CrmAttachment, crm storage domain, storage helper, service, 3 API routes, AttachmentList, rate-limit bucket, migration, file.size hardening) | Document.customerId, OCR-link, Timeline/Activity/Learning, Supplier UI, AV scanning | ✅ green | ✅ Vercel ×2 | ✅ migration `add_crm_attachments` applied (run 29509876416) |

## 12. Production state
- **Live features:** ✅ Customer List (`/customers`), Customer Card (`/customers/[id]`) with identity + billing/payments/conversations/appointments + **Notes** + **Attachments**; entry via `/tools` ("לקוחות").
- **Migrations applied to prod:** `add_crm_notes` ✅, `add_crm_attachments` ✅ (schema "up to date").
- **Not live:** Supplier UI (engine ready), and everything in §13.
- **⚠️ Open risks in prod:**
  1. **Full R2 flow unverified end-to-end** (basic smoke = routes 401 + table exists; no authenticated real-file test).
  2. **Rate limits** (user 20/min+100/hr, business 60/min+500/day, fail-closed) are **first-release values**, pending production tuning.

## 13. Deliberately NOT built (deferred)
- `Document.customerId` / linking OCR docs to a customer (deferred until a real product flow exists).
- Supplier **Card/List UI** (engine + resolver already support SUPPLIER).
- Contacts (multiple contact persons + roles).
- Timeline, Activity feed, Collection Summary, Customer Profitability (deferred; some are Brain-adjacent).
- Tags, Tasks, Reminders (delivery), Bulk Actions.
- Customer Portal, Digital Signature, Global Search, multi-currency picker, i18n, intra-business RBAC, multi-business.
- Wide Storage refactor; malware/AV content scanning (documented as future hardening).
- Business Brain / learning logic (explicitly out of scope for the Foundation).
> Rationale throughout: build the deterministic read/aggregation + thin-UI substrate first; add intelligence and breadth on top later.

## 14. Lessons learned
- **node_modules junction hazard (⚠️ important):** each worktree junctioned `node_modules` to the main repo's. The **generated Prisma client is shared** — when another context regenerated it (Phase 2B), this worktree's tests/tsc broke (missing `crmAttachment`, mismatched `HELD` enum). **Fix/lesson:** run `npx prisma generate` from the worktree's own schema before tests; treat the shared client as volatile.
- **Turbopack rejects the junctioned `node_modules`** ("symlink out of filesystem root") → used **`dev:webpack`** for all visual reviews.
- **Don't run `tsc` while the Next dev server is up** (Phase 1 hit a Turbopack `.next` write panic / os error 1224 on Windows). Delete `.next` and run tsc with the server stopped.
- **Playwright timing flakes:** on `dev:webpack` first-compile, fresh page loads showed loading/skeleton at screenshot time; needed explicit content-selector waits + API-level assertions. Screenshots alone were insufficient.
- **Force `STORAGE_PROVIDER=local`** for visual reviews so uploads never hit the real R2 bucket.
- **Same-timestamp migrations coexist:** `20260716120000_add_authority_submission_held` (#112) and `20260716120000_add_crm_attachments` share a timestamp; Prisma orders by full dir name — safe.
- **Rebase onto latest `origin/main` before every PR** (main advanced between every phase); auto-merge on `schema.prisma` worked because additions were in different hunks.
- **Prod vs dev DB drift:** the dev DB lagged main (missing prior migrations); prod was ahead of dev. Verified pending sets via `migrate diff` / the workflow's pre-status, never assumed.
- **Decisions that proved right:** generic subject-keyed engines (resolver reused verbatim in 2A→2B); keeping `CrmAttachment` ≠ `Document`; streaming download; reconciliation-safe delete; consolidating the two customer-create endpoints.

## 15. Git state (at handover)
- **`origin/main` = `587051b`** (`587051ba395534f983d18cf89ffd5532639d710f`). All three CRM PRs merged (squash).
- **Branches deleted (remote + local):** `feat/crm-foundation-phase-1` (⚠️ the main working repo is still *checked out* on this branch locally, but the CRM work is merged to main), `feat/crm-foundation-phase-2-notes-attachments`, `feat/crm-foundation-phase-2b-attachments`.
- **Worktrees removed:** `bp-crm-phase2` (Notes), `bp-crm-phase2b` (Attachments). node_modules junctions removed safely (main `node_modules` intact).
- **⚠️ Unrelated open work in the main repo working tree (NOT ours, untouched):** modified `app/(shell)/app/page.tsx`, `app/api/home/route.ts`, `app/layout.tsx`, `features/home/*`, `lib/services/billing/uniform/*`; untracked `.tmp/`, `docs/dubiz-capability-audit-and-roadmap-v1.md`, `docs/dubiz-gmail-*`, `docs/google-gmail-*`, `features/home/components/`, `public/secretary-avatar.jpg`. These belong to other sessions/pre-existing work — do not assume they are CRM-related and do not commit them with CRM work.

## 16. Final state
- **Completed & released to Production:** Phase 1 (Customer List + Card), Phase 2A (Notes), Phase 2B (Attachments). All merged to `main`, deployed (Vercel ×2), migrations applied via gated `release-migrate`, schema "up to date". ✅
- **Verified:** service/API/security logic (integration), storage helper + traversal (unit), migration↔schema match, CI green, Production basic smoke (routes 401, no 500), Notes + Attachments UI in dev. ✅
- **Still open (⚠️):** (1) **full R2 end-to-end smoke** with an approved test account (upload→list→download→delete→verify object gone→reject bad/oversize); (2) **rate-limit tuning** before scale; (3) delete **reconciliation** branches not exercised in practice; (4) Supplier UI not built (engine ready).
- **Recommended next step (not started):** run the **full R2 smoke** on Production using an approved test account (per §16.1) to close the last residual risk; then choose the next capability — the strongest candidates are **Supplier Card** (reuse the entire engine — only UI + `PurchaseOrder.supplierId` FK) or **Contacts**, both of which the generic subject substrate already supports.

---
*Handover based on verified git/GitHub state (`origin/main` `587051b`), the three merged PRs (#108/#111/#113), two applied migrations, and the test suite. Items marked ⚠️ are explicitly not verified end-to-end.*
