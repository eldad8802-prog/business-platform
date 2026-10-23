# Foreign-currency collection switch (`DUBIZ_FX_COLLECTION_ENABLED`)

**What it is.** A server-side, fail-closed kill switch over every way Dubiz can ask a payment provider to charge
in a currency other than ILS. Read in one place: `lib/services/payments/fx-collection-flag.ts`
(`isForeignCurrencyCollectionEnabled()`), per call, the same way `DUBIZ_I18N_ENABLED` is read.

**Default: OFF.** It is ON only when the variable is exactly the string `true`. Unset, empty, `1`, `TRUE`,
` true`, `yes`, `on` — all OFF. Nothing sets it anywhere (no Vercel, GitHub or `.env` change was made with it).

## Behaviour

| | Switch OFF (default) | Switch ON |
|---|---|---|
| `GET /api/collection/readiness` → `offerableCurrencies` | `["ILS"]` for every business and every provider, so `/collection/new` shows no currency choice | the Dubiz set (ILS / USD / EUR) narrowed by the selected provider's adapter (CardCom ILS/USD/EUR, SUMIT ILS/USD, Tranzila ILS/USD/EUR, PayPal pass-through → the Dubiz set) |
| `POST /api/payments/requests` with `currency` USD / EUR (any case) or any non-ILS | **400** `{ error, code: "FOREIGN_CURRENCY_COLLECTION_DISABLED", offerableCurrencies: ["ILS"] }`, message in the viewer's language (`api.payments.foreignCurrencyCollectionDisabled`, he/en) | accepted when the provider supports it; otherwise 400 `UNSUPPORTED_CURRENCY` (as #768) |
| Invoice-backed request whose currency resolves to non-ILS (e.g. a future USD invoice, no `currency` sent) | **400** `FOREIGN_CURRENCY_COLLECTION_DISABLED` | the invoice's currency, held to the provider's set |
| Invoice-backed, ILS invoice, other currency sent | 400 `CURRENCY_MISMATCH` (unchanged) | 400 `CURRENCY_MISMATCH` (unchanged) |
| ILS (sent, omitted, or `ils`) | unchanged — byte-identical to the switch ON and to `main` | unchanged |

Where the refusal happens: `createPaymentRequest` (`lib/services/payments/payment-request.service.ts`, step 2b''),
right after the request's currency is resolved and **before** a `PaymentRequest` row, a payment audit event or any
provider call exists (only tenant-scoped reads have run). `assertCurrencyOfferable` applies the same switch first,
so the adapter-level gate gives the same answer. The guard is at the service layer, so every caller is covered —
today the only non-test caller is `POST /api/payments/requests`.

## Every path that can ask a provider for money

| Path | Verdict |
|---|---|
| `POST /api/payments/requests` → `createPaymentRequest` → `adapter.createPaymentLink` | **GUARDED** (the switch) |
| `/collection/new` (`collection-create-screen.tsx`) — the only UI that creates a request | **GUARDED** — calls `POST /api/payments/requests`; with the switch off readiness offers ILS alone, so no currency choice is shown. The inbox / customer thread / `/payments/[id]` only cancel, refund or read |
| `adapter.createPaymentLink` (CardCom, SUMIT, PayPal, Tranzila, stub) | **GUARDED** — its only non-test caller is `createPaymentRequest` |
| `store.createPaymentRequest` (Prisma) | **GUARDED** — its only non-test caller is `createPaymentRequest` |
| Refunds `POST /api/payments/requests/[id]/refund` (+ `/verify`) → `adapter.refundPayment` | **NOT A CHARGE** — returns money in the original transaction's currency; left unchanged so a customer's refund is never trapped. With the switch off no new foreign transaction can arise |
| Webhooks (`/api/payments/webhook/{cardcom,paypal,tranzila,sumit/[secret],[provider]}`) | **NOT A CHARGE** — record the outcome of an existing request; cannot create one |
| Reconciliation, settlement recovery / retry, attention, platform-admin reversals | **NOT A CHARGE** — read provider status / settle verified money |
| `POST /api/payments/qa-webhook-sink` | **N/A** — discards the callback, imports no payment code |
| `POST /api/collection/actions` | **N/A** — records a reminder action only |
| Recurring / standing-order charges | **N/A** — none exist in the codebase |
| Direct provider HTTP outside the adapters | **N/A** — none (`LowProfile/Create`, `checkout/orders` only in adapters) |

## Turning it on

Turning the switch on is an **owner decision**, taken only **after** the CardCom answers (foreign-currency terminal
/ coin support on the live account) and the accountant answers (how a USD / EUR receipt and its ILS value are to be
issued). Until then foreign-currency documents are also held by #766 (`FOREIGN_CURRENCY_DOCUMENT_HELD`, see
`FOREIGN-CURRENCY-HOLD-AUDIT.md`). Setting it means adding `DUBIZ_FX_COLLECTION_ENABLED=true` to the Production
environment and redeploying; removing it (or any other value) switches collection back to ILS-only immediately on
the next request — no data change either way.

## Proof

- `lib/services/payments/payment-currency-offer.test.ts` section 0 (pure): value matrix (only `"true"` opens it),
  OFF offers ILS alone for every provider, USD/EUR/GBP refused with no row / audit / provider call (counted),
  invoice-derived USD refused, ILS output identical OFF vs ON; sections 1–6 = the ON behaviour.
- `.c3settlement/battery.mts` Y (real PostgreSQL, real `POST /api/payments/requests` + real CardCom webhook route):
  OFF → 400 `FOREIGN_CURRENCY_COLLECTION_DISABLED`, no `PaymentRequest`, no `PaymentAuditEvent`, CardCom never
  called; `1` / `TRUE` / ` true` still refused; ILS 201 → receipt issued; ON → USD/EUR recorded and held.
- `.collection/battery.mts` R2 (real readiness route): OFF → `["ILS"]` with CardCom; ON → `["ILS","USD","EUR"]`.
