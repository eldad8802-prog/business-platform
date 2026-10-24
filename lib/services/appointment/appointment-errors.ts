/**
 * Appointments (milestone A) — the closed set of refusals the owner API can answer with. Each code has one HTTP
 * status; a route never invents another. Anything not listed is a 500 with no detail.
 */
export type AppointmentErrorCode =
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_STALE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "SLOT_CONFLICT"
  | "STAFF_NOT_FOUND"
  | "STAFF_NOT_ASSIGNED"
  | "SERVICE_NOT_FOUND"
  | "CUSTOMER_NOT_FOUND"
  | "LEAD_NOT_FOUND"
  | "CONFLICT";

const STATUS: Record<AppointmentErrorCode, number> = {
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_STALE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_CONFLICT: 409,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  INVALID_TRANSITION: 409,
  SLOT_CONFLICT: 409,
  STAFF_NOT_FOUND: 404,
  STAFF_NOT_ASSIGNED: 409,
  SERVICE_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  LEAD_NOT_FOUND: 404,
  CONFLICT: 409,
};

export class AppointmentServiceError extends Error {
  readonly status: number;
  constructor(readonly code: AppointmentErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "AppointmentServiceError";
    this.status = STATUS[code];
  }
}

export const invalid = (field: string) => new AppointmentServiceError("INVALID_INPUT", { field });
