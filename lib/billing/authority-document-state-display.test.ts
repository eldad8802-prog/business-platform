/**
 * The document screen's allocation state, end to end and pure: the server builder
 * (same delivery rule as the PDF route) → the client wording.
 *
 *   - "ready to share" (deliverable) only when the delivery rule allows the final PDF;
 *   - "allocation received" only when a number is stored;
 *   - "sent to the authority" only for SUBMITTED;
 *   - never "try again" — not in this mapper, not in the issue-time mapper.
 *
 * Run: npx tsx lib/billing/authority-document-state-display.test.ts
 */
import { BillingDocumentType } from "@prisma/client";
import { buildAuthorityDocumentState } from "@/lib/services/billing/authority/billing-authority-document-state";
import { evaluateAuthorityDeliverability } from "@/lib/services/billing/authority/billing-authority-delivery.rules";
import {
  describeAuthorityDocumentState,
  isDocumentDeliverable,
} from "@/lib/billing/authority-document-state-display";
import { describeAuthorityIssueOutcome } from "@/lib/billing/authority-issue-display";

let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? " — " + detail : ""}`);
  }
}

type Sub = Parameters<typeof buildAuthorityDocumentState>[0]["submission"];
const TI = BillingDocumentType.TAX_INVOICE;
function state(submission: Sub, allocationNumber: string | null = null, documentType: BillingDocumentType = TI) {
  return buildAuthorityDocumentState({ documentStatus: "ISSUED", documentType, allocationNumber, submission });
}
const sub = (status: string, extra: Partial<NonNullable<Sub>> = {}): Sub =>
  ({ status, errorCode: null, heldDecisionType: null, heldDecisionReportedAt: null, ...extra }) as Sub;

// --- not issued → nothing
ok("a draft has no authority state", buildAuthorityDocumentState({ documentStatus: "DRAFT", documentType: TI, allocationNumber: null, submission: null }) === null);
ok("a missing state keeps today's behaviour (deliverable)", isDocumentDeliverable(undefined) && isDocumentDeliverable(null));
ok("a missing state shows nothing", !describeAuthorityDocumentState(undefined).show);

// --- the builder agrees with the delivery rule for every status
const statuses = ["NOT_REQUIRED", "READY", "PENDING", "SUBMITTED", "FAILED", "HELD", "REJECTED", "APPROVED"];
for (const s of statuses) {
  const st = state(sub(s), s === "APPROVED" ? "2026111012345678" : null)!;
  const rule = evaluateAuthorityDeliverability({ documentType: TI, submissionStatus: s as never, heldDecisionType: null, heldDecisionReportedAt: null, documentAllocationNumber: s === "APPROVED" ? "2026111012345678" : null });
  ok(`builder ≡ delivery rule for ${s}`, st.deliverable === rule.deliverable && st.reason === rule.reason);
}

// --- wording per state
const ready = describeAuthorityDocumentState(state(sub("READY")));
ok("READY → blocked, says the request was NOT sent", ready.show && !ready.deliverable && /לא נשלחה/.test(ready.title));
const approved = describeAuthorityDocumentState(state(sub("APPROVED"), "2026111012345678"));
ok("APPROVED with a number → deliverable, shows the 9 right-most digits", approved.deliverable && approved.tone === "success" && approved.detail.includes("012345678"));
const approvedNoNumber = describeAuthorityDocumentState(state(sub("APPROVED"), null));
ok("APPROVED without a number → blocked, never 'received'", !approvedNoNumber.deliverable && !/התקבל מספר/.test(approvedNoNumber.title));
const submitted = describeAuthorityDocumentState(state(sub("SUBMITTED")));
ok("SUBMITTED → 'sent', blocked", !submitted.deliverable && /נשלחה/.test(submitted.title) && !/לא נשלחה/.test(submitted.title));
const uncertain = describeAuthorityDocumentState(state(sub("SUBMITTED", { errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT" })));
ok("SUBMITTED + uncertain marker → 'not known', blocked, will not be resent", !uncertain.deliverable && /אינה ידועה/.test(uncertain.title) && /לא תישלח שוב/.test(uncertain.detail));
const failedNotSent = describeAuthorityDocumentState(state(sub("FAILED", { errorCode: "AUTHORITY_NOT_SENT_NETWORK" })));
ok("FAILED not-sent → 'not sent', blocked", !failedNotSent.deliverable && /לא נשלחה/.test(failedNotSent.title));
const held = describeAuthorityDocumentState(state(sub("HELD")));
ok("HELD without a decision → decision needed, blocked", !held.deliverable && /נדרשת החלטה/.test(held.title));
const heldContinue = describeAuthorityDocumentState(state(sub("HELD", { heldDecisionType: "PROCEED_WITHOUT_ALLOCATION" as never, heldDecisionReportedAt: new Date() })));
ok("HELD + reported Continue → deliverable without a number", heldContinue.deliverable && heldContinue.show);
const rejected = describeAuthorityDocumentState(state(sub("REJECTED")));
ok("REJECTED → blocked", !rejected.deliverable && /נדחתה/.test(rejected.title));
const notRequired = describeAuthorityDocumentState(state(sub("NOT_REQUIRED")));
ok("NOT_REQUIRED → nothing shown, deliverable", !notRequired.show && notRequired.deliverable);
const receipt = describeAuthorityDocumentState(state(null, null, BillingDocumentType.RECEIPT));
ok("a receipt (no submission, not eligible) → nothing shown, deliverable", !receipt.show && receipt.deliverable);
const missing = describeAuthorityDocumentState(state(null));
ok("an eligible invoice with no submission → blocked (fail closed)", missing.show && !missing.deliverable);

// --- never "try again"
const all = [ready, approved, approvedNoNumber, submitted, uncertain, failedNotSent, held, heldContinue, rejected, missing];
ok("no document-state wording offers to try again", all.every((d) => !/נסו שוב|לנסות שוב/.test(`${d.title} ${d.detail}`)));
const issueOutcomes = ["not_required", "approved", "in_progress", "decision_required", "decision_already_reported", "validation_failed", "infrastructure_failed", "ambiguous", "execution_error"] as const;
for (const status of issueOutcomes) {
  const view = describeAuthorityIssueOutcome({ status, allocationNumber: "2026111012345678", submissionId: 1, errorCode: "X", safeToRetry: false } as never);
  ok(`issue-time '${status}' does not offer to try again`, !/נסו שוב|לנסות שוב/.test(`${view.title} ${view.detail}`), view.detail);
}
const infra = describeAuthorityIssueOutcome({ status: "infrastructure_failed", submissionId: 1, errorCode: "X", safeToRetry: false } as never);
ok("issue-time infrastructure_failed says the request was not sent", /לא נשלחה/.test(infra.title) && /לא נשלחה/.test(infra.detail));

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
