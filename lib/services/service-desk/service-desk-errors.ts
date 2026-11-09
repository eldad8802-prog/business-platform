/**
 * Service Desk 1.3a — the errors of the service layer. A stable code and an HTTP status; details carry codes and field
 * names only, never free text, ids of another business or a database message.
 */
import type { ServiceCaseViolationCode } from "./contracts";

export type ServiceDeskErrorCode =
  | "NOT_FOUND"
  | "READ_ONLY"
  | "INVALID_INPUT"
  | "VERSION_CONFLICT"
  | "STALE_STATE"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_STALE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CONFLICT"
  | "REFUSED"
  | "ACTION_NOT_IN_SCOPE"
  | "SERVER_CHECK_FAILED"
  | "BUSINESS_DELETING"
  /** A write that would leave no audit event (technician, intake data, settings) — closed until the P4 journal exists. */
  | "NOT_AVAILABLE_UNTIL_AUDIT";

const STATUS: Record<ServiceDeskErrorCode, number> = {
  NOT_FOUND: 404,
  READ_ONLY: 403,
  INVALID_INPUT: 400,
  VERSION_CONFLICT: 409,
  STALE_STATE: 409,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_STALE: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONFLICT: 409,
  REFUSED: 422,
  ACTION_NOT_IN_SCOPE: 422,
  SERVER_CHECK_FAILED: 422,
  BUSINESS_DELETING: 409,
  NOT_AVAILABLE_UNTIL_AUDIT: 422,
};

export type ServiceDeskErrorDetails = Record<string, string | number | boolean | null | readonly string[]>;

export class ServiceDeskError extends Error {
  readonly status: number;
  constructor(readonly code: ServiceDeskErrorCode, readonly details: ServiceDeskErrorDetails = {}) {
    super(code);
    this.name = "ServiceDeskError";
    this.status = STATUS[code];
  }
}

/** A core refusal: its violation codes (never their detail text, which may name values). */
export function refused(violations: readonly { code: ServiceCaseViolationCode }[]): ServiceDeskError {
  const codes = [...new Set(violations.map((v) => v.code))];
  if (codes.length === 1 && codes[0] === "VERSION_CONFLICT") return new ServiceDeskError("VERSION_CONFLICT");
  return new ServiceDeskError("REFUSED", { violations: codes });
}
