# Dubiz — Accounts Payable / Commitments Programme v1

**Status:** ARCHITECTURE FROZEN — owner decisions incorporated (10/10); allocation contract and bank-coordinate storage both closed. Implementation **not** authorized.
**Baseline:** `origin/main` @ `18726db2`.
**Blocked on:** ratification of the party-identity amendment (§4 AD-1 / §20) only. The bank-account security decision is CLOSED (§11).
**Scope:** the payables accounting foundation. Outbound money movement is a separate, later programme.

---

## 1. Current-state baseline (established by audit, not assumed)

| Fact | Evidence |
|---|---|
| Commitments are a reminder model, not a payables lifecycle | `BusinessObligation` — `prisma/schema.prisma:1221-1244`; its **only** relation is `business` |
| Payee is free text | `obligeeName String` — `schema:1224` |
| No model anywhere carries `obligationId` / `commitmentId` / `installmentId` | schema-wide grep |
| Lifecycle is tri-valued with no amount | `state = OPEN \| MET \| RELEASED`; no `paidAmount`, no balance |
| Recurrence rolls forward one instance at a time | `obligation.service.ts:225-250` |
| "Installments" are N independent obligations | `secretary-ui.tsx:1247-1262`, note `פריסת תשלומים i/N`, no series id |
| Postdated cheque = free text | `secretary-ui.tsx:1275-1280` writes `` `צ'ק מס' ${n}` `` into `note` |
| Supplier has no outbound bank details | `Supplier` — `schema:1927`; the only bank columns in the DB are `BillingReceiptPayment.bankName/bankBranch/bankAccountNumber` (`schema:2197-2199`), which describe **inbound** customer payment |
| Documents → FinancialRecord is real | `app/api/documents/[id]/approve/route.ts:254-328` |
| OCR persists only amount/date/vendorName/category/direction | `ExtractedData` — `schema:1478` |
| No payable reconciliation | only `BillingPaymentAllocation` (`schema:2213`) — **receivables** |
| No bank ingestion | no `BankTransaction` model or importer exists |
| Outbound execution: none | `PaymentRequest` links `customerId` + `billingDocumentId` (`schema:2896`) |
| Duplicate defence is document-centric | `document-duplicate.ts`, `duplicate-signals.service.ts` |

**Summary:** Dubiz remembers that money is owed. It cannot say how much has been paid, by what, or on what evidence.

---

## 2. Product goal

> דוביז יודעת מה העסק חייב, למי, מתי, איך הוא מתכוון לשלם, מה שולם בפועל, איזו ראיה מוכיחה את התשלום, מה עדיין נשאר, והאם כמה מקורות מתארים למעשה את אותו תשלום.

Binding principle: **analyze → propose → owner confirms → track.** No silent autonomous reconciliation where ambiguity exists. Auto-reconciliation requires a separately approved policy **and** deterministic evidence (an exact external reference — never name similarity).

---

## 3. Domain terminology (frozen)

| Term | Means | Is NOT |
|---|---|---|
| **Payee** | the economic beneficiary the business owes/pays | a Supplier (a Supplier may *be* a payee) |
| **Commitment** | the agreement — "ארנונה 2027, 7,200 ₪" | one payment |
| **Installment** | one scheduled amount due on one date | a payment |
| **Payment** | the economic fact "4,000 ₪ left the business to X on 16/09" | a receipt, a bank line, a document |
| **Allocation** | which payment settles which installment, and by how much | a payment |
| **Evidence** | information proving/observing that a Payment happened | the Payment |
| **Cheque** | a payment *instrument* with its own lifecycle | a Payment |
| **PaymentDestination** | where money goes **TO** | a business bank account |
| **BusinessBankAccount** | where money comes **FROM** | a payment destination |

### 3.1 The frozen Payment/Evidence invariant (owner-mandated)

```
Payment        = the economic event.
PaymentEvidence= information proving/observing that event.
```

- One Payment MAY carry many evidences (manual assertion + receipt + future bank line). **A receipt and a bank debit for the same 1,200 ₪ must not become two expenses.**
- Two legitimate 1,200 ₪ payments to the same payee on the same date MUST remain two Payments.
- **`unique(payee, amount, date)` is prohibited as economic identity.** Uniqueness on money is a data-loss bug, not a safety feature.

---

## 4. Architecture decisions

### AD-1 — Payee identity — **APPROVED (Owner Decision 1)**

`Payee` is a canonical entity, separate from `Supplier`. `Supplier` remains the procurement/inventory entity. A Payee may be a supplier, municipality, government authority, landlord, employee, utility, lender, insurer, or any other person/company.

**Binding constraints:**
- `Payee` MUST NOT carry `supplierId`.
- `Supplier` MUST NOT gain `payeeId` to express sameness.
- Where one real-world party is both, identity resolves through the ratified **Party** architecture (Tier 3), never an FK.

Duplication is avoided on the **read side**: the payee picker searches `Payee` ∪ `Supplier`; choosing a Supplier creates/reuses a `Payee` carrying a Tier-1 name snapshot. Sameness is recorded later as a `PartyResolutionClaim` once `PartyRoleType` is extended (today `{CUSTOMER, LEAD}`).

**Blocked on:** the party-identity amendment (§20). No Phase 1 code before it is ratified.

### AD-2 — Derive balances, never store them — **FROZEN**

**One monetary source of truth for allocation: `PaymentAllocation.allocatedAmount`.** No cached balance column exists anywhere, in Phase 1 or later.

| Quantity | Definition |
|---|---|
| `installmentPaid` | `Σ active PaymentAllocation.allocatedAmount` for that installment |
| `installmentRemaining` | `installment.scheduledAmount − installmentPaid` |
| `paymentAllocated` | `Σ active PaymentAllocation.allocatedAmount` for that payment |
| `paymentUnallocated` | `payment.amount − paymentAllocated` |
| `commitmentPaid` | `Σ active allocations across the commitment's installments` |
| `commitmentRemaining` | finite plans: `Σ installmentRemaining` over non-`CANCELLED`, non-`SETTLED_LEGACY` installments. `RECURRING` commitments have no total, so no closed-form remaining — only the current installment's remaining. |

**Verified against this document: no `Installment.paidAmount`, no `Installment.remainingAmount`, no `Commitment.paidAmount`, no `Commitment.remainingAmount` was ever planned.** `Commitment.totalAmount` is the *agreed* figure (an input to Invariant 14), never a running balance.

Only *assertions* are persisted (`CANCELLED`, `SETTLED_LEGACY`, `VOID`, `reversedAt`) because no computation can recover them.

