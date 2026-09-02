# Proposal (planning only) — Reverse Charge (Action 3), Authority State Machine, Unknown-Outcome Recovery

**Status:** PROPOSAL ONLY. No schema change, no migration, no DB write, no code, no PR, no deploy.
**Targets git ref:** `origin/main` (`004e510`). ⚠️ The current working HEAD (`5031620`, CRM branch) has *deleted* much of the authority module — all code references below are on `origin/main`.
**Primary source:** "Israel Invoice Model API Description" v2.0 (7/2024) — §2.1 (Table 2.5), §2.2.2, §2.3 (Approval field 23), §3 (invoice-information), §4.2 (InvoiceDecisionApi). Mirror + citations in `invoice-decision-contract-evidence-v1.md`. Secondary sources used only for corroboration.

---

## 0. Executive summary of recommendations

| Item | Recommendation | Needs migration? | Needs your decision? |
|---|---|---|---|
| Document vs authority status separation | **Keep `BillingDocument` in `ISSUED`; never add post-ISSUED accounting states.** Already the built design. | No | Confirm principle |
| New submission states | **Do NOT expand `BillingAuthoritySubmissionStatus`.** Model "pending-authority", "held-exit", "unknown" with existing `status` + nullable sub-fields. | Only additive nullable columns (expand-only) | Yes — approve field additions |
| Unknown provider outcome | New nullable marker field + reconciliation via official `invoice-information/v1/details`. **Not** a new enum value. | Additive nullable column | Yes |
| Reverse Charge / Action 3 | **Do not implement yet.** It is an *Approval* `Action=3` flow + **Storno** + replacement zero-rate document — an accounting-lifecycle change gated by the frozen credit/cancellation architecture. Decide the Storno model first. | Yes (fields + possibly a new doc-type/relation) | Yes — blocking decision |
| Doc-type coverage (320, 330) | Reconcile the internal contradiction; **decide** whether TAX_INVOICE_RECEIPT (320) and CREDIT_NOTE (330) require allocation per Table 2.5. | Possibly none (logic only) for 320; 330 ties into Action 3 | Yes |

**Bottom line:** the state-machine work (items 1–3) is small, additive, and low-risk *because the decoupling already exists*. Reverse Charge (item 4) is the only genuinely hard, migration-heavy, compliance-gated piece and must be decided before any code.

---

## 1. The exact accounting model per the official source

### 1.1 Held invoice → 4 alternatives (§2.2.2 / §4.1, verbatim)
When the authority withholds an allocation number for a *substantive* (business) reason (approval codes **460/461** → HELD), the software must present 4 alternatives and report the choice:

1. **Abandonment/revocation — Cancel** → `InvoiceDecisionApi/v1/Cancel`. Revoke the invoice normally; a Storno excludes the invoice + cancellation from the PCN874 file. No hearing possible after lock-in.
2. **Continue without allocation — Continue** → `InvoiceDecisionApi/v1/Continue`. Invoice concluded in the file, and **must display: "Input tax should not be deducted in respect of this invoice"**. A hearing may be requested later via the portal; if permitted, re-apply for allocation with the **same Invoice_Id**.
3. **Reverse charge** → **NOT a decision call. Uses the Approval service** (see §1.2).
4. **Request for Hearing — FurtherObjection** → `InvoiceDecisionApi/v1/FurtherObjection` + portal link.

> §4.1 verbatim: *"If alternatives 1,2,4 are selected, the service described in 4.2 must be activated. When choosing alternative 3, reversing the charge — the approval service must be activated as specified in Section 2."*

### 1.2 Reverse charge = Approval `Action=3` (§2.2.2 + §2.3 field 23, verbatim)
- Field **23 `Action`** on the **Approval** payload (`/Invoices/v2/Approval`), CM: value **`3` = Inversion of the charge**; **"VAT amount must be 0"**. (Value `4` = tax invoice originating from a pro-forma invoice — out of scope here.)
- §2.2.2 verbatim: *"By means of a special request with a zero-rate invoice to the service for receipt of an invoice allocation number. The invoice will bear the same details (other than the reference number and tax amount) with the same Invoice_Id included in the original invoice and the value 3 in the action field. As a result … a special allocation number will be obtained and executed as follows: o Storno operation will be performed to cancel the original invoice; o An invoice shall be issued at zero rate … 'locked' … special allocation number; o The printout … will include a caption: 'Customer must self-report this invoice'. … A zero-rate invoice will receive a reference number in accordance with the accepted rules."*

