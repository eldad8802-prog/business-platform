/**
 * sec/INT — account-deletion security events (workstream F's recordSecurityEvent, wired
 * into workstream E's erasure).
 *
 * WHY businessId IS NULL ON THE ROW. A business-attributed SecurityEvent is written through
 * `tenantTx`, and SEC-E makes every tenant transaction refuse a quarantined business
 * (BusinessQuarantinedError) and refuse nesting (TenantTransactionNestingError). Every
 * deletion event after the quarantine would therefore be dropped by the write path, and a
 * telemetry call made from inside an erasure transaction would be refused as nesting. So
 * these events are written UNTENANTED — the shape the SecurityEvent insert policy admits
 * without a tenant GUC — and name the subject business in `metadata.subjectBusinessId`
 * (an id, readable only by app_admin, like the rest of the table). No tenant capability is
 * widened: the erasure authority is NOT used for telemetry.
 *
 * NEVER BLOCKS THE ERASURE. recordSecurityEvent never throws by contract; this wrapper
 * catches anyway, so a broken telemetry path can never fail, delay into a retry, or reorder
 * a stage. Payloads carry ids, stage names and closed codes only — never an email, a name,
 * a token or an error message.
 */
import { recordSecurityEvent, type SecurityEventOutcome } from "@/lib/security/security-events";

export type ErasureEventKind =
  | "requested"
  | "step_up_ok"
  | "step_up_refused"
  | "quarantine_entered"
  | "erasure_started"
  | "erasure_resumed"
  | "attempt_failed"
  | "provider_cleanup"
  | "verified"
  | "completed";

const TYPE_OF: Record<ErasureEventKind, "ACCOUNT_DELETION_REQUESTED" | "ACCOUNT_DELETION_STAGE" | "ACCOUNT_DELETION_COMPLETED"> = {
  requested: "ACCOUNT_DELETION_REQUESTED",
  step_up_ok: "ACCOUNT_DELETION_STAGE",
  step_up_refused: "ACCOUNT_DELETION_STAGE",
  quarantine_entered: "ACCOUNT_DELETION_STAGE",
  erasure_started: "ACCOUNT_DELETION_STAGE",
  erasure_resumed: "ACCOUNT_DELETION_STAGE",
  attempt_failed: "ACCOUNT_DELETION_STAGE",
  provider_cleanup: "ACCOUNT_DELETION_STAGE",
  verified: "ACCOUNT_DELETION_STAGE",
  completed: "ACCOUNT_DELETION_COMPLETED",
};

const OUTCOME_OF: Record<ErasureEventKind, SecurityEventOutcome> = {
  requested: "INFO",
  step_up_ok: "SUCCESS",
  step_up_refused: "DENIED",
  quarantine_entered: "INFO",
  erasure_started: "INFO",
  erasure_resumed: "INFO",
  attempt_failed: "FAILURE",
  provider_cleanup: "INFO",
  verified: "SUCCESS",
  completed: "SUCCESS",
};

/** Closed-code metadata only: numbers, and strings the F sanitizer accepts (no free text). */
export type ErasureEventDetail = Record<string, number | string | boolean | null>;

export async function emitErasureEvent(
  kind: ErasureEventKind,
  subject: { businessId: number; userId?: number | null; req?: Request | null },
  detail: ErasureEventDetail = {}
): Promise<void> {
  try {
    await recordSecurityEvent({
      type: TYPE_OF[kind],
      outcome: OUTCOME_OF[kind],
      reason: kind,
      businessId: null,
      userId: subject.userId ?? null,
      actor: subject.userId ? "USER" : "SYSTEM",
      req: subject.req ?? null,
      metadata: { subjectBusinessId: subject.businessId, ...detail },
    });
  } catch {
    // recordSecurityEvent never throws; this is the second belt. Telemetry never blocks.
  }
}