#### AD-2.1 — "Active allocation", and reversal over deletion

```
active(allocation) ⟺ allocation.reversedAt IS NULL
                   ∧ allocation.payment.status = 'RECORDED'
```

**Nothing is ever deleted.** Both halves of the predicate are non-destructive:

| Event | What happens | Why |
|---|---|---|
| **Payment VOID** | `payment.status = VOID`. Allocation rows are **not** touched. | One atomic flip invalidates every allocation of that payment. Updating N rows would risk a partial write and gains nothing — the predicate already reads `payment.status`. |
| **Allocation reversed** | `reversedAt`, `reversedByUserId`, `reversalReason` stamped on that row. | Reverses one allocation while the payment stays valid for its others. |
| **Installment CANCELLED** | **Refused while any active allocation exists** (Invariants 8, 12). | Cancelling a partly-settled installment would strand real money. The owner must reverse the allocation first — deliberately, and audited. |

A reversed allocation and a voided payment both remain fully queryable history. Every transition writes a `PayablesAuditEvent`.

### AD-3 — Evidence is a layer, not a field
`PaymentEvidence` is polymorphic-by-kind, so a future source is a new `kind`, not a migration of `Payment`.

### AD-4 — Reuse `PaymentMethod`
The enum is direction-neutral (it names an instrument). Reuse it; **add** `DIRECT_DEBIT` and `STANDING_ORDER`. Do not fork an outbound enum.

### AD-5 — Cheque is an instrument, not a payment
A cheque exists before money moves and may never move it. It becomes a `Payment` on clearance.

### AD-6 — Cheque status provenance — **APPROVED (Owner Decision 6)**
Cheque status carries explicit provenance: `OWNER_ASSERTED` vs future `BANK_OBSERVED`. The UI **must never imply bank verification when none occurred** — an owner-asserted `CLEARED` is labelled as the owner's statement.

### AD-7 — Overpayment refused — **APPROVED (Owner Decision 5)**
`Σ active allocations(installment) ≤ installment.scheduledAmount`. An allocation that would exceed the remaining balance **stops** and raises an explicit owner-facing resolution flow. No silent overpay, no negative remaining balance. Credit/overpayment behaviour is a separate future design.

---

## 5. Proposed data model

```
Business
├── Payee
│    └── PaymentDestination            (money TO — P4)
│
├── Commitment
│    └── Installment
│         └── PaymentAllocation ──┐
│                                 │
├── Payment ─────────────────────┘
│    ├── PaymentEvidence               (MANUAL | DOCUMENT | BANK_TRANSACTION | PROVIDER | CHEQUE)
│    └── (from) BusinessBankAccount    (P3)
│
├── Cheque                             (P3) → plannedInstallmentId?, drawnOn → BusinessBankAccount
├── BusinessBankAccount                (P3 — money FROM)
├── PayablesAuditEvent                 (append-only)
└── BusinessObligation                 (LEGACY — retained, read-only)
```

### 5.1 Model count — **CORRECTED**

The earlier summary said "9 new models" while listing 11 names. **Both were wrong.** The corrected figure is **10 models**, after the minimality review removed `ChequeAssignment` (§6).

**Final proposed models (10):**

| # | Model | Phase |
|---|---|---|
| 1 | `Payee` | 1 |
| 2 | `Commitment` | 1 |
| 3 | `Installment` | 1 |
| 4 | `Payment` | 1 |
| 5 | `PaymentAllocation` | 1 |
| 6 | `PaymentEvidence` | 1 (kind `MANUAL` only; kinds widen in 2/3/5) |
| 7 | `PayablesAuditEvent` | 1 |
| 8 | `Cheque` | 3 |
| 9 | `BusinessBankAccount` | 3 |
| 10 | `PaymentDestination` | 4 — **not authorized until §11 closes** |

**Not models — enums** (7 new + 1 extended): `PayeeKind`, `CommitmentScheduleKind`, `CommitmentStatus`, `InstallmentStatus`, `PaymentStatus`, `PaymentEvidenceKind`, `ChequeStatus`, and `PaymentMethod` **extended** with `DIRECT_DEBIT`, `STANDING_ORDER`.

### 5.2 Field contracts

**`Payee`** — `id, businessId, displayName, kind, legalName?, taxId?, taxIdType?, isActive, note?, timestamps`
`kind: SUPPLIER | AUTHORITY | UTILITY | LANDLORD | EMPLOYEE | LENDER | INSURER | OTHER` — drives presentation and default category, **never** accounting.
Indexes: `(businessId, isActive)`, `(businessId, taxId)`, `(businessId, displayName)`.

**`Commitment`** — `id, businessId, title, category?, payeeId?, payeeNameSnapshot, currency, totalAmount?, scheduleKind, recurrence, recurrenceSeriesId?, startAt?, endAt?, defaultPaymentMethod?, status, note?, legacyObligationId?, timestamps`
`scheduleKind: ONE_OFF | RECURRING | INSTALLMENT_PLAN` · `status: ACTIVE | CLOSED | RELEASED`.

**`Installment`** — `id, businessId, commitmentId, sequence, scheduledAmount, currency, dueAt, status, cancelledAt?, legacySettlementAssertedBy?, legacyMetAt?, note?, timestamps`
`status: SCHEDULED | CANCELLED | SETTLED_LEGACY` — **persisted assertions only.** `SETTLED_LEGACY` is migration-only and unreachable from the API (§13).
`@@unique([commitmentId, sequence])`.

**`Payment`** — `id, businessId, payeeId?, payeeNameSnapshot, amount, currency, paidAt, method, fromBusinessBankAccountId?, externalReference?, status, idempotencyKey?, createdByUserId, timestamps`
`status: RECORDED | VOID`. `@@unique([businessId, idempotencyKey])` where present.

**`PaymentAllocation`** — `id, businessId, paymentId, installmentId, allocatedAmount, currency, createdByUserId, createdAt, reversedAt?, reversedByUserId?, reversalReason?`

**`allocatedAmount` is the single monetary source of truth for allocation.** Name kept (not `amount`) to mirror the existing `BillingPaymentAllocation.allocatedAmount` (`schema:2213`).

`@@unique([paymentId, installmentId]) WHERE reversedAt IS NULL` — a **partial** unique index, so a reversed allocation does not block re-allocating the same pair. Prisma cannot express a partial unique index; it is created in raw SQL in the migration, with a schema comment forbidding regeneration — the precedent is the `secretHash` CHECK constraint (`schema:3702-3703`) and the raw-SQL indexes already used across the D2 RLS migrations.

