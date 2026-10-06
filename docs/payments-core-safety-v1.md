# Dubiz Payments — Production Safety & Shared Payment Core (v1)

Status: implemented in PR-1 (code only, no migration). The schema-backed parts
(single document issuer configuration, default provider) are a separate,
migration-first follow-up and are listed under "Not in PR-1".

## The rule

Dubiz holds the business and financial truth; a provider only performs and
reports a payment. Dubiz never invents financial truth a provider did not
verify.

## The shared contract (lib/services/payments/providers/payment-provider.types.ts)

| Area | Contract | Enforced where |
|---|---|---|
| Money in | PAID is recorded only from `getPaymentStatus`, with the provider's transaction id **and** verified amount **and** currency. A webhook is a signal. | `payment-verification.service.ts` (sole writer of positive PAID rows) |
| Evidence | Every recorded row carries one envelope: source, callback body, payment method, provider-issued-document flag, environment, non-secret evidence. | `payment-evidence.ts` |
| Payment method | `CARD / BIT / APPLE_PAY / GOOGLE_PAY / UNKNOWN`, separate from the provider. Unstated stays UNKNOWN. | adapters → envelope → receipt line (card only with provider-stated brand + last 4) |
| Reconciliation key | Each descriptor declares `verificationKey` (`PROVIDER_REQUEST_ID` or `CORRELATION_VALUE`). Candidates are any issued request (session id **or** link). | `payment-reconciliation.service.ts`, `payment-store.*` |
| Refund verdict | Only `PaymentProviderRefusalError` releases a reservation. Any other throw is UNKNOWN and stays reserved. | `payment-refund.service.ts` |
| Refund identity | Every refund carries an idempotency key; a replay is answered from the ledger. | refund service + route (key required) |
| Refund recovery | Unresolved reversals are re-asked by the reconciliation run; unknown after 24h is unhealthy. A platform admin with MFA can resolve from provider evidence. | reconciliation sweep, `app/api/platform-admin/payments/reversals/resolve` |
| Refund accounting | A settled refund opens a paused accounting row (`REFUND_ACCOUNTING_DECISION_REQUIRED`) in the same write. No document is issued — the document type is an accounting decision. | store `updateTransaction(openRefundAccounting)` |
| Test vs live | Adapters classify a connection (`TEST/SANDBOX/LIVE/UNKNOWN`). In Production, non-LIVE cannot be connected, cannot issue links, and money that still arrives is recorded but its receipt is withheld. Pinned QA tenant excepted. | `payment-environment.ts` |
| Provider documents | When the provider's answer shows it issued its own tax document, the automatic receipt is withheld (`PROVIDER_ISSUED_DOCUMENT`). | verification → settlement opened held |
| Disable / disconnect | A disabled provider stops NEW payments; its open links are still observed (read-only status queries only). A connection with open links or pending refunds cannot be deactivated or repointed. | reconciliation, `payment-connection.service.ts` |
| Authorization | Refund / void / refund verification: the business's account owner (its first user). Manual resolution: platform admin + MFA. | `payment-authorization.ts`, `payment-account-owner.ts` |
| Attention | One read of money that needs a person, from durable rows only. | `payment-attention.service.ts`, `GET /api/payments/attention` |

## Proof

- `provider-contract.test.ts` — each REAL adapter (CardCom, SUMIT) through the shared path: link → lost webhook → reconciliation → exactly one row at the verified amount → replay no-op → refund target from stored evidence → timeout is UNKNOWN. CI puts back two historical defects and requires red.
- `payment-core-safety.test.ts`, `payment-refund.test.ts`, `cardcom-reversal.test.ts` — guards, idempotency, UNKNOWN semantics, refund accounting, CardCom empty-ResponseCode.
- `.m1inbound/battery.mts` case W — the new queries and writes under FORCE RLS as a NOBYPASSRLS role, including cross-tenant refusal.

## Not in PR-1 (needs schema → migration-first, owner approval)

- Per-connection document issuer configuration (`DUBIZ_ISSUES / PROVIDER_ISSUES / NOT_CONFIGURED`).
- Default provider per business.

## Decisions that are not engineering's

- Which document corrects a refund (credit receipt / cancelled receipt / credit tax invoice) — accountant.
- Whether a card payment for a service needs a tax invoice-receipt rather than a receipt — accountant.
- Whether an unconfigured document issuer should fail closed for providers that MAY issue documents — owner.
