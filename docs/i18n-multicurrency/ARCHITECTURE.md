# Dubiz — Languages, regions & multi-currency

Milestone A (audit + architecture) and the status of milestones B–E.
Audit baseline: `origin/main` @ `897eeb9a` (2026-10-21). Branch: `feat/i18n-currency-foundation`.

---

## 1. Audit — what the system assumes today

### 1.1 Language / direction
| Finding | Evidence |
|---|---|
| No i18n library, no dictionary, no stored language preference (no cookie, no column, no localStorage). | `package.json`; `prisma/schema.prisma` (`User`, `Business` have no locale) |
| `<html lang="he" dir="rtl">` hard-coded at the root. | `app/layout.tsx` |
| ~17.2k lines of Hebrew in 988 files: `lib` 8.7k · `app` 4.2k · `components` 3.6k · `features` 0.6k. 157 test files assert Hebrew output. | rg `[֐-׿]` |
| `dir="rtl"` hard-coded 117× (96 files) + 17 inline `direction:"rtl"`. | e.g. `components/navigation/shell-chrome.tsx`, `features/tasks/tasks-screen.tsx` |
| Physical CSS is the main RTL debt: 126 inline `left/right` keys, 81 `textAlign:"right"`, ~50 physical props in CSS modules. Tailwind is barely used (19 physical classes). | `app/(corporate)/home/home.module.css`, `app/(shell)/secretary/secretary.module.css` |
| 216 literal arrows (← → ‹ ›) in TSX, many inside Hebrew strings; `IconChevronLeft` used as "forward". The only mirror-aware control is `components/ui/back-button.module.css`. | |
| ~24 money/date formatters; `he-IL` 191×, `₪` 297×, `Asia/Jerusalem` 92× (55 files). | `lib/ui/money.ts`, `features/home/v3/home-v3-model.ts`, `lib/billing/document-view-model.ts` … |
| ~190 Hebrew API/service error messages. | `app/api/**` (56 files), `lib/auth/auth-messages.ts` |
| Emails: `TransactionalEmail.locale` is stored ("he") but never passed to the renderer; templates are Hebrew-only. | `lib/email/transactional/delivery.ts:147` |
| LLM prompts force Hebrew output and the validator rejects non-Hebrew output. | `lib/features/content/llm/llm-prompt-builder.ts:198`, `llm-output-validator.ts:171` |

**Must NOT be translated:** uniform tax file (מבנה אחיד) `lib/services/billing/uniform/**`, Hebrew OCR/parsing keywords (`financial-normalization.service.ts`, `document-guardrail.service.ts`), issued document snapshots/PDF legal text, user-entered content.

### 1.2 Money / currency
| Finding | Evidence |
|---|---|
| Ledger tables already carry `currency String @default("ILS")` and `Decimal(18,2)` amounts: `BillingDocument`, `BillingReceiptPayment`, `BillingPaymentAllocation`, `FinancialEvent`, `PaymentRequest`, `PaymentTransaction`, `Payment`, `PaymentAllocation`, `Cheque`, `PaymentPreparation`, `ExternalTransaction`, `OutboundExecution`, `BusinessObligation`, `Commitment`, `Installment`. | schema |
| **No FX table, no rate snapshot column anywhere.** | schema, `lib/**` |
| **No base currency / timezone / region per business.** `Business` is a control-plane table — the runtime may UPDATE only `name` (B4). | `schema.prisma:156`, `app/api/business/name/route.ts` |
| Money models **without** currency: `FinancialRecord.amount Float` (the expense/income source of every report), inventory/pricing/purchasing (`Float`), `BusinessService` prices, `Deal` prices (`Float`), `KnowledgeMeasure` "currency" unit. | `schema.prisma:1856, 2075-2089, 1347-1407, 796-806, 949` |
| DB currency CHECKs exist only on `Lead` and `CommerceOrder` (ISO pattern, not ILS-only). | `20261002090000_crm_lead_lifecycle`, `20261013090000_m7a_…` |
| 7 duplicated minor-unit helpers (several `Math.round(x*100)`); only `lib/intake/commerce/money.ts` is exponent-aware. | `payables-core.ts:110`, `payment-document-authority.ts:79` … |