**`PaymentEvidence`** — `id, businessId, paymentId, kind, documentId?, chequeId?, externalRef?, method, confidence?, assertedByUserId?, confirmedAt, createdAt`
`@@unique([businessId, kind, externalRef])` where `externalRef` non-null · `@@unique([businessId, documentId])` where non-null.

**`Cheque`** — `id, businessId, payeeId?, payeeNameSnapshot, chequeNumber, amount, currency, issueDate?, dueDate, drawnOnBusinessBankAccountId?, plannedInstallmentId?, status, statusProvenance, statusAssertedByUserId?, statusAssertedAt?, replacedByChequeId?, note?, timestamps`
`@@unique([businessId, drawnOnBusinessBankAccountId, chequeNumber])`.

**`BusinessBankAccount`** — `id, businessId, label, bankCode?, branchCode?, accountNumber?, iban?, currency, isDefault, isActive, timestamps`

**`PaymentDestination`** — deferred; shape depends on §11.

**`PayablesAuditEvent`** — `id, businessId, commitmentId?, installmentId?, paymentId?, chequeId?, actorUserId?, eventType, source, summary, metadata?, eventHash, occurredAt, createdAt`
Deliberately mirrors `BillingAuditEvent` (`schema:2136`) and `PaymentAuditEvent` (`schema:3013`) field-for-field, including `eventHash` (`lib/services/billing/billing-audit.service.ts:249`).

### 5.3 Edges and cardinality

| Edge | Card. | Meaning | Delete rule |
|---|---|---|---|
| `Business → Payee` | 1:n | tenant root | Cascade |
| `Payee → PaymentDestination` | 1:n | several accounts/currencies; one default | Cascade |
| `Commitment → Payee` | n:1 nullable | Tier-2 FK; snapshot retained beside it | `SetNull` |
| `Commitment → Installment` | 1:n | the schedule | Cascade |
| `Installment → PaymentAllocation` | 1:n | several payments may settle one installment | Restrict |
| `Payment → PaymentAllocation` | 1:n | one payment may settle several installments | Restrict |
| `Payment → PaymentEvidence` | 1:n | **many evidences, one payment** — the double-count defence | Cascade |
| `PaymentEvidence → Document` | n:1 nullable | `kind = DOCUMENT` | `SetNull` |
| `Cheque → Installment` (`plannedInstallmentId`) | n:1 nullable | planning only; settlement spreading comes from allocations | `SetNull` |
| `Cheque → Cheque` (`replacedById`) | 1:1 nullable | replacement chain | `SetNull` |
| `Cheque → BusinessBankAccount` | n:1 nullable | drawn on | `SetNull` |

---

## 6. Model minimality review (owner-mandated)

Every proposed model challenged: *why must this be a table?*

| Model | Why it must persist | Could it be derived / enum / relation / reuse? |
|---|---|---|
| **Payee** | An entity with identity, its own lifecycle (`isActive`), indexed reads, and destinations hanging off it. | No — it is precisely the thing a string cannot be. |
| **Commitment** | Distinct identity and lifecycle; the aggregation root. Expand-only forbids renaming `BusinessObligation`, so it is a new table. | No. |
| **Installment** | Each carries its own amount, due date and cancellation. A JSON schedule on Commitment could not be allocated against or indexed by `dueAt`. | No. |
| **Payment** | The economic event. Nothing else in the schema represents "money left the business". | No. |
| **PaymentAllocation** | Carries `allocatedAmount` — an attribute of the *pair*, not of either side. n:m with data must be a table. | No. Precedent: `BillingPaymentAllocation`. |
| **PaymentEvidence** ⚠️ | **Challenged.** Could be nullable FKs on `Payment` (`documentId?`, `bankTxId?`…). Rejected: (a) the cardinality is 1:n — a single payment may carry a manual assertion *and* a receipt *and* a bank line, which nullable columns cannot express without one column per source; (b) each evidence needs its own uniqueness key (`@@unique(businessId, documentId)`) to enforce "one document testifies to at most one payment" — that constraint has nowhere to live without rows; (c) each carries its own provenance (who confirmed, when, with what confidence). Collapsing it would destroy the frozen §3.1 invariant. **Keep.** |
| **Cheque** | Exists before any payment and may never become one (cancelled, bounced). Has its own number, lifecycle and replacement chain. A status enum on Installment cannot hold 12 cheques against 12 installments. | No. |
| **~~ChequeAssignment~~** ❌ | **REMOVED.** The n:m case ("one cheque covering several installments") is already served by `PaymentAllocation` at clearance — a cleared cheque becomes a Payment, and Payment→Installment is *already* n:m with amounts. For *planning*, n:1 (`Cheque.plannedInstallmentId`) is sufficient, and supports several cheques per installment. A join table would duplicate allocation semantics. |
| **BusinessBankAccount** | Money-FROM identity, needed by cheques (drawn-on) and by a future bank feed. Distinct from destinations by direction. | No. |
| **PaymentDestination** | A payee legitimately has several accounts, currencies, an inactive old one, one default. Flat columns on Payee/Supplier cannot express that. | No — but **schema not authorized until §11**. |
| **PayablesAuditEvent** ⚠️ | **Challenged against existing models.** `PlatformAuditEvent` (`schema:393`) has **no `businessId`** — it is platform-admin scoped and cannot be tenant-isolated or RLS-scoped for payables. `BillingAuditEvent` and `PaymentAuditEvent` are *per-domain* models with a typed subject FK (`billingDocumentId`, `paymentRequestId`); reusing either would mean payables events hanging off an unrelated subject. `FinancialEvent` is a ledger projection, not an audit trail. The repo's **established pattern is one audit model per domain**, and `PayablesAuditEvent` follows it exactly. `updatedAt` is not an audit trail. **Keep.** |

**Net: 11 proposed names → 10 models.**

---

## 7. Accounting invariants

