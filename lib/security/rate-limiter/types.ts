/**
 * Shared rate limiter types.
 */

export type RateLimitScope = "user" | "business" | "ip" | "global";

/** A single window rule inside a bucket (e.g. "120 / minute per business"). */
export type WindowRule = {
  scope: RateLimitScope;
  limit: number;
  windowSeconds: number;
};

/**
 * Fail mode applied ONLY when the backend itself is unavailable (transient
 * network / timeout). It does NOT affect normal over-limit decisions.
 * - "closed": deny the request (controlled 503). Used for writes (upload/processing).
 * - "open": allow the request but mark it degraded + log. Used for reads.
 */
export type FailMode = "closed" | "open";

export type BucketName =
  | "UPLOAD_ACCEPT"
  | "DOCUMENT_PROCESSING"
  | "DOCUMENTS_API"
  | "WHATSAPP_INTAKE"
  | "ACQUISITION_INTAKE"
  | "ACQUISITION_WEB_PUBLIC"
  | "CRM_ATTACHMENT_UPLOAD"
  | "DATA_TRANSFER_IMPORT_EXECUTE"
  | "DATA_TRANSFER_DOCUMENTS_IMPORT"
  | "LANDING_COMPOSE"
  | "ACCOUNTANT_LINK_PUBLIC"
  | "ACCOUNTANT_LINK_FILE"
  | "ACCOUNTANT_SEND";

export type BucketConfig = {
  failMode: FailMode;
  rules: WindowRule[];
};

/** Result of evaluating ONE window rule against the backend. */
export type RuleResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** epoch ms when the current window resets */
  resetAt: number;
};

export type RateLimitOutcome =
  | "allowed"
  | "rate_limited"
  | "backend_unavailable";

export type RateLimitDecision = {
  allowed: boolean;
  outcome: RateLimitOutcome;
  bucket: BucketName;
  /** which scope tripped the limit (only set on rate_limited) */
  scope: RateLimitScope | null;
  limit: number;
  remaining: number;
  /** epoch ms */
  resetAt: number;
  retryAfterSeconds: number;
  /** true when the backend was unavailable and a fail mode was applied */
  degraded: boolean;
};

/** A backend evaluates a single rule and consumes one token. */
/** reserveAttempt's answer. `count` includes this attempt; `locked` = an explicit lock is set. */
export type AttemptReservation =
  | { allowed: true; count: number }
  | { allowed: false; locked: boolean; retryAfterMs: number };

export interface RateLimitBackend {
  readonly name: "redis" | "memory";
  evaluate(
    prefix: string,
    identifier: string,
    limit: number,
    windowSeconds: number
  ): Promise<RuleResult>;
  /**
   * Attempt ledger — an EXACT rolling window of attempts for one identifier, plus a lock.
   * `reserveAttempt` is atomic: it refuses while a lock is set or while `limit` attempts already
   * sit in the window (reservations included, so a parallel burst cannot exceed it), and otherwise
   * records this attempt. The caller then `clearAttempts` (the attempt proved legitimate — e.g. a
   * successful login — so the window is emptied) or `lockAttempts` (sets the lock for lockMs and
   * clears the window).
   */
  reserveAttempt(
    prefix: string,
    identifier: string,
    member: string,
    limit: number,
    windowMs: number,
    nowMs: number
  ): Promise<AttemptReservation>;
  clearAttempts(prefix: string, identifier: string): Promise<void>;
  lockAttempts(prefix: string, identifier: string, lockMs: number, nowMs: number): Promise<void>;
}
