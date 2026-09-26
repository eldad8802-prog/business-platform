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
import { createHash, timingSafeEqual } from "node:crypto";
import { acceptsNormalWrites } from "@/lib/tenant/business-lifecycle";
import {
  REVOKED_REASON,
  issueRefreshSession,
  parseCredential,
  revokeAllSessionsForUser,
} from "@/lib/auth/refresh-session";

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

// ============================================================================
// CREDENTIAL LIFECYCLE (security closure, workstream B)
//
// Password change, password reset, step-up and cookie-proven logout all need
// the auth plane, and this module is one of the few the CI-2a boundary allows to
// hold it. They live here rather than in the routes so the routes never import
// the auth client, and so every generation move and every session revocation in
// the product is written in one reviewed place.
// ============================================================================

/** What a credential operation needs about its subject. Never leaves the server. */
export type CredentialSubject = {
  id: number;
  email: string;
  passwordHash: string;
  tokenVersion: number;
  businessId: number;
  /** The business is under the deletion quarantine (or has no business row). */
  quarantined: boolean;
};

const CREDENTIAL_SUBJECT_SELECT = {
  id: true,
  email: true,
  password: true,
  tokenVersion: true,
  businessId: true,
  business: { select: { deletionRequestedAt: true, deletedAt: true } },
} as const;

type SubjectRow = {
  id: number;
  email: string;
  password: string;
  tokenVersion: number;
  businessId: number;
  business: { deletionRequestedAt: Date | null; deletedAt: Date | null } | null;
};

function toSubject(row: SubjectRow | null): CredentialSubject | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password,
    tokenVersion: row.tokenVersion,
    businessId: row.businessId,
    quarantined: !row.business || !acceptsNormalWrites(row.business),
  };
}

export async function loadCredentialSubjectById(userId: number): Promise<CredentialSubject | null> {
  const row = await authDb().user.findUnique({
    where: { id: userId },
    select: CREDENTIAL_SUBJECT_SELECT,
  });
  return toSubject(row as SubjectRow | null);
}

/**
 * By address. Folded first; the address as typed is ALSO looked up whenever
 * folding changed it — unconditionally, not only on a miss — so the number of
 * queries depends on what was typed and never on whether an account exists.
 */
export async function loadCredentialSubjectByEmail(
  typed: string,
  normalized: string
): Promise<CredentialSubject | null> {
  const [folded, raw] = await Promise.all([
    authDb().user.findUnique({ where: { email: normalized }, select: CREDENTIAL_SUBJECT_SELECT }),
    typed !== normalized
      ? authDb().user.findUnique({ where: { email: typed }, select: CREDENTIAL_SUBJECT_SELECT })
      : Promise.resolve(null),
  ]);
  return toSubject((folded ?? raw) as SubjectRow | null);
}

/**
 * Move the user's generation forward IF it is still `expected`. One conditional
 * UPDATE, so of two concurrent callers presenting the same generation exactly
 * one wins — this is what makes a reset token single-use and a password change
 * race-free. Every access token and every refresh session minted under the old
 * generation is dead the instant this commits (gate 3 in lib/auth.ts, and the
 * `tokenVersionAtIssue` check in the refresh engine).
 */
export async function advanceTokenGeneration(userId: number, expected: number): Promise<boolean> {
  const { count } = await authDb().user.updateMany({
    where: { id: userId, tokenVersion: expected },
    data: { tokenVersion: { increment: 1 } },
  });
  return count === 1;
}

export const CREDENTIAL_REVOKED_REASON = {
  PASSWORD_CHANGED: "password_changed",
  PASSWORD_RESET: "password_reset",
} as const;

/** Mark every live session of the user revoked. Explicit state, not implied. */
export async function revokeAllSessions(userId: number, reason: string, now = new Date()): Promise<number> {
  return revokeAllSessionsForUser(authDb(), { userId, now, reason });
}

/** Issue a fresh device session (after a credential has been proven). */
export async function issueSession(input: {
  userId: number;
  tokenVersion: number;
  userAgent: string | null;
  now?: Date;
}) {
  return issueRefreshSession(authDb(), {
    userId: input.userId,
    tokenVersion: input.tokenVersion,
    now: input.now ?? new Date(),
    userAgent: input.userAgent,
  });
}

const sha256hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Logout proven by the REFRESH COOKIE instead of the access token.
 *
 * The refresh cookie is scoped to /api/auth/refresh, so /api/auth/logout never
 * sees it; and when the 24-hour access token has already expired, that route
 * has no user to sign out — it cleared the cookie and left every refresh
 * session alive. This closes that: possession of the CURRENT secret (or one
 * still inside its rotation grace) signs the user out exactly as logout does —
 * generation moved, every session revoked.
 *
 * An unrecognised secret proves nothing and changes nothing (same rule as the
 * refresh engine: the selector authenticates nobody).
 */
export async function logoutByRefreshCredential(
  credential: string | null,
  now = new Date()
): Promise<{ kind: "signed_out"; userId: number } | { kind: "unknown" }> {
  const parsed = parseCredential(credential);
  if (!parsed) return { kind: "unknown" };

  const session = await authDb().authSession.findUnique({
    where: { id: parsed.sessionId },
    select: { id: true, userId: true, secretHash: true, revokedAt: true },
  });
  if (!session || session.revokedAt !== null) return { kind: "unknown" };

  const presented = sha256hex(parsed.secret);
  let proven = sameHash(presented, session.secretHash);
  if (!proven) {
    const historic = await authDb().authSessionSecret.findUnique({
      where: { sessionId_secretHash: { sessionId: session.id, secretHash: presented } },
      select: { graceUntil: true },
    });
    proven = historic !== null && now <= historic.graceUntil;
  }
  if (!proven) return { kind: "unknown" };

  await authDb().user.update({
    where: { id: session.userId },
    data: { tokenVersion: { increment: 1 } },
    select: { id: true },
  });
  await revokeAllSessionsForUser(authDb(), {
    userId: session.userId,
    now,
    reason: REVOKED_REASON.LOGOUT,
  });
  return { kind: "signed_out", userId: session.userId };
}