1. `Σ allocations(payment) ≤ payment.amount`.
2. **`Σ active allocations(installment) ≤ installment.scheduledAmount`** — overpayment **REFUSED** (AD-7). Violation stops and raises an owner resolution flow.
3. Remaining balance never goes negative, implicitly or explicitly.
4. One `PaymentEvidence` can never produce a second economic `Payment`.
5. Every row business-scoped; cross-business allocation impossible in service **and** RLS.
6. Reconciliation is idempotent — confirming the same match twice is a no-op.
7. Undo is explicit and audited; allocations are removed only through it.
8. `CANCELLED` / `SETTLED_LEGACY` installments and `RELEASED`/`CLOSED` commitments cannot receive allocations.
9. Currency must match across Payment → Allocation → Installment → Commitment. No implicit conversion.
10. `Payment.amount` immutable once allocations exist; correction is `VOID` + re-record.
11. A `VOID` payment contributes zero to every balance; its allocations reverse in the same transaction.
12. A cheque may hold a planned installment only while `PLANNED`/`ISSUED`.
13. `payeeNameSnapshot` written once, never mutated (Tier-1 rule).
14. **Finite-plan integrity (Owner Decision 7):** for `scheduleKind = INSTALLMENT_PLAN`, `Σ installment.scheduledAmount == commitment.totalAmount` exactly, at creation and after any edit. The generator assigns the rounding remainder to the final installment so the sum is exact to the minor unit. For `ONE_OFF`, `totalAmount == the single installment amount`. For `RECURRING`, `totalAmount` is NULL and **no** sum invariant applies.
15. Cheque status `CLEARED`/`DEPOSITED`/`BOUNCED` must carry `statusProvenance`; `OWNER_ASSERTED` may never be presented as verified.

---

## 8. Matching / reconciliation model

**Phase 1 signals — only what `ExtractedData` has:** `amount`, `date`, `vendorName` (normalized via the existing `vendor-normalization.service.ts`), `direction`.

**Candidates:** open installments where `|amount − remaining| ≤ tolerance` **and** `|document.date − dueAt| ≤ window`.

**Scoring** (deterministic and explainable): exact amount = remaining `high` · amount within tolerance `medium` · resolved `payeeId` match `high` · normalized vendor ≈ snapshot `medium` · date ±7d `medium` · date ±30d `low` · prior confirmed match for this payee+commitment `medium`.

**Hard contradictions (veto):** currency mismatch · inbound `direction` · installment `CANCELLED`/`SETTLED_LEGACY` · commitment `RELEASED` · document already evidences another payment.

**Bands:** `STRONG` → one pre-selected suggestion · `POSSIBLE` → list, none pre-selected · `WEAK` → not surfaced. Two candidates within a narrow band are both shown, never auto-picked. Rejections persist so the same candidate is not re-proposed.

**Phase 2 richer signals:** extend `ExtractedData` with `documentNumber`, `paymentReference`, `payeeTaxId`, `paymentDate`, `paymentMethod`. Only `payeeTaxId` + `paymentReference` could ever justify an auto-reconciliation policy.

**Confirmation (one transaction):** find-or-create `Payment` → create `PaymentEvidence{DOCUMENT}` (unique index blocks a second payment from the same document) → create allocation(s) → write audit event → balances recompute by derivation.

**Partial cases:** document < installment → `PARTIALLY_PAID`. Document > installment → allocate across the next open installments of the same commitment; any remainder stays unallocated on the Payment and is surfaced (never silently overpaid — AD-7). Undo → remove allocations + evidence, audit `RECONCILIATION_UNDONE`.

---

## 9. Double-count prevention

The mechanism is **payment identity**, not uniqueness on money.

- Bank line + receipt for one payment → **two `PaymentEvidence` rows on one `Payment`**.
- Strong identifiers (bank transaction id, provider id, document id) carry `@@unique` → a re-delivered import cannot create a second payment. Precedent: `FinancialEvent.@@unique([businessId, sourceType, sourceKey])` (`schema:2230`).
- Soft identifiers (vendor + amount + date) generate candidates and warnings only.
- **`unique(payee, amount, date)` is prohibited** (§3.1).

---

## 10. Cheque model

Own entity (AD-5). Numbers are **never assumed sequential** — the plan generator *proposes* consecutive numbers the owner may edit. Supported: one cheque per installment, several cheques per installment, replacement (`replacedByChequeId`), cancellation, non-consecutive numbers, differing amounts.

Lifecycle `PLANNED → ISSUED → DEPOSITED → CLEARED` (+ `BOUNCED`, `CANCELLED`, `REPLACED`), every non-`PLANNED`/`ISSUED` transition stamped with `statusProvenance` (AD-6). On `CLEARED`: create `Payment` + `PaymentEvidence{CHEQUE}` + allocation.

---

## 11. Bank-coordinate storage — **DECISION CLOSED: Option C**

Two models, never merged: `PaymentDestination` is money **TO**; `BusinessBankAccount` is money **FROM**. They share a value-object helper, never a table (§11.8).

### 11.1 Recommendation — Option C

Randomized authenticated encryption for the recoverable value, **plus** a separate keyed HMAC fingerprint for exact matching.

```
bankCoordinateEncrypted / Iv / Tag   — AES-256-GCM, recoverable by an authorized path
bankCoordinateFingerprint            — HMAC-SHA-256, one-way, used only for equality
accountLast4                         — display only, never identity
```

**Why not A** (plaintext + RLS + masking + audit): leaves full account identifiers readable in any DB dump, backup or leaked-credential incident. RLS is an *application-database* control; it does not protect a stolen backup file.

**Why not B** (encryption alone): encryption is randomized (fresh IV per row), so two rows holding the same account produce different ciphertext. Exact matching becomes impossible — breaking Phase 5 bank ingestion, the very capability the encryption is meant to survive into.

**Why C:** it separates the two jobs. Ciphertext answers *"show the owner their account"*; the fingerprint answers *"is this the same account"* without ever revealing it.

### 11.2 Why a keyed HMAC and not a plain hash — argued from this repo

`lib/inbound-email/inbound-address.ts:131` uses plain SHA-256 for its lookup hash, and its own comment states the condition that makes that safe:

> *"A slow KDF would buy nothing against a **160-bit random pre-image**, which is not guessable at any work factor."*

That reasoning is correct **for its input** and does **not** transfer here. An Israeli bank coordinate is bank code (2-3 digits) + branch (3 digits) + account (6-9 digits) — roughly `10^12–10^14` possibilities, exhaustively enumerable offline against an unkeyed hash. A plain SHA-256 of a bank account is therefore **reversible in practice** and is explicitly rejected.

**HMAC-SHA-256 under a secret key** removes offline enumeration: without the key, an attacker holding the whole table cannot test a guess. (A slow KDF is the wrong tool — the fingerprint is computed on every row of every bank import.)

### 11.3 Cryptographic contract