**⚠️ Contract correction of a prior assumption:** the `Action` field belongs to the **Approval** request, not the Decision request. Any earlier note suggesting a 4th decision endpoint or a decision-payload action is wrong.

### 1.3 Document-type allocation requirement (§2.1, Table 2.5)
Table 2.5 (row alignment partly garbled in the extracted copy — **must be re-verified against a clean official PDF before coding**), directionally:

| Code | Document type | Allocation required? |
|---|---|---|
| 305 | Tax invoice | **Yes** |
| 310 | Periodic tax invoice | Yes |
| 320 | Tax invoice/receipt | **Yes** |
| 330 | Credit tax invoice | **Yes** |
| 332 | Pro forma invoice | No |
| 340 | Reservation tax invoice | Yes |
| 345 | Agent tax invoice | Yes |

**This contradicts Dubiz's current `evaluateAuthorityReadinessAtIssue`, which returns `NOT_REQUIRED` for everything except `TAX_INVOICE` (305)** — i.e. it under-covers `TAX_INVOICE_RECEIPT` (320) and `CREDIT_NOTE` (330). See §6.

---

## 2. Current built model (origin/main) — what already exists

**Separation of concerns is already correct:**
- `BillingDocument.status` ∈ `{DRAFT, PENDING_REVIEW, ISSUED}` — the document **never leaves ISSUED** based on the authority outcome (`billing-issue.service.ts:361 resolveAuthorityOutcomeAfterIssue`).
- The full authority lifecycle lives on `BillingAuthoritySubmission.status` ∈ `{NOT_REQUIRED, READY, PENDING, SUBMITTED, APPROVED, REJECTED, FAILED, HELD}` (`schema.prisma:2547`), plus `allocationNumber`, `heldDecisionType`, `heldDecisionReportedAt`, `retryCount`, `authorityPayloadHash`, `authoritySubmissionId`.
- **Delivery** (whether a "final" PDF is served) is a *pure rule* `evaluateAuthorityDeliverability` (`billing-authority-delivery.rules.ts:66`) keyed off submission status + heldDecisionType — enforced centrally in `billing-pdf.service.ts:177-199` (throws `AUTHORITY_NOT_DELIVERABLE`). It is **not** keyed off document status.
- HELD exit is already **"Option A — no new statuses"**: submission stays `HELD`; `recordAuthorityHeldDecisionTx` (`transition.service.ts:1727`) sets `heldDecisionType`/`heldDecisionReportedAt`; the delivery rule then treats `PROCEED_WITHOUT_ALLOCATION` as deliverable.
- Document↔document linkage: a single self-relation `referenceDocumentId` (`BillingDocumentReversalReference`) used by credit notes. **No** `cancelledById` / Storno state exists; `BillingDocumentStatus` has no `CANCELLED`.

**Implication:** your steer ("keep BillingDocument in ISSUED, manage authority separately, don't mix accounting vs allocation status") is *already implemented*. The proposal should preserve and extend this, not restructure it.

---

## 3. Proposal C — Issuance state machine (minimal, additive)

**Recommendation: no new `BillingDocumentStatus` values; no change to `BillingAuthoritySubmissionStatus` enum.** Fill the two behavioral gaps using the existing statuses + the pure delivery rule.

### 3.1 States (reuse existing submission statuses)
```
READY ──reserve──▶ SUBMITTED ──approved──▶ APPROVED (+allocationNumber)   [deliverable]
                       │
                       ├──460/461──▶ HELD ──decision──▶ HELD + heldDecisionType
                       │                                   ├ PROCEED_WITHOUT_ALLOCATION → deliverable (w/ caption)
                       │                                   ├ ABANDONED           → blocked (revoke path)
                       │                                   └ HEARING_REQUESTED   → blocked (portal)
                       ├──ITA validation reject──▶ REJECTED [blocked]
                       └──technical/timeout──▶ FAILED [blocked, retry-safe]
NOT_REQUIRED [deliverable]
```
Allowed transitions are already enforced by conditional `updateMany` + `requireCurrentStatus` (optimistic concurrency, `transition.service.ts:986-1028`).

### 3.2 The two behavioral gaps to close (logic-only, no schema)
1. **"Continue" caption:** when `heldDecisionType === PROCEED_WITHOUT_ALLOCATION`, the PDF must render **"אין לנכות מס תשומות בגין חשבונית זו"** ("Input tax should not be deducted…"). Today the delivery rule *allows* delivery but the template does not add the caption. → template/logic change, no schema.
2. **Reverse-charge caption:** the zero-rate replacement doc must render **"על הלקוח לדווח על חשבונית זו"** ("Customer must self-report this invoice"). Ties to Proposal B.

