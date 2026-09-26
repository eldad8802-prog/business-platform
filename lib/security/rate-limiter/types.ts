/**
 * Shared rate limiter types.
 */

/**
 * `account` is a normalized-email key (hashed before it reaches the backend) and
 * `account_ip` is the pair. They exist for the authentication buckets, which
 * must throttle an ACCOUNT under attack from many addresses as well as one
 * address attacking many accounts — before any user row has been read, so the
 * key cannot be a user id.
 */
export type RateLimitScope = "user" | "business" | "ip" | "account" | "account_ip" | "global";

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
  | "CRM_ATTACHMENT_UPLOAD"
  | "DATA_TRANSFER_IMPORT_EXECUTE"
  | "DATA_TRANSFER_DOCUMENTS_IMPORT"
  | "AUTH_LOGIN_IP"
  | "AUTH_LOGIN_ACCOUNT"
  | "AUTH_PASSWORD_CHANGE"
  | "AUTH_STEP_UP"
  | "AUTH_PASSWORD_RESET_REQUEST"
  | "AUTH_PASSWORD_RESET_CONFIRM"
  | "ADMIN_MFA_ENROLL";

export type BucketConfig = {
  failMode: FailMode;
  rules: WindowRule[];
  /**
   * When true, a rule whose identifier is missing DENIES instead of being
   * skipped. Authentication buckets set this: a throttle that silently drops
   * its per-account rule because a caller forgot to pass the account is a
   * throttle that does not exist.
   */
  requireAllIdentifiers?: boolean;
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
  | "backend_unavailable"
  /** A required identifier was missing on a bucket that demands them all. */
  | "misconfigured";

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
export interface RateLimitBackend {
  readonly name: "redis" | "memory";
  evaluate(
    prefix: string,
    identifier: string,
    limit: number,
    windowSeconds: number
  ): Promise<RuleResult>;
}
