/**
 * Persistent login — the refresh-session decision layer.
 *
 * SERVER-ONLY. Deliberately DB-free: every rule below is decided from values
 * handed in, so the whole classification can be exercised without a database and
 * the store stays a thin adapter. The frozen parameters and every rule here come
 * from the ratified design; none of them is a choice made at implementation time.
 *
 * WHAT THE CREDENTIAL IS
 *
 *   cookie = "<sessionId>.<secret>"
 *
 *   sessionId  the row's UUID. A SELECTOR. It authenticates NOTHING; its whole
 *              job is to find the row after the secret has rotated away.
 *   secret     256 bits of CSPRNG, stored only as its SHA-256 hex digest.
 *
 * A two-hash scheme (current + previous) is provably broken: with three
 * concurrent refreshes carrying the original secret, the third matches neither
 * hash — and after two rotations the original digest is stored nowhere, so "a
 * credential we issued" and "a random string" stop being distinguishable. The
 * selector is what makes both concurrency and classification possible at all.
 *
 * THE THREE OUTCOMES, and why the middle one exists
 *
 *   ROTATE   the presented secret is current, or is a rotated secret still
 *            inside its grace window. Issue a new secret, record the outgoing
 *            one, advance idle expiry.
 *   REFUSE   401 and NOTHING ELSE. This is the answer for an unknown secret,
 *            and it is a security property rather than laziness: revoking on
 *            "no match" would turn the selector — a value that authenticates
 *            nothing — into a session-kill primitive available to anyone who
 *            learned it. Absence of evidence is never evidence.
 *   REVOKE   401 AND kill the session. Requires POSITIVE evidence: the presented
 *            hash is still stored for this exact session, its grace has passed,
 *            AND the session has been used since that grace ended.
 *
 * THE LAST CONDITION IS THE WHOLE DIFFERENCE between theft and a dropped
 * response. Without it, an ordinary lost `Set-Cookie` looks identical to reuse:
 * the client still holds the old secret, comes back later, and gets its session
 * killed with no attacker involved. `lastUsedAt > graceUntil` proves somebody
 * refreshed successfully after every legitimate in-flight request had already
 * expired, and one session row is reachable from exactly one cookie jar.
 *
 * WORDING IS MANDATED. This is `refresh_chain_divergence`. It is NOT "confirmed
 * credential theft" and must never be described that way: divergence is what the
 * evidence supports, possession is not.
 *
 * ACCEPTED RESIDUAL MISS, recorded rather than hidden: an attacker who uses a
 * stolen secret exactly once and then goes dormant is not detected. No rotation
 * scheme detects that — rotation sees divergence, not possession.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Frozen parameters. Changing any of these is a design decision, not a tweak. */
export const GRACE_WINDOW_MS = 120_000; // 120s per rotated secret
export const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, advanced on each refresh
export const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, NEVER advanced
/**
 * Resource guard ONLY, never a security invariant. Eviction degrades a known
 * secret to UNKNOWN, which is a 401 with no revocation — strictly more lenient.
 */
export const HISTORY_CAP = 1000;

/** 256 bits, base64url. 43 characters, and never 64 hex — so it can never be mistaken for a digest. */
const SECRET_BYTES = 32;

export type RefreshDecision =
  | { kind: "rotate"; reason: "current" | "within_grace" }
  | { kind: "refuse"; reason: RefuseReason }
  | { kind: "revoke"; reason: "refresh_chain_divergence" };

export type RefuseReason =
  | "malformed_cookie"
  | "session_not_found"
  | "session_revoked"
  | "absolute_expired"
  | "idle_expired"
  | "token_version_stale"
  | "account_quarantined"
  | "unknown_secret"
  | "grace_expired_no_divergence";

/** The session fields the decision needs. Nothing else is read. */
export type SessionFacts = {
  readonly secretHash: string;
  readonly tokenVersionAtIssue: number;
  readonly lastUsedAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
};

/** A previously rotated secret, when the presented hash matches one. */
export type RotatedSecretFacts = { readonly graceUntil: Date };

export type DecideInput = {
  readonly session: SessionFacts;
  readonly presentedSecretHash: string;
  /** The row from AuthSessionSecret for (sessionId, presentedSecretHash), if any. */
  readonly rotated: RotatedSecretFacts | null;
  /** `User.tokenVersion` as it is NOW. */
  readonly currentTokenVersion: number;
  /** False when the business is being or has been erased (account-deletion quarantine). */
  readonly accountAcceptsUse: boolean;
  readonly now: Date;
};

