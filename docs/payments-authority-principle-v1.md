# Payments Authority Principle (v1) — RATIFIED

**Type:** Design decision / principle ratification. No code, no migration, no
implementation design.
**Scope:** The entire Payments domain and every current and future payment
provider.
**Status:** RATIFIED.

> **The Principle**
>
> A webhook is **never** authority. A webhook is a **signal**.
> Provider **verification** is authority.
> **Only a verified payment may transition to `PAID`.**

This document ratifies the principle. It does not design how to implement it.

---

## 1. Problem Statement

The current webhook orchestration treats the inbound webhook payload as the
source of truth: `processPaymentWebhook` parses the notification and moves the
`PaymentRequest` to `PAID` directly from the parsed outcome
(`payment-webhook.service.ts`, step 6). The provider-verification seam exists on
the adapter (`getPaymentStatus?` in `payment-provider.types.ts`) but is **not
wired** — it has no call-site.

Trusting the webhook payload as authority is unsafe: a webhook is an
unauthenticated, replayable, spoofable, and sometimes out-of-order message. A
`PAID` state is a **financial fact** in Dubiz — it is the trigger for receipts,
allocations, and debt closure. A financial fact must never rest on an
unverified signal. This principle removes that ambiguity for every provider,
once and for all.

---

## 2. Why Webhook Is Not Authority

- **Unauthenticated / spoofable:** an endpoint that must be public can receive
  forged calls. Absent a strong, provider-issued signature, the body cannot be
  trusted on its own.
- **Replayable:** the same notification can arrive many times; the payload alone
  cannot establish "this truly happened once."
- **Tamperable:** fields such as amount, currency, and status in the body are
  not guaranteed to reflect what the provider actually settled.
- **Out-of-order / partial:** notifications can arrive late, duplicated, or in a
  sequence that does not match the real transaction lifecycle.
- **Provider guidance aligns:** the selected provider (CardCom) explicitly
  recommends Webhook → verification (GetLpResult) → trust. The webhook is the
  prompt to verify, not the verdict.

A webhook tells us **"something may have happened — go check."** It does not
tell us **"this is what happened."**

---

## 3. Signal vs Authority

Mapping onto Dubiz's evidence/authority ontology:

| Concept | Role | Trust | Moves to PAID? |
|---|---|---|---|
| **Webhook** | **Signal** — reported, unverified reality | None on its own | **Never** |
| **Provider verification** (e.g. GetLpResult) | **Authority** — directly queried, authoritative reality | Authoritative | **Yes** |

- A **signal** is permitted to do exactly one thing: be recorded, and trigger a
  verification.
- **Authority** is the only thing permitted to move money state forward.
- The persisted webhook record remains valuable as evidence and for
  idempotency — but evidence is not authority.

---

## 4. Payment Lifecycle

**Forbidden (current):**

```
Webhook → PAID
```

**Ratified (target ontology):**

```
Webhook (signal)
   ↓  record + dedupe
Provider verification (authority)
   ↓  confirms success / failure
PAID | FAILED   (only from verification)
```

- The webhook is **persisted first** (raw, before processing) and used for
  idempotency — unchanged.
- The webhook **locates** the `PaymentRequest` and **prompts** verification.
- The transition to `PAID` (and equally to a verified `FAILED`) is owned by the
  **verification result only**.
- `PENDING` is the resting state until authority speaks.
- `CANCELLED` / `EXPIRED` are derived states (timeout / no settlement), not
  signal-driven transitions.

---

## 5. Provider-Agnostic Rule

This principle is **not** CardCom-specific. It binds the shared Payments
orchestration and every provider adapter:

- Every provider MUST expose a verification capability (the existing
  `getPaymentStatus` seam is the contract).
- The shared webhook orchestration MUST NOT transition to `PAID` from a parsed
  webhook outcome for **any** provider.
- A provider without a usable verification path is **not eligible** to move a
  payment to `PAID` — it may only hold `PENDING` and surface the signal.
- Adding a future provider does not get to opt out of this rule.

The webhook adapter method interprets a signal; the verification adapter method
establishes authority. No provider may collapse the two.

---

## 6. Impact On PaymentRequest

- `PaymentRequest.status = PAID` becomes a **verified-only** state. It may be
  set exclusively as the consequence of provider verification, never directly
  from a webhook.
- `PENDING` explicitly means "signal may exist, authority has not yet
  confirmed."
- Verification authority should also confirm that the settled amount and
  currency match the `PaymentRequest`; a mismatch is not a `PAID`.
- Idempotency guarantees are unchanged and complementary: a verified `PAID` is
  applied once, and repeated signals/verifications never double-apply.

---

## 7. Impact On Receipt Creation

- A receipt is a financial/legal artifact. It may only be created from a
  **verified** `PAID` — never from a webhook signal.
- This is consistent with the Documents truth-layer and billing-compliance
  constraints: no financial artifact is produced on unverified input.
- Receipt automation (future, out of scope here) takes the verified `PAID`
  transition as its single trigger — not webhook receipt.

---

## 8. Impact On Debt Closure

- Closing an invoice's open balance (allocation / `remaining → 0`) is a
  consequence of a **verified** payment only.
- A signal must never reduce a debt. Debt closure follows the same authority as
  receipts: the verified `PAID` event.
- This protects the invoice's financial integrity: an unverified or spoofed
  notification can never make a debt disappear.

---

## 9. Impact On Future Providers

- The provider abstraction stands: adapters interpret signals and provide
  verification; the shared orchestration owns the authority rule.
- Onboarding any future provider is a question of "how does this provider let us
  **verify**" — verification is mandatory, not optional.
- A provider that only emits webhooks and offers no verification path may
  collect signals but may **not** be trusted to confirm `PAID`.
- This keeps payment correctness uniform across providers and prevents
  per-provider authority drift.

---

## 10. Final Ratification

**RATIFIED:**

1. A webhook is a **signal**, never authority.
2. Provider **verification** is the sole authority.
3. A `PaymentRequest` may transition to `PAID` **only** from verification.
4. Receipts, allocations, and debt closure derive from the verified `PAID`
   event only.
5. The rule is **provider-agnostic** and binds all current and future
   providers.

This principle is the constitutional rule for the Payments domain. Any
implementation work — including the CardCom integration and the authority-flow
wiring identified in `cardcom-implementation-planning-audit-v1.md` — must
conform to it. This document ratifies the rule only; it prescribes no code.
