import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who may trigger settlement recovery: only a scheduler holding CRON_SECRET.
 *
 * FAIL CLOSED. No secret configured → nobody is authorised (the route answers
 * 503, never "open"). A secret shorter than 32 characters is treated as not
 * configured, so a placeholder can never become the credential.
 *
 * Constant-time: both sides are hashed first, so the comparison cost does not
 * depend on how much of a guess was right or on the header's length.
 */
export const MIN_RECOVERY_SECRET_LENGTH = 32;

export type RecoveryAuthDecision = "AUTHORIZED" | "UNAUTHORIZED" | "NOT_CONFIGURED";

export function decideRecoveryAuth(
  authorizationHeader: string | null | undefined,
  configuredSecret: string | null | undefined
): RecoveryAuthDecision {
  const secret = (configuredSecret ?? "").trim();
  if (secret.length < MIN_RECOVERY_SECRET_LENGTH) {
    return "NOT_CONFIGURED";
  }
  const header = (authorizationHeader ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return "UNAUTHORIZED";
  }
  const a = createHash("sha256").update(match[1].trim()).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b) ? "AUTHORIZED" : "UNAUTHORIZED";
}