/** Constant-time compare over two fixed-width hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  // Both sides are SHA-256 hex by construction, but a caller-supplied value can
  // be any length, and a length mismatch would make timingSafeEqual throw. Hash
  // both again so every comparison is the same width and neither length nor
  // content is observable in the timing.
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A fresh secret and its digest. The secret leaves this process only in a cookie. */
export function mintSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { secret, secretHash: sha256Hex(secret) };
}

/**
 * Split "<sessionId>.<secret>". Returns null for anything that is not exactly
 * two non-empty parts, which is a REFUSAL and never a revocation — a malformed
 * cookie carries no evidence about any session.
 */
export function parseRefreshCookie(
  raw: string | undefined | null
): { sessionId: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const sessionId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  // The selector is a UUID. Rejecting a non-UUID here keeps a malformed value
  // out of the database driver entirely rather than relying on it to complain.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return null;
  }
  if (secret.includes(".") || secret.length < 16 || secret.length > 256) return null;
  return { sessionId, secret };
}

export function buildRefreshCookieValue(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/**
 * The whole classification, as one pure function.
 *
 * ORDER MATTERS and is not arbitrary: every check that can refuse WITHOUT
 * consulting the presented secret runs first, so a caller holding nothing but a
 * selector learns the same "401" whatever it sends, and the expensive path is
 * only reached by a credential that could plausibly be real.
 */
export function decideRefresh(input: DecideInput): RefreshDecision {
  const { session, presentedSecretHash, rotated, currentTokenVersion, accountAcceptsUse, now } =
    input;

  if (session.revokedAt !== null) {
    return { kind: "refuse", reason: "session_revoked" };
  }
  // The ceiling first: it is the one bound nothing can advance.
  if (now.getTime() > session.absoluteExpiresAt.getTime()) {
    return { kind: "refuse", reason: "absolute_expired" };
  }
  if (now.getTime() > session.idleExpiresAt.getTime()) {
    return { kind: "refuse", reason: "idle_expired" };
  }
  // Global logout. The session was issued under an earlier generation, so it was
  // already signed out; it simply had no row of its own to hear about it.
  if (session.tokenVersionAtIssue !== currentTokenVersion) {
    return { kind: "refuse", reason: "token_version_stale" };
  }
  // Account deletion. The same gate `getCurrentUser` applies to a bearer token:
  // without it, a refresh would mint a NEW access token for a business that is
  // being erased, which is the one way the quarantine could be walked around.
  if (!accountAcceptsUse) {
    return { kind: "refuse", reason: "account_quarantined" };
  }

  if (hashesEqual(presentedSecretHash, session.secretHash)) {
    return { kind: "rotate", reason: "current" };
  }

  // Not current. Only a secret THIS session issued can say anything further.
  if (rotated === null) {
    return { kind: "refuse", reason: "unknown_secret" };
  }

  if (now.getTime() <= rotated.graceUntil.getTime()) {
    // A concurrent refresh, a lost response, or out-of-order Set-Cookie. Rotate
    // so the client converges onto the newest secret instead of being trapped
    // holding one the server has already replaced.
    return { kind: "rotate", reason: "within_grace" };
  }

  // Past grace, and the secret is one we issued. Divergence requires that the
  // session was used AFTER this secret's grace ended — otherwise this is the
  // lost-response case and killing the session would be a false positive.
  if (session.lastUsedAt.getTime() > rotated.graceUntil.getTime()) {
    return { kind: "revoke", reason: "refresh_chain_divergence" };
  }
  return { kind: "refuse", reason: "grace_expired_no_divergence" };
}

/** The four timestamps a new session is born with, from ONE captured instant. */
export function newSessionWindow(now: Date): {
  createdAt: Date;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
} {
  return {
    createdAt: now,
    lastUsedAt: now,
    idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TTL_MS),
  };
}

/**
 * Cookie lifetime: the shorter of the idle window and what is left of the
 * absolute ceiling, so the browser stops presenting a credential the server
 * would refuse anyway. Never negative.
 */
export function cookieMaxAgeSeconds(now: Date, absoluteExpiresAt: Date): number {
  const remaining = absoluteExpiresAt.getTime() - now.getTime();
  return Math.max(0, Math.floor(Math.min(IDLE_TTL_MS, remaining) / 1000));
}
