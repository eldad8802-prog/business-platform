/**
 * Unit tests for ExecutionResult → AuthorityIssueOutcome mapping (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-issue-outcome.test.ts
 * Pure — no DB, no network.
 */
import { mapExecutionResultToAuthorityOutcome } from "@/lib/services/billing/authority/billing-authority-issue-outcome";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const D = 7; // billingDocumentId
const S = 55; // submissionId

{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "completed_approved", billingDocumentId: D, submissionId: S, allocationNumber: "12345678", safeToRetry: false });
  ok("completed_approved → approved + allocation", r.status === "approved" && r.allocationNumber === "12345678" && r.submissionId === S);
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "completed_rejected", billingDocumentId: D, submissionId: S, errorCode: "ITA_434", safeToRetry: false });
  ok("completed_rejected → validation_failed", r.status === "validation_failed" && r.errorCode === "ITA_434");
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "decision_required", billingDocumentId: D, submissionId: S, code: 460, errorCode: "AUTHORITY_DECISION_REQUIRED_460", userActionRequired: true, safeToRetry: false });
  ok("decision_required → decision_required + userActionRequired + code", r.status === "decision_required" && r.userActionRequired === true && r.code === 460 && r.safeToRetry === false);
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "decision_already_reported", billingDocumentId: D, submissionId: S, code: 462, errorCode: "AUTHORITY_DECISION_ALREADY_REPORTED", safeToRetry: false });
  ok("decision_already_reported → decision_already_reported + code", r.status === "decision_already_reported" && r.code === 462);
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "authentication_failed", billingDocumentId: D, submissionId: S, errorCode: "AUTHORITY_AUTHENTICATION", safeToRetry: true });
  ok("authentication_failed → authentication_failed + safeToRetry true", r.status === "authentication_failed" && r.safeToRetry === true);
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "infrastructure_failed", billingDocumentId: D, submissionId: S, errorCode: "AUTHORITY_NETWORK", safeToRetry: true });
  ok("infrastructure_failed → infrastructure_failed + safeToRetry passthrough", r.status === "infrastructure_failed" && r.safeToRetry === true);
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "ambiguous_result", billingDocumentId: D, submissionId: S, errorCode: "AUTHORITY_NOT_APPROVED_AMBIGUOUS", safeToRetry: "manual" });
  ok("ambiguous_result → ambiguous + safeToRetry manual", r.status === "ambiguous" && r.safeToRetry === "manual");
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "in_progress", billingDocumentId: D, submissionId: S, safeToRetry: false });
  ok("in_progress → in_progress", r.status === "in_progress" && r.submissionId === S);
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "already_processed", billingDocumentId: D, submissionId: S, status: "APPROVED", safeToRetry: false });
  ok("already_processed → in_progress (defensive)", r.status === "in_progress");
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "preflight_failed", billingDocumentId: D, submissionId: S, errorCode: "ENVIRONMENT_NOT_CONFIGURED", safeToRetry: true });
  ok("preflight_failed → infrastructure_failed", r.status === "infrastructure_failed" && r.errorCode === "ENVIRONMENT_NOT_CONFIGURED");
}
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "local_validation_failed", billingDocumentId: D, submissionId: S, errorCode: "MISSING_CUSTOMER_VAT_NUMBER", safeToRetry: true });
  ok("local_validation_failed → validation_failed", r.status === "validation_failed");
}

// ---- No HTTP status codes leak into the business outcome ----
{
  const r = mapExecutionResultToAuthorityOutcome({ outcome: "completed_approved", billingDocumentId: D, submissionId: S, allocationNumber: "9", safeToRetry: false });
  const keys = Object.keys(r);
  ok("no httpStatus / status-code keys in outcome", !keys.includes("httpStatus") && !keys.includes("status_code"));
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll authority issue-outcome mapping tests passed.");
