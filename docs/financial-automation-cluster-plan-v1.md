# Financial Automation Cluster — Planning Document (v1)

**Status:** Planning only — NO implementation. For owner review before any build.
**Date:** 2026-07-08
**Scope:** Task-list items #8–#12 (contact book, auto-receivable, suggest-collection, auto-classify, auto-receipt).

This document grounds each idea in (a) the project's **canonical governing documents** and (b) the **current code/data model**, then gives a boundary-safe recommendation and sequencing. It deliberately reshapes or defers ideas that would violate the canonical constitution, and shows how much intent is **already served by existing infrastructure**.

---

## 0. The load-bearing rules these features must obey

From the canonical family (`docs/dubiz-business-obligation-domain-v1.md`, `docs/payment-secretary-mvp-*`, `docs/dubiz-business-obligation-integration-model-v1.md`, `docs/billing-compliance-*`, and the Collections/Payments-Authority docs). Section numbers below should be re-verified against the live docs at build time.

1. **The Payment Secretary is an operational coordinator only** — not a ledger, not a payment processor, not an accounting system. It **composes awareness from truth; it never becomes the truth.**
2. **Direction is fixed:** a **Business Obligation is OUTBOUND** (the business is the payer). A **Receivable is INBOUND** and is **never** a Business Obligation. Receivables/collections are owned by **Billing + the Collections domain**, not the Secretary.
3. **No new financial source of truth.** Billing owns issued invoices (immutable after issue: number, snapshot, lines, totals, VAT). Documents owns inbound artifacts + extracted facts. The Secretary/Brain consume; they don't re-own.
4. **Meaning vs. fact boundary:** Documents owns *facts* (extracted); Business (Brain / the issuing domain) owns *interpretation* (category, direction). The Secretary cannot author meaning.
5. **Automatic vs. suggested:** silence-by-default / owner keeps the decision. Automatic creation of a financial/legal artifact is only allowed where the relevant **Policy explicitly authorizes** it. Suggestions are always safe.
6. **Receipts** are a financial/legal artifact: may be created **only from a verified `PAID`** (never a raw webhook), must be immutable + audited after issue. Receipt *automation* is currently **out of scope** in the compliance hardening plan ("no receipt flows").

---

## 1. What already exists in code (the seams)

| Capability | Exists today | Where |
|---|---|---|
| Invoice issue lifecycle (DRAFT→ISSUED, immutable snapshot, sequential number) | ✅ | `lib/services/billing/billing-issue.service.ts` |
| **Income event auto-created on invoice issue** | ✅ | `ensureBillingInvoicePostedEvent` → `FinancialEvent(direction=INCOME, sourceType=BILLING_INVOICE, status=POSTED)` in `lib/services/financial-events/financial-event.service.ts` |
| Inbound "collection" tracking (per issued tax invoice) | ✅ | `PaymentRequest` model + `collection-workspace.service.ts` (read-model); visibility gated to issued `TAX_INVOICE` in `lib/billing/collections-visibility.ts` |
| Collection request creation | ✅ | `PaymentRequest` + `payment-request.service.ts` |
| **Verified payment-received signal** | ✅ (hook ready, no consumer yet) | `onVerifiedPaid` fires only on verified `PAID` in `payment-webhook.service.ts` |
| Receipt as a document type (draft, issue, numbering, allocation to invoice) | ✅ | `BillingDocumentType.RECEIPT`, `billing-receipt-draft.service.ts`, `billing-payment-allocation.service.ts` |
| Customer contacts (name/phone/email/city/taxId) + dedup | ✅ | `Customer` model, `PartyResolutionClaim`, `party-resolution.service.ts`, `BillingDocumentCustomerPicker` |
| Invoice→customer prefill (party-only snapshot, no amounts) | ✅ | `BillingDocument.customerId` + `customerNameSnapshot` |

**Does NOT exist:** a distinct `Receivable` table; aging/overdue derivation; auto-receipt-on-payment; a Document row created for an issued invoice (Billing store and inbound Documents store are separate); manual offline payment entry.

---

## 2. Per-item verdict, reshaped to be boundary-safe

