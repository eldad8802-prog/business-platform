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
  | "CONFLICT"
  | "SLOT_UNAVAILABLE"
  | "REQUEST_LIMIT"
  | "REQUEST_EXPIRED"
  | "SELF_CANCEL_CLOSED"
  | "BOOKING_CLOSED"
  | "BOOKING_NOT_READY"
  | "SELF_RESCHEDULE_CLOSED"
  | "PHONE_NOT_VERIFIED"
  | "OTP_INVALID"
  | "OTP_COOLDOWN"
  | "OTP_LIMIT"
  | "OTP_UNAVAILABLE";

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
  // Public booking (Milestone C): the time is no longer free / the phone has its open requests / the request lapsed /
  // the business's self-cancel window has closed.
  SLOT_UNAVAILABLE: 409,
  REQUEST_LIMIT: 429,
  REQUEST_EXPIRED: 409,
  SELF_CANCEL_CLOSED: 409,
  // The platform has not opened public booking for the business: its link cannot be turned on or replaced yet.
  BOOKING_CLOSED: 409,
  // G3: the link cannot be turned on before the business is ready (eligible, hours, services, a WhatsApp path that can
  // deliver the mandatory verification code). details.missing names what is missing.
  BOOKING_NOT_READY: 409,
  // G15: the business does not let customers move their appointment through the link, or its window has closed.
  SELF_RESCHEDULE_CLOSED: 409,
  // G2 (owner requirement 8): a public request without a verified, unused phone verification is refused.
  PHONE_NOT_VERIFIED: 403,
  // G2: the code is wrong, expired, used, replaced or out of attempts — ONE answer for all of them (no oracle).
  OTP_INVALID: 422,
  // G2: a new code for this phone is not sent yet (details.retryAfterSeconds); the previous one still works.
  OTP_COOLDOWN: 429,
  // G2: a send cap was reached (per phone / IP / business — not said which).
  OTP_LIMIT: 429,
  // G2: no WhatsApp path can deliver a code now (the link answers as unavailable).
  OTP_UNAVAILABLE: 503,
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
