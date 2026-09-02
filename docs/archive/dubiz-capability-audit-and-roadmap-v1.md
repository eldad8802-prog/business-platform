# Dubiz — Business Capability Audit & Completion Roadmap (v1)

> **Purpose.** Evidence-based audit of Dubiz's *professional business-management* capabilities (post-benchmark vs. יש‑חשבונית et al.), plus a clean completion roadmap. Every status below is anchored to real code. Items that could not be verified in code are marked **UNVERIFIED**.
>
> **Strategic frame (binding).** The goal is **not** to copy competitors. The goal is: (1) ensure Dubiz has the baseline capabilities expected from a professional business platform, then (2) build Dubiz's real advantage — Business Brain, learning engines, insights, automation — on top of that baseline.
>
> **Non-negotiables carried into every roadmap item:** don't break existing features; no unrequested refactors; integrate into existing architecture; Design System v1 is the only language; no added user load (fewer clicks / fewer decisions).
>
> Method: 7 parallel code audits across CRM, Documents, Files, Search, Data, Activity, Productivity, Business. Date: 2026-07-13.

---

## 0. Executive summary — what Dubiz actually is today

Dubiz is **not** a thin invoicing clone. It already has deep, compliance-grade billing (atomic gapless numbering, immutable issued snapshots, SHAAM/Uniform export, credit/reversal lifecycle), a real payments stack (Tranzila/Cardcom/PayPal), Gmail + WhatsApp integrations, an OCR document-ingestion engine, inventory + supplier purchasing, and a "Secretary" obligations engine.

The gaps vs. a "professional business platform" checklist are **not** in the financial core — they are almost entirely in the **CRM surface, the read/aggregation layer, and cross-cutting productivity glue**:

- **The data exists; the surfaces don't.** Customers already relate to invoices, conversations, messages, appointments and payment requests — but nothing aggregates them. There is **no customer card, no activity timeline, no per-customer collection status**, and `notes` fields exist but are never displayed.
- **A few one-line-away wins.** Payment terms / due dates are entirely absent, which blocks any real "collections" / aging story. Global search covers only financial records. Billing has no embedded preview and no print button despite producing clean A4 PDFs.
- **Some models are decorative.** `Task` / `TaskStatus` are dead code (0 usages). `Business.archivedAt` scaffold is unused. `currency` columns exist everywhere but are write-once-ILS.
- **Two architectural forks to reconcile before building on top:** duplicate customer-create endpoints with divergent phone normalization; `PurchaseOrder.supplierName` is a string, not an FK to `Supplier` (blocks supplier purchase history).
- **One compliance-critical open thread:** SHAAM/ITA allocation has full OAuth + state machine but **no verified live HTTP transport** for the allocation request — treat as incomplete pending confirmation.

**Bottom line:** most "missing professional features" are a **read/aggregation + thin-UI layer over data that already exists**, not new engines. That is exactly the cheap, low-risk foundation the Brain should sit on.

---

## 1. Legend

- **Status:** `Exists` / `Partial` / `Missing`
- **Priority:** `Critical` (compliance/blocks core value) · `High` (baseline professional expectation) · `Medium` (valuable, not blocking) · `Low` (nice-to-have / defer)
- **Complexity:** `S` (≤ few days, no migration) · `M` (feature w/ migration) · `L` (multi-part / cross-cutting) · `XL` (architectural)
- **MVP?** = belongs in the near-term "professional parity" push (Wave 1/2) vs. Defer.

---

