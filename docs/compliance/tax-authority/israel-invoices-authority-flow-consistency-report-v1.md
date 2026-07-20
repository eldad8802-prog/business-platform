# Phase 2A — Authority Flow Consistency Report (v1)

Read-only verification + logic-only consistency fixes. No schema, no migration, no
live OAuth/Approval, no Production change, no Reverse Charge / Storno.

## 1. Official Contract Report (Workstream 1)

**Source:** "Israel Invoice Model API Description" (מודל חשבוניות ישראל – תיאור ה-API's),
**v2.0 / 7.2024**. Verified against a clean extraction of the official PDF
(`pdftotext -raw`), cross-checked against the gov.il Hebrew mirror (same row order)
and a secondary reading. Mirror: `https://assets.kpmg.com/content/dam/kpmg/il/pdf/vat_software-houses-ENG.pdf`;
gov.il 2.0/7.2024 (Hebrew): `https://claltax.com/wp-content/uploads/2024/12/vat_software-houses-180724.pdf`.

### 1.1 Table 2.5 — Types of documents (verbatim, allocation column)
| Code | Document Type | Allocation Number required | Notes |
|---|---|---|---|
| 300 | Invoice/transaction invoice | **No** | |
| 305 | Tax invoice | **Yes** | |
| — | Tax invoice I | No | Future (Palestinian customer) |
| 310 | Periodic tax invoice | **Yes** | |
| 320 | Tax invoice/receipt | **Yes** | |
| 330 | Credit tax invoice | **No** | |
| 331 | Credit tax invoice I | No | Future |
| 332 | Pro forma invoice | Yes | See §3.5 (pro-forma→invoice, Action 4) |
| 340 | Reservation Tax Invoice | Yes | New |
| 345 | Agent Tax Invoice | Yes | New |
| 348 | Log command | Yes | New |

**Decisions for the three codes Dubiz issues (§ = Table 2.5):**
- **305 (TAX_INVOICE) → Yes.** Allocation required, subject to the reform conditions (threshold/VAT/licensed-dealer). Normal Approval (`/Invoices/v2/Approval`).
- **320 (TAX_INVOICE_RECEIPT) → Yes.** Treated **exactly like 305** (same conditions, same Approval). No exception in the table.
- **330 (CREDIT_NOTE) → No.** A credit tax invoice does **not** request an allocation number, does not need a related number, and has no extra field for this purpose.

### 1.2 invoice-information/v1/details (Workstream 1.6–1.7)
- Sandbox: `https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details`
- Production: `https://openapi.taxes.gov.il/shaam/production/invoice-information/v1/details` (⚠️ production host is `openapi`, not `ita-api`).
- Request (Table 3.1): `Customer_VAT_Number` (M) + invoice identifiers; OAuth2 user-restricted.
- **Suitable for reconciliation after timeout / unknown outcome: YES** — it reads whether an allocation exists for an invoice, so recovery can query it instead of blind-resubmitting. (Not implemented this phase; requires the deferred `outcomeUncertainAt` marker — see §5.)

### 1.3 Printing rules (Workstream 1.8) — VERIFIED (EN) / Hebrew string SOURCE-BLOCKED
- **Approval:** save the allocation number; print the 9 right-most digits under the heading "Allocation Number" (§2.2.1).
- **HELD:** present 4 alternatives; do not treat as a completed success (§2.2.2).
- **Continue without allocation:** the invoice must display **"Input tax should not be deducted in respect of this invoice"** (§2.2.2, EN verbatim).
- **Reverse charge:** the zero-rate invoice prints **"Customer must self-report this invoice"** (§2.2.2, EN verbatim).
- ⚠️ **The official Hebrew PDF has no Unicode-extractable glyphs**, and no reachable authoritative source quotes the exact Hebrew caption. Per the rule "use the verified official wording, do not compose your own", the exact **Hebrew** caption string is **source-blocked** and NOT hardcoded in this phase (see §6 Remaining Proposals). The delivery layer already distinguishes the state (`CONTINUE_WITHOUT_ALLOCATION`).

## 2. Document-Type Consistency Matrix (Workstream 2)

**Before (origin/main) — four registries disagreed:**
| Type | Registry (eligible) | Readiness | Approval code map | Delivery (no submission) | Official |
|---|---|---|---|---|---|
| TAX_INVOICE (305) | eligible | CONDITIONAL | 305 | fail-closed | **Yes** ✓ |
| TAX_INVOICE_RECEIPT (320) | **not eligible** | **NOT_REQUIRED** | 320 | deliverable | **Yes** ✗ |
| CREDIT_NOTE (330) | **eligible** | NOT_REQUIRED | absent | **blocked** | **No** ✗ |

**After (this PR) — one source of truth (`AUTHORITY_ALLOCATION_REQUIREMENT`):**
| Type | Requirement | Eligible | Readiness | Approval code | Delivery (no submission) | Official |
|---|---|---|---|---|---|---|
| TAX_INVOICE (305) | CONDITIONAL | ✅ | conditional READY | 305 | fail-closed | Yes ✓ |
| TAX_INVOICE_RECEIPT (320) | CONDITIONAL | ✅ | conditional READY | 320 | fail-closed | Yes ✓ |
| CREDIT_NOTE (330) | NOT_REQUIRED | ❌ | NOT_REQUIRED | none | deliverable (NOT_RELEVANT) | No ✓ |
| RECEIPT / QUOTE | NOT_REQUIRED | ❌ | NOT_REQUIRED | none | deliverable | n/a ✓ |

Eligibility, readiness, and the approval code-map now all derive from / agree with the single registry — enforced by `billing-authority-document-type-consistency.test.ts`.

**Operational impact (flag):** readiness is **not** connection-gated. Now that 305 **and** 320 are CONDITIONAL, a qualifying tax-invoice/receipt (ILS ≥ threshold, VAT > 0, licensed-dealer customer) is **delivery-blocked until an allocation is approved** — the same gate that already applied to 305. Because the allocation channel is not yet operational (OAuth), qualifying 320 invoices will be blocked from final PDF until the connection is activated. This is the correct compliance behavior, but it must be sequenced with connection activation.

## 3. Deliverability State Table (Workstream 3)

Single canonical function `evaluateAuthorityDeliverability` (unchanged logic; the eligibility set it depends on is now correct). All ten logical states:

| Authority state | PDF (final) | Send/Download | UI reason | Required text | Retry |
|---|---|---|---|---|---|
| Not required (330/RECEIPT/QUOTE, or non-eligible no submission) | ✅ | ✅ | NOT_REQUIRED / NOT_RELEVANT | — | — |
| Required, no submission (eligible) | ❌ | ❌ | AUTHORITY_SUBMISSION_MISSING | — | fix issue flow |
| READY (not yet sent) | ❌ | ❌ | AUTHORITY_NOT_DELIVERABLE_READY | — | send |
| PENDING / SUBMITTED (in progress) | ❌ | ❌ | AUTHORITY_NOT_DELIVERABLE_SUBMITTED | — | await |
| APPROVED + allocation | ✅ | ✅ | APPROVED_WITH_ALLOCATION | print allocation № | — |
| APPROVED, no number | ❌ | ❌ | AUTHORITY_ALLOCATION_MISSING | — | reconcile |
| HELD (no decision) | ❌ | ❌ | AUTHORITY_NOT_DELIVERABLE_HELD | — | decide |
| HELD + Continue (reported) | ✅ | ✅ | CONTINUE_WITHOUT_ALLOCATION | "no input-tax deduction" caption† | — |
| HELD + Cancel / FurtherObjection | ❌ | ❌ | AUTHORITY_NOT_DELIVERABLE_HELD | — | — |
| Provider rejection (REJECTED) | ❌ | ❌ | AUTHORITY_NOT_DELIVERABLE_REJECTED | — | — |
| Infra failure (FAILED) | ❌ | ❌ | AUTHORITY_NOT_DELIVERABLE_FAILED | — | retry (safe) |
| Unknown / future state | ❌ | ❌ | AUTHORITY_STATE_UNKNOWN | — | fail-closed |

† caption Hebrew string is source-blocked (§1.3); the state is represented, the exact rendered text is deferred.

**Unknown outcome (timeout):** currently collapses into FAILED (retry-safe). Representing it distinctly to block auto-retry requires the deferred `outcomeUncertainAt` field (§5/§6) — not added this phase.

## 4. Implementation Report

Files (logic + tests only; no schema, no migration):
- `billing-authority.types.ts` — added `AUTHORITY_ALLOCATION_REQUIREMENT` (single source of truth, exhaustive over `BillingDocumentType`); fixed `AUTHORITY_ELIGIBLE_DOCUMENT_TYPES` → `[TAX_INVOICE, TAX_INVOICE_RECEIPT]`.
- `billing-authority-readiness.ts` — readiness now derives from the registry (activates 320; keeps 330/RECEIPT/QUOTE NOT_REQUIRED).
- `billing-authority-delivery.rules.ts` — corrected stale comment (held-decision path IS used post-#138); no logic change.
- `billing-authority-approval-payload.ts` — updated CREDIT_NOTE comment (330 = No, resolved by Table 2.5); code map unchanged (already 305/320).
- Tests: new `…-document-type-consistency.test.ts`; extended readiness (320 cases), delivery (320 eligible, 330 deliverable, Workstream-4 Continue-vs-Approval distinction + no-placeholder-promotion).

## 5. Idempotency (Workstream 5) — code-only findings

Existing guards on `origin/main` are sufficient and unchanged: stable `invoice_id = String(documentId)`; `authorityPayloadHash` determinism; conditional `requireCurrentStatus` updates; `retryCount` bumped only on FAILED→SUBMITTED; single 401 force-refresh; provider-side 462 duplicate guard; HELD-decision NOOP/conflict idempotency. **No safe code-only way to represent "unknown provider outcome" without a new field** → `outcomeUncertainAt` is required for that one case and is deferred (§6).

## 6. Remaining Proposals

1. **Reverse Charge / Action 3 + Storno + replacement document** — accounting model + migration; blocked (prior unified proposal).
2. **`outcomeUncertainAt` (unknown-outcome marker) + reconciliation via `invoice-information/v1/details`** — one additive nullable column; deferred.
3. **Continue-caption exact Hebrew string** — SOURCE-BLOCKED; needs the verified official Hebrew wording before rendering it in the PDF.

## 7. Final Verdict
### → **LOGICAL FLOW COMPLETE — REVERSE CHARGE REMAINS**
The document-type source of truth is unified and correct per the verified official Table 2.5 (305=Yes, 320=Yes, 330=No), the deliverability state machine is explicit and single-sourced, and idempotency guards are confirmed. The remaining items (Reverse Charge/Storno, the unknown-outcome marker, and the exact Hebrew caption string) are explicitly out of this phase's logic-only scope.