### #8 — Contact book after first send → prefill future documents
**Verdict: ✅ VIABLE. Mostly already built; the gap is a save-prompt + a party-only guarantee.**

- Canonical: allowed as **operational metadata**; reuse **party details only, never service/price/amounts**.
- Code reality: `Customer` + party resolution already store and dedup contacts; the customer picker already prefills a new invoice's party (name snapshot), and amounts/services are never carried from a saved contact.
- **What's actually missing:** (a) the explicit "**נשמור את פרטי העסק לשימוש עתידי?**" prompt when a recipient was entered ad-hoc and not yet saved as a `Customer`; (b) confirm every prefill path is party-only.
- **Plan:** small Billing-side UX addition — on first issue/send to a recipient not already a saved `Customer`, offer to persist it as a `Customer` (owned by Billing/CRM, **not** the Secretary). Reuse the existing picker for future documents. No new store.
- **Prerequisite to confirm:** does invoice creation today allow a fully ad-hoc recipient (unsaved), or is a `Customer` always created? That determines whether #8 is "add a prompt" or "already done."

### #9 — Auto-create a Receivable when an invoice is issued
**Verdict: ⚠️ RESHAPE — do NOT build a new entity. The intent is already represented.**

- Canonical: the Secretary **cannot own receivables**; Billing owns them; **no new source of truth**.
- Code reality: there is **no** `Receivable` model, and there shouldn't be one — **the issued invoice IS the open receivable**, already surfaced through the Collection Workspace until a verified payment closes it, and already recorded as income truth via `FinancialEvent(INCOME)` on issue.
- **Plan:** treat "open receivable, stays open until collection detected" as an **existing read-model** over `BillingDocument` (issued) + `PaymentRequest` state, not a new write. The only defensible *additive* piece is **read-only aging/overdue derivation** (e.g., "open N days") computed from `issuedAt`/due date — no new truth, no Secretary ownership. Closure is driven by the existing `onVerifiedPaid` path, never by the Secretary.
- **Net:** #9 needs little-to-no new persistence; mostly surfacing what already exists + optional aging read-model.

### #10 — Suggest opening a collection request right after issuing
**Verdict: ✅ VIABLE as a suggestion (never automatic), on existing infra.**

- Canonical: **suggestions preserve owner agency**; automatic collection creation is only allowed if Collections Policy authorizes it (it currently does not, at business level only). A one-time suggestion is safe.
- Code reality: `PaymentRequest` is exactly the "collection request"; `payment-request.service.ts` creates it; collections visibility already restricts to issued `TAX_INVOICE`.
- **Plan:** after an invoice reaches `ISSUED`, show a **non-blocking suggestion** ("נפתחה חשבונית — לפתוח בקשת גבייה?"). On "yes" → create a `PaymentRequest` **prefilled from the invoice** (amount, customer, reference/currency). On "no" → nothing changes. Prefill pulls only invoice-derived facts; the owner confirms provider/expiry per existing flow.
- **Guardrail:** this is a prepared decision, not an engine. No auto-routing, no auto-dunning.

### #11 — Auto-classify the issued invoice (category=Invoices, direction=Income)
**Verdict: ✅ ALREADY SATISFIED at the truth layer — do NOT add a second classifier or a parallel Document row.**

- Canonical: classification is **meaning**; the Secretary may not author it; it belongs to the issuing/extractor/Brain layer.
- Code reality: on issue, Billing **already** authors its own income truth: `FinancialEvent(direction=INCOME, sourceType=BILLING_INVOICE, category)`. That is exactly "this is an invoice; it is income," authored by the correct owner (Billing, from its own facts) — fully compliant.
- **Boundary trap to avoid:** the task's "file it under the Documents category" implies writing a row into the **inbound** Documents/OCR store (`Document`/`ExtractedData`). Billing invoices and inbound Documents are **separate stores**; creating a Document for an outbound invoice mixes them and duplicates truth.
- **Plan:** confirm the existing `FinancialEvent(INCOME)` meets the product intent. If the desire is "see issued invoices alongside records," build a **read-only union view** over `BillingDocument` + `FinancialEvent` / Documents — **not** a new classification write. No Secretary-authored category.

