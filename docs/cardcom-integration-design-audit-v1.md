# CardCom Integration Design Audit (v1)

**Status:** Design audit only — no code, no migration, no schema change, no PR.
**Branch context:** `feat/payments-foundation` @ `5c341b2` (P1 → P1.3).
**Decision (closed):** CardCom is the first payment provider for Dubiz. Provider
selection is closed; this audit validates architectural alignment before
building `CardComProvider`.

## Evidence basis & confidence marking

- **Dubiz architecture facts** are marked **VERIFIED** against code (file
  references included).
- **CardCom claims** are marked **VERIFIED** only where explicitly provided as
  confirmed research; otherwise **INFERRED** (general knowledge) or **NOT
  VERIFIED**. There is **no official CardCom documentation in this repo** and no
  live calls were made. Every CardCom-specific conclusion below must be
  confirmed against official CardCom documentation before implementation.

---

## 1. PaymentRequest Ontology

**Dubiz `PaymentRequest`** = a single-use request to collect a specific amount
for a specific invoice/customer, with a `status` lifecycle, `amount/currency`,
`paymentUrl`, `providerRequestId`, `expiresAt`, `paidAt` — **VERIFIED**
(`lib/services/payments/payments.types.ts` → `PaymentRequestRecord`).

**CardCom `LowProfile`** (created by `LowProfile/Create`) = a hosted payment
session returning a URL + `LowProfileId`:
- Payment session (not an abstract "request") — **INFERRED**
- Single-use — **INFERRED**
- Expires — **INFERRED** (no verified expiry value — **NOT VERIFIED**)
- Not reusable — **INFERRED**

**Cleanest ontology:** `PaymentRequest (1) ──creates──> (1) LowProfile`. A 1:1
mapping — one request creates one session. If a session expires/fails, a **new**
LowProfile must be created (not recycled), stored as a new
`providerRequestId`/`paymentUrl` on the same request. The existing model (single
`providerRequestId` + single `paymentUrl` per request) fits 1:1 — **VERIFIED
(Dubiz side)**.

> Subtle gap: "re-issue link" on an expired request is not implemented
> (`createPaymentLink` is called once). Architecturally supported, behaviorally
> not built — **VERIFIED**.

---

## 2. Identity Chain

| Dubiz role | Recommended CardCom source | Marking |
|---|---|---|
| `providerRequestId` (primary correlation key) | **`ReturnValue`** = our `PaymentRequest.id` | VERIFIED that ReturnValue is echoed by webhook + GetLpResult (provided as confirmed research) |
| Session handle | `LowProfileId` (CardCom GUID) | INFERRED |
| `providerTransactionId` | `TranzactionId` (exists only after a transaction attempt, from webhook/GetLpResult) | INFERRED |
| `eventId` (dedup) | `LowProfileId` or `TranzactionId` — **not** ReturnValue | INFERRED |

**Most stable identity chain:** `ReturnValue` (= PaymentRequestId) is the
canonical correlation — merchant-controlled, survives redirect + webhook +
GetLpResult (**VERIFIED** per provided research). The existing correlation
mechanism locates a request by `providerRequestId` only — **VERIFIED**
(`payment-webhook.service.ts` → `findPaymentRequestByProviderRequestId`). What
survives retries/redirects/verification = ReturnValue and LowProfileId;
TranzactionId survives only after a charge.

---

## 3. Authority Model

Mapping onto the Dubiz ontology (Evidence vs Authority — consistent with the
Brain first-principles framing and the Documents truth-layer):

- **Signal** = the webhook (reported reality, unverified) — **INFERRED**
- **Evidence/Authority** = `GetLpResult` (direct query to CardCom) —
  **VERIFIED** that this is the recommendation (provided:
  Webhook → GetLpResult → Trust)
- **What moves to PAID:** only `GetLpResult` confirming success — **VERIFIED
  (per research) / INFERRED for the specific success codes**

**Key architectural gap (VERIFIED from code):** the current flow moves to PAID
**directly from the parsed webhook outcome** (step 6) and **does not call**
`getPaymentStatus` (`payment-webhook.service.ts`). The seam exists —
`getPaymentStatus?` is optional on the adapter
(`payment-provider.types.ts:97`) — but is not invoked in orchestration.
Adopting CardCom's authority model requires inserting a verification step
(webhook = trigger → GetLpResult = verifier → PAID). This is a change to the
shared service, not the adapter alone.

---

## 4. Lifecycle Analysis

| Status (Dubiz) | Exists? | CardCom source | Marking |
|---|---|---|---|
| `PENDING` | VERIFIED (enum) | LowProfile created, awaiting payment | INFERRED |
| `PAID` | VERIFIED | GetLpResult success (ResponseCode=0/Success) | INFERRED (codes) |
| `FAILED` | VERIFIED | Transaction declined | INFERRED |
| `CANCELLED` | VERIFIED (Dubiz) | **No clear push event** (page abandonment = no webhook) | **NOT VERIFIED** that a CardCom source exists |
| `EXPIRED` | VERIFIED (enum) but **not produced** from webhook today | LowProfile expiry — likely no push | **NOT VERIFIED** |