**Already multi-currency-aware (keep and build on):** payment providers' currency allow-lists (CardCom ILS/USD/EUR, Tranzila ILS/USD/EUR, SUMIT ILS/USD only, PayPal pass-through) and `assertCurrencySupported`; verification/settlement `VERIFIED_CURRENCY_MISMATCH`; receipt allocations `assertSameCurrency`; credit notes copy+enforce source currency; business-cost engine excludes non-base rows (`NON_BASE_CURRENCY`) instead of summing them.

### 1.3 Financial / tax risks found (exist today, latent while everything is ILS)
| # | Risk | Where | Severity |
|---|---|---|---|
| R1 | **ITA allocation threshold silently skipped for non-ILS invoices** (`meetsThreshold = currency === "ILS" && …`). A USD tax invoice would issue without an allocation number. | `billing/authority/billing-authority-readiness.ts:49` | **Critical (tax)** |
| R2 | Billing draft creation hard-codes `currency: "ILS"` (input ignored). | `billing/billing-draft.service.ts:218` | Blocks foreign invoices (safe) |
| R3 | Uniform file: field 1032 leading currency fixed ILS; 1422/1423 (foreign currency) hard-coded empty; raw amounts written as ILS. | `uniform/uniform-config.ts:63`, `uniform-file-builder.ts:165-267` | Critical once non-ILS docs exist |
| R4 | ITA approval payload sends amounts with no currency/ILS equivalent. | `authority/billing-authority-approval-payload.ts:180-345` | Critical once non-ILS docs exist |
| R5 | Cross-document totals summed without currency, labelled with the first row's currency (`invoices[0].currency`). | `collection/awaiting-payment.rules.ts:205-226`, `collection-inbox.service.ts:381-393`, `customer-financial-thread.service.ts:118,191`, `knowledge/snapshot/{cross-domain,cross-domain-brain,snapshot-sources}.ts` | High (wrong number) |
| R6 | Home / reports `_sum` with no currency filter; `FinancialRecord` has no currency. | `home-day.service.ts`, `home-collection.service.ts`, `app/api/reports/summary`, `lib/reports/accountant-export-zip.ts`, `app/api/documents/inbox/route.ts` | High |
| R7 | Receipt payment lines carry their own currency, not checked against the receipt header, then summed. | `receipt/billing-receipt-draft.service.ts:156`, `billing-receipt-allocation.rules.ts:132` | Medium |
| R8 | UI VAT default is `"17"` (Israeli VAT is 18% since 2025-01-01). | `lib/billing/document-view-model.ts:120` | Medium (pre-existing, not currency) |
| R9 | Learning observations (`IncomeDocumentObservation.total`, `VendorDocumentObservation.amount`) carry no currency → medians across currencies. | `lib/knowledge/rules/{income,documents}.ts` | Medium |
| R10 | OCR intake recognises only ₪/ILS; a USD receipt becomes a bare ILS number. | `document-guardrail.service.ts:34`, `amount-strategy.service.ts:254` | Medium |

~75 cross-row money aggregations exist; ~20 are safe (single document / currency-enforced). The rest are listed in the audit agent output and become the Milestone D work list.

---

## 2. Architecture

### 2.1 Four independent settings
`interface language` (he/en) · `region` (IL) · `time zone` (Asia/Jerusalem) · `base currency` (+ `display currency`).
Changing one never changes another. Language changes strings and direction only — never data.

