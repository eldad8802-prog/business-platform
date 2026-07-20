# Evidence — ITA InvoiceDecision / Reverse-Charge Contract (v1)

**Purpose.** Record the official source of truth used to resolve the
`Invoice-decision` vs `InvoiceDecisionApi` path conflict and to determine how the
four held-invoice alternatives (including reverse charge / action 3) are actually
executed. This document backs the code change in
`billing-authority-decision-client.config.ts` and the Proposals for the parts of
Phase 1 that are blocked pending a schema/accounting decision.

Read-only research only — no live OAuth/Approval/Decision call was made.

## Source

- **Document:** "Israel Invoice Model API Description" (מודל חשבוניות ישראל –
  תיאור ה-API's), **version 2.0 / 7.2024**.
- **Retrieved mirror (public):**
  `https://assets.kpmg.com/content/dam/kpmg/il/pdf/vat_software-houses-ENG.pdf`
- **Corroborating official pages:**
  - ITA "קישור לשע"ם" service: `https://www.gov.il/he/service/connect-to-shaam`
  - ITA process PDF: `https://www.gov.il/BlobFolder/service/connect-to-shaam/he/Service_Pages_shaam_connection-work-process-software-houses.pdf`
  - ITA OpenAPI demo (dsaddan): `https://github.com/dsaddan/Israel-Tax-Authority-OpenAPI-Taxes-Demo`

## Finding 1 — Decision endpoint path (§4.2)

The published routes (verbatim, §4.2):

```
https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Cancel
https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Continue
https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/FurtherObjection
https://ita-api.taxes.gov.il/shaam/production/InvoiceDecisionApi/v1/{Cancel|Continue|FurtherObjection}
```

- **Segment = `InvoiceDecisionApi`** (not `Invoice-decision`). The code's prior
  `Invoice-decision` segment was never a published route → **corrected**.
- **Version = `v1`** — code was already correct.
- Only **three** decision endpoints exist: `Cancel`, `Continue`, `FurtherObjection`.

## Finding 2 — The four held-invoice alternatives (§2.2.2 + §4.1)

§4.1 lists exactly four alternatives and how each is executed:

| # | Alternative (official) | How it is executed |
|---|---|---|
| 1 | Abandonment/revocation — **Cancel** | `InvoiceDecisionApi/v1/Cancel` |
| 2 | Continued generation without an allocation number — **Continue** | `InvoiceDecisionApi/v1/Continue` |
| 3 | **Reversing the charge** | **"see Approval… the approval service must be activated as specified in Section 2"** — NOT a decision call |
| 4 | Request for Hearing — **Further Objection** | `InvoiceDecisionApi/v1/FurtherObjection` (+ portal link) |

> §4.1: *"If alternatives 1,2,4 are selected, the service described in 4.2 must be
> activated. When choosing alternative 3, reversing the charge — the approval
> service must be activated as specified in Section 2."*

## Finding 3 — Reverse charge / Action 3 is an APPROVAL request, not a decision (§2.2.2)

§2.2.2, "Third alternative: reverse charge":

> *"By means of a special request with a zero-rate invoice to the service for
> receipt of an invoice allocation number. The invoice will bear the same details
> (other than the reference number and tax amount) with the same Invoice_Id
> included in the original invoice and **the value 3 in the action field**. …
> a special allocation number will be obtained and executed as follows:
> o **Storno** operation will be performed to cancel the original invoice;
> o An invoice shall be issued at **zero rate** … 'locked' … special allocation
> number; o printout includes the caption 'Customer must self-report this
> invoice'."*

Corroborated by the **Approval** payload field table: field **23 `Action`**,
value **`3` = Inversion** (reverse charge).

**Implication:** reverse charge is (a) an **Approval** call (`Invoices/v2/Approval`)
carrying `Action=3` + a zero-rate line, plus (b) a **Storno** of the original
invoice, plus (c) issuing a **new zero-rate document** that stores a **special
allocation number**. It is therefore an accounting-lifecycle operation, not a new
decision endpoint. The pre-existing `BillingAuthorityDecisionType.REVERSE_CHARGE`
enum value labels the user's choice, but the executing mechanism is unbuilt (the
Approval payload has no `Action` field today).

## Finding 4 — Approval (allocation) path (§2.3)

```
https://ita-api.taxes.gov.il/shaam/{tsandbox|production}/Invoices/v2/Approval
```

Code (`buildInvoiceApprovalUrl` → `/Invoices/v2/Approval`) is **correct**.

## Finding 5 — Decision request body (§4.2, Table 4.1)

Required (M): `invoice_id`, `vat_number`, `accounting_software_number`.
Conditional (CM): `authorized_company`, `user_id` **or** `user_name`.
Success = HTTP 200 with `{ "status": 200, "message": "Decision accepted" }`
(no confirmation_number in a decision response).
Existing `InvoiceDecisionRequest` type already matches this — no change needed.

## Finding 6 — Held-invoice display / state rules (§2.2.1–§2.2.2)

- On allocation: save the allocation number in the invoice record and print the
  9 right-most digits under the heading "Allocation Number".
- **Continue** alternative: the finalized invoice must display "Input tax should
  not be deducted in respect of this invoice".
- A held invoice presents 4 alternatives and must not be treated as a completed
  success until the authority decision is resolved.

These rules inform the Workstream C (state-machine) Proposal; implementing them
touches `BillingDocumentStatus` and is deferred pending a migration decision.
