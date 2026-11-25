/**
 * "שלח שוב" — resend an allocation (Approval) request that PROVABLY never reached
 * the Israel Tax Authority. Gap A of the 2026-11-24 readiness review.
 *
 * WHY
 *
 * When sending is open and an attempt fails before anything leaves Dubiz (no
 * connection yet, a token refresh that failed, the egress proxy refusing the
 * connection), the invoice is already issued and numbered, its submission is
 * READY or FAILED[AUTHORITY_NOT_SENT_*], and its PDF is blocked until a number
 * arrives. The execution service has always treated exactly these two states as
 * executable ("Only a provably NOT_SENT failure is persisted as FAILED
 * (re-executable)"), but nothing in the product could execute them again. This
 * is that single trigger — nothing more.
 *
 * REGULATORY FOOTING (what this relies on, and what it does not)
 *
 *   - A request that never reached the authority has not been answered, refused
 *     or recorded there; sending it is the FIRST transmission of that invoice,
 *     with the same invoice id and content. No ITA rule is needed for that.
 *   - The ITA OpenAPI description (Invoices v2) also instructs: "If an invoice
 *     receives a technical error code(s), the problem should be corrected and the
 *     invoice should be retransmitted again." This service does NOT rely on that
 *     sentence and does NOT resend anything the authority answered: a 400
 *     rejection is REJECTED, a 460/461 is HELD, every other answer or a timeout
 *     is SUBMITTED + uncertain — none of them is eligible here.
 *
 * WHEN IT IS ALLOWED (all must hold; otherwise refused BEFORE anything runs)
 *
 *   - the document is ISSUED and has a submission;
 *   - READY that was never reserved: no payload hash and no attempt time. READY
 *     is only ever entered at issue (INITIAL → READY, submission machine); the
 *     reserve moves it to SUBMITTED before any I/O, and nothing returns to READY.
 *   - or FAILED with an AUTHORITY_NOT_SENT_* code: written only by the execution
 *     service's persistNotSent, which runs only for a pre-send/configuration
 *     failure or an allowlisted connect-phase transport code (send-certainty).
 *
 * NEVER ALLOWED: SUBMITTED (in flight, stale or uncertain), PENDING, HELD,
 * REJECTED, APPROVED, NOT_REQUIRED, FAILED with any other code, an inconsistent
 * READY row.
 *
 * WHAT IT DOES NOT DO: create, change or renumber a document; change amounts,
 * customer or snapshot; resend automatically; bypass the production pilot gate,
 * the N10 document list, the operation switches, the re-entry gate, the
 * payload-hash determinism check or the compare-and-set reserve — it calls the
 * SAME executeAuthorityApproval the issue hook calls, which applies all of them.
 * Two concurrent resends: the reserve admits one caller, the other is
 * `in_progress`; nothing is sent twice.
 */
