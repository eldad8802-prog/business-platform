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

/**
 * The scheduler credential for the CRON endpoints ONLY — settlement recovery,
 * payment reconciliation and the intake sweep. Never used by any other route;
 * the knowledge-derive route has its own, dedicated authority.
 *
 * ZERO-GAP ROTATION. `CRON_SECRET_NEXT` is an optional transitional value that
 * is accepted IN ADDITION to `CRON_SECRET`, so the new value can reach every
 * caller before the old one stops working. It never stands alone:
 *
 *   - CRON_SECRET missing/short → NOT_CONFIGURED, whatever NEXT holds
 *     (unchanged fail-closed behaviour; NEXT cannot become the only credential).
 *   - NEXT unset/blank → exactly decideRecoveryAuth(header, CRON_SECRET).
 *   - NEXT shorter than the minimum, or equal to KNOWLEDGE_DERIVE_SECRET →
 *     IGNORED (never accepted), and the current secret keeps working: a botched
 *     NEXT can neither weaken authentication nor lock out existing callers, and
 *     the derive credential can never open a cron endpoint. Reported once per
 *     process as a code, never a value.
 *
 * Constant-time over both candidates: the header is hashed once and compared
 * to two digests without short-circuiting (the current digest twice when NEXT
 * is not in use).
 */
export type CronAuthEnv = Readonly<Record<string, string | undefined>>;

let reportedNextProblem: string | null = null;

export function decideCronAuth(
  authorizationHeader: string | null | undefined,
  env: CronAuthEnv = process.env
): RecoveryAuthDecision {
  const current = (env.CRON_SECRET ?? "").trim();
  if (current.length < MIN_RECOVERY_SECRET_LENGTH) {
    return "NOT_CONFIGURED";
  }
  const next = usableNextCronSecret(env);
  const header = (authorizationHeader ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return "UNAUTHORIZED";
  }
  const presented = createHash("sha256").update(match[1].trim()).digest();
  const matchesCurrent = timingSafeEqual(presented, createHash("sha256").update(current).digest());
  const matchesNext = timingSafeEqual(presented, createHash("sha256").update(next ?? current).digest());
  return matchesCurrent || matchesNext ? "AUTHORIZED" : "UNAUTHORIZED";
}

/** The NEXT value if it may be accepted; null when unset or ignored (see above). */
function usableNextCronSecret(env: CronAuthEnv): string | null {
  const next = (env.CRON_SECRET_NEXT ?? "").trim();
  if (next.length === 0) return null;
  let problem: string | null = null;
  if (next.length < MIN_RECOVERY_SECRET_LENGTH) problem = "too_short";
  else if (next === (env.KNOWLEDGE_DERIVE_SECRET ?? "").trim()) problem = "equals_derive_secret";
  if (problem) {
    if (reportedNextProblem !== problem) {
      reportedNextProblem = problem;
      console.warn("[cron-auth] CRON_SECRET_NEXT ignored", { reason: problem });
    }
    return null;
  }
  return next;
}