## 2. CRM

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| כרטיס לקוח מלא | **Partial** | APIs exist: `app/api/customer/route.ts`, `app/api/billing/customers/route.ts`, `.../[id]/route.ts` (PATCH only edits tax fields). Identity select `lib/billing/customer-tax-identity.ts`. **No customer detail page** anywhere in `app/(shell)`. | Detail page rendering the customer + its `billingDocuments/conversations/messages/appointments/paymentRequests`; general edit (not just tax). | New `app/(shell)/customers/[id]` page fed by an extended `[id]` GET (already `businessId`-scoped). Consolidate the two create endpoints into one normalized service. | **High** | M | — (data exists) | **MVP.** Hub for CRM. Build the card first; everything below hangs off it. |
| כרטיס ספק מלא | **Partial** | Full CRUD service `lib/services/inventory/supplier.service.ts` + `app/api/inventory/suppliers/*`. No supplier detail UI. `Supplier` model minimal (`schema.prisma:1684`): name/phone/email/notes/leadTime only. | Supplier card UI; supplier purchase history (blocked: `PurchaseOrder.supplierName` is a **string, not FK**). | Supplier detail page on existing `getSupplier`; add `PurchaseOrder.supplierId` FK migration to enable history join. | Medium | M | PO→Supplier FK | **MVP-light.** Build card; do the FK migration to unlock history. |
| אנשי קשר (Contacts) | **Missing** | No `Contact` model. Customer/Supplier each hold **one** inline phone/email. `Party`/`PartyResolutionClaim` is identity-resolution, **not** contacts. | Multiple contact persons per customer/supplier. | New `Contact` model (FK to Customer & Supplier) + UI on the card. | Medium | M | Customer/Supplier card | **Defer to Wave 2.** Most IL SMBs = one contact; don't add load before the card exists. |
| היסטוריית פעילות | **Missing** | No activity/interaction model. Relations exist but nothing aggregates them. | Per-customer activity feed. | Read-only aggregator endpoint unioning existing `Customer` relations by timestamp — **no new table**. | **High** | M | Customer card | **MVP.** Cheap (derive, don't store). Part of the card. |
| הערות (Notes) | **Partial** | `Customer.notes` (`schema.prisma:612`) & `Supplier.notes` (`:1691`) exist; write paths accept them. **Not** in `CUSTOMER_BILLING_IDENTITY_SELECT`; **no UI reads them.** | Display + edit in UI; (optional) dated/threaded notes. | Surface existing scalar in the card + add to select. Only add a `Note` model if threading is required (design with activity feed to avoid twin tables). | **High** | S | Customer card | **MVP quick win.** Field already exists — just surface it. |
| סטטוס גבייה (Collection) | **Partial** | `lib/services/payments/collection-*` exists but is **PaymentRequest (CardCom link) only** — explicitly *no aging/overdue*. Per-invoice `computeRemainingAllocatable` exists at write-time (`billing-receipt-allocation.rules.ts`). | Per-customer receivable rollup; invoice paid/open **read** status; aging; due date. | Read-model per `customerId`: Σ issued invoices − `BillingPaymentAllocation`. **Requires due-date field** (see Payment Terms). Do **not** extend the link-only collection-view. | **Critical** | M | Payment Terms (due date) | **MVP.** Highest-value CRM-financial gap; foundational to any "collections" story. |
| רווחיות לקוח | **Missing** | `Deal` has margin fields (`schema.prisma:633-640`) but **no `customerId`** — margin can't attribute to a customer. `FinancialRecord` has no `customerId`. | Revenue/cost/margin per customer. | Aggregate issued-invoice revenue per customer; add `Deal.customerId` for cost/margin. | Medium | L | `Deal.customerId`, revenue rollup | **Defer (Brain territory).** Natural first Brain insight once card + rollups exist. |
| ציר זמן מלא (Timeline) | **Missing** | Only per-PaymentRequest ledger timeline. No unified per-customer timeline. All source rows carry `customerId`. | Merge invoices + payments + messages + appointments + deals into one feed. | Customer-scoped aggregator (same as activity feed) merged by timestamp. | **High** | M | Customer card | **MVP.** Same aggregator as activity history — build once. |
| שיוך קבצים ללקוח | **Missing** | `BillingDocument` links to customer; **uploaded `Document` (`schema.prisma:1101`) has no `customerId`.** | Attach uploaded/OCR docs to a customer. | Add nullable `Document.customerId` + back-relation. Use canonical `Document` (not legacy `FinancialDocument`). | **High** | M | Migration | **MVP.** Small migration; big CRM payoff. |

---

## 3. Documents

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| חתימה דיגיטלית | **Missing** | None. `חתימה` appears only as an OCR keyword. Auth-token HMAC is unrelated. | Full e-signature (capture + embed + verify). | Net-new: signature artifact on `BillingDocument` + inject into PDF template + capture UI. | Low | L | PDF template | **Defer.** No IL-compliance need today; net-new. |
| תבניות מסמכים | **Exists** | 1 template `billing-v1`, **3 presets** CLASSIC/MODERN/COMPACT (`lib/billing/billing-pdf-template-style.ts`), business-level, **frozen into issued snapshot**. Picker `BillingDocumentStylePicker.tsx` w/ MiniPreview. | User-editable/custom templates; per-doc override; color/font. | Extend preset union or go data-driven; snapshot-freeze pattern already correct. | Low | M | — | **Keep as-is;** extend only on demand. |
| תצוגה מקדימה | **Partial** | Docs/OCR engine: full iframe/img overlay (`DocumentFilePreviewOverlay.tsx`, `ReviewDocumentPreview.tsx`). **Billing: open-in-new-tab only** — no embedded PDF preview. | Embedded in-page billing preview. | Reuse the OCR overlay's iframe/blob pattern against `/api/billing/documents/[id]/pdf`. | Medium | S | — | **MVP quick win.** Reuse existing component. |
| שיתוף (Sharing) | **Partial** | Billing hero has share menu: Web Share, WhatsApp (**text only, no file**), copy link (**auth-protected URL — not publicly openable**). | True public/tokenized share link; server-side email send; WhatsApp w/ file. | Add a **signed, expiring public PDF route** keyed to the document — also unlocks the customer portal. | **High** | M | Tokenized route | **MVP.** One tokenized route → sharing *and* portal. |
| ייצוא (Export) | **Exists** | Billing PDF (`.../[id]/pdf`), Accountant ZIP (`/api/reports/export-zip`), SHAAM Uniform (`lib/services/billing/uniform/*`). | CSV/XLSX of a single document (rare). | — | — | — | — | **Keep.** Mature. |
| הדפסה (Print) | **Missing** | No `window.print()` / `@media print` / print button. Users print via browser PDF. | In-app print affordance. | Print button on hero/overlay invoking print on the existing PDF blob. | Low | S | Embedded preview | **MVP quick win.** Trivial once preview embed lands. |

---

## 4. Files

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| ניהול קבצים | **Partial** | Real storage layer `lib/storage/*` — **Cloudflare R2** (prod) / local (dev); **not** Vercel Blob/S3. Organized per-domain (documents/billing/content/inventory/offers). **No general `File` model / no file-browser UI.** Legacy `public/uploads/` (270+ orphaned files). | Unified file registry/browse/delete; file metadata. | Only if a real need emerges; otherwise keep per-domain. Clean up `public/uploads` + throwaway `app/upload`, `app/test-upload`. | Medium | L | — | **Defer** the manager; **do** the dead-file cleanup. |
| שיוך קבצים למסמך | **Exists** (inverted) | A `Document` *is* the file; `EmailAttachmentImport.documentId` / `WhatsAppAttachmentImport.documentId` link import→Document. Arbitrary secondary-attachment does not exist. | Attaching an extra file to an existing document. | New `DocumentAttachment` table only if required. | Low | M | — | **Defer.** |
| שיוך קבצים לפרויקט | **Missing** | **No `Project` model exists** (only Neon release tooling uses "project"). | Entire project concept. | Out of scope until a Project entity is designed. | Low | XL | New Project domain | **Defer / out of scope.** |

---

## 5. Search

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| חיפוש גלובלי | **Partial** | Single route `app/api/search/route.ts` queries **`FinancialRecord` only** (vendorName/category). UI `app/(shell)/documents/search/page.tsx`. Legacy `app/search/page.tsx`. | Coverage beyond finance. | Expand into a fan-out search (below). Retire legacy `app/search`. | **High** | M | — | **MVP.** |
| חיפוש חוצה מודולים | **Missing** | No route spans modules; only the single-model finance search. | Federated search. | `/api/search/global` fanning out over `Customer`, `InventoryItem`, `BillingDocument`, `Document/FinancialRecord`, all `businessId`-scoped, discriminated `type` per result. Postgres FTS later for scale. | **High** | M | — | **MVP.** Big UX signal of "professional platform"; cheap as `findMany` fan-out. |

---

## 6. Data

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| Import | **Partial** | CSV import **supplier-purchases only** (`app/api/inventory/supplier-purchases/import/csv/route.ts` + connector/adapter pattern). No customer/product import; no Excel-in. | Customer/product CSV import; Excel read. | Reuse connector/adapter pattern; add customer/product connectors + routes. Excel via `ExcelJS.xlsx.load()` → same adapters. | Medium | M | — | **MVP-light.** Customer/product import eases migration *from competitors* — strategic for onboarding. |
| Export | **Exists** | CSV `/api/reports/export` (finance) + Accountant ZIP + summary. | Export for customers/inventory. | Extend export to more entities; adopt the escaped writer. | Medium | S | — | **MVP-light.** |
| CSV (read/write) | **Exists** (w/ bug) | Read: supplier parser. Write: **`/api/reports/export` uses naive `join(",")` — no escaping** (injection/corruption risk); `accountant-export-zip.ts` has a proper escaped writer. | Fix the unescaped export. | Reuse `escapeCsvField` from the accountant module in the reports route. | High (bugfix) | S | — | **Quick fix.** Correctness bug — do early. |
| Excel (xlsx) | **Partial** | Write only — `exceljs` (`accountant-export-zip.ts:216-295`). No read. | Excel import. | `ExcelJS.Workbook().xlsx.load()` into row adapters. | Low | M | Import | **Defer** read. |
| PDF | **Exists** | **3 engines:** Chromium HTML (canonical billing), pdfmake (legacy billing + supplier docs), jsPDF (supplier). Playwright-in-serverless is a flagged deploy concern. | — | Consolidate onto Chromium HTML once RTL parity confirmed; retire pdfmake billing path. | Low (debt) | M | — | **Keep; consolidate later.** Don't refactor now. |

---

## 7. Activity

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| Audit Log | **Exists** (fragmented) | **4 separate systems:** `LearningEvent` (general, via `audit.service.ts` — thin: coupons/offers/redeem only), `BillingAuditEvent` (broad, hashed), `PaymentAuditEvent` (hashed, wired), `PlatformAuditEvent` (admin, wired + UI). Duplicate hash/stable-JSON code in billing & payments. | Unified audit; coverage for inventory/documents/customers. | Either designate one canonical writer, or incrementally extend `logAuditEvent` coverage + extract shared hash helper. | Medium | L | — | **Defer unification.** Extend coverage opportunistically. |
| Timeline | **Partial** | Payments timeline wired to `app/(shell)/payments/[id]`. `getBillingDocumentAuditTimeline` **defined but unwired.** | Cross-entity feed. | Wire billing timeline into billing detail (quick). Converge with the customer timeline (§2). | Medium | S–M | Customer timeline | **Quick win + fold into CRM timeline.** |
| Recycle Bin | **Missing** | No `deletedAt`/soft-delete anywhere. `Business.archivedAt` scaffold + migration exist but **zero code usage**. Deletes are hard (`onDelete: Cascade`). | Soft-delete + restore convention. | Cheapest: activate `Business.archivedAt`. General bin = soft-delete convention + query filtering across models (absent today). | Low | M | — | **Defer.** Financial trails are intentionally append-only; don't retrofit lightly. |

---

## 8. Productivity

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| תגיות (Tags) | **Missing** | No `Tag` model. UI "tags" are derived display chips only (`inventory-primitives.tsx:600`). | Tag entity + assignment + filter. | `Tag` + polymorphic join, or `String[]` for free-text; assignment UI. | Medium | M | — | **Defer to Wave 2.** |
| תזכורות (Reminders) | **Partial** | In-app snooze/follow-up on `BusinessObligation` (`followUpAt`) + pull-based morning briefing (`/api/obligations/briefing`). **No scheduler/queue/push — no delivery mechanism.** | Scheduled delivery + `Notification` model. | Cron/queue reads `dueAt`/`followUpAt` → deliver via **existing WhatsApp integration**; add `Notification` for tracking. | **High** | M | Scheduler infra, WhatsApp | **MVP (Secretary value).** Data layer ready; only scheduler + delivery missing. |
| משימות (Tasks) | **Missing / dead code** | `Task` + `TaskStatus` (`schema.prisma:985`) = **0 usages** (dead). Real "tasks" = domain `BusinessObligation` + `Appointment` (full stacks). | Decide intent. | Either **remove** dead `Task` model, or build service+API+UI mirroring the obligations pattern. | Medium | M | — | **Remove dead code now;** defer a general to-do unless a real need surfaces. |
| Bulk Actions | **Missing** | None. All mutation routes are single-`[id]`. No multi-select anywhere. | Selection + bulk bar + batch endpoints. | Reusable selection hook + action bar; batch endpoints (or client fan-out interim). Pilot on inbox or inventory. | Medium | M | — | **MVP-light.** Pilot one high-volume list. |

---

## 9. Business / Platform

| Feature | Status | Current Implementation (code) | Missing Parts | Recommended Architecture | Priority | Complexity | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|---|
| פורטל לקוח | **Missing** | No customer auth (customers have no credentials); no `(portal)` route. Closest = `PaymentRequest.paymentUrl` (provider-hosted link). | Customer-facing document/invoice view. | **Magic-link / signed-token** surface reusing `BillingDocument.pdfStorageKey` — not full customer accounts. | Medium→High | L | Tokenized share route (§3) | **Wave 2.** Reuse the tokenized link; avoid building accounts. |
| אינטגרציות | **Partial** | Gmail (`EmailConnection`), WhatsApp (`WhatsAppConnection`), Payments (Tranzila/Cardcom/PayPal) — **implemented**. POS inbound (`POSApiKey`). **SHAAM/ITA: full OAuth + state machine but NO verified live HTTP transport** for allocation request. Tranzila webhook accepts unsigned when no secret. | SHAAM allocation HTTP call; Tranzila webhook signature hardening. | Implement/inject ITA allocation HTTP client behind existing state machine. | **Critical** (SHAAM) | M | — | **Compliance track.** Complete SHAAM transport; harden webhook. Separate from the parity push. |
| ריבוי מטבעות | **Partial** | `currency @default("ILS")` stored on all money models; formatting respects it. **No way to set non-ILS; no picker/FX.** | Currency selector; FX; multi-currency VAT/rounding. | Surface existing field in create + selector; add per-currency rules. | Low | L | — | **Defer.** IL SMB ≈ ILS-only. |
| ריבוי שפות (i18n) | **Missing** | No i18n framework; **Hebrew hardcoded** (inline literals, `dir="rtl"`, Hebrew server errors). | Framework + extraction + locale switch + LTR. | `next-intl` (App Router) — large surface (thousands of strings). | Low | XL | — | **Defer.** Not needed for IL market now. |
| תנאי תשלום | **Missing** | No paymentTerms/netDays/dueDate on Customer or BillingDocument. Only `validUntil` (quote expiry) + free-text `billingPaymentNote`. | Structured net-N terms + derived due date. | `paymentTermsDays` on `Customer` (default) + `BillingDocument` (override); derive `dueDate` at issue. | **High** | S–M | — | **MVP.** Foundational — **unlocks collection status & aging (§2).** Do early. |
| מספור מסמכים | **Exists** (robust) | `BillingDocumentNumberSequence` w/ atomic `upsert increment` in `$transaction`; DB-level uniqueness; assigned at issue; immutable snapshot. | Configurable prefixes/year-reset (optional). | Optional prefix/year columns; core is sound. | Low | S | — | **Keep as-is.** |
| ניהול מספר עסקים | **Missing** | `User.businessId` is a **required single scalar**; no membership table, no switching. Platform admin console ≠ user multi-business. | User↔Business M:N; active-business switch. | `BusinessMembership(userId, businessId, role)`; move `businessId` to a session claim. | Low→Medium | XL | Auth refactor (threaded everywhere) | **Defer.** Big migration; validate demand first. |
| הרשאות (Permissions) | **Partial** | `UserRole` = **USER / PLATFORM_ADMIN only.** Platform-admin gate enforced & fail-closed (`requirePlatformAdmin`). Non-admin auth = pure business-scoping, **no intra-business roles.** `settings/team` is a placeholder "My Account". `BusinessFeatureAccess` = feature flags, not user perms. | Intra-business RBAC (owner/staff/accountant/viewer); team management UI. | Roles on the `BusinessMembership` table; permission helper mirroring `requirePlatformAdmin`. | Medium | L | Multi-business membership | **Wave 2.** Pairs with membership table. |

---

## 10. Cross-cutting tech-debt to reconcile (before building on top)

These aren't features but will bite any new work; fix opportunistically, **no big-bang refactor**:

1. **Duplicate customer-create** — `app/api/customer/route.ts` (normalized phone, accepts city/notes) vs `app/api/billing/customers/route.ts` (raw phone slice). Consolidate into one normalized service **before** the customer card writes on top.
2. **`PurchaseOrder.supplierName` is a string, not an FK** → blocks supplier purchase history. Add `supplierId` FK.
3. **Dead code:** `Task`/`TaskStatus` (0 usages), unused `Business.archivedAt` scaffold, throwaway `app/upload` + `app/test-upload` (now 401), ~270 orphaned `public/uploads/*`, legacy `app/search/page.tsx`.
4. **CSV export escaping bug** — `/api/reports/export` naive `join(",")`.
5. **Unwired reader:** `getBillingDocumentAuditTimeline` defined, no caller.
6. **3 PDF engines / 2 billing renderers** — consolidate later; confirm live path via `billing-pdf-renderer-policy.ts` first.
7. **UNVERIFIED — SHAAM allocation transport.** No concrete `fetch` found in `lib/services/billing/authority/`; allocation number is passed *in* rather than fetched. Confirm before treating SHAAM submission as complete.

---

## 11. Recommended sequencing (waves)

Ordered for **maximum baseline value at minimum risk**, respecting dependencies. Nothing here breaks existing features; all additive.

### Wave 1 — "Professional parity" foundation (the read/aggregation + thin-UI layer)
The single highest-leverage cluster, because the data already exists.
1. **Customer card** (`app/(shell)/customers/[id]`) — the hub. *(High/M)*
2. **Surface `notes`** on customer/supplier cards. *(High/S — quick win)*
3. **Customer activity timeline** (read-only aggregator over existing relations). *(High/M)*
4. **`Document.customerId`** — attach files/docs to a customer. *(High/M)*
5. **Payment terms + due date** on Customer/BillingDocument. *(High/S–M — unlocks #6)*
6. **Per-customer collection status + aging** (read-model over allocations). *(Critical/M)*
7. **Cross-module global search** (`/api/search/global` fan-out). *(High/M)*
8. **Billing embedded preview + print + tokenized public share link.** *(High/S–M)*
- **Quick fixes alongside:** CSV escaping bug, wire billing timeline, remove `Task` dead code, consolidate customer-create.

### Wave 2 — Expansion
- Customer **portal** via magic-link (reuses Wave 1 tokenized link). *(L)*
- **Reminders delivery** via scheduler + WhatsApp. *(M)*
- **Supplier card** + `PurchaseOrder.supplierId` FK + purchase history. *(M)*
- **Contacts** (multiple per customer/supplier). *(M)*
- **Customer/product import + broader export.** *(M)*
- **Bulk actions** pilot (inbox or inventory). *(M)*
- **Intra-business RBAC + team management** (needs membership table). *(L)*

### Wave 3 — Defer / validate demand first
Customer profitability *(first real Brain insight)* · multi-business *(XL)* · i18n *(XL)* · multi-currency picker/FX · digital signature · general file manager · tags · recycle bin · Excel import · projects.

### Parallel compliance track (independent of parity waves)
- **Complete SHAAM/ITA allocation HTTP transport** (Critical) · harden Tranzila webhook signature.

### Where the Brain plugs in
Wave 1's aggregation layer (customer timeline, collection read-model, cross-module search) is precisely the substrate the Business Brain consumes. **Customer profitability** and **collection prioritization / next-best-action** are the natural first Brain outputs once that substrate exists — build baseline first, intelligence on top.

---

*All findings anchored to code as of commit on branch `feat/brain-c0-core-contracts`, 2026-07-13. Items marked UNVERIFIED require live confirmation before being treated as fact.*