import { BillingAuthoritySubmissionStatus, BillingDocumentStatus } from "@prisma/client";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import {
  defaultSubmissionExecutionDeps,
  executeAuthorityApproval,
  type ExecutionResult,
  type LoadedDocumentSubmission,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";
import {
  mapExecutionResultToAuthorityOutcome,
  type AuthorityIssueOutcome,
} from "@/lib/services/billing/authority/billing-authority-issue-outcome";
import { isAuthorityNotSentErrorCode } from "@/lib/services/billing/authority/billing-authority-send-certainty";

export const AUTHORITY_RESEND_NOT_ELIGIBLE_CODE = "AUTHORITY_RESEND_NOT_ELIGIBLE" as const;

export type AuthorityResendBasis = "READY_NEVER_SENT" | "FAILED_NOT_SENT";

export type AuthorityResendRefusalReason =
  | "DOCUMENT_NOT_ISSUED"
  | "NO_SUBMISSION"
  | "IN_FLIGHT_OR_UNCERTAIN"
  | "HELD"
  | "REJECTED"
  | "APPROVED"
  | "NOT_REQUIRED"
  | "NOT_PROVABLY_UNSENT"
  | "INCONSISTENT_READY";

export type AuthorityResendEligibility =
  | { eligible: true; basis: AuthorityResendBasis }
  | { eligible: false; reason: AuthorityResendRefusalReason };

/** Hebrew explanation per refusal (no ids, no codes from the authority). */
export const AUTHORITY_RESEND_REFUSAL_MESSAGES: Record<AuthorityResendRefusalReason, string> = {
  DOCUMENT_NOT_ISSUED: "אפשר לשלוח בקשת הקצאה רק עבור חשבונית שהונפקה.",
  NO_SUBMISSION: "לחשבונית זו אין בקשת הקצאה.",
  IN_FLIGHT_OR_UNCERTAIN:
    "לא ניתן לשלוח שוב: ייתכן שהבקשה כבר הגיעה לרשות המסים, או שהיא עדיין בטיפול. בקשה כזו לעולם אינה נשלחת שוב.",
  HELD: "לא ניתן לשלוח שוב: רשות המסים השיבה לבקשה, ונדרשת החלטה.",
  REJECTED: "לא ניתן לשלוח שוב: רשות המסים דחתה את הבקשה.",
  APPROVED: "לא ניתן לשלוח שוב: כבר התקבל מספר הקצאה.",
  NOT_REQUIRED: "החשבונית אינה חייבת מספר הקצאה.",
  NOT_PROVABLY_UNSENT: "לא ניתן לשלוח שוב: לא ניתן להוכיח שהבקשה הקודמת לא הגיעה לרשות המסים.",
  INCONSISTENT_READY: "לא ניתן לשלוח שוב: מצב הבקשה אינו עקבי.",
};

/**
 * Pure eligibility rule. Reads only what the execution service's loader returns
 * (document status, submission status / error code / payload hash / attempt time).
 */
export function evaluateAuthorityResendEligibility(
  loaded: Pick<LoadedDocumentSubmission, "status" | "submission">
): AuthorityResendEligibility {
  if (loaded.status !== BillingDocumentStatus.ISSUED) return { eligible: false, reason: "DOCUMENT_NOT_ISSUED" };
  const sub = loaded.submission;
  if (!sub) return { eligible: false, reason: "NO_SUBMISSION" };
  switch (sub.status) {
    case BillingAuthoritySubmissionStatus.READY:
      // Never reserved ⇒ never sent. A READY row carrying a reserve's traces
      // cannot be explained by the state machine: refuse rather than guess.
      return sub.authorityPayloadHash === null && sub.lastAttemptAt === null
        ? { eligible: true, basis: "READY_NEVER_SENT" }
        : { eligible: false, reason: "INCONSISTENT_READY" };
    case BillingAuthoritySubmissionStatus.FAILED:
      return isAuthorityNotSentErrorCode(sub.errorCode)
        ? { eligible: true, basis: "FAILED_NOT_SENT" }
        : { eligible: false, reason: "NOT_PROVABLY_UNSENT" };
    case BillingAuthoritySubmissionStatus.SUBMITTED:
    case BillingAuthoritySubmissionStatus.PENDING:
      return { eligible: false, reason: "IN_FLIGHT_OR_UNCERTAIN" };
    case BillingAuthoritySubmissionStatus.HELD:
      return { eligible: false, reason: "HELD" };
    case BillingAuthoritySubmissionStatus.REJECTED:
      return { eligible: false, reason: "REJECTED" };
    case BillingAuthoritySubmissionStatus.APPROVED:
      return { eligible: false, reason: "APPROVED" };
    case BillingAuthoritySubmissionStatus.NOT_REQUIRED:
      return { eligible: false, reason: "NOT_REQUIRED" };
    default:
      return { eligible: false, reason: "NOT_PROVABLY_UNSENT" };
  }
}

export type ResendAuthorityApprovalInput = {
  businessId: number;
  billingDocumentId: number;
  actorUserId: number;
};

export type ResendAuthorityApprovalResult = {
  basis: AuthorityResendBasis;
  /** Same shape the issue route returns; read `status`, never assume success. */
  authority: AuthorityIssueOutcome;
};

export type ResendAuthorityDeps = {
  loadDocumentWithSubmission: (businessId: number, billingDocumentId: number) => Promise<LoadedDocumentSubmission | null>;
  executeApproval: (input: ResendAuthorityApprovalInput) => Promise<ExecutionResult>;
};

export const defaultResendAuthorityDeps: ResendAuthorityDeps = {
  loadDocumentWithSubmission: (businessId, billingDocumentId) =>
    defaultSubmissionExecutionDeps.loadDocumentWithSubmission(businessId, billingDocumentId),
  executeApproval: (input) => executeAuthorityApproval(input),
};

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * One user-triggered resend. Throws ConflictError(AUTHORITY_RESEND_NOT_ELIGIBLE)
 * when the stored state does not prove the previous request never left — before
 * anything is executed. Otherwise runs ONE execution (which re-checks every gate).
 */
export async function resendAuthorityApproval(
  input: ResendAuthorityApprovalInput,
  deps: ResendAuthorityDeps = defaultResendAuthorityDeps
): Promise<ResendAuthorityApprovalResult> {
  if (!isPositiveInt(input.businessId) || !isPositiveInt(input.actorUserId)) throw new UnauthorizedError();
  if (!isPositiveInt(input.billingDocumentId)) throw new ValidationError("billingDocumentId must be a positive integer");

  // Read under the caller's own tenant (billingTenantTx): another business's
  // document is simply not found.
  const loaded = await deps.loadDocumentWithSubmission(input.businessId, input.billingDocumentId);
  if (!loaded) throw new NotFoundError("Billing document not found");

  const eligibility = evaluateAuthorityResendEligibility(loaded);
  if (!eligibility.eligible) {
    throw new ConflictError(AUTHORITY_RESEND_NOT_ELIGIBLE_CODE, AUTHORITY_RESEND_REFUSAL_MESSAGES[eligibility.reason]);
  }

  const result = await deps.executeApproval({
    businessId: input.businessId,
    billingDocumentId: input.billingDocumentId,
    actorUserId: input.actorUserId,
  });
  return { basis: eligibility.basis, authority: mapExecutionResultToAuthorityOutcome(result) };
}
