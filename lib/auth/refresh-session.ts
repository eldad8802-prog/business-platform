/**
 * PERSISTENT LOGIN — the refresh-session engine.
 *
 * Deliberately knows nothing about HTTP. No headers, no cookies, no Request, no
 * Response. It takes a credential, an instant and a Prisma client, and returns a
 * verdict. The browser-specific half — cookie attributes, Origin and
 * Sec-Fetch-Site — lives in the route, so the engine is not permanently coupled
 * to the one client that happens to be first.
 *
 * WHY A ROTATING SECRET AT ALL
 *
 * The access token is a stateless HMAC capped at 24 hours by CASA 2.2.3, and
 * that cap is not negotiable. Staying signed in for weeks therefore needs a
 * second credential that never reaches JavaScript: an HttpOnly cookie, exchanged
 * for a short access token and replaced on every exchange.
 *
 * THE CREDENTIAL
 *
 * `<sessionId>.<secret>`. The id is a SELECTOR: it finds a row and authenticates
 * NOTHING. The secret is 256 bits of CSPRNG and is stored only as its SHA-256
 * digest, so nothing in the database can be replayed as a credential. A two-hash
 * schema was tried and is provably broken — with three concurrent refreshes the
 * third matches neither hash, and two rotations later the original digest is
 * stored nowhere at all, which makes "a credential we issued" and "a random
 * string" indistinguishable and reuse detection unimplementable.
 *
 * THE PART THAT IS EASY TO GET WRONG
 *
 * A rotation whose response is lost leaves the browser holding the PREVIOUS
 * secret while the row holds the hash of the new one. The server cannot hand
 * back the new secret — it kept only a digest of it. So a grace hit does not
 * "restore" anything: it mints a fresh secret and swaps it in against the
 * CURRENT state, which leaves the caller holding a credential that outlives the
 * grace window. Returning only an access token would leave the browser with a
 * secret that dies in 120 seconds, which is the opposite of persistent login.
 *
 * WHAT IS NOT HERE, ON PURPOSE
 *
 * No history cap and no eviction. There is no approved retention contract yet,
 * and a cap plus a delete is a lifecycle decision, not a refresh decision.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { acceptsNormalWrites } from "@/lib/tenant/business-lifecycle";

/** 256 bits, hex. */
const SECRET_BYTES = 32;

/** Frozen parameters. Changing any of these is a design decision, not a tweak. */
export const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const GRACE_MS = 120 * 1000;

/**
 * Recovery re-reads and retries exactly once when it loses a race. Bounded on
 * purpose: an unbounded loop under contention is how a refresh endpoint becomes
 * a way to spin the database.
 */
const RECOVERY_ATTEMPTS = 2;

export type RefreshOutcome =
  /** The credential was current, or recoverable inside its grace. */
  | { kind: "rotated"; userId: number; tokenVersion: number; credential: string; absoluteExpiresAt: Date }
  /**
   * Refused, but nothing about this session is proven. The caller MUST NOT
   * revoke and MUST NOT clear the cookie: the selector authenticates nothing, so
   * treating an unrecognised secret as proof of anything hands a session-kill
   * primitive to whoever learns an id.
   */
  | { kind: "unauthorized"; reason: "no_credential" | "malformed" | "unknown_secret" | "not_found" }
  /** Conclusively dead. The caller clears the cookie. */
  | {
      kind: "invalid";
      reason:
        | "revoked"
        | "idle_expired"
        | "absolute_expired"
        | "token_version_mismatch"
        /** The business is being or has been erased. See the gate in refreshSession. */
        | "account_quarantined";
    }
  /** Proven chain divergence. Session revoked, cookie cleared, event logged. */
  | { kind: "replay_revoked"; sessionId: string; userId: number }
  /** A known rotated secret past its grace, with no proof anyone else used the session. */
  | { kind: "replay_unproven" };

export const REVOKED_REASON = {
  LOGOUT: "logout",
  IDLE_EXPIRED: "idle_expired",
  ABSOLUTE_EXPIRED: "absolute_expired",
  TOKEN_VERSION_MISMATCH: "token_version_mismatch",
  SUSPECTED_REUSE: "suspected_refresh_reuse",
} as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time compare so a hash comparison cannot be timed byte by byte. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

