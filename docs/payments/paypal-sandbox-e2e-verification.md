# PayPal Sandbox — End-to-End Collection Verification

**Status:** ✅ Verified (DEV + PayPal Sandbox)
**Date:** 2026-07-05
**Scope:** First full money-in E2E against a real external clearing provider, exercising the additive Payments Provider Framework and the Collection Workspace read-model without changing the product architecture.

---

## 1. Purpose

Prove — against a **real external provider** rather than mocks — that a customer payment flows end-to-end through Dubiz's payments architecture and surfaces correctly in the Collection Workspace, **before** the production CardCom provider is available.

Specifically, verify that:

- A payment request can be created and paid through a real provider checkout.
- **PAID is established only by authority verification**, never by a webhook signal alone (the Authority Principle).
- The verified collection appears in the Collection Workspace through the **same single read-model** the screen already consumes — with **no PayPal-specific UI coupling**.
- PayPal was added **additively**: no change to the Collection Workspace model, no new financial source of truth, no forbidden states.

PayPal Sandbox is a **means to exercise the architecture on live provider data**, not a product commitment to PayPal.

---

## 2. Environment Configuration

| Component | Value / Notes |
|---|---|
| **App environment** | DEV (local `next dev`, Next.js 16.2.1, Turbopack) |
| **Database** | Neon DEV branch `ep-square-grass-amqdtlrl` (provisioned via `prisma db push`; not Production) |
| **Provider** | PayPal **Sandbox** (Orders v2 API) |
| **Public webhook tunnel** | **ngrok** → exposes the local server so PayPal Sandbox can reach `/api/payments/webhook/paypal` |
| **`PAYMENTS_PUBLIC_BASE_URL`** | ngrok HTTPS URL (used for PayPal `return_url` and to receive webhooks) |
| **Credentials** | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, `PAYPAL_WEBHOOK_ID` — server-side env only (never entered in the UI, never stored as a connection secret) |
| **Encryption** | `PAYMENTS_ENCRYPTION_KEY` (32-byte, AES-256-GCM, fail-closed) present in `.env.local` (gitignored) |
| **Card data** | **None stored by Dubiz** — payment happens entirely on PayPal |

---

## 3. What Was Actually Verified

The complete inbound ("money-in") path on real Sandbox data:

1. Provider **connection/activation** persisted and shown as connected.
2. **Payment request** created and a real PayPal **order** opened.
3. **Buyer checkout + payment** completed on PayPal Sandbox.
4. **Webhook** received and treated strictly as a **signal**.
5. **Authority verification** (PayPal Orders GET + capture) confirmed a `COMPLETED` capture.
6. Request transitioned to **PAID** with a recorded transaction.
7. **Collection Workspace** surfaced the payment in the **verified** truth-state.
8. **Timeline / lifecycle** reflected the progression.

---

## 4. Flow — Step by Step

### 4.1 Connection
- Settings → Connections → **PayPal (sandbox)** activated via the generic descriptor-driven route `POST /api/payments/connections` with `{ provider: "PAYPAL", merchantId }`.
- PayPal's descriptor declares **`credentialFields: []`** — credentials come from server env, so the connection is an **activation flag**, not a secret store.
- `GET /api/payments/connections` → PayPal `isActive: true`, `hasCredential: true`.

### 4.2 Payment Creation
- `/payments/new` → a `PaymentRequest` is created (`status: PENDING`).
- The PayPal adapter performs OAuth (`/v1/oauth2/token`) then **creates an Orders v2 order** (`intent: CAPTURE`) carrying `custom_id = paymentRequestId` for correlation and `return_url = <PAYMENTS_PUBLIC_BASE_URL>/?payment=success`.
- The order's `approve` link is returned as the payment URL; `providerRequestId = ORDER id` is stored on the request.
- **No card data** is included in any request body.

### 4.3 PayPal Checkout
- The buyer is redirected to the PayPal Sandbox **approve** URL for the order.

### 4.4 Buyer Payment
- The Sandbox buyer approves and pays. PayPal moves the order toward `APPROVED`/`COMPLETED`.

### 4.5 Webhook
- PayPal Sandbox calls `POST /api/payments/webhook/paypal` (through ngrok).
- The route is **public, Node runtime, always answers `200 { ok: true }`** (even on bad/duplicate/error) to avoid provider retry storms.
- The webhook is fed into the **shared** orchestration as a **raw signal** — it carries **no authority** and adds no PayPal-specific settlement logic. A forged/duplicate webhook **cannot** move a request to PAID.

### 4.6 Authority Verification
- Orchestration calls the adapter's **`getPaymentStatus`**: GET the order; if `APPROVED`, **capture**; a request is PAID **only** when a `COMPLETED` capture is confirmed.
- This is the single source of the PAID decision — the **Authority Principle**.

### 4.7 PAID
- On a confirmed `COMPLETED` capture: `PaymentRequest.status → PAID`, a **`PaymentTransaction`** is recorded with the PayPal **capture id** as `providerTransactionId`, and the settlement posts to the existing **financial-event** truth layer.
- **Idempotent:** a duplicate capture webhook does not settle twice (no second transaction).