**Conclusion:** PENDING/PAID/FAILED are mappable (PAID/FAILED CardCom codes
INFERRED). CANCELLED and EXPIRED have **no verified CardCom push source** →
derived states (our timeout/`expiresAt`), not a provider push. (Analysis only,
no mapping design.)

---

## 5. Idempotency Analysis

- **Existing layer (VERIFIED):** DB unique `(provider, providerEventId)` +
  a `providerTransactionId`-exists check before creating a transaction /
  moving status (`payment-webhook.service.ts` step 7; schema
  `@@unique([provider, providerEventId])`).
- **Strongest key:** `providerTransactionId = TranzactionId` (one per
  successful charge) for transaction-level dedup — **INFERRED**
  (confidence: medium-high).
- **Event dedup key:** `LowProfileId` as `providerEventId` — **INFERRED**.
  **Warning (VERIFIED from structure):** `ReturnValue` (= PaymentRequestId) must
  NOT be used as `providerEventId`, because two legitimately distinct deliveries
  (pending → paid) on the same request would be wrongly deduplicated.
  `providerEventId` must be a per-event/transaction id.
- **Fallback:** if no unique event id — `TranzactionId`; absent that, the
  transaction-level check prevents duplicate effects — **VERIFIED (Dubiz)**.
- **Verification dedup:** `GetLpResult` is read-only/idempotent — calling it
  twice is safe; effect protection via transaction existence — **VERIFIED
  (Dubiz)**.

---

## 6. Receipt Trigger Analysis

The moment a payment becomes **"business reality"** = when it is
authoritatively verified = **`GetLpResult` confirms success** — not
"webhook received" (signal only). — **VERIFIED as ontology** (consistent with
billing-compliance and the Documents truth-layer: do not create a
financial/legal artifact on an unverified signal); **INFERRED** that GetLpResult
is the specific CardCom authority.

Therefore the future trigger for Receipt creation / allocation / debt-closure =
**the transition to PAID that originates from GetLpResult verification** (not
webhook receipt). (Ontology only — no accounting logic.)

---

## 7. Compatibility Review

| Component | Fit | Evidence |
|---|---|---|
| `PaymentRequest` | **HIGH** | amount/currency/providerRequestId/paymentUrl/expiresAt/status map cleanly to a LowProfile session — VERIFIED (`payments.types.ts`) |
| `PaymentTransaction` | **HIGH** | `providerTransactionId←TranzactionId`, `rawPayload←GetLpResult/webhook` — VERIFIED structure |
| `PaymentWebhookEvent` | **MEDIUM** | raw storage + dedup exist, but `providerEventId` choice requires a per-event id (not ReturnValue) — VERIFIED structure / INFERRED source |
| `Provider Registry` | **MEDIUM** | adding `CARDCOM` to the registry is trivial, but `PaymentProvider` is an enum (TS union + **Prisma enum** `{ TRANZILA }`) → requires a schema change + **migration** — VERIFIED (`provider-registry.ts`, schema enum) |
| `Provider Adapter` | **HIGH** | createPaymentLink/verifyWebhook/parseWebhook compatible; **`getPaymentStatus?` seam exists** for GetLpResult — VERIFIED (`payment-provider.types.ts`). Gap: orchestration does not call it (see Authority) |

---

## 8. Final Verdict

### **MINOR GAPS REMAIN**

**Why not READY:** core fit is high — the generic abstraction absorbs CardCom
cleanly (PaymentRequest/Transaction/Adapter = HIGH, and the `getPaymentStatus`
seam was pre-built precisely for GetLpResult). But real gaps remain beyond the
adapter:
1. **Authority model not wired** — the flow moves to PAID directly from the
   webhook rather than via GetLpResult; CardCom explicitly recommends
   webhook → GetLpResult → trust, which is also Dubiz's truth-layer principle.
   Requires adding a verification step in the shared `payment-webhook.service` —
   **VERIFIED gap**.
2. **`PaymentProvider` enum + Prisma enum** require a `CARDCOM` value +
   migration — **VERIFIED**.
3. **`providerEventId` semantics** must be a per-event id (not ReturnValue) —
   **VERIFIED (risk)**.
4. **CANCELLED/EXPIRED** have no verified CardCom push source — **NOT
   VERIFIED**; would require derived states.

**Why not MAJOR:** none of the gaps require rearchitecting. All are
additive/point-hardening (enum + migration, wiring getPaymentStatus in the
service, dedup key choice). The generic architecture holds for CardCom.

**Verification-pending before building:** every CardCom item marked
INFERRED/NOT VERIFIED above (LowProfile lifecycle, field names, success codes,
event-dedup id, ReturnValue limits) must be confirmed against official CardCom
documentation — not available in this repo and not verified in this audit.
