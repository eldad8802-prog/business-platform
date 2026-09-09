/**
 * Persistent login — the orchestrator. SERVER-ONLY.
 *
 * Issues a refresh session at login, and exchanges a refresh credential for a
 * short access token. It owns ORDER and SIDE EFFECTS; every rule it applies
 * comes from `decideRefresh`, which is DB-free and separately tested.
 *
 * WHAT THIS DOES NOT DO, deliberately:
 *   - it never raises, weakens or bypasses the 24h access-token ceiling. A
 *     refresh mints exactly the token `signAuthToken` already mints, at the
 *     user's CURRENT generation;
 *   - it never writes a password, a permanent token, or the secret anywhere but
 *     the Set-Cookie header;
 *   - it never logs the secret, the digest, or the selector.
 */
import { signAuthToken } from "@/lib/auth";
import { acceptsNormalWrites } from "@/lib/tenant/business-lifecycle";
import {
  GRACE_WINDOW_MS,
  IDLE_TTL_MS,
  buildRefreshCookieValue,
  cookieMaxAgeSeconds,
  decideRefresh,
  mintSecret,
  newSessionWindow,
  parseRefreshCookie,
  sha256Hex,
  type RefuseReason,
} from "@/lib/auth/refresh-session";
import {
  createSession,
  deleteSession,
  evictHistoryOverCap,
  loadRotatedSecret,
  loadSessionBySelector,
  loadUserForRefresh,
  revokeSession,
  rotateSession,
  sweepExpiredSessions,
} from "@/lib/auth/refresh-session.store";

export type IssuedSession = {
  /** The full cookie value, `<selector>.<secret>`. Goes ONLY into Set-Cookie. */
  cookieValue: string;
  maxAgeSeconds: number;
};

/**
 * Mint a refresh session for a user who has just proven their password.
 *
 * Best-effort by contract: a login that authenticated correctly must not fail
 * because the persistence layer did. The caller treats `null` as "no cookie this
 * time", which degrades to today's behaviour — a 24h bearer token and nothing
 * else — rather than to an error.
 */
export async function issueRefreshSession(
  userId: number,
  tokenVersion: number,
  now: Date = new Date()
): Promise<IssuedSession | null> {
  try {
    const { secret, secretHash } = mintSecret();
    const window = newSessionWindow(now);
    const session = await createSession({
      userId,
      secretHash,
      tokenVersionAtIssue: tokenVersion,
      ...window,
    });
    return {
      cookieValue: buildRefreshCookieValue(session.id, secret),
      maxAgeSeconds: cookieMaxAgeSeconds(now, session.absoluteExpiresAt),
    };
  } catch (error) {
    console.error(
      "REFRESH_SESSION_ISSUE_FAILED:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return null;
  }
}

export type RefreshOutcome =
  | {
      ok: true;
      token: string;
      user: { id: number; email: string; businessId: number };
      cookieValue: string;
      maxAgeSeconds: number;
    }
  | { ok: false; reason: RefuseReason | "refresh_chain_divergence" | "rotation_lost_race" };

/**
 * Exchange a refresh credential for an access token, rotating the credential.
 *
 * Every failure returns the SAME shape and the caller returns the same 401 body
 * for all of them: the reason is for the server log, never for the client. A
 * caller who can distinguish "unknown secret" from "session revoked" learns
 * whether a selector it guessed exists.
 */
export async function refreshAccessToken(
  rawCookie: string | null,
  now: Date = new Date()
): Promise<RefreshOutcome> {
  const parsed = parseRefreshCookie(rawCookie);
  if (!parsed) return { ok: false, reason: "malformed_cookie" };

  const session = await loadSessionBySelector(parsed.sessionId);
  if (!session) return { ok: false, reason: "session_not_found" };

  const user = await loadUserForRefresh(session.userId);
  // A session whose user has gone is not refusable-with-evidence; it is simply
  // not a session. The FK cascade means this is close to unreachable.
  if (!user) return { ok: false, reason: "session_not_found" };

  const presentedSecretHash = sha256Hex(parsed.secret);
  // Only consulted when the presented digest is not the current one; loading it
  // unconditionally keeps the timing of "current" and "rotated" indistinguishable.
  const rotated = await loadRotatedSecret(parsed.sessionId, presentedSecretHash);

  const decision = decideRefresh({
    session,
    presentedSecretHash,
    rotated,
    currentTokenVersion: user.tokenVersion,
    // A business under account-deletion quarantine accepts no normal use. Without
    // this the refresh path would mint NEW access tokens for an account being
    // erased — the one way the quarantine could be walked around.
    accountAcceptsUse: user.business ? acceptsNormalWrites(user.business) : false,
    now,
  });

  if (decision.kind === "revoke") {
    await revokeSession(parsed.sessionId, decision.reason, now);
    // Wording is mandated: divergence, never "confirmed theft".
    console.warn("REFRESH_CHAIN_DIVERGENCE: session revoked");
    return { ok: false, reason: decision.reason };
  }

  if (decision.kind === "refuse") {
    return { ok: false, reason: decision.reason };
  }

  const next = mintSecret();
  const { rotated: won } = await rotateSession({
    sessionId: parsed.sessionId,
    // The digest the session currently holds — NOT the presented one, which in
    // the within-grace case is already an outgoing secret.
    outgoingSecretHash: session.secretHash,
    newSecretHash: next.secretHash,
    now,
    graceUntil: new Date(now.getTime() + GRACE_WINDOW_MS),
    idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS),
  });

  if (!won) {
    // A concurrent refresh moved the session first. Refusing here is correct and
    // costs the client nothing: it still holds a secret that is now in history
    // and inside its grace window, so its retry succeeds.
    return { ok: false, reason: "rotation_lost_race" };
  }

  // Housekeeping only. Neither may fail the request that authenticated.
  await evictHistoryOverCap(parsed.sessionId).catch(() => 0);
  await sweepExpiredSessions(user.id, now).catch(() => 0);

  return {
    ok: true,
    token: signAuthToken(user.id, user.tokenVersion),
    user: { id: user.id, email: user.email, businessId: user.businessId },
    cookieValue: buildRefreshCookieValue(parsed.sessionId, next.secret),
    maxAgeSeconds: cookieMaxAgeSeconds(now, session.absoluteExpiresAt),
  };
}

/**
 * Drop the session a logout was performed from.
 *
 * Global logout already happens through `User.tokenVersion`, which invalidates
 * every session of every device by making `tokenVersionAtIssue` stale. This
 * removes the row as well, so the browser is not left presenting a credential
 * that will only ever be refused. Best-effort: a logout that could not tidy up
 * has still signed the user out.
 */
export async function endRefreshSession(rawCookie: string | null): Promise<void> {
  const parsed = parseRefreshCookie(rawCookie);
  if (!parsed) return;
  await deleteSession(parsed.sessionId).catch((error: unknown) => {
    console.error(
      "REFRESH_SESSION_END_FAILED:",
      error instanceof Error ? error.name : "UnknownError"
    );
  });
}