### 2.2 Languages (Milestone B) — built
- **No locale in the URL.** Dubiz is an authenticated app; sub-path routing would move every route. Locale = `dz_locale` cookie → (later) the persisted preference → default `he`.
- `lib/i18n/config.ts` — locales, direction, Intl tag (`en` + `IL` → `en-IL`), the release flag `DUBIZ_I18N_ENABLED`.
- `lib/i18n/messages/he.ts` is the **source** dictionary; every other language is typed `Messages` so `tsc` lists missing keys. Keys are compile-checked (`MessageKey`).
- `lib/i18n/server.ts` (`getServerI18n`) for server components/route handlers; `components/i18n/I18nProvider.tsx` (`useI18n`) for client components. Only the active language's dictionary is sent to the browser.
- `lib/i18n/format.ts` — the single locale-aware money/number/date formatter. **Hebrew output is byte-identical to the legacy `lib/ui/money.ts`** (verified). Dates always render in the business time zone.
- `POST /api/preferences/locale` writes the cookie (no tenant data → no session needed; refuses unknown locales).
- **Release flag:** with `DUBIZ_I18N_ENABLED` unset, the root layout never reads cookies and renders `he/rtl` exactly as before (static pages stay static); the language buttons show "בקרוב".
- **Direction rule:** components never set `dir="rtl"`; they inherit from `<html>`. Use logical properties (`inset-inline-*`, `padding-inline-*`, `text-start`). Keep `dir="ltr"` only on intrinsically-LTR values (phones, e-mails, IBANs, codes).
- **Not in the dictionaries:** user content, issued documents, uniform tax file, parsing keywords, LLM prompts.

### 2.3 Money (Milestone C) — engine built, persistence proposed
- `lib/money/` — pure, runtime-agnostic (client-safe; no Prisma import):
  - `currency.ts` registry ILS/USD/EUR (+exponent, symbol); unknown currency → `UnsupportedCurrencyError`, never a default.
  - `decimal.ts` exact BigInt scaled decimals; rounding only by an explicit mode (`HALF_UP` / `HALF_EVEN`). Float noise (`0.1+0.2`) is **refused**, not rounded.
  - `money.ts` `Money {minor: bigint, currency}`; `add/subtract/compare` across currencies throw `CurrencyMismatchError`.
  - `fx.ts` `FxRate {base, quote, rate(decimal string), kind REPRESENTATIVE|TRANSACTION|DISPLAY, source BANK_OF_ISRAEL|PAYMENT_PROVIDER|MANUAL, rateDate, fetchedAt, verification}`. `convert()` returns a typed refusal (`RATE_MISSING | RATE_STALE | RATE_UNVERIFIED | RATE_KIND_NOT_ALLOWED | RATE_PAIR_MISMATCH | RATE_FROM_FUTURE | RATE_INVALID`) — **no silent conversion**. `accountingPolicy` = verified representative rate ≤4 days old; `displayPolicy` allows indicative rates and marks the result approximate.
  - `aggregate.ts` `sumByCurrency` + `totalIn` — a converted total exists only if every component converted; otherwise the per-currency breakdown + which currency failed.
- **Three layers:** base currency (business reporting) · transaction currency (stored on the row, never altered) · display currency (presentation; converted values are marked "≈").
- **Rates source:** Bank of Israel publishes official representative rates (שער יציג) free of charge — suitable as the `REPRESENTATIVE` source. **No paid provider is selected; no commercial commitment made.** The fetcher (Milestone C-2) requires owner approval of the source and a cron entry.

### 2.4 Proposed schema (Milestone C-1) — NOT applied
See `proposed-migration.sql`. Summary:
- `BusinessLocaleSettings` (new tenant table, 1 row per business; ENABLE+FORCE RLS on `app.current_business_id`; no row ⇒ defaults he / IL / Asia/Jerusalem / ILS — so **no backfill, no existing row changes**). Separate table because the runtime may not UPDATE `Business` beyond `name` (B4).
- `UserPreference` (userId PK, `locale`) — makes language survive logout/login on other devices.
- `FxRate` (global reference data, read-only to the runtime role; written by the fetcher role) unique on (base, quote, kind, source, rateDate), `rate numeric(20,10)`, CHECK rate > 0, currency CHECKs.
- `baseCurrencyLockedAt` on `BusinessLocaleSettings`: set at the first financial record; afterwards base currency changes only through a separate controlled process (not built).
- **Deferred to D (tax-gated):** FX snapshot columns on `BillingDocument` (`reportingCurrency`, `fxRate`, `fxRateDate`, `fxRateSource`, `reporting{Subtotal,Vat,Total}`), `FinancialRecord.currency`, currency on pricing/inventory.

