/**
 * Issue-time allocation gate: an invoice that will need an ITA allocation number
 * is not issued while sending that request is known to be closed.
 *
 * WHY
 *
 * Before this gate, such an invoice was issued anyway: it took its number, its
 * submission stayed READY because the Production pilot gate refused the Approval
 * before anything was sent, and the delivery rules then refused its PDF for good
 * (READY is never deliverable). Nothing could move it forward. The owner saw
 * "אפשר לנסות שוב" for a request that had never been made.
 *
 * WHAT IT DECIDES
 *
 *   1. Would this document be READY at issue? — the SAME rule the submission is
 *      created with (evaluateAuthorityReadinessAtIssue): type, VAT, ILS
 *      threshold by date, licensed-dealer customer. No second copy of the rule.
 *   2. Is sending the Approval known to be refused right now? — the SAME pilot
 *      gate the execution service consults before any send
 *      (resolveAuthorityProductionOperationRefusal, operation "approval").
 *
 * Both true → blocked. The caller refuses before the number sequence is touched,
 * so the draft stays a draft with no number.
 *
 * WHAT IT DOES NOT DECIDE
 *
 *   - A failure or an uncertain outcome AFTER a send: that is the execution
 *     service's job and is unchanged.
 *   - An unresolvable runtime environment (no BILLING_AUTHORITY_RUNTIME_ENVIRONMENT):
 *     left exactly as before — not blocked here. It is a deployment fault, not a
 *     known-closed gate, and changing it is outside this change's approval.
 *   - Documents already issued: untouched.
 *
 * Pure apart from reading the environment through its injectable deps.
 */
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
} from "@prisma/client";
import {
  evaluateAuthorityReadinessAtIssue,
  type AuthorityReadinessInput,
} from "@/lib/services/billing/authority/billing-authority-readiness";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  resolveAuthorityProductionOperationRefusal,
  type AuthorityProductionPilotRefusalCode,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";

/** Stable code for the API and the screen. */
export const AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE =
  "AUTHORITY_ALLOCATION_SENDING_CLOSED" as const;

export const AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE =
  "לא ניתן להפיק את החשבונית כעת: היא חייבת מספר הקצאה מרשות המסים, ושליחת בקשות הקצאה עדיין אינה פתוחה לעסק. החשבונית נשארה טיוטה ולא קיבלה מספר.";

export type IssueAllocationGateInput = AuthorityReadinessInput & {
  businessId: number;
};

export type IssueAllocationGateResult =
  | { blocked: false }
  | { blocked: true; refusalCode: AuthorityProductionPilotRefusalCode };

export type IssueAllocationGateDeps = {
  resolveEnvironment: () => BillingAuthorityEnvironment;
  resolveRefusal: (
    businessId: number,
    environment: BillingAuthorityEnvironment
  ) => AuthorityProductionPilotRefusalCode | null;
};

export const defaultIssueAllocationGateDeps: IssueAllocationGateDeps = {
  resolveEnvironment: () => resolveRuntimeAuthorityEnvironment(),
  resolveRefusal: (businessId, environment) =>
    resolveAuthorityProductionOperationRefusal(businessId, environment, "approval"),
};

export function resolveIssueAllocationGate(
  input: IssueAllocationGateInput,
  deps: IssueAllocationGateDeps = defaultIssueAllocationGateDeps
): IssueAllocationGateResult {
  const { businessId, ...readiness } = input;
  if (evaluateAuthorityReadinessAtIssue(readiness) !== BillingAuthoritySubmissionStatus.READY) {
    return { blocked: false };
  }

  let environment: BillingAuthorityEnvironment;
  try {
    environment = deps.resolveEnvironment();
  } catch {
    // Unchanged behaviour for an unconfigured deployment (see header).
    return { blocked: false };
  }

  const refusalCode = deps.resolveRefusal(businessId, environment);
  return refusalCode === null ? { blocked: false } : { blocked: true, refusalCode };
}
