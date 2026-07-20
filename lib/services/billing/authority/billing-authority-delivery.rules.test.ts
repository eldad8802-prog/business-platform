/**
 * Unit tests for the authority delivery guard (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-delivery.rules.test.ts
 * Pure — no DB, no network.
 */
import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentType,
} from "@prisma/client";
import {
  AUTHORITY_NOT_DELIVERABLE_CODE,
  evaluateAuthorityDeliverability,
  type AuthorityDeliverabilityInput,
} from "@/lib/services/billing/authority/billing-authority-delivery.rules";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

function base(
  overrides: Partial<AuthorityDeliverabilityInput>
): AuthorityDeliverabilityInput {
  return {
    documentType: BillingDocumentType.TAX_INVOICE,
    submissionStatus: null,
    heldDecisionType: null,
    heldDecisionReportedAt: null,
    documentAllocationNumber: null,
    ...overrides,
  };
}

// ---- Allowed ----
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.NOT_REQUIRED }));
  ok("NOT_REQUIRED → deliverable", r.deliverable === true && r.reason === "NOT_REQUIRED");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.APPROVED, documentAllocationNumber: "12345678" }));
  ok("APPROVED + allocation → deliverable", r.deliverable === true && r.reason === "APPROVED_WITH_ALLOCATION");
}
{
  // Non-eligible document type with no submission → delivered normally.
  const r = evaluateAuthorityDeliverability(base({ documentType: BillingDocumentType.QUOTE, submissionStatus: null }));
  ok("no submission + non-eligible type → deliverable (NOT_RELEVANT)", r.deliverable === true && r.reason === "NOT_RELEVANT");
}

// ---- Blocked (fail-closed) ----
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.APPROVED, documentAllocationNumber: null }));
  ok("APPROVED without allocation → blocked", r.deliverable === false && r.reason === "AUTHORITY_ALLOCATION_MISSING");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.APPROVED, documentAllocationNumber: "   " }));
  ok("APPROVED with blank allocation → blocked", r.deliverable === false && r.reason === "AUTHORITY_ALLOCATION_MISSING");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.READY }));
  ok("READY → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_READY");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.SUBMITTED }));
  ok("SUBMITTED → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_SUBMITTED");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.FAILED }));
  ok("FAILED → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_FAILED");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.HELD }));
  ok("HELD → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_HELD");
}
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.REJECTED }));
  ok("REJECTED → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_REJECTED");
}
{
  // Eligible doc type (TAX_INVOICE) with no submission → fail closed.
  const r = evaluateAuthorityDeliverability(base({ documentType: BillingDocumentType.TAX_INVOICE, submissionStatus: null }));
  ok("no submission + eligible type → blocked (fail closed)", r.deliverable === false && r.reason === "AUTHORITY_SUBMISSION_MISSING");
}
{
  // 320 Tax invoice/receipt is now eligible (Table 2.5: Yes) → no submission fails closed.
  const r = evaluateAuthorityDeliverability(base({ documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, submissionStatus: null }));
  ok("no submission + TAX_INVOICE_RECEIPT (320) → blocked (fail closed)", r.deliverable === false && r.reason === "AUTHORITY_SUBMISSION_MISSING");
}
{
  // CREDIT_NOTE (330) is NO LONGER eligible (Table 2.5: No) → delivered normally.
  const r = evaluateAuthorityDeliverability(base({ documentType: BillingDocumentType.CREDIT_NOTE, submissionStatus: null }));
  ok("no submission + CREDIT_NOTE (330) → deliverable (NOT_RELEVANT)", r.deliverable === true && r.reason === "NOT_RELEVANT");
}

// ---- Held decision outcomes (Decision Flow) ----
{
  // Continue accepted + reported → delivery ALLOWED without an allocation number.
  const r = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "PROCEED_WITHOUT_ALLOCATION",
    heldDecisionReportedAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
  ok("HELD + Continue (PROCEED_WITHOUT_ALLOCATION) + reported → deliverable", r.deliverable === true && r.reason === "CONTINUE_WITHOUT_ALLOCATION");
}
{
  // Cancel accepted → delivery blocked.
  const r = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "ABANDONED",
    heldDecisionReportedAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
  ok("HELD + Cancel (ABANDONED) → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_HELD");
}
{
  // FurtherObjection accepted → delivery blocked (awaiting hearing).
  const r = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "HEARING_REQUESTED",
    heldDecisionReportedAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
  ok("HELD + FurtherObjection (HEARING_REQUESTED) → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_HELD");
}
{
  // Continue decision type WITHOUT a reported timestamp → inconsistent → blocked.
  const r = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "PROCEED_WITHOUT_ALLOCATION",
    heldDecisionReportedAt: null,
  }));
  ok("HELD + Continue but NOT reported → blocked (inconsistent)", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_HELD");
}
{
  // HELD with no decision at all → blocked.
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.HELD }));
  ok("HELD + no decision → blocked", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_HELD");
}

// ---- Workstream 4: Continue-without-allocation is DISTINCT from an approval ----
{
  // Continue is deliverable with NO allocation number at all — it must never be
  // conflated with APPROVED_WITH_ALLOCATION, and must not require/borrow a number.
  const cont = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "PROCEED_WITHOUT_ALLOCATION",
    heldDecisionReportedAt: new Date("2026-07-16T00:00:00.000Z"),
    documentAllocationNumber: null,
  }));
  const appr = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.APPROVED,
    documentAllocationNumber: "12345678",
  }));
  ok("Continue deliverable WITHOUT any allocation number", cont.deliverable === true && cont.reason === "CONTINUE_WITHOUT_ALLOCATION");
  ok("Approved reason differs from Continue reason", appr.deliverable === true && appr.reason === "APPROVED_WITH_ALLOCATION" && appr.reason !== cont.reason);
  // A Continue decision must NOT be upgraded to an approval just because a number
  // is (erroneously) present — the reason stays CONTINUE_WITHOUT_ALLOCATION.
  const contWithNumber = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "PROCEED_WITHOUT_ALLOCATION",
    heldDecisionReportedAt: new Date("2026-07-16T00:00:00.000Z"),
    documentAllocationNumber: "00000001",
  }));
  ok("Continue stays Continue even if a stray number is present (no placeholder promotion)", contWithNumber.deliverable === true && contWithNumber.reason === "CONTINUE_WITHOUT_ALLOCATION");
}

// ---- No sensitive leakage: reason is always an internal code, public code is stable ----
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.HELD }));
  ok("blocked reason is an internal code (no free text)", r.deliverable === false && /^[A-Z_]+$/.test(r.reason));
  ok("public code stable", AUTHORITY_NOT_DELIVERABLE_CODE === "BILLING_AUTHORITY_DOCUMENT_NOT_DELIVERABLE");
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll authority delivery rules tests passed.");
