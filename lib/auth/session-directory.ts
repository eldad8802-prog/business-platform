/**
 * DEVICE & SESSION MANAGEMENT — the owner's view of their own sessions.
 *
 * One module holds every query this feature makes, so the two rules that matter
 * are enforced in one place instead of three routes remembering them:
 *
 *   OWNERSHIP LIVES IN THE WRITE PREDICATE. Every revoke filters on `userId` in
 *   the same statement that writes. It is never an `if` above the call, because
 *   an `if` is something a later edit can move, reorder or forget, and the
 *   failure mode of forgetting is one user revoking another user's device.
 *
 *   NOTHING INTERNAL LEAVES. The DTO is assembled here and carries no hash, no
 *   `tokenVersionAtIssue`, no rotation history and no raw User-Agent — only a
 *   label derived from it.
 *
 * Revocation is a state transition, never a delete. Retention is a separate
 * contract and this plane holds no DELETE privilege it does not need.
 */

import { authDb } from "@/lib/prisma-auth";
import { deviceLabel } from "@/lib/auth/device-label";
import { REVOKED_REASON } from "@/lib/auth/refresh-session";

/** Why a session was ended, when the owner did it themselves. */
export const USER_REVOKED_REASON = {
  /** One device, from the device list. */
  DEVICE: "revoked_by_user",
  /** Everything except the device doing the asking. */
  OTHER_DEVICES: "revoked_other_devices",
} as const;

export type SessionStatus = "active" | "revoked" | "expired";

/** Exactly what the screen renders. Nothing else crosses the boundary. */
export type SessionView = {
  id: string;
  current: boolean;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  /** The earlier of the two ceilings: whichever ends this session first. */
  expiresAt: string;
  status: SessionStatus;
};

const LIST_SELECT = {
  id: true,
  createdAt: true,
  lastUsedAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  userAgent: true,
} as const;

function earlier(a: Date, b: Date): Date {
  return a <= b ? a : b;
}

function statusOf(row: { revokedAt: Date | null; idleExpiresAt: Date; absoluteExpiresAt: Date }, now: Date): SessionStatus {
  // Revoked outranks expired: if someone ended a session deliberately, that is
  // the fact worth showing, even if it would also have aged out by now.
  if (row.revokedAt !== null) return "revoked";
  if (earlier(row.idleExpiresAt, row.absoluteExpiresAt) <= now) return "expired";
  return "active";
}

/**
 * The caller's own sessions, newest activity first.
 *
 * `currentSessionId` comes from the verified access token, never from a header or
 * a cookie: the refresh cookie is scoped to its own path and does not reach this
 * endpoint, and a User-Agent match would be a guess.
 */
export async function listSessions(input: {
  userId: number;
  currentSessionId: string | null;
  now?: Date;
}): Promise<SessionView[]> {
  const now = input.now ?? new Date();
  const rows = await authDb().authSession.findMany({
    where: { userId: input.userId },
    select: LIST_SELECT,
    orderBy: { lastUsedAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    current: input.currentSessionId !== null && row.id === input.currentSessionId,
    label: deviceLabel(row.userAgent),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: earlier(row.idleExpiresAt, row.absoluteExpiresAt).toISOString(),
    status: statusOf(row, now),
  }));
}

export type RevokeOneResult =
  /** It was the caller's, and it is now ended — or already was. */
  | { kind: "revoked"; wasCurrent: boolean }
  /** Not the caller's, or not a session at all. The two are indistinguishable. */
  | { kind: "not_found" };

/**
 * End one session.
 *
 * Unknown and foreign ids produce the SAME result, which is what stops this
 * endpoint from confirming that a guessed id exists. Ownership is part of the
 * UPDATE, so a foreign id cannot change a row even if the check above it were
 * ever removed.
 *
 * Idempotent: revoking a session the caller owns and has already revoked
 * succeeds. That leaks nothing — they already know it is theirs — and it means a
 * double tap is not an error.
 */
export async function revokeSession(input: {
  userId: number;
  sessionId: string;
  currentSessionId: string | null;
  now?: Date;
}): Promise<RevokeOneResult> {
  const now = input.now ?? new Date();

  const { count } = await authDb().authSession.updateMany({
    where: { id: input.sessionId, userId: input.userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: USER_REVOKED_REASON.DEVICE },
  });

  if (count === 0) {
    // Either it is not theirs, or it is theirs and already revoked. Only the
    // second is allowed to answer success, and the probe that tells them apart is
    // itself scoped by userId so it cannot leak either.
    const mine = await authDb().authSession.findFirst({
      where: { id: input.sessionId, userId: input.userId },
      select: { id: true },
    });
    if (mine === null) return { kind: "not_found" };
  }

  return {
    kind: "revoked",
    wasCurrent: input.currentSessionId !== null && input.sessionId === input.currentSessionId,
  };
}

