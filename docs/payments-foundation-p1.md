# P1 — Payment Links Foundation

External clearing foundation. **Dubiz is not a payment processor.** We never
store card numbers / CVV / card details and never hold customer funds. Payment
happens at an external provider via a hosted checkout URL. We persist only
statuses, identifiers, the payment link, webhook events, and links to
document / customer.

## What this slice contains (Data + Services + Tests)

- **Schema** (additive) — `BusinessPaymentConnection`, `PaymentRequest`,
  `PaymentTransaction`, `PaymentWebhookEvent` + enums `PaymentProvider`,
  `PaymentRequestStatus`, `PaymentTransactionStatus`,
  `PaymentWebhookProcessingStatus`.
- **Migration** — `prisma/migrations/20260624140000_add_payments_foundation/`
  (generated offline; **not** applied to Production).
- **Domain services** under `lib/services/payments/`:
  - `payment-crypto.service.ts` — AES-256-GCM for the merchant credential
    (never card data), AAD-bound to `businessId:provider`. Key:
    `PAYMENTS_ENCRYPTION_KEY`.
  - `payment-request.service.ts` — create-payment-link flow.
  - `payment-webhook.service.ts` — idempotent webhook ingestion.
  - `payments.types.ts` — domain types + the `PaymentStore` port.
  - `payment-store.prisma.ts` / `payment-store.memory.ts` — store
    implementations (Postgres / in-memory fake).
  - `payments.deps.ts` — production wiring.
  - `providers/` — `PaymentProviderAdapter` interface, registry, Tranzila
    adapter, stub provider.
- **Tests** (run with `npx tsx <file>`, no DB, no real provider):
  - `payment-crypto.test.ts`, `payment-request.test.ts`,
    `payment-webhook.test.ts`.

## Architecture

Every route/service calls an internal service; the service calls the provider
**adapter** through the registry — never the provider SDK/HTTP directly. The
persistence `PaymentStore` port keeps the create/webhook logic unit-testable
without a database.

### Create payment link
1. validate business + input → 2. find active `BusinessPaymentConnection` →
3. create `PaymentRequest` PENDING (persist first) → 4.
`provider.createPaymentLink` → 5. save `paymentUrl` + `providerRequestId` →
6. return request + URL.

### Webhook
1. persist raw event first (idempotent on `provider + providerEventId`) →
2. verify authenticity → 3. parse → 4. locate `PaymentRequest` →
5. create `PaymentTransaction` → 6. move request to PAID/FAILED/CANCELLED →
7. idempotent (duplicate event or duplicate provider transaction never double
-charges or corrupts status) → 8. Billing/Receipt hand-off is **prepared, not
auto-fired**.

## Environment

| Var | Purpose | Required |
| --- | --- | --- |
| `PAYMENTS_ENCRYPTION_KEY` | 32-byte key (hex/base64) for credential crypto | to connect a provider |
| `TRANZILA_WEBHOOK_SECRET` | optional shared secret for webhook auth | optional (foundation) |

Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## ⚠️ DOCS-CONFIRM before going live (Tranzila)

Isolated in `providers/tranzila/tranzila.provider.ts`:
- exact hosted-page parameter names (`sum` / `currency` / custom field echo),
- notification field names (transaction id, response code),
- notification authentication scheme.

Confirm these against current Tranzila integration docs before enabling a live
terminal. No live HTTP calls are made in this slice.

## Not in scope (P1) / next steps

- **Not built now:** subscriptions, tokenization, refunds/credits, marketplace,
  split payments, wallet, recurring charges, full UI.
- **Next:** API routes (`POST /api/payments/requests`, connection management,
  `POST /api/payments/webhook/tranzila`), then minimal Settings → Payments UI,
  then (separately, only when the receipt engine is ready) the Billing/Receipt
  hand-off on PAID.