export function buildCredential(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/**
 * `<uuid>.<64 hex>`. Split on the LAST dot: a uuid contains dashes, not dots,
 * but pinning the shape here means a malformed value never reaches a query.
 */
export function parseCredential(raw: string | null | undefined): { sessionId: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const sessionId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  if (!/^[0-9a-f]{64}$/i.test(secret)) return null;
  return { sessionId, secret };
}

/** The columns the engine reads. Named, never implicit. */
const SESSION_SELECT = {
  id: true,
  userId: true,
  secretHash: true,
  tokenVersionAtIssue: true,
  lastUsedAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
} as const;

/** Idle may advance, but never past the ceiling. The ceiling itself never moves. */
function nextIdle(now: Date, absoluteExpiresAt: Date): Date {
  const candidate = new Date(now.getTime() + IDLE_MS);
  return candidate < absoluteExpiresAt ? candidate : absoluteExpiresAt;
}

/**
 * Issue a session. Called after a password has already been verified — this
 * function does not authenticate anyone.
 */
export async function issueRefreshSession(
  db: PrismaClient,
  input: { userId: number; tokenVersion: number; now: Date }
): Promise<{ credential: string; absoluteExpiresAt: Date }> {
  const secret = mintSecret();
  const absoluteExpiresAt = new Date(input.now.getTime() + ABSOLUTE_MS);

  // Every timestamp comes from ONE instant supplied here. Nothing is left to the
  // database: `CURRENT_TIMESTAMP` is a timestamptz cast into these
  // `timestamp(3)` columns through a session TimeZone this project never sets,
  // which measured three hours of error on an Asia/Riyadh server — in the
  // direction that makes every expiry more lenient.
  const row = await db.authSession.create({
    data: {
      userId: input.userId,
      secretHash: sha256(secret),
      tokenVersionAtIssue: input.tokenVersion,
      createdAt: input.now,
      lastUsedAt: input.now,
      idleExpiresAt: new Date(input.now.getTime() + IDLE_MS),
      absoluteExpiresAt,
    },
    select: { id: true },
  });

  return { credential: buildCredential(row.id, secret), absoluteExpiresAt };
}

/**
 * Revoke every live session for a user. Used by logout, which stays GLOBAL: it
 * also increments `User.tokenVersion`, and this makes the refresh half match.
 * Rows are revoked, never deleted — retention is a separate contract.
 */
export async function revokeAllSessionsForUser(
  db: PrismaClient,
  input: { userId: number; now: Date; reason?: string }
): Promise<number> {
  const { count } = await db.authSession.updateMany({
    where: { userId: input.userId, revokedAt: null },
    data: { revokedAt: input.now, revokedReason: input.reason ?? REVOKED_REASON.LOGOUT },
  });
  return count;
}

async function revokeOne(
  db: PrismaClient,
  sessionId: string,
  now: Date,
  reason: string
): Promise<void> {
  // Conditional on `revokedAt: null` so a racing revoke does not overwrite the
  // first reason, and so this is idempotent under retry.
  await db.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
}

type SessionRow = {
  id: string;
  userId: number;
  secretHash: string;
  tokenVersionAtIssue: number;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
};

/**
 * One rotation, atomically.
 *
 * The compare-and-swap IS the concurrency control. `updateMany` compiles to a
 * single `UPDATE ... WHERE` with no RETURNING and reports a count, so the row is
 * locked by PostgreSQL for exactly the statement's duration and the winner is
 * whoever matched `expectedHash`. No `SELECT ... FOR UPDATE`, no advisory lock,
 * no read-then-write window.
 *
 * The swap and the history row are one transaction. A rotation that moved the
 * current secret without recording the old one would strand every client still
 * holding it, so the two halves must fail together.
 */
async function rotate(
  db: PrismaClient,
  session: SessionRow,
  expectedHash: string,
  now: Date
): Promise<{ secret: string } | null> {
  const secret = mintSecret();

  const won = await db.$transaction(async (tx) => {
    const { count } = await tx.authSession.updateMany({
      where: {
        id: session.id,
        secretHash: expectedHash,
        revokedAt: null,
        absoluteExpiresAt: { gt: now },
        idleExpiresAt: { gt: now },
      },
      data: {
        secretHash: sha256(secret),
        lastUsedAt: now,
        idleExpiresAt: nextIdle(now, session.absoluteExpiresAt),
      },
    });

    if (count !== 1) return false;

    // The secret that was current a moment ago becomes recoverable for exactly
    // GRACE_MS. The window is fixed here and never extended: a grace that could
    // be renewed would keep reuse detection permanently out of reach.
    await tx.authSessionSecret.create({
      data: {
        sessionId: session.id,
        secretHash: expectedHash,
        rotatedAt: now,
        graceUntil: new Date(now.getTime() + GRACE_MS),
      },
      select: { id: true },
    });

    return true;
  });

  return won ? { secret } : null;
}

/**
 * The refresh state machine.
 *
 * `db` is the auth-plane client. `now` is one instant for the whole request.
 */
export async function refreshSession(
  db: PrismaClient,
  input: { credential: string | null | undefined; now: Date }
): Promise<RefreshOutcome> {
  if (input.credential === null || input.credential === undefined || input.credential === "") {
    return { kind: "unauthorized", reason: "no_credential" };
  }
  const parsed = parseCredential(input.credential);
  if (!parsed) return { kind: "unauthorized", reason: "malformed" };

  const presentedHash = sha256(parsed.secret);
  const { now } = input;

  for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt++) {
    const session = (await db.authSession.findUnique({
      where: { id: parsed.sessionId },
      select: SESSION_SELECT,
    })) as SessionRow | null;

    if (!session) return { kind: "unauthorized", reason: "not_found" };

    // ---- lifecycle, before anything is written -----------------------------
    if (session.revokedAt !== null) return { kind: "invalid", reason: "revoked" };
    if (session.absoluteExpiresAt <= now) {
      await revokeOne(db, session.id, now, REVOKED_REASON.ABSOLUTE_EXPIRED);
      return { kind: "invalid", reason: "absolute_expired" };
    }
    if (session.idleExpiresAt <= now) {
      await revokeOne(db, session.id, now, REVOKED_REASON.IDLE_EXPIRED);
      return { kind: "invalid", reason: "idle_expired" };
    }

    // A global logout increments User.tokenVersion. A session issued under an
    // older generation is one that logout already killed.
    //
    // The business lifecycle is read in the same statement because the account
    // may be under an erasure quarantine, which is checked immediately below.
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        tokenVersion: true,
        business: { select: { deletionRequestedAt: true, deletedAt: true } },
      },
    });
    if (!user) return { kind: "unauthorized", reason: "not_found" };
    if (user.tokenVersion !== session.tokenVersionAtIssue) {
      await revokeOne(db, session.id, now, REVOKED_REASON.TOKEN_VERSION_MISMATCH);
      return { kind: "invalid", reason: "token_version_mismatch" };
    }

    // ACCOUNT-DELETION QUARANTINE.
    //
    // `getCurrentUser` refuses a bearer token the instant a business enters
    // DELETION_REQUESTED. Without the same gate here, refresh would be the one
    // door left open: the erasure runs on the tenant plane, which holds no
    // privilege on these tables at all, so it cannot reach a session to kill it,
    // and a client holding a valid credential would go on minting fresh access
    // tokens for an account being erased.
    //
    // This calls the CANONICAL gate rather than re-deriving the rule. A second
    // copy of "which timestamps mean quarantined" is exactly how the two answers
    // drift apart, and the lifecycle module is the one place that decides it.
    //
    // Fail-closed: a missing business row denies. The check runs BEFORE any
    // rotation write and long before the route mints anything, so no token is
    // signed for a quarantined account even transiently.
    //
    // The session is deliberately NOT revoked. Revocation in this design means
    // "something about this credential is proven bad"; here the credential is
    // fine and the account is closing. The row goes when the erasure cascades
    // through User, or when the sweep collects it.
    if (!user.business || !acceptsNormalWrites(user.business)) {
      return { kind: "invalid", reason: "account_quarantined" };
    }

    // ---- the current secret ------------------------------------------------
    if (hashesEqual(presentedHash, session.secretHash)) {
      const rotated = await rotate(db, session, presentedHash, now);
      if (rotated) {
        return {
          kind: "rotated",
          userId: session.userId,
          tokenVersion: user.tokenVersion,
          credential: buildCredential(session.id, rotated.secret),
          absoluteExpiresAt: session.absoluteExpiresAt,
        };
      }
      // Lost the race to a concurrent refresh. Re-read and fall through: the
      // secret we presented is now in history, inside its grace.
      continue;
    }

    // ---- a rotated secret --------------------------------------------------
    const historic = await db.authSessionSecret.findUnique({
      where: { sessionId_secretHash: { sessionId: session.id, secretHash: presentedHash } },
      select: { id: true, rotatedAt: true, graceUntil: true },
    });

    // Not current and not ours. NEVER revoke and NEVER clear: absence of
    // evidence is not evidence, and the selector proves nothing.
    if (!historic) return { kind: "unauthorized", reason: "unknown_secret" };

    if (now <= historic.graceUntil) {
      // GRACE RECOVERY. Swap against the CURRENT hash, not the presented one, so
      // the caller leaves holding a credential that outlives this grace window.
      const rotated = await rotate(db, session, session.secretHash, now);
      if (rotated) {
        return {
          kind: "rotated",
          userId: session.userId,
          tokenVersion: user.tokenVersion,
          credential: buildCredential(session.id, rotated.secret),
          absoluteExpiresAt: session.absoluteExpiresAt,
        };
      }
      continue; // someone rotated underneath us; one bounded retry
    }

    // ---- past its grace ----------------------------------------------------
    //
    // Revocation requires POSITIVE evidence that a second party holds a later
    // credential: a successful refresh AFTER this secret's grace ended. Without
    // that condition an ordinary lost response looks exactly like theft — the
    // client still holds the old secret, comes back hours later, and would have
    // its session killed with no attacker anywhere.
    if (session.lastUsedAt > historic.graceUntil) {
      await revokeOne(db, session.id, now, REVOKED_REASON.SUSPECTED_REUSE);
      return { kind: "replay_revoked", sessionId: session.id, userId: session.userId };
    }
    return { kind: "replay_unproven" };
  }

  // Both attempts lost their race. Refusing is correct and costs the caller one
  // retry; looping is not.
  return { kind: "unauthorized", reason: "unknown_secret" };
}