/**
 * End every session except the one asking.
 *
 * Deliberately NOT a generation bump. Incrementing `tokenVersion` would end the
 * caller's session too, which is the opposite of what the control says, and it
 * would also invalidate the token in the hand of the person pressing the button.
 *
 * Requires a known current session. Guessing which row to spare is the one
 * mistake here that signs the owner out of everything, so a token that names no
 * session is refused instead.
 */
export async function revokeOtherSessions(input: {
  userId: number;
  currentSessionId: string;
  now?: Date;
}): Promise<{ revoked: number }> {
  const now = input.now ?? new Date();
  const { count } = await authDb().authSession.updateMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      id: { not: input.currentSessionId },
    },
    data: { revokedAt: now, revokedReason: USER_REVOKED_REASON.OTHER_DEVICES },
  });
  return { revoked: count };
}

/** Re-exported so callers do not reach into the refresh engine for a constant. */
export { REVOKED_REASON };

// ─────────────────────────────────────────────────────────────────────────────
// SEC-E / M-12(a) — ACCOUNT ERASURE: the authority a deleted account still held
// ─────────────────────────────────────────────────────────────────────────────
//
// Until this existed the ONLY thing standing between a token minted before a deletion
// and the account was the business lifecycle gate (lib/auth.ts gate 2, and the same
// check in refreshSession). One control, and erasure-dispositions.ts said so: "a known
// single-control gap". These two functions make the deletion revoke the authority
// itself, on the auth plane that owns it, so a token or refresh cookie issued before
// the deletion fails gate 3 / gate 4 / the refresh generation check even if the
// lifecycle gate were ever lost.
//
// They live HERE because this is the module CI-2a already allows to hold the auth
// client, and every query the session plane makes about ownership lives in one place.
// The erasure never imports the auth client itself.

/** Recorded on every session the erasure ends, so the row says why it died. */
export const ERASURE_REVOKED_REASON = "account_erasure" as const;

/**
 * Revoke every credential of every user of `businessId`:
 *
 *   1. `User.tokenVersion` +1 — every bearer token and every refresh session minted
 *      before this instant stops matching the user's generation (gate 3 and the
 *      refresh generation check). This is the load-bearing half, exactly as in logout.
 *   2. every live `AuthSession` marked revoked — gate 4 and refresh both refuse it
 *      explicitly rather than by accident of ordering.
 *
 * Idempotent in effect: a retry bumps the generation again, which can only kill more
 * tokens (there are none left to kill), and the session update is conditional on
 * `revokedAt: null`. The scope is `businessId` in the write predicate, never an id
 * list assembled above the call.
 */
export async function revokeAuthorityOfBusinessUsers(
  businessId: number,
  now: Date
): Promise<{ users: number; sessions: number }> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("revokeAuthorityOfBusinessUsers: a positive, server-derived businessId is required");
  }
  const db = authDb();
  const users = await db.user.updateMany({
    where: { businessId },
    data: { tokenVersion: { increment: 1 } },
  });
  const sessions = await db.authSession.updateMany({
    where: { user: { businessId }, revokedAt: null },
    data: { revokedAt: now, revokedReason: ERASURE_REVOKED_REASON },
  });
  return { users: users.count, sessions: sessions.count };
}

/**
 * Delete the session rows of every user of `businessId` — the device history, with the
 * User-Agent each login recorded. Run by the erasure AFTER `revokeAuthorityOfBusinessUsers`
 * (the revocation is the security control; this is the personal-data erasure).
 *
 * Children first and explicitly, for the same reason the tenant erasure never leans on
 * a cascade it cannot see. The auth plane holds DELETE on both tables (migration
 * 20260908200000) for exactly this kind of cleanup. Idempotent: a second run deletes
 * nothing.
 */
export async function eraseSessionsOfBusinessUsers(
  businessId: number
): Promise<{ secrets: number; sessions: number }> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("eraseSessionsOfBusinessUsers: a positive, server-derived businessId is required");
  }
  const db = authDb();
  const secrets = await db.authSessionSecret.deleteMany({
    where: { session: { user: { businessId } } },
  });
  const sessions = await db.authSession.deleteMany({
    where: { user: { businessId } },
  });
  return { secrets: secrets.count, sessions: sessions.count };
}

/** Post-condition read for the erasure VERIFY stage: no session row may survive. */
export async function countSessionsOfBusinessUsers(businessId: number): Promise<number> {
  return authDb().authSession.count({ where: { user: { businessId } } });
}
