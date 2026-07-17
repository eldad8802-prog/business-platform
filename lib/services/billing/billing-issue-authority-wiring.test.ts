/**
 * Unit tests for post-commit authority resolution in the issue flow (run manually):
 *   npx tsx lib/services/billing/billing-issue-authority-wiring.test.ts
 *
 * Injects executeApproval — no DB, no network. Verifies WHEN execution runs and
 * how its result / throws map to the issue-facing authority outcome.
 */
import { BillingAuthoritySubmissionStatus } from "@prisma/client";
import type { ExecutionResult } from "@/lib/services/billing/authority/billing-authority-submission-execution.service";
import type { CreateAuthoritySubmissionAtIssueResult } from "@/lib/services/billing/authority/billing-authority-issue.service";
import {
  resolveAuthorityOutcomeAfterIssue,
  type IssueAuthorityDeps,
} from "@/lib/services/billing/billing-issue.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const BASE = { businessId: 1, billingDocumentId: 7, actorUserId: 3 };

function submission(status: BillingAuthoritySubmissionStatus): CreateAuthoritySubmissionAtIssueResult {
  return {
    submissionId: 55,
    status,
    transitionKind: status === BillingAuthoritySubmissionStatus.NOT_REQUIRED ? "CREATE_NOT_REQUIRED" : "CREATE_READY",
    auditEventType: status === BillingAuthoritySubmissionStatus.NOT_REQUIRED ? "BILLING_AUTHORITY_MARKED_NOT_REQUIRED" : "BILLING_AUTHORITY_READINESS_CREATED",
  };
}

function spy(resultOrThrow: ExecutionResult | Error) {
  const calls = { n: 0 };
  const deps: IssueAuthorityDeps = {
    executeApproval: async () => {
      calls.n += 1;
      if (resultOrThrow instanceof Error) throw resultOrThrow;
      return resultOrThrow;
    },
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  // 1. No submission (non-eligible type) → not_required, NO execution.
  {
    const s = spy({ outcome: "completed_approved", billingDocumentId: 7, submissionId: 55, allocationNumber: "1", safeToRetry: false });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: null }, s.deps);
    ok("null submission → not_required, no execute", r.status === "not_required" && s.calls.n === 0);
  }

  // 2. NOT_REQUIRED → not_required + submissionId, NO execution.
  {
    const s = spy({ outcome: "completed_approved", billingDocumentId: 7, submissionId: 55, allocationNumber: "1", safeToRetry: false });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.NOT_REQUIRED) }, s.deps);
    ok("NOT_REQUIRED → not_required + submissionId, no execute", r.status === "not_required" && r.submissionId === 55 && s.calls.n === 0);
  }

  // 3. READY → execute ONCE → approved.
  {
    const s = spy({ outcome: "completed_approved", billingDocumentId: 7, submissionId: 55, allocationNumber: "12345678", safeToRetry: false });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.READY) }, s.deps);
    ok("READY → execute once → approved", r.status === "approved" && r.allocationNumber === "12345678" && s.calls.n === 1);
  }

  // 4. READY + 460 → decision_required (HELD).
  {
    const s = spy({ outcome: "decision_required", billingDocumentId: 7, submissionId: 55, code: 460, errorCode: "AUTHORITY_DECISION_REQUIRED_460", userActionRequired: true, safeToRetry: false });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.READY) }, s.deps);
    ok("READY + 460 → decision_required + userActionRequired", r.status === "decision_required" && r.userActionRequired === true && r.code === 460 && s.calls.n === 1);
  }

  // 5. READY + validation → validation_failed.
  {
    const s = spy({ outcome: "completed_rejected", billingDocumentId: 7, submissionId: 55, errorCode: "ITA_434", safeToRetry: false });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.READY) }, s.deps);
    ok("READY + rejected → validation_failed", r.status === "validation_failed");
  }

  // 6. READY + network/timeout → infrastructure_failed.
  {
    const s = spy({ outcome: "infrastructure_failed", billingDocumentId: 7, submissionId: 55, errorCode: "AUTHORITY_NETWORK", safeToRetry: true });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.READY) }, s.deps);
    ok("READY + network → infrastructure_failed + safeToRetry", r.status === "infrastructure_failed" && r.safeToRetry === true);
  }

  // 7. READY + unexpected throw → execution_error (contained, filtered).
  {
    const s = spy(new Error("boom SECRET_TOKEN should not leak"));
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.READY) }, s.deps);
    ok("READY + throw → execution_error (contained)", r.status === "execution_error" && r.errorCode === "AUTHORITY_EXECUTION_UNEXPECTED" && s.calls.n === 1);
    ok("execution_error outcome carries no leaked token", !JSON.stringify(r).includes("SECRET_TOKEN"));
  }

  // 8. Defensive: SUBMITTED at issue → in_progress, NO execution.
  {
    const s = spy({ outcome: "completed_approved", billingDocumentId: 7, submissionId: 55, allocationNumber: "1", safeToRetry: false });
    const r = await resolveAuthorityOutcomeAfterIssue({ ...BASE, submission: submission(BillingAuthoritySubmissionStatus.SUBMITTED) }, s.deps);
    ok("SUBMITTED at issue → in_progress, no execute", r.status === "in_progress" && s.calls.n === 0);
  }
}

main()
  .then(() => {
    if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
    console.log("\nAll billing-issue authority wiring tests passed.");
  })
  .catch((error) => { console.error(error); process.exit(1); });