### 4.8 Collection Workspace
- `GET /api/payments/collection-workspace` (the **only** endpoint the screen consumes) shows the payment in the **`verified`** state, in history — not active, not attention.
- No PayPal-specific field, endpoint, or branch was added to the Workspace.

### 4.9 Timeline
- The request's lifecycle reflects the progression from created → paid/verified, consistent with the two-truth-state model (waiting → verified).

---

## 5. Architectural Principles Verified

- **Authority Principle** — webhook is a signal; PAID is established **only** by provider verification (`getPaymentStatus`), which for PayPal means a `COMPLETED` capture. A forged webhook cannot fabricate PAID.
- **Additive provider framework** — PayPal was added by registering an adapter + descriptor (+ one enum value). **No** new route per provider, **no** change to the generic connection route, catalog, or webhook orchestration.
- **Collection Workspace untouched** — it still consumes only `GET /api/payments/collection-workspace`; no model change, no provider coupling.
- **No new financial source of truth** — settlement posts to the existing financial-event layer; the provider framework does not become a ledger.
- **Idempotency** — duplicate settlement signals do not double-record.
- **Fail-closed encryption** — credentials use AES-256-GCM with a mandatory key; PayPal stores no secret at all (env-only).
- **Dubiz never stores card data** — payment occurs entirely on the provider.

---

## 6. Product Principles Verified

- **Two truth-states only** — `waiting` / `verified`; the verified collection landed as `verified`.
- **Business language** — the collection reads as "collected & verified" (נגבה ואומת), not raw gateway status.
- **Single Workspace endpoint** — the screen's contract is unchanged.
- **No forbidden concepts introduced** — no `PARTIALLY_PAID`, Late, Deposited, Settlement, Refund, Manual Paid, aging, or Billing coupling.
- **Minimal UI** — PayPal appears as one option in the technical Connections screen; credentials are explicitly server-side.

---

## 7. Not Yet Verified

- **Production CardCom** (the real target provider) — blocked on provider availability.
- **Real money** — Sandbox only; no live funds moved.
- **Refunds / chargebacks / disputes** — out of scope by design (no Refund state).
- **Webhook signature verification enforcement** — `PAYPAL_WEBHOOK_ID` is configured; end-to-end signature rejection was not adversarially tested (authority does not depend on it — verification is independent).
- **Recurring / multi-currency reconciliation / high-concurrency** — not exercised.
- **Non-happy-path buyer flows** — cancel/abandon/expired-order handling verified in unit tests but not driven through the live Sandbox UI.

---

## 8. Key Findings

- The **provider abstraction held**: bringing up an entirely new, real provider required only an adapter + descriptor + enum value — the connection route, webhook orchestration, Collection Workspace, and read-model were reused unchanged.
- The **Authority Principle is enforceable in practice**: the live webhook was correctly demoted to a signal, and PAID was gated on the capture verification.
- The **Collection Workspace consumed the verified payment with zero provider awareness**, confirming the read-model boundary.
- Credentials-from-env (empty `credentialFields`) is a clean pattern for providers whose secrets are platform-level rather than per-merchant.

---

## 9. Issues Encountered & Resolutions

| # | Symptom | Root cause | Resolution | Class |
|---|---|---|---|---|
| 1 | `POST /api/payments/connections` → **500** | `PAYMENTS_ENCRYPTION_KEY` missing → `PaymentCryptoConfigError` (fail-closed encryption) | Generated a 32-byte key; added to `.env.local` (gitignored) | Config (DEV) |
| 2 | After restart: login "Server error" 500, all APIs 401 | DEV DB had no tables (`P2021` on `User`); 401s were downstream (no token) | `prisma db push` (DEV only) + seeded a test user/business | DEV data |
| 3 | `POST /api/payments/connections` (PayPal) → **500 again**, while an identical fresh-process path **succeeded** | Running dev server held a **stale in-memory Prisma Client** loaded *before* the `PAYPAL` enum was generated → client-side `PrismaClientValidationError` on `provider: "PAYPAL"` | **Restarted** the dev server to load the current client (env/runtime only, no code change) | Runtime state |
| 4 | Env check reported all 4 PayPal vars **EMPTY**, contradicting the file | **Flawed verification method**: `grep … .env.local .env \| tail -1` let the empty placeholders in `.env` shadow the real `.env.local` values — the **opposite** of Next's `.env.local`-wins precedence | Re-checked with `@next/env` (Next's actual loader): all four **present**; the vars were loaded all along | Diagnostic error (mine) |

**Note (housekeeping):** empty `PAYPAL_*` placeholders remain in `.env` (overridden by `.env.local`); harmless but worth removing to avoid future confusion.

---

## 10. Conclusions

- The PayPal Sandbox E2E is **verified end-to-end**: connection → order → buyer payment → webhook signal → authority verification → PAID → Collection Workspace (verified) → timeline.
- The **architecture held under a real provider**: additive, no forbidden states, no new source of truth, Authority Principle enforced, Collection Workspace boundary intact.
- Dubiz is **provider-ready**: onboarding the production CardCom provider is now an adapter+descriptor exercise on a proven substrate.
- Remaining gaps (production provider, real money, refunds/disputes, signature-rejection, recurring) are **explicitly out of this verification's scope** and tracked above.
