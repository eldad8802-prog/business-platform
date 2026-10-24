# Foreign-currency collection switch (`DUBIZ_FX_COLLECTION_ENABLED`)

**What it is.** A server-side, fail-closed kill switch over every way Dubiz can ask a payment provider to charge
in a currency other than ILS. Read in one place: `lib/services/payments/fx-collection-flag.ts`
(`isForeignCurrencyCollectionEnabled()`), per call, the same way `DUBIZ_I18N_ENABLED` is read.

**Default: OFF.** It is ON only when the variable is exactly the string `true`. Unset, empty, `1`, `TRUE`,
` true`, `yes`, `on` — all OFF. Nothing sets it anywhere (no Vercel, GitHub or `.env` change was made with it).

**ON is not enough.** Dubiz issues no foreign-currency tax document of its own (#766), so a USD / EUR payment must
come with the provider's document. A foreign currency is therefore offered and accepted only when **all four** hold:

1. the switch is ON;
2. the selected provider is **CardCom**;
3. the CardCom adapter can encode the currency (ILS 1, USD 2, EUR 978);
4. this business's CardCom connection has `documentIssuer = PROVIDER_ISSUES` (CardCom issues the documents).

Anything else — switch OFF, `DUBIZ_ISSUES`, `NOT_CONFIGURED`, any other provider — is **ILS only**. The rule is
`foreignCurrencyCollectionRefusal` / `isForeignCurrencyAllowedFor` in `lib/services/payments/payment-currency-offer.ts`;
readiness and `createPaymentRequest` both use it.

### Truth table (USD / EUR; ILS is always accepted, unchanged)

| Switch | Provider | `documentIssuer` | Readiness `offerableCurrencies` | `POST /api/payments/requests` USD/EUR |
|---|---|---|---|---|
| OFF | any | any | `["ILS"]` | 400 `FOREIGN_CURRENCY_COLLECTION_DISABLED` |
| ON | CardCom | `NOT_CONFIGURED` | `["ILS"]` | 400 `FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS` |
| ON | CardCom | `DUBIZ_ISSUES` | `["ILS"]` | 400 `FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS` |
| ON | CardCom | `PROVIDER_ISSUES` | `["ILS","USD","EUR"]` | **201**, CardCom asked for coin 2 / 978 |
| ON | any other provider | any | `["ILS"]` | 400 `FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS` (today every other provider is also disabled) |
| ON | CardCom `PROVIDER_ISSUES`, adapter without the currency | | the adapter's set | 400 `UNSUPPORTED_CURRENCY` |

Every 400 above is `{ error, code, offerableCurrencies: ["ILS"] }` with the message in the viewer's language
(`api.payments.foreignCurrencyCollectionDisabled` / `api.payments.foreignCurrencyRequiresProviderDocuments`, he/en),
returned **before** a `PaymentRequest` row, a payment audit event or any provider call exists.

**Whether the terminal accepts the coin** cannot be known in advance. If CardCom refuses it when the payment page is
created (`LowProfile/Create` with a non-zero `ResponseCode`), the existing failure handling applies: the request is
marked `FAILED` with no link (nothing can be charged), the caller gets 400 "Failed to create payment link: …", and
no money row, routing entry or settlement exists.

## Behaviour

| | Switch OFF (default) | Switch ON |
|---|---|---|
| `GET /api/collection/readiness` → `offerableCurrencies` | `["ILS"]` for every business and every provider, so `/collection/new` shows no currency choice | CardCom `PROVIDER_ISSUES`: the Dubiz set (ILS / USD / EUR) narrowed by the adapter (CardCom ILS/USD/EUR); every other collector: `["ILS"]` |
| `POST /api/payments/requests` with `currency` USD / EUR (any case) or any non-ILS | **400** `{ error, code: "FOREIGN_CURRENCY_COLLECTION_DISABLED", offerableCurrencies: ["ILS"] }`, message in the viewer's language (`api.payments.foreignCurrencyCollectionDisabled`, he/en) | CardCom `PROVIDER_ISSUES`: accepted when the adapter supports it, otherwise 400 `UNSUPPORTED_CURRENCY`; every other collector: 400 `FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS` |
| Invoice-backed request whose currency resolves to non-ILS (e.g. a future USD invoice, no `currency` sent) | **400** `FOREIGN_CURRENCY_COLLECTION_DISABLED` | the same collector rule, then the invoice's currency held to the adapter's set |
| Invoice-backed, ILS invoice, other currency sent | 400 `CURRENCY_MISMATCH` (unchanged) | 400 `CURRENCY_MISMATCH` (unchanged) |
| ILS (sent, omitted, or `ils`) | unchanged — byte-identical to the switch ON and to `main` | unchanged |

Where the refusal happens: `createPaymentRequest` (`lib/services/payments/payment-request.service.ts`, step 2b''),
right after the request's currency is resolved and **before** a `PaymentRequest` row, a payment audit event or any
provider call exists (only tenant-scoped reads have run). It is given the collector — the selected provider and its
active connection's `documentIssuer`, read server-side; nothing in the request body can name it. `assertCurrencyOfferable`
applies the same switch and collector first, so the adapter-level gate gives the same answer. The guard is at the service layer, so every caller is covered —
today the only non-test caller is `POST /api/payments/requests`.

## Every path that can ask a provider for money

| Path | Verdict |
|---|---|
| `POST /api/payments/requests` → `createPaymentRequest` → `adapter.createPaymentLink` | **GUARDED** (the switch + the CardCom `PROVIDER_ISSUES` collector) |
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

## After a USD / EUR payment: CardCom's document

The **payment** is recorded exactly as before (M1: CardCom's own transaction id, amount and coin from `GetLpResult`).
Whether CardCom issued a document is decided **only** from that same authoritative `GetLpResult` answer
(`cardComIssuedDocument` in `providers/cardcom/cardcom.provider.ts`) — never from the webhook body, never from
payment success alone:

- `DocumentInfo` with a non-zero `ResponseCode` → CardCom says no document was created → **missing**;
- otherwise `DocumentInfo` (or else `TranzactionInfo`) `DocumentNumber` > 0 **and** a `DocumentType` (not `Error`)
  → the document; `DocumentUrl` is kept only as an https link on CardCom's own hosts (`cardcom.solutions`,
  `cardcom.co.il`), otherwise the number is kept without a link;
- anything less (a bare `DocumentInfo`, number 0, no type) → **missing**.

Only for a **foreign-currency request on a `PROVIDER_ISSUES` connection**, the recording path
(`payment-verification.service.ts`) stores the verdict inside the existing JSON evidence envelope
(`PaymentTransaction.rawPayload.verification.providerDocument` = `{ number, type, url }` or `null`) — no schema
change — and opens the settlement:

| Verified answer | Settlement (`REQUIRES_ATTENTION`) | Owner sees |
|---|---|---|
| document present | `PROVIDER_IS_DOCUMENT_ISSUER` (the same reason ILS + `PROVIDER_ISSUES` gets today) | the existing "the processor issues the document" line **plus** "המסמך הופק ב־CardCom: … מס׳ N" and a link that opens CardCom's own URL in a new tab |
| document missing | `PROVIDER_DOCUMENT_MISSING` (new, non-retryable) | "התשלום התקבל ונרשם — המסמך מ־CardCom חסר ודורש טיפול" / "The payment arrived and was recorded — the CardCom document is missing and needs attention" |

Dubiz **never** issues a receipt for these: `documentHoldFor(PROVIDER_ISSUES)` stops every settlement path before any
receipt work, `PROVIDER_DOCUMENT_MISSING` is in `NON_RETRYABLE_ATTENTION_REASONS` (requeue / "try again" / scheduled
recovery cannot clear it) and an issuer-decision release touches only `DOCUMENT_ISSUER_NOT_CONFIGURED` rows. A
redelivered webhook records nothing new (the money row is unique per CardCom transaction). A failed lookup records
nothing; the next delivery or reconciliation asks again. A foreign row on `DUBIZ_ISSUES` / `NOT_CONFIGURED` (cannot
be created any more) still pauses `FOREIGN_CURRENCY_DOCUMENT_HELD` / `DOCUMENT_ISSUER_NOT_CONFIGURED` as in #766.

ILS is untouched: no ILS row is checked for a CardCom document, no ILS envelope gains the `providerDocument` key, and
every ILS hold is decided exactly as before.

The document is shown (additive, optional `providerDocument` field, present only on those foreign-currency rows) in
`GET /api/collection/inbox` (paid items and receipt-attention items), `GET /api/collection/customers/[customerId]`
(`PAYMENT_VERIFIED` events) and `GET /api/payments/requests/[id]` (`transactions[]`) — each read inside the caller's
own tenant, so another business never sees it.

**No `Document` object is sent to `LowProfile/Create`.** CardCom v11 `DocumentBase` requires the recipient `Name` and
takes `Products` with prices, `IsVatFree` and other fiscal fields; filling those would be Dubiz deciding the
foreign-currency document's content and VAT treatment, which is out of scope until the accountant answers. Whether a
terminal creates its configured document without that object is a CardCom question for the pilot; until it is
answered, the verification above is what makes a terminal that does not visible (`PROVIDER_DOCUMENT_MISSING`).

## Turning it on

Turning the switch on is an **owner decision**, taken only **after** the CardCom answers (foreign-currency terminal
/ coin support on the live account, and that the terminal issues its configured document for a USD / EUR LowProfile
payment) and the accountant answers (how a USD / EUR receipt and its ILS value are to be issued). It only ever opens
USD / EUR for a business whose CardCom connection is set to `PROVIDER_ISSUES`. Until then foreign-currency documents are also held by #766 (`FOREIGN_CURRENCY_DOCUMENT_HELD`, see
`FOREIGN-CURRENCY-HOLD-AUDIT.md`). Setting it means adding `DUBIZ_FX_COLLECTION_ENABLED=true` to the Production
environment and redeploying; removing it (or any other value) switches collection back to ILS-only immediately on
the next request — no data change either way.

