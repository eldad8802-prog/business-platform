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
 *   3. (N10) Sending is open, but is THIS document authorized? — the SAME
 *      Approval document list the execution service consults before any send
 *      (resolveAuthorityProductionApprovalDocumentRefusal). In the PRODUCTION
 *      pilot only a document listed in advance may be sent; any other READY
 *      document of the business is refused here, before numbering, and stays a
 *      draft — instead of becoming an issued invoice that is never sent.
 *      Reached only when step 2 admitted the send, so today's "oauth" (sending
 *      closed) answers exactly as before.
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
  resolveAuthorityProductionApprovalDocumentRefusal,
  resolveAuthorityProductionOperationRefusal,
  type AuthorityProductionPilotRefusalCode,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";

/** Stable code for the API and the screen. */
export const AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE =
  "AUTHORITY_ALLOCATION_SENDING_CLOSED" as const;

export const AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE =
  "לא ניתן להפיק את החשבונית כעת: היא חייבת מספר הקצאה מרשות המסים, ושליחת בקשות הקצאה עדיין אינה פתוחה לעסק. החשבונית נשארה טיוטה ולא קיבלה מספר.";

/** N10: stable code when sending is open but this document is not on the pilot's Approval list. */
export const AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_CODE =
  "AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED" as const;

export const AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_MESSAGE =
  "לא ניתן להפיק את החשבונית כעת: היא חייבת מספר הקצאה מרשות המסים, והיא אינה המסמך שאושר מראש לשליחה בפיילוט. החשבונית נשארה טיוטה ולא קיבלה מספר.";

export type IssueAllocationGateInput = AuthorityReadinessInput & {
  businessId: number;
  /** The draft being issued (a draft keeps its id when issued). */
  billingDocumentId: number;
};

export type IssueAllocationGateBlockReason = "SENDING_CLOSED" | "DOCUMENT_NOT_AUTHORIZED";

export type IssueAllocationGateResult =
  | { blocked: false }
  | {
      blocked: true;
      reason: IssueAllocationGateBlockReason;
      refusalCode: AuthorityProductionPilotRefusalCode;
      /** The API code and the Hebrew explanation the caller refuses with. */
      code: typeof AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE | typeof AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_CODE;
      message: string;
    };

export type IssueAllocationGateDeps = {
  resolveEnvironment: () => BillingAuthorityEnvironment;
  resolveRefusal: (
    businessId: number,
    environment: BillingAuthorityEnvironment
  ) => AuthorityProductionPilotRefusalCode | null;
  resolveDocumentRefusal: (
    businessId: number,
    billingDocumentId: number,
    environment: BillingAuthorityEnvironment
  ) => AuthorityProductionPilotRefusalCode | null;
};

export const defaultIssueAllocationGateDeps: IssueAllocationGateDeps = {
  resolveEnvironment: () => resolveRuntimeAuthorityEnvironment(),
  resolveRefusal: (businessId, environment) =>
    resolveAuthorityProductionOperationRefusal(businessId, environment, "approval"),
  resolveDocumentRefusal: (businessId, billingDocumentId, environment) =>
    resolveAuthorityProductionApprovalDocumentRefusal(businessId, billingDocumentId, environment),
};

export function resolveIssueAllocationGate(
  input: IssueAllocationGateInput,
  deps: IssueAllocationGateDeps = defaultIssueAllocationGateDeps
): IssueAllocationGateResult {
  const { businessId, billingDocumentId, ...readiness } = input;
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
  if (refusalCode !== null) {
    return {
      blocked: true,
      reason: "SENDING_CLOSED",
      refusalCode,
      code: AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE,
      message: AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE,
    };
  }

  // N10 — sending is open for this business; only a listed document may be sent.
  const documentRefusal = deps.resolveDocumentRefusal(businessId, billingDocumentId, environment);
  if (documentRefusal !== null) {
    return {
      blocked: true,
      reason: "DOCUMENT_NOT_AUTHORIZED",
      refusalCode: documentRefusal,
      code: AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_CODE,
      message: AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_MESSAGE,
    };
  }
  return { blocked: false };
}