### 3.3 Documentation-only fixes (flag, don't necessarily code now)
- `billing-authority-delivery.rules.ts:24-31` comment says heldDecision is "not used to grant delivery yet" but the switch (`:96-100`) does. Align comment.
- `billing-authority-approval-payload.ts:39` says readiness is "currently unwired" — it *is* wired (`billing-authority-issue.service.ts:102`). Align comment.
- `billing-authority-submission-execution.service.ts` header "NOT wired…" — it *is* wired. Align comment.

**No `BillingDocumentStatus` change ⇒ zero risk to existing documents from Proposal C.**

---

## 4. Proposal E — Unknown provider outcome + recovery

**Problem:** on a network timeout / aborted response mid-Approval, the software cannot know whether the authority actually granted an allocation. Today this collapses into `FAILED` (retry-safe), which is *ambiguous* — a blind resubmit could, in principle, request a second allocation. (Provider-side, a duplicate is guarded by code **462 "already reported"**, but we should not rely solely on that.)

**Recommendation (honoring "prefer a separate state in BillingAuthoritySubmission over a new enum"):**
- Do **not** add `UNKNOWN_PROVIDER_OUTCOME` to the enum. Instead add a **nullable marker column** on `BillingAuthoritySubmission`, e.g. `outcomeUncertainAt DateTime?` (and reuse existing `errorCode`), leaving `status` at `SUBMITTED`. `SUBMITTED` already means "reserved, awaiting confirmed outcome" and already blocks delivery — semantically correct for "unknown".
- **Recovery path = official reconciliation, not blind retry:** query **`invoice-information/v1/details`** (§3, `…/shaam/{tsandbox}/invoice-information/v1/details`; ⚠️ production host is `openapi.taxes.gov.il`, not `ita-api`) with the same `invoice_id`/customer to discover whether an allocation exists.
  - Found → transition `SUBMITTED → APPROVED` with the retrieved allocation number.
  - Not found → safe to re-submit the *same* payload (same `invoice_id`), where 462 provides a second-line guard.
- Recovery is an **explicit, callable service** (manual trigger or internal job) — no general scheduler required; must run **without any manual DB edit**.

**Migration footprint:** one additive nullable `DateTime?` column (expand-only). No enum change. No backfill required (defaults NULL).

---

## 5. Proposal B — Reverse Charge / Action 3 (BLOCKING — decide before any code)

This is the only piece that is a genuine accounting-model change. **Do not implement until the Storno + replacement-document model is ratified** against `docs/billing-credit-cancellation-architecture-plan.md` and the credit/reversal Phase 2A scope.

### 5.1 Full Action-3 flow (per §2.2.2)
```
HELD invoice, user chooses "Reverse charge"
  → obtain customer consent (record it)
  → build a SPECIAL Approval request:
        invoice_id      = original document's invoice_id  (SAME id)
        Action          = 3   (Inversion)
        VAT amount      = 0    (zero-rate)
        all other details = original, EXCEPT reference number & tax amount
  → POST /Invoices/v2/Approval
  → receive a SPECIAL allocation number
  → THEN, locally:
        (a) Storno (cancel) the original invoice
        (b) issue a NEW zero-rate invoice, "locked", bearing the special allocation number,
            with a fresh reference number, printing "Customer must self-report this invoice"
```

### 5.2 The three modeling questions that require your decision
**Q-B1 — Does reverse charge create a new BillingDocument, a Storno document, or both?**
Per source: a Storno of the original **and** a new zero-rate invoice. Options:
- **Option 1 (reuse existing linkage):** Storno = a `CREDIT_NOTE` referencing the original via `referenceDocumentId` (existing mechanism), + a new zero-rate `TAX_INVOICE` also linked. Pros: no new doc type / relation. Cons: overloads "credit note" semantics; a zero-rate tax invoice is unusual.
- **Option 2 (explicit cancellation state):** add `BillingDocumentStatus.CANCELLED` (or a `cancelledAt`/`cancelledById` field) for the Storno, + new zero-rate doc. Pros: honest Storno semantics. Cons: **`BillingDocumentStatus` migration touching every document** — high blast radius; contradicts §3's "keep it minimal".
- **Option 3 (dedicated reverse-charge relation):** new nullable self-relation `reverseChargeOfId` + a `documentSubType` marker. Additive, but a new relation + backfill semantics.
- **Recommendation:** **Option 1** if the credit/cancellation constitution permits a zero-VAT credit + zero-rate re-issue; otherwise **Option 3**. Avoid Option 2 (document-status migration) unless compliance requires an explicit CANCELLED state.

