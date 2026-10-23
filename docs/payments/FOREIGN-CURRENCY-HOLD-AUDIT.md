# Foreign-currency document hold — bypass audit

**Scope.** PR #766 (`FOREIGN_CURRENCY_DOCUMENT_HELD`) on the combined code: `origin/main` @ `3329b5cd` + #766 + #768
(integration branch `integ/fx-766-768`, draft PR #773). Question: can a verified payment in a currency other than
ILS end with an automatically issued tax document (receipt) by any path that does not go through the hold?

**Rule under audit.** `settleVerifiedPayment` → `settleInTx` throws `SettlementAttention("FOREIGN_CURRENCY_DOCUMENT_HELD")`
for any currency ≠ `AUTOMATIC_DOCUMENT_CURRENCY` (`"ILS"`), after the eligibility / verified-money / issuer /
invoice-currency checks and **before** customer resolution, `createReceiptDraftTx`, allocation and
`issueBillingDocumentTx`. The reason is in `NON_RETRYABLE_ATTENTION_REASONS`, so `requeueSettlement` refuses it.

**Method.** `grep` over `app/`, `lib/`, `components/`, `scripts/` (tests excluded) for every caller of
`createReceiptDraftTx`, `createReceiptDraft`, `issueBillingDocumentTx`, `issueBillingDocument`,
`settleVerifiedPayment`, `releaseDocumentIssuerHolds`, `requeueSettlement`, `settleAccounting`, and every
`billingDocument.create|createMany|upsert`; plus every cron in `vercel.json`, every webhook route, the QA sink,
data-transfer / historical import, refunds, and accountant month close.

Verdicts: **HELD** = goes through `settleVerifiedPayment`, so a foreign currency pauses with the reason ·
**NO AUTO-ISSUE** = cannot issue a document without a person · **N/A** = never writes billing documents.

## The two writers of an automatic receipt

| Function | Callers (non-test) | Verdict |
|---|---|---|
| `createReceiptDraftTx` | `payment-accounting-settlement.service.ts` (`settleInTx`, after the hold); `billing-receipt-draft.service.ts` `createReceiptDraft` (wrapper) | **HELD** — the only automatic caller is after the hold |
| `createReceiptDraft` | none outside its own file (tests only) | **N/A** — no route reaches it |
| `issueBillingDocumentTx` | `settleInTx` (after the hold); `issueBillingDocument` | **HELD** for the automatic path |
| `issueBillingDocument` | `app/api/billing/documents/[id]/issue/route.ts` — the owner presses "issue" on a draft | **NO AUTO-ISSUE** — manual; drafts are created ILS (`billing-draft.service.ts` hard-codes `currency: "ILS"`) |

## Every path into `settleVerifiedPayment`

| Path | Entry | Verdict |
|---|---|---|
| CardCom webhook | `app/api/payments/webhook/cardcom/route.ts` → `handleProviderWebhook` → `processPaymentWebhook` → `paymentWebhookDeps().settleAccounting` → `settleVerifiedPayment` | **HELD** — proven end to end by C3 case **Y** (USD, EUR held; ILS issued) and C3 case **X** |
| Generic webhook | `app/api/payments/webhook/[provider]/route.ts` → `handleProviderWebhook` (same deps) | **HELD** for enabled providers; disabled ones refused 404 before parsing |
| Tranzila / PayPal / SUMIT webhooks (disabled) | `webhook/tranzila`, `webhook/paypal`, `webhook/sumit/[secret]` → `handleProviderWebhook` | **N/A today** — `isPaymentProviderEnabled` refuses (`DISABLED_PAYMENT_PROVIDERS`); if re-enabled they use the same `settleAccounting` → **HELD** |
| QA webhook sink | `app/api/payments/qa-webhook-sink/route.ts` | **N/A** — answers `{}` / 404, never reaches `processPaymentWebhook` |
| Reconciliation cron | `/api/payments/reconciliation` (02:40) → `payment-reconciliation.service` → `projectAndSettle` → `paymentReconciliationDeps().settleAccounting` (= the webhook's) | **HELD** |
| Settlement recovery cron | `/api/payments/settlement-recovery` (03:00) → `payment-settlement-recovery.service.ts:140` → `settleVerifiedPayment` | **HELD** — only `PENDING` rows are picked; a held row is `REQUIRES_ATTENTION` and non-retryable |
| Attention "retry" / name the customer | `app/api/collection/settlements/[paymentTransactionId]/retry/route.ts` → `resolveAndRetrySettlement` → `requeueSettlement` (refuses the reason) → `settleVerifiedPayment` | **HELD** — the re-run reaches the same currency check (C3 X: "a further settle stays held") |
| Document-issuer decision | `payment-connection.service.ts:212` `onDocumentIssuerConfigured` → `releaseDocumentIssuerHolds` → `settleVerifiedPayment` | **HELD** — releases only `DOCUMENT_ISSUER_NOT_CONFIGURED` rows; a foreign one re-pauses as `FOREIGN_CURRENCY_DOCUMENT_HELD` (C3 X "release") |
| Provider is document issuer | `documentHoldFor` in `settleInTx` (before the currency check) | **NO AUTO-ISSUE by Dubiz** — `PROVIDER_IS_DOCUMENT_ISSUER`, no Dubiz document in any currency |

## Other cron routes (`vercel.json`)

| Cron | Verdict |
|---|---|
| `/api/intake/sweep` (03:20) | **N/A** — intake only, no billing import |
| `/api/transactional-email/sweep` (*/10) | **N/A** — email only (imports only the shared cron auth helper) |
| `/api/knowledge/derive` (GitHub workflow) | **N/A** — knowledge derivation |

There is no `app/api/cron/*` directory on main.

## Other writers of `BillingDocument`

| Writer | Verdict |
|---|---|
| `billing-draft.service.ts` (manual drafts: invoice, quote, receipt) | **NO AUTO-ISSUE** — owner-created, `currency: "ILS"` |
| `convert-quote-to-invoice.service.ts` | **NO AUTO-ISSUE** — owner action; copies the quote's currency (quotes are ILS drafts) |
| `billing-credit-reversal.service.ts` (`/api/billing/documents/[id]/credit-note`) | **NO AUTO-ISSUE** — owner action; currency must equal the source invoice |
| Refunds (`/api/payments/requests/[id]/refund`, `/refund/verify`, `payment-refund.service.ts`) | **NO AUTO-ISSUE** — a settled refund pauses as `REFUND_ACCOUNTING_DECISION_REQUIRED`; no credit document is created automatically |
| Billing authority (ITA) services | **N/A** — act on documents that already exist; untouched by #766 |
| `scripts/manual/collection-loader-smoke.ts` | **N/A** — manual lab script, not deployed |

## Imports and month close

| Path | Verdict |
|---|---|
| Data transfer — documents (`/api/data-transfer/documents/*`) | **N/A** — uploads source documents, no `BillingDocument` |
| Data transfer — historical (`/api/data-transfer/import/historical/*`, `/historical/records`) | **N/A** — writes `HistoricalFiscalDocument` (history, never issued, never numbered) |
| Commerce intake (Wix / WooCommerce) | **N/A** — no billing imports |
| Accountant month close | **N/A on main** — only PRs #745 / #750 / #746 (unmerged); `ops/evidence/accountant-month-close-*.sql` are read-only evidence queries. Re-audit if those land. |

## Result

**No bypass found.** Every automatic path to a receipt runs through `settleVerifiedPayment`, and the hold sits in
front of every receipt write inside it. The only ways to issue a document without it are manual owner actions
on ILS drafts. Two things to re-check later: a re-enabled provider (it inherits the hold through the shared
`settleAccounting`), and accountant month close if #745/#750 merge.

**Evidence.** C3 settlement battery (PG17) cases X and Y; `.i18n/battery.mts` M3/M4/M6; pure test
`lib/services/billing/settlement/foreign-currency-document-hold.test.ts`. Run ids are in the PR #766 body.