| | |
|---|---|
| **Encryption** | AES-256-GCM, 12-byte random IV, 16-byte tag — the **existing repo shape** (`lib/services/payments/payment-crypto.service.ts`) |
| **AAD** | `"<model>:<businessId>:<rowId>"` — binds ciphertext to tenant and row, so a row read under the wrong tenant **fails to decrypt** instead of leaking |
| **Fingerprint** | `HMAC-SHA-256(fingerprintKey, canonicalCoordinate)`, hex |
| **Keys** | `PAYABLES_BANK_ENCRYPTION_KEY` + `PAYABLES_BANK_FINGERPRINT_KEY` — **separate from every existing key**, per the key-separation rule already argued in `lib/inbound-email/inbound-address-crypto.ts` |
| **Key version** | `encryptionKeyId` + `fingerprintKeyId` columns (established: `PAYMENTS_ENCRYPTION_KEY_ID = "payments-v1"`) |
| **Failure** | **fail-closed on write** — a coordinate that cannot be encrypted is not stored. Decrypt failure surfaces a controlled error, never a plaintext fallback. Matching is unaffected (the fingerprint is independent of the ciphertext). |

**Rotation.** Encryption key: an offline job decrypts under the old `encryptionKeyId` and re-encrypts under the new; reads accept both during the window (dual-key read). **Fingerprint-key rotation is possible only because the plaintext is recoverable** — the job decrypts, recomputes the HMAC and writes both columns. A hash-only design could never rotate its lookup key. That is a second, independent reason to keep ciphertext alongside the fingerprint.

### 11.4 Canonical fingerprint input

Versioned, so the normalization rule can change without silent collisions:

```
domestic : v1|<COUNTRY>|bank:<bankCode>|branch:<branchCode>|acct:<digitsOnly>
IBAN     : v1|iban:<UPPERCASE, whitespace removed>
```

Country upper-cased ISO-3166 alpha-2 · separators, spaces and hyphens stripped · **leading zeros preserved** (significant in Israeli account numbers — stripping them would collide distinct accounts) · IBAN and domestic coordinates live in separate namespaces and are never cross-compared. **`last4` is never an input to identity.**

### 11.5 Tenant scoping and uniqueness

`businessId` is **included in the HMAC input**. Both consequences are wanted:
- the same beneficiary held by two businesses produces **different** fingerprints → even a leaked DB *and* key cannot correlate counterparties across tenants
- matching is always intra-tenant, which is correct: a bank feed belongs to exactly one business

| Model | Constraint | Why |
|---|---|---|
| `PaymentDestination` | `@@unique([businessId, payeeId, fingerprint])` | the same account cannot be added twice to one payee; **two payees of one business may legitimately share an account** (parent/subsidiary) |
| `PaymentDestination` | `@@index([businessId, fingerprint])` | matching by coordinate alone, since the unique includes `payeeId` |
| `BusinessBankAccount` | `@@unique([businessId, fingerprint])` | a business should not hold its own account twice |

No global uniqueness on any fingerprint — two businesses paying the same beneficiary is normal and must never collide.

### 11.6 Exposure policy

| Surface | Rule |
|---|---|
| **List APIs** | masked only — `בנק 10 · סניף 123 · חשבון ••••5678`. Full identifiers **never** in a list/search payload. |
| **Detail/edit API** | full value only via an explicitly authorized single-row read, itself audited |
| **Logs** | never. Configuration errors name the *key*, never the coordinate (precedent already set in `inbound-address-crypto.ts`). |
| **Analytics / telemetry / error reporting** | never — not even masked |
| **AI prompts / OCR / model context** | never, under any circumstance |
| **Audit payload** | records *"bank details changed"* + which fields changed. **Never old/new raw account numbers**, not even encrypted. |

### 11.7 Destination provenance — the names challenged

The proposed `UNVERIFIED / OWNER_ENTERED / DOCUMENT_DERIVED / PROVIDER_VERIFIED` conflates two questions: `UNVERIFIED` and `OWNER_ENTERED` overlap, because owner-entered *is* unverified. Recommended instead — **two orthogonal fields**:

```
origin       : OWNER_ENTERED | DOCUMENT_DERIVED | PROVIDER_SUPPLIED
verification : NONE | MICRO_DEPOSIT | PROVIDER_CONFIRMED | BANK_CONFIRMED
```

Typing an account number is an **origin**, never a verification. Through Phase 4 every destination is `verification = NONE`, and **no UI may use the word "מאומת" while it is**. This matters most immediately before any future "Pay now": paying an unverified destination must be a knowing decision.

### 11.8 Shared helper, separate ownership

Both models use one `BankCoordinates` value-object helper — normalize → canonicalize → encrypt → fingerprint — so the crypto exists once. They do **not** share a table: direction, lifecycle, ownership and authorization all differ. **No polymorphic mega-table.**

### 11.9 Threat coverage — what encryption does and does not solve

