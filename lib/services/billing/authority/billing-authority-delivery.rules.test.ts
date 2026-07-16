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
  // CREDIT_NOTE is authority-eligible; no submission → fail closed too.
  const r = evaluateAuthorityDeliverability(base({ documentType: BillingDocumentType.CREDIT_NOTE, submissionStatus: null }));
  ok("no submission + CREDIT_NOTE → blocked (fail closed)", r.deliverable === false && r.reason === "AUTHORITY_SUBMISSION_MISSING");
}

// ---- A held decision never unblocks in this PR ----
{
  const r = evaluateAuthorityDeliverability(base({
    submissionStatus: BillingAuthoritySubmissionStatus.HELD,
    heldDecisionType: "PROCEED_WITHOUT_ALLOCATION",
    heldDecisionReportedAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
  ok("HELD + PROCEED_WITHOUT_ALLOCATION (future) still blocked now", r.deliverable === false && r.reason === "AUTHORITY_NOT_DELIVERABLE_HELD");
}

// ---- No sensitive leakage: reason is always an internal code, public code is stable ----
{
  const r = evaluateAuthorityDeliverability(base({ submissionStatus: BillingAuthoritySubmissionStatus.HELD }));
  ok("blocked reason is an internal code (no free text)", r.deliverable === false && /^[A-Z_]+$/.test(r.reason));
  ok("public code stable", AUTHORITY_NOT_DELIVERABLE_CODE === "BILLING_AUTHORITY_DOCUMENT_NOT_DELIVERABLE");
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll authority delivery rules tests passed.");
