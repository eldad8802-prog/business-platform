/**
 * Unit tests for the authority issue-outcome display mapping (run manually):
 *   npx tsx lib/billing/authority-issue-display.test.ts
 * Pure — no DB, no React.
 */
import type { AuthorityIssueOutcome } from "@/lib/services/billing/authority/billing-authority-issue-outcome";
import { describeAuthorityIssueOutcome } from "@/lib/billing/authority-issue-display";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

// 1. approved → success WITH allocation number; the only state that "received" one.
{
  const d = describeAuthorityIssueOutcome({ status: "approved", submissionId: 5, allocationNumber: "20240627231846297178091822", safeToRetry: false } as AuthorityIssueOutcome);
  // §2.2.1: the display shows the 9 right-most digits, not the full confirmation number.
  ok("approved → allocationReceived + 9-digit number + success", d.allocationReceived === true && d.allocationNumber === "178091822" && d.tone === "success");
  ok("approved detail shows 9-digit allocation", d.detail === "מספר הקצאה: 178091822");
}

// 2. not_required → issued, not required, no number.
{
  const d = describeAuthorityIssueOutcome({ status: "not_required" } as AuthorityIssueOutcome);
  ok("not_required → issued, no allocation, not success-as-received", d.documentIssued === true && d.allocationReceived === false && d.allocationNumber === undefined);
}

// 3. decision_required → NOT presented as a normal success; user action required.
{
  const d = describeAuthorityIssueOutcome({ status: "decision_required", submissionId: 5, code: 460, errorCode: "X", userActionRequired: true, safeToRetry: false } as AuthorityIssueOutcome);
  ok("decision_required → not success, not received, userActionRequired", d.tone !== "success" && d.allocationReceived === false && d.userActionRequired === true);
}

// 4. infra + execution_error → never presented as "received a number".
{
  const inf = describeAuthorityIssueOutcome({ status: "infrastructure_failed", submissionId: 5, errorCode: "AUTHORITY_NETWORK", safeToRetry: true } as AuthorityIssueOutcome);
  const exe = describeAuthorityIssueOutcome({ status: "execution_error", submissionId: 5, errorCode: "AUTHORITY_EXECUTION_UNEXPECTED", safeToRetry: "manual" } as AuthorityIssueOutcome);
  ok("infrastructure_failed → not received, not success", inf.allocationReceived === false && inf.tone !== "success");
  ok("execution_error → not received, not success", exe.allocationReceived === false && exe.tone !== "success");
}

// 5. decision_already_reported → not a false approval.
{
  const d = describeAuthorityIssueOutcome({ status: "decision_already_reported", submissionId: 5, code: 462, errorCode: "X", safeToRetry: false } as AuthorityIssueOutcome);
  ok("decision_already_reported → not received, no false approval", d.allocationReceived === false && d.tone !== "success");
}

// 6. in_progress / validation_failed / authentication_failed / ambiguous → never "received".
{
  for (const status of ["in_progress", "validation_failed", "authentication_failed", "ambiguous"] as const) {
    const d = describeAuthorityIssueOutcome({ status, submissionId: 5 } as AuthorityIssueOutcome);
    ok(`${status} → documentIssued, allocationReceived=false`, d.documentIssued === true && d.allocationReceived === false);
  }
}

// 7. Invariant: only "approved" yields allocationReceived === true.
{
  const all: AuthorityIssueOutcome["status"][] = ["approved","not_required","in_progress","decision_required","decision_already_reported","validation_failed","authentication_failed","infrastructure_failed","ambiguous","execution_error"];
  const received = all.filter((s) => describeAuthorityIssueOutcome({ status: s, allocationNumber: s === "approved" ? "9" : undefined } as AuthorityIssueOutcome).allocationReceived);
  ok("only 'approved' reports allocationReceived", received.length === 1 && received[0] === "approved", received);
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll authority issue-display tests passed.");
