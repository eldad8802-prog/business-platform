# M1 — Production proof of inbound reconciliation (QA tenant, CardCom TEST terminal)

**Claim under proof:** a payment CardCom took is recorded exactly once even when
its webhook never reaches the processing path, and running reconciliation
again changes nothing.

**Constraints:** QA tenant only (business 38, see
`collection-qa-tenant.identity.env`), CardCom **test terminal 1000**, no real
money, no fabricated provider or database state, no schema change.

## How the webhook is withheld without fabricating anything

CardCom requires a `WebHookUrl` on every checkout. When — and only when — both
gates hold, the checkout is created with that URL pointing at
`/api/payments/qa-webhook-sink`, a path with no route (it answers 404), so
CardCom's real notification reaches nothing that processes it:

1. Vercel Production env `PAYMENTS_QA_SUPPRESS_WEBHOOK` is exactly
   `collection-qa-38`;
2. the request belongs to business **38** (a repository constant, pinned by
   `lib/services/payments/qa-webhook-suppression.ts` and its test).

Every such request carries the audit event
`PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED`. With the flag unset — the default —
nothing changes for anyone, and even with it set no other business is affected.

## Procedure

| # | Who | Step | Expected |
|---|---|---|---|
| 0 | — | M1 merged, `m1 — inbound money truth` CI green on `main`, Production deployed | — |
| 1 | Owner | Vercel → Production env: add `PAYMENTS_QA_SUPPRESS_WEBHOOK=collection-qa-38`, redeploy | — |
| 2 | Owner | Log in as the QA tenant; confirm CardCom **test terminal 1000** is the connected provider | readiness shows no blocker |
| 3 | Owner | Issue a QA tax invoice of **10 ₪**; `/collection/new` → collect **5 ₪** against it; open the link | CardCom hosted page, 5 ₪ |
| 4 | Owner | Pay with a CardCom **test card** | CardCom success page |
| 5 | Operator | Run *Prod Read-Only Evidence* with `ops/evidence/m1-reconciliation-qa-evidence.sql` | Q1 row: `incoming_tx 0`, `webhook_events 0`, request `PENDING` — Dubiz does not know yet |
| 6 | Operator | Wait ≥ 2 minutes, then dispatch *payment settlement recovery (scheduled)* (reconciliation runs first) | reconciliation step `HTTP 200`, report `recorded ≥ 1` |
| 7 | Operator | Run the evidence file again | Q1: `request_status PAID`, `webhook_events 0`, `incoming_tx 1`, `incoming_amount 5.00 ILS`, `settled 1` of `settlements 1`, `issued_receipts 1`, `receipt_total 5.00`, `receipts_by_a_person 0`, `allocated 5.00`, `money_in_events 1`, `verified_by RECONCILIATION`, `verified_audits 1`. Q2: invoice `10.00`, settled `5.00`, remaining `5.00`. Q3: all zero |
| 8 | Operator | Dispatch the recovery workflow again, then run the evidence a third time | reconciliation `recorded 0`; evidence identical to step 7 |
| 9 | Owner | Remove `PAYMENTS_QA_SUPPRESS_WEBHOOK` from Vercel, redeploy | the QA tenant's checkouts notify the real webhook again |

A red reconciliation step is itself evidence and must be read, not retried
away: the report says whether CardCom could not be asked
(`verificationErrors`) or answered anomalously (`anomalies.*`).

## What this does not prove

Live (non-test) money; SUMIT, PayPal, Tranzila or PayPlus; refunds (M2).
