/**
 * Typed Gmail integration errors.
 *
 * GmailReauthRequiredError marks the cases where the stored OAuth credential is
 * no longer usable and the ONLY recovery is the user reconnecting Gmail:
 * - no connected integration row,
 * - the stored token cannot be decrypted (encryption key missing/rotated),
 * - Google rejected the refresh token (revoked / invalid_grant).
 *
 * Routes catch this specifically and return a controlled "needs reconnect"
 * response (Hebrew) instead of a raw 500 "Server error". Transient failures
 * (network blips, 5xx from Google, missing client config) stay generic 500.
 */

export type GmailReauthReason =
  | "no_connection"
  | "token_undecryptable"
  | "refresh_rejected";

export class GmailReauthRequiredError extends Error {
  readonly reason: GmailReauthReason;
  constructor(reason: GmailReauthReason, message?: string) {
    super(message ?? `Gmail re-auth required: ${reason}`);
    this.name = "GmailReauthRequiredError";
    this.reason = reason;
  }
}
