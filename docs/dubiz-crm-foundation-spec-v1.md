# EPIC 1 — CRM Foundation — Architectural Specification (v1)

> **Status:** Specification only. No code, no PR, no migration. This document is the blueprint for a staged implementation of the CRM product layer.
>
> **Goal.** Complete Dubiz's product layer so it is a *professional, complete business system* — a first-class Customer and Supplier surface. **No AI, no learning engines, no automation, no Business Brain** in this Epic. Those sit on top later; here we build the deterministic substrate.
>
> **Binding principles (carried into every section):**
> 1. Never break existing features.
> 2. Never create duplicate engines — maximize reuse of existing infrastructure.
> 3. Every new capability must be **Generic** (usable by future modules, not just Customer/Supplier).
> 4. Design System v1 is the only visual language.
> 5. Business Brain is out of scope.
>
> **Companion docs:** [Capability Audit & Roadmap](dubiz-capability-audit-and-roadmap-v1.md) (the evidence base for this spec). Compliance rule for anything touching invoices/receivables: `docs/billing-compliance-tax-authority-readiness-plan.md`. Payment Secretary / Business-Obligation ontology (governs Supplier-as-payer): `docs/dubiz-business-obligation-domain-v1.md`.
>
> Date: 2026-07-13. Anchored to code on branch `feat/brain-c0-core-contracts`.

---

## 0. Scope

### In scope (the 18 named capabilities)
- **Customer:** List · Card · Timeline · Notes · Attachments · Collection Summary · Profitability · Activity
- **Supplier:** List · Card · Timeline · Notes · Attachments · Purchase Summary · Activity
- **Contacts:** Multiple Contact Persons · Contact Management · Contact Roles

### Explicitly NOT in scope (do not build in Epic 1)
- Business Brain, insights, recommendations, learning, any AI. *(Profitability here = a deterministic rollup, not a Brain insight.)*
- Intra-business RBAC / team roles (permissions in v1 = tenant-scoping only — see §11).
- Reminders delivery, tasks, bulk actions, tags (separate Epics).
- Multi-currency picker, i18n, customer portal (later waves).
- Changing the billing/receivable **financial source of truth**. CRM only *reads/aggregates* it (compliance non-negotiable).

---

## 1. Architectural foundations (conventions this Epic MUST follow)

All conventions below are taken from existing code — CRM Foundation adopts them verbatim so nothing new is invented.