**Q-B2 — invoice_id collision.** The special Approval reuses the **original** `invoice_id` (= original `BillingDocument.id`), but `BillingAuthoritySubmission.billingDocumentId` is `@unique` (one submission per document). A second Approval on the same id needs either (a) a second submission row keyed differently (breaks the `@unique`), or (b) modeling the reverse-charge Approval as a *second attempt on the original submission* with a distinct sub-type. → **decision required**; likely needs a submission schema change (drop-in `reverseChargeSubmission` relation or a `submissionKind` discriminator).

**Q-B3 — Is Action 3 final and single-shot?** Per source it produces a "locked" special allocation → treat as **terminal and idempotent**: guard on consent + existing reverse-charge linkage so it cannot run twice (a second attempt returns NOOP/conflict, mirroring `recordAuthorityHeldDecisionTx`).

### 5.3 Why this is gated
It mutates issued-invoice reality (Storno), creates a new legal document, and reuses an allocation identity — all of which intersect the **frozen** billing-compliance and credit/cancellation architecture. Per AGENTS.md, such changes must be made in the canonical compliance docs first. → **STOP; requires your ratification + a compliance-doc update before code.**

---

## 6. Proposal D — Coverage of TAX_INVOICE / TAX_INVOICE_RECEIPT / CREDIT_NOTE

**Current contradictions (origin/main):**
- `AUTHORITY_ELIGIBLE_DOCUMENT_TYPES = [TAX_INVOICE, CREDIT_NOTE]` (`billing-authority.types.ts:27`) — but readiness returns `NOT_REQUIRED` for `CREDIT_NOTE`, and the approval code map **excludes** it. So `CREDIT_NOTE` gets a submission row that is never submitted.
- `APPROVAL_DOCUMENT_TYPE_CODE = { TAX_INVOICE:305, TAX_INVOICE_RECEIPT:320 }` — but `TAX_INVOICE_RECEIPT` is **not** in the eligible list and readiness returns `NOT_REQUIRED` for it.

**Per Table 2.5:** 305 Yes, 320 Yes, 330 Yes, 332 No.

| Dubiz type | ITA code | Table 2.5 | Dubiz today | Proposed (pending clean-table re-verify) |
|---|---|---|---|---|
| TAX_INVOICE | 305 | Yes | READY (conditional) | keep |
| TAX_INVOICE_RECEIPT | 320 | **Yes** | NOT_REQUIRED | **change to conditional READY** (logic-only; 320 already in code map) |
| CREDIT_NOTE | 330 | **Yes** | NOT_REQUIRED | **decide** — credit allocation ties into Storno/reverse model (Proposal B). Do not enable standalone. |
| RECEIPT / QUOTE | — | n/a | NOT_REQUIRED | keep |

**Decisions required:** (D1) confirm 320 requires allocation and flip readiness (logic-only, no schema). (D2) confirm 330 requirement and whether credit-note allocation is in-scope now or deferred with Action 3. (D3) fix the eligible-list vs code-map vs readiness inconsistency to one coherent source.

---

## 7. Idempotency & retry (consolidated)

Already present on origin/main (preserve): stable `invoice_id = String(document.id)`; `authorityPayloadHash` determinism guard (`AUTHORITY_PAYLOAD_HASH_MISMATCH`); pre-flight status gate (`SUBMITTED→in_progress`, `APPROVED/REJECTED→already_processed`); optimistic `requireCurrentStatus` updates; single 401 force-refresh retry; `retryCount` bumped only on `FAILED→SUBMITTED`; provider-side 462 duplicate guard; HELD-decision idempotency (NOOP on same, conflict on different).

**To add (with Proposal E):** treat "unknown" as reconcile-before-retry (never blind-resubmit on uncertain outcome). **To add (with Proposal B):** reverse-charge single-shot guard (consent + existing reverse-charge link ⇒ NOOP/conflict).

---

## 8. Proposed schema (NOT implemented) — estimated Prisma/SQL diff

> Additive, expand-only, all nullable. Presented for review; **not applied.**

**8.1 Unknown-outcome marker (Proposal E) — lowest risk**
```prisma
model BillingAuthoritySubmission {
  // ...
  outcomeUncertainAt   DateTime?   // set when an Approval attempt ended without a confirmed outcome (timeout/abort)
}
```
```sql
ALTER TABLE "BillingAuthoritySubmission" ADD COLUMN "outcomeUncertainAt" TIMESTAMP(3);
-- expand-only, nullable, no backfill
```