| # | Threat | Option C | Honest assessment |
|---|---|---|---|
| 1 | Accidental application logs | ⚠️ **not solved by crypto** | plaintext exists in memory at the authorized path; solved by the §11.6 policy and review, not encryption |
| 2 | Analytics / telemetry | ⚠️ **not solved by crypto** | same — policy |
| 3 | Ordinary cross-tenant app bug | 🟡 **partially** | RLS + tenant context is the control. Crypto adds real depth: AAD binds ciphertext to `businessId:rowId`, so a row read under the wrong tenant **fails to decrypt** — a silent leak becomes a loud error. |
| 4 | Direct DB read / leaked credential | ✅ **solved** | ciphertext + keyed fingerprint are useless without keys held outside the DB. **The primary threat Option C addresses.** |
| 5 | Backup exposure | ✅ **solved** | backups contain ciphertext only |
| 6 | Support / admin access | 🟡 **partially** | DB-level admin sees ciphertext; app-level admin sees what authorization permits — §11.6 + read auditing, not crypto |
| 7 | Compromised application runtime | ❌ **not solved** | the runtime holds the key by construction; mitigation is runtime security + key separation limiting blast radius |
| 8 | Compromised encryption key | ❌ **not solved** (that key's data) | key + DB together defeat it. Mitigations: per-domain keys (a payables leak does not touch Gmail/WhatsApp/payments material), rotation, and **separate encryption vs fingerprint keys** — leaking one does not grant the other. |
| 9 | Malicious tenant | ⚠️ **not a crypto problem** | RLS + tenant context. Tenant-scoped fingerprints additionally prevent probing whether another tenant holds a known account. |
| 10 | Future bank-import matching | ✅ **enabled** | the fingerprint is why Option C exists — Option B would have made this impossible |

**Summary: encryption meaningfully solves 4 and 5, enables 10, partially helps 3 and 6, and does nothing for 1, 2, 7 and 9** — which are policy, runtime and RLS problems. Claiming otherwise would be security theatre.

### 11.10 Reused vs new

**Reused:** AES-256-GCM three-column shape · `encryptionKeyId` versioning · AAD binding · fail-closed key load · env-var convention · the per-domain key-separation rule. **New:** two env keys and one HMAC fingerprint helper (~30 lines) — the repo has AES-GCM but **no keyed-fingerprint utility**, and its one hashing precedent is unkeyed and correctly so for its own input (§11.2). **No second crypto framework is introduced.**

### 11.11 Gate

`BusinessBankAccount` schema is authorized **only** under this contract, in **Phase 3**; `PaymentDestination` in **Phase 4**. Neither may appear in Phase 1.

**Supplier UX:** the Supplier card gains *"פרטי תשלום"* reading/writing the payee's destinations through the Supplier↔Payee association — **not** by adding bank columns to `Supplier`.

---

## 12. UX flows

**Create commitment** — four sections, mobile-first:
1. **מה משלמים?** title + category
2. **למי?** payee search (`Payee` ∪ `Supplier`) or create — reusing the combobox + quick-create pattern shipped in #441
3. **כמה ומתי?** one-off / recurring / installments → **preview the generated installments before saving**
4. **איך משלמים?** method; conditional — `CHECK` → cheque plan (P3); `BANK_TRANSFER` → destination if known (P4); recurring → cadence

**Commitment detail**
```
ארנונה — עיריית תל אביב
סה"כ 7,200 ₪ · שולם 2,400 ₪ · נותר 4,800 ₪
הבא: 15.05 — 1,200 ₪

15.01  1,200 ₪  שולם     📎 קבלה
15.03  1,200 ₪  שולם     📎 קבלה
15.05  1,200 ₪  ממתין
[סמן תשלום] [קשר מסמך] [ערוך]            (later: [שלם עכשיו])
```

**Document approval** — when candidates exist: *"מצאנו התחייבות מתאימה"* with `[קשר לתשלום] [לא קשור] [בחר אחר]`. Leaving it unmatched **must** keep today's approval working unchanged.

---

## 13. Migration and backward compatibility — **EXPAND-ONLY (Owner Decision 10)**

Philosophy, mandatory: **EXPAND → BACKFILL → COMPATIBILITY/PROOF → CUTOVER → RETIRE only in a later explicitly approved programme.** No `DROP`, no rename, no destructive rewrite in the initial migrations. Existing production rows remain recoverable.

| Today | Becomes | Rule |
|---|---|---|
| `BusinessObligation` row | `Commitment` + exactly **one** `Installment`, `legacyObligationId` set | 1:1, no grouping |
| `obligeeName` | `payeeNameSnapshot` | verbatim; `payeeId` **NULL** |
| `amount` / `currency` / `dueAt` | installment `scheduledAmount` / `currency` / `dueAt` | verbatim |
| `state OPEN` | commitment `ACTIVE`, installment `SCHEDULED` | — |
| `state MET` + `metAt` | commitment `CLOSED`, installment **`SETTLED_LEGACY`** + `legacySettlementAssertedBy`, `legacyMetAt` | **no Payment synthesized** — see §13.1 |
| `state RELEASED` | commitment `RELEASED` | — |
| `recurrence` / `recurrenceSeriesId` | carried to `Commitment` | — |
| `note` | carried verbatim | — |

**Legacy installment rows (Owner Decision 3):** rows created by the old installments UI migrate as **independent commitments**. The note `פריסת תשלומים 1/12` is **not** parsed into a parent. Historical meaning is not invented. Grouping may later be *offered* to the owner, never inferred.

**Legacy cheque notes:** `` `צ'ק מס' 500101` `` stays text. Not parsed into a `Cheque`.

**Rollback:** every migration additive; `BusinessObligation` retained read-only so a revert restores behaviour without data recovery.

### 13.1 Legacy `MET` — **DECISION: do NOT synthesize a Payment**

The earlier draft proposed migrating each `MET` row into a `Payment` with `MANUAL` evidence. **That is withdrawn.** Evidence:

- The owner-facing action is **"סמן שטופל"** (*mark as handled*), and the result reads **"טופל ונסגר"** — `secretary-ui.tsx`. It asserts *handled*, not *money moved*.
- `settlementAssertedBy = "OWNER"` is **provenance of an assertion**, not payment evidence — `obligations.types.ts`.
- The ratified domain doc disclaims owning payment truth: *"Payments owns payment attempts and verified settlement (execution)"* and *"the other domain owns the truth; the Business Obligation domain recognizes and coordinates"* — `docs/dubiz-business-obligation-domain-v1.md §4`.

Synthesizing a `Payment` would **fabricate economic history**: economic events with an amount, date and payee that neither the system observed nor the owner asserted. Those fabricated payments would then become reconciliation candidates against real receipts — actively harmful.

Instead: the installment is `SETTLED_LEGACY`, carrying the original provenance. It contributes **zero** to paid amounts, is excluded from due/overdue (so the owner is not re-nagged about something they closed), and is displayed honestly as *closed by an earlier assertion, without a payment record*. If a receipt later arrives, normal matching creates the **first real Payment** against it. `SETTLED_LEGACY` is migration-only and unreachable from the API.

**Existing FinancialRecords (Owner-approved conservative option A):** remain unmatched until touched. No historical rewrite, no async backfill. Matching applies to documents approved after the feature ships; a "match older documents" action may be offered later, owner-initiated.

---

## 14. Security / tenant model

Every new model: `businessId` + RLS policy + `runWithTenantContext` + `withTenantTransaction` (the live D2 pattern). Cross-tenant negative proofs required per model. No new model may be written outside a tenant transaction. Bank/destination data adds §11's rules — and its schema is gated on §11 closing.

---

## 15. Audit model

`PayablesAuditEvent`, append-only, mirroring `BillingAuditEvent`/`PaymentAuditEvent` including `eventHash`.

Event types: `COMMITMENT_CREATED/EDITED/RELEASED` · `INSTALLMENT_CANCELLED` · `PAYMENT_RECORDED/VOIDED` · `ALLOCATION_CREATED/REVERSED` · `EVIDENCE_LINKED/UNLINKED` · `MATCH_SUGGESTED/CONFIRMED/REJECTED` · `CHEQUE_ISSUED/CANCELLED/REPLACED/STATUS_ASSERTED` · `DESTINATION_CREATED/UPDATED/DEACTIVATED`.

---

## 16. Concurrency / idempotency

| Risk | Defence |
|---|---|
| two tabs confirm the same match | `@@unique([paymentId, installmentId])` + `@@unique([businessId, documentId])`; second commit is a no-op |
| import delivered twice | `@@unique([businessId, kind, externalRef])` |
| document approved twice | existing advisory-lock pattern (`document-duplicate.ts`), reused |
| manual payment races receipt matching | find-or-create `Payment` by idempotency key inside one tenant transaction |
| future bank feed retry | evidence `externalRef` = bank transaction id |

All reconciliation runs in a single `withTenantTransaction`. Because balances are derived (AD-2), no read-modify-write of a total exists — the whole race class is removed rather than defended.

---

## 17. Phase 1 — exact contract

**Models (7):** `Payee`, `Commitment`, `Installment`, `Payment`, `PaymentAllocation`, `PaymentEvidence` (kind `MANUAL` only), `PayablesAuditEvent`.
`PaymentEvidence` is included in Phase 1 deliberately: manual payment needs provenance, and establishing the §3.1 invariant on day one avoids migrating `Payment` later.

### 17.1 What is created

**A. One-off commitment** (`ONE_OFF`)
→ 1 `Commitment{totalAmount = X, recurrence NONE}` + **1** `Installment{sequence 1, scheduledAmount = X, dueAt}`. Invariant 14 holds trivially.

**B. Recurring indefinite** (`RECURRING`, e.g. rent 6,000/month)
→ 1 `Commitment{totalAmount = NULL, recurrence MONTHLY}` + **1** `Installment` for the next due date only.
Roll-forward preserves today's behaviour: when the current installment becomes fully allocated (or is cancelled), the **next** installment is materialised from `recurrence`. No unbounded pre-generation. No sum invariant (Invariant 14).

**C. Finite installment plan** (`INSTALLMENT_PLAN`, e.g. 7,200 / 6)
→ 1 `Commitment{totalAmount = 7,200}` + **N** `Installment` rows generated up front, `sequence 1..N`, dates from cadence, amounts `floor(total/N)` with the remainder on the last. **Invariant 14 enforced at creation and on every edit.**

### 17.2 What happens on payment

**D. Full manual payment** (installment 1,200, owner records 1,200)
One transaction: create `Payment{amount 1,200, paidAt, method}` → `PaymentEvidence{kind MANUAL, assertedByUserId}` → `PaymentAllocation{payment→installment, 1,200}` → audit `PAYMENT_RECORDED` + `ALLOCATION_CREATED`.
Derived: installment `PAID`, commitment remaining reduced.

**E. Partial manual payment** (installment 10,000, owner records 4,000)
Same shape, `allocatedAmount = 4,000`. Derived: `PARTIALLY_PAID`, remaining 6,000. A later 6,000 payment creates a **second** Payment + allocation → `PAID`.

**F. One payment covering several installments** (3,000 against 3 × 1,000)
One `Payment{3,000}` + **three** allocations, applied in `dueAt` order, each `min(payment unallocated, installment remaining)`. Invariant 1 holds (Σ = 3,000 ≤ 3,000). If the payment exceeds the total remaining, the surplus stays **unallocated on the Payment** and is surfaced — never auto-overpaid (AD-7).

### 17.3 Derived vs persisted

| Derived (never written) | Persisted |
|---|---|
| `paid = Σ active allocatedAmount` (AD-2.1) | `scheduledAmount`, `dueAt`, **`allocatedAmount`** |
| `remaining = scheduledAmount − paid` | `status ∈ {SCHEDULED, CANCELLED, SETTLED_LEGACY}` |
| `PAID ⟺ remaining ≤ 0` | `Payment.status ∈ {RECORDED, VOID}` |
| `PARTIALLY_PAID ⟺ 0 < paid < scheduled` | `Commitment.status` |
| `DUE ⟺ remaining > 0 ∧ dueAt ≤ now + window` | evidence provenance |
| `OVERDUE ⟺ remaining > 0 ∧ dueAt < now` | audit events |
| commitment rollup = Σ over installments | — |

### 17.4 Transaction boundaries

Every mutation runs inside one `runWithTenantContext` + `withTenantTransaction`:
- **create commitment** → commitment + all installments + audit, atomically (a half-generated plan must be impossible)
- **record payment** → payment + evidence + allocation(s) + audit, atomically
- **void payment** → status flip + allocation reversal + audit, atomically
- **cancel installment** → status + audit; refused if active allocations exist

Reads use the derived read model in the same tenant context. No balance is ever written.

### 17.5 Out of Phase 1
Document matching (P2) · cheques (P3) · bank accounts/destinations (P3/P4, gated on §11) · bank ingestion (P5) · any outbound execution (P6).

### 17.6 Exit criteria
An owner can create ארנונה 7,200/6, record full and partial manual payments, and watch derived balances move — with **zero regression** in today's Secretary reminders, and every legacy `BusinessObligation` row still rendering.

### 17.7 Phase 1a / 1b split — **FROZEN**

**PHASE 1a — DOMAIN FOUNDATION** (no end-user UI)
Ratified party-strategy amendment (prerequisite) · schema for the 7 models · expand-only migrations · conservative `BusinessObligation` backfill (§13, incl. the no-synthesized-Payment rule) · services: payee, commitment + schedule generator, manual payment, allocation, reversal/void · derived read model · tenant/RLS contracts + cross-tenant negative proofs · idempotency and concurrency (§16) · the full invariant battery (§7) · migration tests.
UI limited to whatever is strictly required to prove the service contract — no product surface.

**Exit 1a:** every invariant test green; a migrated production-shaped fixture set proves zero data loss; balances derive correctly for full, partial and multi-installment payments; cross-tenant allocation impossible at the database level.

**PHASE 1b — PRODUCT UI**
Commitment create/edit · payee selection/create · one-off · recurring · installment-plan UX with pre-save preview · commitment detail · installment timeline · manual full payment · manual partial payment · one payment across several installments · balances and derived statuses · audit/provenance presentation (including the honest `SETTLED_LEGACY` label) · mobile/RTL/accessibility/runtime QA at 320-1920.

**Exit 1b:** §17.6, verified in the running app.

Document matching remains **Phase 2**; cheques **Phase 3**; `PaymentDestination` **Phase 4**; no outbound execution in either.

The ledger has no coherent unit smaller than 1a — a commitment without installments and allocations cannot compute a balance, which is the entire user value.

---

## 18. Phased programme

Reordered from the original suggestion: payment destinations deliver **no user value until preparation exists** and carry the highest security cost; cheques need `BusinessBankAccount` (money FROM), not destinations (money TO); matching is the largest value and depends only on the ledger.

| # | Phase | Goal | User value | Depends on |
|---|---|---|---|---|
| **0** | Party-identity amendment | Ratify AD-1 | none (unblocks all) | owner |
| **1** | Ledger — Payee, Commitment, Installment, Payment, Allocation, Evidence(MANUAL), Audit | balances are real | **"I know what I owe, paid, and what remains"** | P0 |
| **2** | Document→Commitment matching | receipts attach to payments | **"my receipt found its commitment"** | P1 |
| **3** | Cheques + BusinessBankAccount | real cheque plans | **"my 12 cheques are tracked"** | P1, **§11** |
| **4** | PaymentDestination + "הכן תשלום" | prepare, not execute | **"I can pay without hunting for details"** | P3, **§11** |
| **5** | Bank ingestion | bank lines become evidence | cross-source dedup | P2 |
| **6** | Outbound execution | **separate programme** | — | P4, P5 |

Per phase: GOAL · USER VALUE · SCHEMA · BACKEND · UI · MIGRATION · TESTS · DEPENDENCIES · EXIT CRITERIA — each independently reviewable and revertible.

---

## 19. Scenario proofs

**A — ארנונה (7,200 ₪, 6 bi-monthly, receipt after bank payment)**
```
Payee{displayName:"עיריית תל אביב", kind:AUTHORITY}
Commitment{title:"ארנונה 2027", payeeId, totalAmount:7200, scheduleKind:INSTALLMENT_PLAN}
  Installment 1..6 {1200, 15/01,15/03,…}      Σ = 7200 ✔ (Invariant 14)
manual payment → Payment{1200} + Evidence{MANUAL} + Allocation→#5
  ⇒ #5 derived PAID; commitment remaining 6,000
receipt uploaded → candidate (amount exact, payee resolved, date +1d) → owner confirms
  ⇒ Evidence{DOCUMENT} attached to the SAME Payment — no second payment, no second expense
```

**B — Supplier ABC, 5,000 ₪** — `Supplier` stays inventory-domain; a `Payee` is created/reused; destination holds bank details (P4, gated). Commitment → Payee. Manual Payment → allocation. Receipt later attaches as `Evidence{DOCUMENT}` to that Payment. Supplier↔Payee sameness is a Tier-3 claim, never an FK.

**C — 12 cheques, 500101-500112**
```
Commitment{12,000, INSTALLMENT_PLAN, defaultPaymentMethod:CHECK}
  Installment 1..12 {1,000 monthly}            Σ = 12,000 ✔
Cheque 500101..500112 {1,000, dueDate = installment.dueAt,
                       plannedInstallmentId = installment_i,
                       drawnOn: BusinessBankAccount}
CLEARED (statusProvenance OWNER_ASSERTED) → Payment + Evidence{CHEQUE} + Allocation

#500105 cancelled → status CANCELLED, plannedInstallmentId cleared
#500220 created {1,000, plannedInstallmentId = installment#5}
#500105.replacedByChequeId = #500220
  ⇒ installment#5 returns to derived-DUE; balance unchanged; both cheques retained; audit written
  ⇒ the 500105→500220 gap is fine — sequence is never assumed
```
*(No `ChequeAssignment` — n:m settlement comes from `PaymentAllocation` at clearance, §6.)*

**D — partial (10,000 → 4,000 + 6,000)** — two Payments, two allocations; `PARTIALLY_PAID` then `PAID`. No stored total mutated.

**E — duplicate evidence** — whichever arrives first creates `Payment#123`; the second is proposed as **evidence for the existing payment** (candidate generation searches payments before installments). One payment, one expense, two proofs.

**F — one payment, three installments** — one `Payment{3,000}`, three allocations, each installment derives `PAID` independently.

**G — two identical legitimate payments** — two Payments, each with its own evidence. Nothing collapses them: there is **no uniqueness constraint on (payee, amount, date)** (§3.1/§9). The soft-signal warning appears; the owner keeps both.

---

## 20. Proposed amendment to `docs/dubiz-party-identity-strategy-v1.md`

**Not applied. Drafted in `docs/dubiz-party-identity-strategy-v1-amendment-payee-DRAFT.md` for owner review.** See that file for the exact old/new wording of §2, §6 and §7 plus the new §2.1 admission gate.

---

## 21. Test strategy

Pure/unit: schedule generation (incl. rounding remainder, Invariant 14) · balance derivation · allocation arithmetic · candidate scoring · state derivation · migration mapping.
Contract: every invariant in §7 as a named test, especially #2 (overpayment refused) and #14.
DB/RLS: cross-tenant negative proofs per model; cross-tenant allocation impossible at the database level.
Runtime/UI: the repo's Playwright pattern — create commitment, record full/partial payment, confirm a match, undo it, at 320-1920.
Migration: fixtures shaped like real production `BusinessObligation` rows (OPEN, MET, RELEASED, recurring, installment-noted, cheque-noted) asserted field-by-field for zero loss — and an explicit test that **no Payment is synthesized from a legacy MET row** (§13.1).

---

## 22. Out of scope

Real bank transfer execution · Open Banking provider selection · MASAV · accounting-export changes unrelated to payables · customer receivables redesign · any change to CardCom/SUMIT/Tranzila/PayPal · autonomous payment execution · autonomous reconciliation without an approved policy · overpayment/credit behaviour (AD-7 defers it).

---

## 23. Decision register

| # | Decision | Status |
|---|---|---|
| 1 | Payee canonical, separate from Supplier, no FK either way | **APPROVED** |
| 2 | Party-identity amendment | **APPROVED IN PRINCIPLE** — draft ready, not committed |
| 3 | Legacy installment rows stay independent | **APPROVED** |
| 4 | Bank-account security model | **CLOSED — Option C** (§11): AES-256-GCM + keyed HMAC fingerprint |
| 5 | Overpayment refused | **APPROVED** |
| 6 | Cheque `CLEARED` owner-asserted with explicit provenance | **APPROVED** |
| 7 | `totalAmount` nullable + finite-plan sum invariant | **APPROVED** |
| 8 | First release = ledger, no matching | **APPROVED** |
| 9 | Outbound execution out of scope | **APPROVED** |
| 10 | Legacy `BusinessObligation` expand-only | **APPROVED** |
| — | Legacy `MET` → **no synthesized Payment** | **DECIDED** (§13.1) |
| — | Model count 11 → **10** (`ChequeAssignment` removed) | **DECIDED** (§5.1, §6) |
| — | Allocation source of truth = `PaymentAllocation.allocatedAmount`; no cached balances | **FROZEN** (AD-2) |
| — | Reversal over deletion; active = `reversedAt IS NULL ∧ payment RECORDED` | **FROZEN** (AD-2.1) |
| — | Phase 1a / 1b split | **FROZEN** (§17.7) |