### #12 — Auto-generate + send a receipt when payment is received
**Verdict: ⛔ DEFER (canonical). Technically feasible via an existing seam, but gated behind governance.**

- Canonical: receipts must be created **only from a verified `PAID`**, be immutable + audited; and **receipt automation is explicitly out of current compliance scope** ("no receipt flows", "safe to wait: receipt type").
- Code reality: the pieces exist — `RECEIPT` document type + `createReceiptDraft` + issue/numbering/immutability + allocation to the invoice, and `onVerifiedPaid` (fires only on **verified** PAID, currently no consumer). So the pipeline *could* be: `onVerifiedPaid` → `createReceiptDraft(from settlement)` → issue → allocate to invoice → deliver.
- **Why defer:** compliance hardening hasn't opened receipt automation; delivery ("send to client") + "store under documents" need (a) a delivery channel decision and (b) avoiding the same store-mixing trap (a receipt lives in Billing, surfaced via a union view — not copied into the inbound Documents store).
- **Plan when authorized:** implement strictly as: **trigger = verified `PAID` only** (never webhook signal); **owner opt-in** (not silent) unless Collections/Billing Policy authorizes silent issuance; immutable + `BillingAuditEvent` logged (already enforced by the issue flow); receipt surfaced in records via a read-only view, not duplicated.

---

## 3. Recommended sequencing

**Phase A — build now (low risk, high value, boundary-safe, mostly existing infra):**
- **#10** Suggest-collection after issue (new `PaymentRequest` from invoice; suggestion only).
- **#8** Save-contact prompt + party-only prefill guarantee (pending the ad-hoc-recipient check).

**Phase B — verify/surface, likely little-to-no new persistence:**
- **#9** Confirm the issued invoice + Collection Workspace already serve "open receivable until paid"; add only a **read-only aging** derivation if the owner wants overdue visibility.
- **#11** Confirm the existing `FinancialEvent(INCOME)` satisfies "classified as income"; if a unified records view is wanted, build it **read-only** (no new classifier, no Document row for invoices).

**Phase C — deferred, needs governance sign-off:**
- **#12** Auto-receipt via `onVerifiedPaid`, only after receipt automation is authorized in the compliance plan; strictly verified-PAID-triggered, immutable, audited, owner-opt-in.

---

## 4. Open questions for the owner (block precise scoping)

1. **#8:** Does invoice creation currently allow a fully ad-hoc, unsaved recipient? (If a `Customer` is always created, #8 may already be done bar the prompt.)
2. **#9/#11:** Is the desired outcome a **unified "records/documents" view** that shows issued invoices next to inbound documents? If yes, we build a read-only union — not new writes. Confirm this is the intent rather than literally copying invoices into the inbound Documents store.
3. **#11:** Is the existing `FinancialEvent(direction=INCOME)` on issue considered sufficient "auto-classification," or is there a specific UI surface the owner expects it to appear in?
4. **#12:** Authorization to open **receipt automation** (currently deferred by the compliance hardening plan). Until ratified, #12 stays on the shelf.
5. **#10/#12:** Any Collections Policy stance on **silent vs. owner-confirmed** creation? Default assumption here: **suggest/opt-in**, never silent, until policy says otherwise.
6. **#12 delivery:** which channel sends the receipt to the customer (email / WhatsApp), and does it reuse existing integration infra?

---

## 5. Anti-patterns this plan explicitly avoids

- Creating a **new Receivable source of truth** or making the Secretary own receivables (#9). ❌ avoided.
- Having the **Secretary author classification/meaning** (#11). ❌ avoided — Billing already authors its own income truth.
- **Copying outbound invoices/receipts into the inbound Documents store** (#11/#12 store-mixing). ❌ avoided — surface via read-only views.
- **Auto-issuing receipts from an unverified signal** (#12). ❌ avoided — verified `PAID` only, and deferred until authorized.
- **Silent automatic financial actions** overriding owner agency (#10). ❌ avoided — suggestion/opt-in.