| Concern | Existing convention (cite) | CRM adopts |
|---|---|---|
| **Auth** | `getCurrentUser(req)` → user incl. `business` ([lib/auth.ts:7](../lib/auth.ts#L7)); business resolved from `user.businessId`. | Same. Every CRM route calls `getCurrentUser`; 401 via inline `Unauthorized` (billing style). |
| **Errors** | Shared `AppError` hierarchy `ValidationError/NotFoundError/UnauthorizedError/ForbiddenError/ConflictError` ([lib/errors.ts](../lib/errors.ts)) + `handleError()` ([lib/handle-error.ts](../lib/handle-error.ts)). Used by [app/api/billing/customers/route.ts](../app/api/billing/customers/route.ts). | Standardize on **this shared family** (the newer, generic one). Do **not** create a CRM-specific error class family (avoids a 3rd parallel to `InventoryError`). |
| **Service shape** | Exported `xxxService` object; typed `Input` types; `assertBusinessId`; `normalizeX` helpers; tenant guard `where:{ id, businessId }`; `updateMany`+count check for tenant-safe writes; `TxOptions { tx? }` for transaction composition. See [lib/services/inventory/supplier.service.ts](../lib/services/inventory/supplier.service.ts). | Same shape for every CRM service. |
| **Tenant isolation** | Every query filtered by `businessId`; writes guarded so a row from another business can't be touched (`updateMany` count === 1). | Mandatory on every CRM read/write. |
| **Storage** | `lib/storage` `StorageService` (Cloudflare R2 prod / local dev); domain-scoped keys `biz/{businessId}/{domain}/{basename}`; per-domain visibility ([lib/storage/domain-policy.ts]). Pattern in [lib/services/documents/document-storage.service.ts](../lib/services/documents/document-storage.service.ts). | Attachments reuse this with a **new `crm` domain** (private). No new storage stack. |
| **Nav** | Shell = `ShellChrome` → `BottomBar` ([components/navigation/shell-chrome.tsx](../components/navigation/shell-chrome.tsx), `components/navigation/bottom-bar.tsx`). Pages live under `app/(shell)/…`. | CRM pages under `app/(shell)/customers` & `app/(shell)/suppliers`; nav entry added to BottomBar (§10). |
| **DS v1 theming** | Per-feature theme module in `lib/design/*-theme.ts` mapping to `lib/design/tokens.ts` (e.g. billing-theme, documents-theme, bot-theme). | New `lib/design/crm-theme.ts` — one injection point, DS v1 tokens only. |
| **Migrations** | `prisma/migrations/YYYYMMDDHHMMSS_snake_description/migration.sql`, **expand-only**, additive nullable columns; production applied via gated `release-migrate` workflow. | Same. All CRM migrations additive + nullable → zero backfill, zero downtime (§5). |
| **Tests** | Vitest `*.service.test.ts` colocated (e.g. `supplier.service.test.ts`); verify scripts (`verify:brain-c0`). | Colocated `*.service.test.ts` + route tests (§ per-capability + §12). |

---

## 2. The core reuse decision — a generic **CRM Subject**

Customer and Supplier need the *same* cross-cutting features (notes, attachments, timeline, activity). Building them twice violates "no duplicate engines." So Epic 1 introduces one lightweight polymorphic reference used by all generic engines:

```
CrmSubjectType = 'CUSTOMER' | 'SUPPLIER'   // extensible: future 'LEAD', 'PARTNER', 'PROJECT'
CrmSubjectRef  = { subjectType: CrmSubjectType, subjectId: number }
```

- Every generic engine (Notes, Attachments, Timeline, Activity, Contacts) is keyed by `(businessId, subjectType, subjectId)`.
- Adding a future module = add one enum value + register its timeline/summary providers. **No engine is rewritten.**

**Why NOT reuse the existing `Party` graph.** `Party` / `PartyResolutionClaim` ([schema.prisma:2064-2099]) is an **identity-resolution** system (linking rows that refer to the same real-world entity). It holds no name/phone/notes and answers a different question ("are these the same entity?"). Overloading it with CRM attributes would corrupt its purpose. CRM Subject is a thin addressing convention, **orthogonal** to Party. (If, later, Party resolution wants to point at a Customer, that's a separate wire — out of scope here.)

**Boundary with Business-Obligation / Payment Secretary.** Supplier stays a *counterparty record*. Supplier payables/obligations remain owned by the Business-Obligation domain; the Supplier **Purchase Summary** (§ E4) only *reads/links* those — it never becomes a new financial source of truth.

---

## 3. Generic engines (build once — reused by Customer, Supplier, and future modules)

These five engines are the heart of the Epic. Each named capability in §7 is a *composition* of these.

### E1 — Notes engine
- **Purpose.** Threaded, timestamped, attributable notes on any subject.
- **Model** `CrmNote`: `id, businessId, subjectType, subjectId, body(Text), authorUserId?, pinned Boolean @default(false), createdAt, updatedAt`. Indexes: `@@index([businessId, subjectType, subjectId, createdAt])`.
- **Relationship to existing scalar `Customer.notes` / `Supplier.notes`.** Those stay as a **single "summary note"** field (a quick win — already writable, just unsurfaced). `CrmNote` is the **threaded** system layered on top. The card shows the summary note inline + a notes thread below. *No data migration; both coexist with a clear role split.* (Rationale: honors "don't break existing" — the scalar keeps working — while giving a generic, reusable threaded engine.)
- **Service** `lib/services/crm/crm-notes.service.ts`: `listNotes(subjectRef) · addNote · editNote · deleteNote · togglePin`. Tenant-guarded; `authorUserId` from `getCurrentUser`.
- **Reuse.** Any future module gets notes for free by passing its `subjectType`.

### E2 — Attachments engine
- **Purpose.** Attach files to any subject — **two sources unified behind one model**: (a) a freshly uploaded arbitrary file (contract, image, PDF), and (b) a link to an existing financial `Document` (a scanned invoice that belongs to this customer).
- **Model** `CrmAttachment`: `id, businessId, subjectType, subjectId, kind('UPLOAD'|'DOCUMENT_LINK'), documentId? (FK→Document, for DOCUMENT_LINK), storageBasename? (for UPLOAD), fileName, mimeType, sizeBytes?, uploadedByUserId?, createdAt`. Index `@@index([businessId, subjectType, subjectId, createdAt])`.
- **Storage.** UPLOAD files use `lib/storage` under a **new `crm` domain** (`biz/{businessId}/crm/{basename}`), private visibility — mirrors [document-storage.service.ts](../lib/services/documents/document-storage.service.ts) exactly (validated basename, R2/local fallback). DOCUMENT_LINK stores no bytes — it references an existing `Document`.
- **Also add** `Document.customerId Int?` (roadmap item) so an ingested financial document can be *directly* owned by a customer even outside the attachment list. `CrmAttachment(kind=DOCUMENT_LINK)` is the explicit user-curated link; `Document.customerId` is the ownership FK. Both additive.
- **Service** `lib/services/crm/crm-attachments.service.ts`: `listAttachments · uploadAttachment · linkDocument · deleteAttachment · getDownload` (signed URL / streamed via existing storage read).
- **Reuse.** Generic across subjects; new `crm` storage domain reusable by any module.

### E3 — Timeline & Activity engine
- **Purpose.** A **read-only** chronological feed per subject. No new event table — it *derives* from rows that already exist. This is the single most reused piece.
- **Design — pluggable source providers.** A registry of `TimelineSource` contributors, each: `(subjectRef, businessId, range) → TimelineEvent[]`. The engine merges + sorts by timestamp + paginates.
  ```
  TimelineEvent = {
    id, occurredAt, kind, category: 'BUSINESS' | 'ACTIVITY',
    title, subtitle?, amount?, currency?, status?, href?, icon
  }
  ```
- **Customer sources (v1):** issued `BillingDocument`s; `BillingReceiptPayment` / `PaymentRequest`; `Conversation`/`Message` (last message summary); `Appointment`; `Deal` (once `Deal.customerId` lands — see §10); `CrmNote` added; `CrmAttachment` added.
- **Supplier sources (v1):** `PurchaseOrder` (once `supplierId` FK lands); `ReceivingSession`; `SupplierPurchaseDraft`; `CrmNote`; `CrmAttachment`.
- **Timeline vs Activity split.** Same engine, two `category` values:
  - **Timeline** (`category:'BUSINESS'`) = business events (invoice issued, payment received, order sent).
  - **Activity** (`category:'ACTIVITY'`) = record/actor actions (customer created/edited, note added, file attached, contact added). Sourced from the append-only mutations the CRM services themselves emit (see §11 audit note) + existing audit events where available.
  - UI renders Timeline and Activity as two filters over one feed → **"Customer Timeline", "Customer Activity", "Supplier Timeline", "Supplier Activity" are the same engine, filtered.**
- **Service** `lib/services/crm/crm-timeline.service.ts` + `crm-timeline-sources/*.ts` (one file per source, so adding a source never edits the merger).
- **Reuse.** New modules register a source file; the feed, sorting, pagination, and UI are untouched.

### E4 — Financial summary services (deterministic rollups, no new source of truth)
Three thin read-models. **Compliance:** each *reads* existing billing/payment/purchase rows; none writes or invents financial state.

- **E4a — Customer Collection Summary** `lib/services/crm/customer-financial-summary.service.ts`
  - Computes, per customer: total issued (Σ issued `TAX_INVOICE`/receipt-eligible totals), total settled (Σ `BillingPaymentAllocation` for that customer's invoices), **open balance** = issued − settled, and (once due dates exist — Roadmap Wave 1 "payment terms") an **aging** bucket split. Reuses `computeRemainingAllocatable` ([lib/services/billing/receipt/billing-receipt-allocation.rules.ts]) — does **not** re-implement settlement math.
  - v1 without due dates: report open balance + oldest-open-invoice age; aging buckets ship when the payment-terms field lands (documented dependency, not a blocker).
- **E4b — Supplier Purchase Summary** `lib/services/crm/supplier-financial-summary.service.ts`
  - Per supplier: total ordered (Σ `PurchaseOrder` totals), total received (`ReceivingSession`), open orders count, last order date. **Requires `PurchaseOrder.supplierId` FK** (§10) — today PO stores `supplierName` string only.
- **E4c — Customer Profitability** `lib/services/crm/customer-profitability.service.ts`
  - Deterministic: revenue (Σ issued invoice totals for customer) − cost (Σ `Deal.actualCost`/`estimatedCost` for customer) = gross profit + margin%. **Requires `Deal.customerId`** (§10; today `Deal` links only to `Lead`). Until that FK exists, profitability shows **revenue only** with an explicit "cost data not linked yet" state — never a fabricated margin. *(This is the natural first Brain hand-off point later, but v1 is pure arithmetic.)*
- **UI.** All three feed a shared `SummaryStatCard` DS v1 component (label + figure + trend-neutral). No AI copy.

### E5 — Contacts engine
- **Purpose.** Multiple contact persons per subject, with roles.
- **Model** `Contact`: `id, businessId, subjectType, subjectId, name, role(ContactRole), phone?, email?, isPrimary Boolean @default(false), notes?, createdAt, updatedAt`. Index `@@index([businessId, subjectType, subjectId])`; partial-unique intent: at most one `isPrimary` per subject (enforced in service, not DB, to stay expand-only).
- **`ContactRole` enum:** `OWNER, BILLING, PROCUREMENT, LOGISTICS, TECHNICAL, GENERAL` (extensible). Hebrew labels in a `contact-role.ts` label map (mirrors `customer-tax-identity.ts` label pattern).
- **Service** `lib/services/crm/contacts.service.ts`: `listContacts · addContact · updateContact · deleteContact · setPrimary`. `setPrimary` clears the previous primary in one `$transaction`.
- **Relationship to inline `phone`/`email`.** Customer/Supplier keep their inline phone/email as the **primary quick-contact** (unbroken). Contacts add *additional people*. The card's header shows the record's inline phone/email; the Contacts tab lists the people. Optional convenience: when the first `isPrimary` contact is set, mirror nothing back (avoid dual source) — inline stays authoritative for identity.

### E6 — List & Card UI scaffolds (DS v1)
- **Purpose.** Customer List/Card and Supplier List/Card share layout → shared scaffolds, not copy-paste.
- **Shared components** (`components/crm/`):
  - `EntityListView` — search box (reuses existing `q`-search API shape), rows, empty-state (per `docs/dubiz-product-decisions-v1.md` empty-state law), "one primary action" = create.
  - `EntityCard` — header (name, identity chips, inline phone/email, primary action), + a tab strip: **Overview · Timeline · Activity · Notes · Attachments · Contacts · Financial**. Tabs are the same for both entities; each entity supplies its data adapters.
  - `SummaryStatCard`, `TimelineFeed`, `NotesThread`, `AttachmentList`, `ContactList` — all subject-agnostic, driven by `CrmSubjectRef`.
- **Theme.** `lib/design/crm-theme.ts` → DS v1 tokens. Single injection point.
- **Reuse.** A future "Project" or "Partner" card = new route + data adapters over the *same* scaffolds and engines.

---

## 4. UX flows (per capability, condensed)

DS v1 rules apply throughout: structured-calm, one primary action per screen, progressive disclosure, no added load.

- **Customer/Supplier List →** search or scan → tap row → **Card**. Primary action: "לקוח חדש" / "ספק חדש". (Suppliers also remain reachable from inventory purchasing, deep-linking into the same Card.)
- **Card (default = Overview):** identity + inline contact + `SummaryStatCard`s (collection/purchase) + latest 3 timeline items + quick actions (add note, attach, new invoice/PO). Tabs reveal full Timeline / Activity / Notes / Attachments / Contacts / Financial on demand (disclosure — nothing overwhelming up front).
- **Notes:** inline summary note (edit-in-place) + threaded `NotesThread` (add/edit/pin/delete).
- **Attachments:** drag/drop upload **or** "link existing document" picker → `AttachmentList` with preview (reuses the existing `DocumentFilePreviewOverlay` pattern from the documents engine).
- **Contacts:** `ContactList` with role chips; add/edit person; star = set primary.
- **Timeline / Activity:** one feed, a filter toggle (Business ↔ Activity), infinite/paged scroll.
- **Financial tab:** Collection/Purchase summary + Profitability (customer) with the honest "not linked yet" states where FKs are pending.

---

## 5. Database & migrations

**Strategy:** expand-only, additive, all new columns nullable / defaulted → **no backfill, safe on live data**, applied via the gated `release-migrate` pipeline. New tables have no impact on existing reads.

### New models
| Model | Purpose | Key fields |
|---|---|---|
| `CrmNote` | E1 threaded notes | subjectType, subjectId, body, authorUserId?, pinned |
| `CrmAttachment` | E2 attachments | subjectType, subjectId, kind, documentId?, storageBasename?, fileName, mimeType, sizeBytes?, uploadedByUserId? |
| `Contact` | E5 contacts | subjectType, subjectId, name, role, phone?, email?, isPrimary, notes? |

### New enums
- `CrmSubjectType { CUSTOMER, SUPPLIER }`
- `ContactRole { OWNER, BILLING, PROCUREMENT, LOGISTICS, TECHNICAL, GENERAL }`

### Additive columns on existing models
| Model | Column | Why | Note |
|---|---|---|---|
| `Document` | `customerId Int?` + relation + index `@@index([businessId, customerId])` | Own an ingested financial doc to a customer (E2 / roadmap) | Nullable → no backfill |
| `PurchaseOrder` | `supplierId Int?` + relation + index | Enable Supplier Purchase Summary + timeline (E4b) | Nullable; `supplierName` string retained (unbroken). Optional later soft-backfill by name-match — **advisory, not in this migration** |
| `Deal` | `customerId Int?` + relation + index | Enable Customer Profitability (E4c) | Nullable |

### Migration sequence (each its own timestamped dir, expand-only)
1. `..._add_crm_subject_notes` — `CrmNote` + `CrmSubjectType` enum.
2. `..._add_crm_attachments` — `CrmAttachment`.
3. `..._add_crm_contacts` — `Contact` + `ContactRole` enum.
4. `..._add_document_customer_fk` — `Document.customerId`.
5. `..._add_purchase_order_supplier_fk` — `PurchaseOrder.supplierId`.
6. `..._add_deal_customer_fk` — `Deal.customerId`.

**Rollback posture:** every step is additive; reverting = drop new object, existing behavior unaffected.

---

## 6. API surface (route map)

All under existing auth + `handleError`. Business-scoped. REST-ish, mirroring existing `app/api/billing/customers` style.

**Customer**
- `GET /api/customers` — list/search (`?q=&status=&limit=`). *Consolidates the two existing create paths — see §10.*
- `POST /api/customers` — create (normalized phone).
- `GET /api/customers/[id]` — card payload (identity + summary + counts).
- `PATCH /api/customers/[id]` — edit (identity + general fields; extends today's tax-only PATCH).
- `GET /api/customers/[id]/timeline` — `?category=&cursor=` (E3).
- `GET/POST /api/customers/[id]/notes`, `PATCH/DELETE /api/customers/[id]/notes/[noteId]` (E1).
- `GET/POST /api/customers/[id]/attachments`, `DELETE .../attachments/[attId]`, `GET .../attachments/[attId]/file` (E2).
- `GET/POST /api/customers/[id]/contacts`, `PATCH/DELETE .../contacts/[contactId]`, `POST .../contacts/[contactId]/primary` (E5).
- `GET /api/customers/[id]/financial` — collection summary + profitability (E4a/E4c).

**Supplier** — symmetric under `/api/suppliers/*` (reusing existing `supplierService`), plus `/api/suppliers/[id]/purchase-summary` (E4b). Notes/Attachments/Contacts/Timeline routes are the **same handlers** parametrized by `subjectType='SUPPLIER'` (generic controllers).

**Generic controller note:** notes/attachments/contacts/timeline endpoints are implemented once as subject-generic handlers; the customer/supplier route files are thin adapters passing `subjectType`. No duplicated logic.

---

## 7. Per-capability specification

Each capability below is defined across the 13 required dimensions. To avoid duplication, dimensions that are fully covered by a generic engine reference it (§3) rather than restating.

### CUSTOMER

**C1 · Customer List** — *Purpose:* find/scan/select any customer. *UX:* search + rows + create. *DB/Models:* `Customer` (existing). *Services:* new `customer.service.ts` `listCustomers` (wraps existing query, tenant-guarded). *APIs:* `GET /api/customers`. *UI:* `EntityListView`. *Nav:* BottomBar → לקוחות → `/(shell)/customers`. *Permissions:* tenant-scope. *Tests:* list filters, tenant isolation, empty-state. *Migration:* none. *Integration:* deep-linked from billing/inbox pickers. *Reuse:* `EntityListView` → suppliers & future.

**C2 · Customer Card** — *Purpose:* single source-of-view for a customer. *UX:* Overview + tabs (§4). *DB/Models:* `Customer` + related. *Services:* `customer.service.ts` `getCustomerCard` (identity + counts + summary handles). *APIs:* `GET/PATCH /api/customers/[id]`. *UI:* `EntityCard`. *Nav:* `/(shell)/customers/[id]`. *Permissions:* tenant-scope; PATCH extends today's tax-only edit. *Tests:* card assembly, cross-tenant 404, PATCH field validation. *Migration:* none (uses new engines' tables). *Integration:* links out to each billing doc / conversation / appointment. *Reuse:* scaffold shared with supplier card.

**C3 · Customer Timeline** — Engine **E3** (`category` filter = BUSINESS+ACTIVITY). *APIs:* `GET /api/customers/[id]/timeline`. *UI:* `TimelineFeed`. *Migration:* none (derived). *Dependency:* `Deal.customerId` for deal events (degrades gracefully). *Reuse:* engine.

**C4 · Customer Notes** — Engine **E1** + existing scalar as summary note. *APIs:* notes routes. *UI:* `NotesThread` + inline summary. *Migration:* `CrmNote`. *Reuse:* engine.

**C5 · Customer Attachments** — Engine **E2** (+ `Document.customerId`). *APIs:* attachments routes. *UI:* `AttachmentList` + preview overlay reuse. *Migration:* `CrmAttachment`, `Document.customerId`. *Reuse:* engine + `crm` storage domain.

**C6 · Customer Collection Summary** — Engine **E4a**. *Purpose:* open balance / aging without a new financial source. *APIs:* part of `/financial`. *UI:* `SummaryStatCard`s. *Permissions:* tenant-scope. *Tests:* balance = issued − allocations; multi-invoice; refunds/credit notes reduce balance; matches billing math. *Migration:* none (reads billing); aging needs the Wave-1 payment-terms field (documented). *Integration:* reuses `computeRemainingAllocatable`. *Reuse:* summary-card pattern.

**C7 · Customer Profitability** — Engine **E4c** (deterministic). *Dependency:* `Deal.customerId`; until then revenue-only with honest empty state. *Tests:* revenue−cost math; "no cost linked" state; never fabricates margin. *Migration:* `Deal.customerId`. *Reuse:* rollup pattern. *(Brain hand-off point later — not now.)*

**C8 · Customer Activity** — Engine **E3** filtered to `category:'ACTIVITY'`. *Source:* CRM service mutation events (§11) + existing audit where present. *UI:* same feed, Activity filter. *Reuse:* engine.

### SUPPLIER (symmetric; reuses `supplierService` + all engines)

**S1 · Supplier List** — existing `supplierService.listSuppliers` + `EntityListView`. *Nav:* `/(shell)/suppliers` (+ existing inventory entry points). *Migration:* none.

**S2 · Supplier Card** — `EntityCard` over `supplierService.getSupplier`. *APIs:* `GET/PATCH /api/suppliers/[id]` (existing service). *Migration:* none.

**S3 · Supplier Timeline** — Engine **E3**, supplier sources. *Dependency:* `PurchaseOrder.supplierId`. *Migration:* PO FK.

**S4 · Supplier Notes** — Engine **E1** + existing `Supplier.notes` scalar as summary. *Migration:* `CrmNote` (shared).

**S5 · Supplier Attachments** — Engine **E2**. *Migration:* `CrmAttachment` (shared).

**S6 · Purchase Summary** — Engine **E4b**. *Dependency:* `PurchaseOrder.supplierId`. *Tests:* ordered/received/open counts by supplier; excludes other businesses; PO-without-FK excluded gracefully. *Integration:* reads inventory purchasing; never a new payables source (Business-Obligation owns payables). *Migration:* PO FK.

**S7 · Supplier Activity** — Engine **E3**, `category:'ACTIVITY'`.

### CONTACTS (generic engine E5, used by both)

**K1 · Multiple Contact Persons** — `Contact` model, N per subject. *UI:* `ContactList`. *Migration:* `Contact`.

**K2 · Contact Management** — `contacts.service.ts` CRUD + `setPrimary`. *APIs:* contacts routes (generic). *Tests:* one-primary invariant; tenant isolation; cascade on subject delete.

**K3 · Contact Roles** — `ContactRole` enum + Hebrew label map. *UI:* role chips. *Reuse:* any subject type.

---

## 8. UI components (inventory)

New under `components/crm/` (all subject-agnostic, DS v1 via `crm-theme.ts`):
`EntityListView`, `EntityCard` (+ `EntityCardTabs`), `TimelineFeed`, `NotesThread`, `AttachmentList` (reuses `DocumentFilePreviewOverlay`), `ContactList`, `SummaryStatCard`, `CustomerCreateSheet` / `SupplierCreateSheet`.

Reused as-is: existing `DocumentFilePreviewOverlay` (preview), existing customer/supplier pickers (link into cards), DS v1 primitives.

---

## 9. Navigation

- Primary: add a CRM destination to `components/navigation/bottom-bar.tsx` (verify current slots before wording — likely "לקוחות"/"אנשי קשר" grouping). Routes: `app/(shell)/customers`, `app/(shell)/customers/[id]`, `app/(shell)/suppliers`, `app/(shell)/suppliers/[id]`.
- Secondary (no duplication): existing customer references in Billing/Inbox/Payments and supplier references in Inventory become **deep links** into the new cards.

---

## 10. Integration with the rest of the system + tech-debt to reconcile first

- **Billing** ↔ Customer: `BillingDocument.customerId` already exists — card links each doc; collection summary reads allocations. No billing change.
- **Payments** ↔ Customer: `PaymentRequest.customerId` feeds timeline.
- **Inbox/Conversations** ↔ Customer: `Conversation.customerId`/`Message` feed timeline.
- **Inventory/Purchasing** ↔ Supplier: after the `supplierId` FK, PO/receiving feed timeline + purchase summary.
- **Documents** ↔ Customer: `Document.customerId` links ingested docs.

**Two reconciliations to do as part of Epic 1 (they unblock clean CRM):**
1. **Consolidate duplicate customer-create.** Today [app/api/customer/route.ts](../app/api/customer/route.ts) (normalizes phone via `normalizeCustomerPhone`, accepts city/notes) and [app/api/billing/customers/route.ts](../app/api/billing/customers/route.ts) (raw phone slice, no normalization) diverge. Introduce `customer.service.ts` as the **single normalized create/list**, and point both existing routes at it (keep their URLs to not break callers). Fixes the phone-normalization inconsistency before the card writes on top.
2. **Add `PurchaseOrder.supplierId` FK** (additive) so supplier history is joinable. `supplierName` string retained for back-compat.

---

## 11. Permissions

- **v1 = tenant-scoping only**, matching every existing route: authenticated user of the business (`getCurrentUser`), every query/write filtered + guarded by `businessId`. Platform-admin unaffected.
- **Forward-compatibility hook (design, don't enforce):** each CRM service takes the acting user; a single `assertCanAccessCrm(user)` helper is a **no-op today** but is the one place future intra-business RBAC (Roadmap Wave 2) will plug in — so adding roles later touches one function, not every route. No RBAC is built in this Epic.
- **CRM Activity audit:** CRM service mutations (create/edit/delete note/contact/attachment, customer/supplier edits) emit lightweight append-only activity records feeding E3's Activity feed. To avoid spawning a *fifth* audit system, reuse the existing generic `logAuditEvent` (`lib/services/audit.service.ts` → `LearningEvent`) whose coverage the audit flagged as thin — extending it here is the sanctioned way to broaden coverage, not a new engine. *(Confirm this vs. a dedicated `CrmActivityEvent` table — see §14 open decisions.)*

---

## 12. Testing strategy

Mirrors existing Vitest conventions (colocated `*.service.test.ts`, e.g. `supplier.service.test.ts`).

- **Service unit tests (per engine):** tenant isolation (cannot read/write another business's subject); normalization; Notes CRUD + pin; Attachments upload/link/delete + basename validation; Contacts one-primary invariant + setPrimary transaction; Timeline merge order + pagination + graceful degradation when a source FK is absent; Collection summary equals billing settlement math (cross-checked against `computeRemainingAllocatable`); Profitability arithmetic + "no cost linked" state.
- **API route tests:** 401 unauth; 404 cross-tenant; validation 400s; create/patch happy paths; generic controllers behave identically for CUSTOMER vs SUPPLIER.
- **Migration checks:** additive/nullable verified (existing rows unaffected); FK integrity.
- **No-regression:** existing billing/customer/supplier/inventory tests stay green; the two consolidated create routes keep their existing response contracts (contract test).
- **Optional** `verify:crm` script mirroring `verify:brain-c0` (typecheck + targeted tests) for CI gating.

---

## 13. Reuse / future-proofing (explicit)

Everything keyed by `CrmSubjectRef` is reusable. To onboard a **future module** (e.g. Projects, Partners, Leads-as-subjects):
1. Add an enum value to `CrmSubjectType`.
2. Add timeline source file(s) + (if financial) a summary service.
3. Reuse `EntityCard`, all tabs, Notes/Attachments/Contacts engines, `crm` storage domain — unchanged.

This is the concrete payoff of the "must be Generic" principle: CRM Foundation is simultaneously the Customer/Supplier product **and** the reusable relationship-management substrate for the platform.

---

## 14. Open decisions to confirm before implementation

1. **CRM Activity storage:** extend the existing generic `logAuditEvent`/`LearningEvent` (less new surface, reuses infra) **vs.** a dedicated `CrmActivityEvent` table (cleaner semantics, but a new store). *Recommendation: extend the existing one* (principle: no duplicate engines) unless activity volume/query needs justify a table.
2. **Notes model:** keep scalar-summary + threaded `CrmNote` (recommended) **vs.** threaded-only (requires surfacing/migrating the scalar). *Recommendation: coexist* (don't break existing).
3. **Supplier `supplierId` backfill:** ship the FK now, do the historical name→id soft-backfill as a **separate, advisory** task later. *Recommendation: yes — keep this migration purely structural.*
4. **Nav placement:** dedicated CRM bottom-bar entry vs. nesting suppliers under inventory + customers standalone. *Needs a quick look at current BottomBar slots.*

---

## 15. Suggested build sequence within Epic 1 (still no code until approved)

1. **Foundation:** `CrmSubjectType`, `customer.service.ts` (consolidate create), `crm-theme.ts`, `EntityListView`/`EntityCard` scaffolds → **Customer List + Card (identity/overview)**.
2. **Notes + Attachments engines** (E1, E2, `Document.customerId`) → Customer tabs.
3. **Timeline/Activity engine** (E3) → Customer Timeline + Activity.
4. **Financial** (E4a collection, E4c profitability w/ honest states).
5. **Supplier**: FK + `EntityCard` reuse → List/Card/Notes/Attachments/Timeline/Activity + Purchase Summary (E4b).
6. **Contacts** (E5) across both.

Each step is independently shippable, additive, DS v1, and leaves existing features untouched.

---

*Specification only. No implementation, PR, or migration performed. Ready for review — §14 open decisions benefit from a ruling before build starts.*
