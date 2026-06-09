/**
 * Authority Runtime C.2 — domain service foundation (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority.service.test.ts
 */
import { BillingAuthoritySubmissionStatus, BillingDocumentStatus } from "@prisma/client";
import {
  canTransitionAuthoritySubmission,
  getRequiredAuditEventForTransition,
  isForbiddenAuthoritySubmissionTransition,
  validateAuthorityProjection,
  validateAuthorityTransition,
} from "@/lib/services/billing/authority/billing-authority.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const issuedDocument = {
  businessId: 1,
  status: BillingDocumentStatus.ISSUED,
  documentType: "TAX_INVOICE" as const,
  legalSnapshotHash: "abc123",
  allocationNumber: null,
  allocationApprovedAt: null,
  isEmergencyAllocation: false,
};

const submission = {
  businessId: 1,
  billingDocumentId: 10,
  status: BillingAuthoritySubmissionStatus.SUBMITTED,
  submissionChannel: "STANDARD" as const,
  legalSnapshotHash: "abc123",
  allocationNumber: null,
  isEmergencyAllocation: false,
  authoritySubmissionId: null,
  approvedAt: null,
};

ok("INITIAL → READY allowed", canTransitionAuthoritySubmission("INITIAL", "READY"));
ok("INITIAL → NOT_REQUIRED allowed", canTransitionAuthoritySubmission("INITIAL", "NOT_REQUIRED"));
ok("NOT_REQUIRED → READY allowed", canTransitionAuthoritySubmission("NOT_REQUIRED", "READY"));
ok("SUBMITTED → APPROVED allowed", canTransitionAuthoritySubmission("SUBMITTED", "APPROVED"));
ok("FAILED → SUBMITTED allowed", canTransitionAuthoritySubmission("FAILED", "SUBMITTED"));
ok("APPROVED → SUBMITTED forbidden", isForbiddenAuthoritySubmissionTransition("APPROVED", "SUBMITTED"));
ok("READY → NOT_REQUIRED forbidden", isForbiddenAuthoritySubmissionTransition("READY", "NOT_REQUIRED"));

const approveResult = validateAuthorityTransition({
  from: BillingAuthoritySubmissionStatus.SUBMITTED,
  to: BillingAuthoritySubmissionStatus.APPROVED,
  kind: "APPROVE",
  document: issuedDocument,
  submission: {
    ...submission,
    allocationNumber: "123456789",
    approvedAt: new Date("2026-06-01T12:00:00.000Z"),
  },
});
ok("APPROVE validates with projection preconditions", approveResult.ok === true);
ok(
  "APPROVE requires audit event BILLING_AUTHORITY_APPROVED",
  getRequiredAuditEventForTransition("APPROVE") === "BILLING_AUTHORITY_APPROVED"
);

const projectionResult = validateAuthorityProjection({
  submission: {
    businessId: 1,
    status: BillingAuthoritySubmissionStatus.APPROVED,
    allocationNumber: "123456789",
    isEmergencyAllocation: false,
    approvedAt: new Date("2026-06-01T12:00:00.000Z"),
  },
  document: {
    businessId: 1,
    allocationNumber: null,
    allocationApprovedAt: null,
    isEmergencyAllocation: false,
  },
  proposedAllocationNumber: "123456789",
  proposedApprovedAt: new Date("2026-06-01T12:00:00.000Z"),
  proposedIsEmergencyAllocation: false,
});
ok("projection pre-write validates", projectionResult.ok === true);

const draftReject = validateAuthorityTransition({
  from: "INITIAL",
  to: BillingAuthoritySubmissionStatus.READY,
  kind: "CREATE_READY",
  document: {
    ...issuedDocument,
    status: BillingDocumentStatus.DRAFT,
  },
});
ok("non-issued document rejected", draftReject.ok === false);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll billing authority C.2 checks passed.");