## Proof

- `lib/services/payments/payment-currency-offer.test.ts` section 0 (pure): value matrix (only `"true"` opens it),
  OFF offers ILS alone for every provider, USD/EUR/GBP refused with no row / audit / provider call (counted),
  invoice-derived USD refused, ILS output identical OFF vs ON; sections 1–6 = the ON behaviour.
- `.c3settlement/battery.mts` Y (real PostgreSQL, real `POST /api/payments/requests` + real CardCom webhook route):
  OFF → 400 `FOREIGN_CURRENCY_COLLECTION_DISABLED`, no `PaymentRequest`, no `PaymentAuditEvent`, CardCom never
  called; `1` / `TRUE` / ` true` still refused; ILS 201 → receipt issued.
- `.collection/battery.mts` R2 (real readiness route): OFF → `["ILS"]` with CardCom; ON → `["ILS"]` for
  `DUBIZ_ISSUES` / `NOT_CONFIGURED`, `["ILS","USD","EUR"]` for `PROVIDER_ISSUES`. D1: the document in inbox, thread
  and payment detail, `null` when missing, absent on ILS, never visible to another tenant (404s).
- `lib/services/payments/fx-provider-documents.test.ts` (pure, real CardCom adapter): the whole truth table through
  `createPaymentRequest` + readiness (no row / audit / provider call on refusal), ILS identical for every issuer and
  switch state, CardCom refusing a coin, every document shape, the webhook body ignored, lookup failure, redelivery,
  ILS envelopes byte-identical, foreign refunds unchanged, he/en labels and the rendered link.
- `.c3settlement/battery.mts` Y-ON (real PostgreSQL + real routes): `DUBIZ_ISSUES` / `NOT_CONFIGURED` → 400
  `FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS` with nothing persisted; `PROVIDER_ISSUES` USD/EUR → recorded, document
  kept, `PROVIDER_IS_DOCUMENT_ISSUER` or `PROVIDER_DOCUMENT_MISSING`, no `BillingDocument`, duplicate webhook inert;
  lookup failure then recovery; CardCom refusing EUR → `FAILED`, no money.
- `lib/services/billing/settlement/foreign-currency-document-hold.test.ts`: `PROVIDER_DOCUMENT_MISSING` survives settle,
  requeue, "try again", issuer decisions and scheduled recovery with no receipt work.