### 2.5 Financial integration rules (Milestone D) — design, gated
1. Document currency, charge currency, settlement currency, payout currency and reporting currency are separate fields when they differ; none overwrites another.
2. An issued document freezes its currency **and** its FX snapshot (already enforced by `billing-immutability.guard.ts`) — rates are captured at issue, never back-filled.
3. Tax-relevant ILS amounts (allocation threshold, VAT in ILS, uniform file) use the **representative rate of the relevant date** under `accountingPolicy`; if no verified rate exists, issuing a foreign-currency tax document is **BLOCKED**, never approximated.
4. Until the owner/accountant approves the Israeli rules (rate date for tax invoices, VAT reporting in ILS, uniform-file foreign-currency fields, ITA payload), **foreign-currency tax documents stay blocked** (R2 stays as is). Quotes / proposals (non-tax) in foreign currency can be enabled first.
5. Payments: providers already enforce supported currencies; SUMIT EUR stays unsupported. Refunds inherit the original transaction currency. Exchange differences (charged vs. settled) are recorded as a separate field, never by editing amounts.
6. Every cross-row total moves to `sumByCurrency`; a single number appears only through `totalIn` with an explicit policy.

---

## 3. Plan & status

| Milestone | Scope | Status |
|---|---|---|
| **A** Audit & architecture | this document | **Done** |
| **B-1** i18n foundation | config, dictionaries (he source / en), translator, server+client access, formatter, root layout lang/dir, cookie endpoint, flag | **Done** (`lib/i18n`, `components/i18n`) |
| **B-2** Shell + settings | nav (rail / sidebar / bottom bar) translated + direction-agnostic; settings area direction-agnostic; "שפה, אזור ומטבע" screen | **Done** |
| **B-3** Screen-by-screen translation | 9 areas: home/shared UI, inbox/WhatsApp, documents, billing UI, collection/payments/payables, customers/leads/suppliers/inventory, tasks/secretary, settings/auth/onboarding, content/business/offers — ~7,000 keys; tab titles localized | **Done** (regression: 307/342 non-DB tests pass; the 34 failures also fail on main) |
| **B-4** Server strings | Still Hebrew in English mode: API error messages (~20 routes), server-built view-model text (lib/business-status, lib/inbox-view, task agenda-core, home-history), customer-facing WhatsApp/collection messages, emails | Planned |
| **C-1** Money engine | `lib/money` + tests | **Done** |
| **C-2** Persistence | proposed migration (settings, user pref, FxRate) | **Awaiting approval (schema)** |
| **C-3** BoI rate fetcher | cron + verification | **Awaiting approval (external source / cron)** |
| **D-1** Safe aggregation | R5 fixed: awaiting-payment groups by (customer, currency) + per-currency totals; collection inbox headline single-currency; customer thread per-currency; knowledge snapshots never add a second currency. ILS-only output unchanged (tests). | **Done** |
| **D-2** Remaining aggregation | R6 (home/reports `_sum`, `FinancialRecord` has no currency), R7 (receipt lines vs header), payment-request `waiting`/`paidRecent` sums | Planned (R6 needs the FinancialRecord.currency decision) |
| **D-3** Tax paths | R1/R3/R4 + foreign-currency tax docs | **Blocked pending accountant/owner rules** |
| **E** UX + regression | settings live currency choice, display-currency totals, E2E matrix | After C-2 |

### Approval stops (nothing below has been done)
1. Apply the C-2 migration (Production schema).
2. Turn on `DUBIZ_I18N_ENABLED` in Production.
3. Choose the FX source (Bank of Israel proposed) + add the cron.
4. Accounting rules for foreign-currency tax documents (rate date, VAT in ILS, uniform-file fields 1032/1422/1423, ITA payload, allocation threshold in ILS).
5. Any merge / deployment.

## 4. Translation wave plan (B-3)
Per area: move strings into `lib/i18n/messages` namespaces, `useI18n()`/`getServerI18n()`, remove `dir="rtl"`, convert physical CSS to logical, mirror directional icons, route money/dates through `lib/i18n/format.ts`. Hebrew output must stay identical (existing Hebrew tests are the regression net).
Waves: (1) home + notifications + inbox, (2) documents + billing UI, (3) collection + payments + payables, (4) customers + leads + suppliers + inventory, (5) tasks + secretary, (6) settings sub-screens + profile + onboarding/setup + auth, (7) API error codes. Out of scope: corporate marketing site (Hebrew-only public site), platform-admin (internal).