**8.2 Reverse charge (Proposal B) — ONLY if Option 3 chosen; decide first**
```prisma
model BillingDocument {
  // ...
  reverseChargeOfId Int?              // original invoice this zero-rate reverse-charge replaces
  reverseChargeOf   BillingDocument?  @relation("BillingDocumentReverseCharge", fields: [reverseChargeOfId], references: [id], onDelete: Restrict)
  reverseChargedBy  BillingDocument[] @relation("BillingDocumentReverseCharge")
}
model BillingAuthoritySubmission {
  submissionKind    String?           // discriminator: null=standard, "REVERSE_CHARGE" (avoids the billingDocumentId @unique collision)
  reverseChargeConsentAt DateTime?
}
```
*(If Option 1 is chosen instead, no schema change — reuse `referenceDocumentId`; if Option 2, a `BillingDocumentStatus` enum add — high risk, not recommended.)*

**No `BillingDocumentStatus` or `BillingAuthoritySubmissionStatus` enum change is proposed.**

---

## 9. Backfill, rollback, compatibility

**Backfill:** none required. All proposed columns are nullable with NULL meaning "standard / not applicable". Existing documents and submissions read unchanged.

**Rollback:** expand-only columns are safe to leave in place if a feature is reverted; if a full rollback is required, drop the added nullable columns (no data dependency, no enum rollback hazard). No two-phase enum contraction needed because no enum is touched.

**Compatibility / regression risks:**
- *Low:* Proposal E column + reconciliation service (isolated, additive).
- *Low:* §3 caption logic (PDF template only; gated by existing delivery rule).
- *Medium:* Proposal D flip of 320 → conditional READY changes which invoices *require* allocation at issue — could newly *block delivery* of tax-invoice/receipts that previously delivered freely. Must be feature-flagged/announced and validated against the threshold rules.
- *High:* Proposal B (Storno + reverse-charge doc) — touches issued-invoice immutability, numbering, PCN874 exclusion, and the credit/cancellation constitution. Requires compliance ratification and careful migration.

---

## 10. Alternatives considered

- **A. Expand `BillingDocumentStatus` with authority states** (PENDING_AUTHORITY, etc.) — *rejected*: mixes accounting status with allocation-request status (violates your steer), forces an enum migration touching every document, and duplicates the already-correct submission model.
- **B. Add `UNKNOWN_PROVIDER_OUTCOME` to the submission enum** — *not recommended*: an enum add is heavier than a nullable marker and `SUBMITTED` already carries the right "awaiting confirmed outcome" meaning.
- **C. Model reverse charge as a decision endpoint (4th action)** — *rejected*: contradicts the primary source (it is an Approval `Action=3` flow).
- **D. Recommended combination:** §3 (logic-only state machine completion) + Proposal E (one nullable column + reconciliation) now; Proposal B + Proposal D-330 deferred behind a ratified Storno model.

---

## 11. Decisions that require your explicit approval before ANY code

1. **Confirm** the principle: keep `BillingDocument` in `ISSUED`; no post-ISSUED accounting state; no `BillingDocumentStatus` change. (Proposal C)
2. **Approve** the single additive nullable column `outcomeUncertainAt` + reconciliation via `invoice-information/v1/details`. (Proposal E)
3. **Choose** the Storno / replacement-document model for reverse charge: **Option 1 (reuse credit linkage)** vs **Option 3 (new reverse-charge relation + submissionKind)**; Option 2 (document-status migration) only if compliance demands an explicit CANCELLED state. (Proposal B / Q-B1)
4. **Rule** on the `invoice_id` reuse vs `billingDocumentId @unique` collision (Q-B2) — whether reverse charge is a second submission row (needs schema) or a sub-typed attempt.
5. **Confirm** reverse charge is terminal + single-shot (Q-B3).
6. **Decide** doc-type coverage: flip 320 → conditional READY (D1); in/defer 330 (D2); reconcile eligible-list vs code-map vs readiness (D3).
7. **Authorize** re-verification of Table 2.5 and the reverse-charge text against a **clean** official PDF before implementing (the extracted copy has garbled rows).
8. **Sequence:** whether Proposal B must first be reflected in the canonical billing-compliance / credit-cancellation docs (per AGENTS.md) before implementation.

---

*End of proposal. No schema/migration/DB/deploy performed. Awaiting decisions 1–8.*
