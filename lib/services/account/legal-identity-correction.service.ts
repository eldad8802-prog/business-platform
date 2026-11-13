/**
 * Legal identity correction — the business's side (owner decision 2026-11-13; migration 20261128100000).
 *
 * OFF by default: LEGAL_IDENTITY_CORRECTION_ENABLED must be exactly "true", and the owner has not yet approved WHO
 * decides a request or the verification policy. Until then this is a Draft: the routes answer 404, no screen links to
 * it, and the database grants the decision function to nobody — a request can be stored but never applied.
 *
 *   readCorrectionState   the confirmed identity, whether it is locked, which re-verification the requester needs,
 *                         and the business's request history (newest first).
 *   verifyRequester       re-verification proportional to the change: an account with a password re-enters it;
 *                         an account opened with Google (no password) must have signed in within the last 10 minutes.
 *   submitCorrection      legal_identity_correction_request in the business's tenant transaction.
 *   cancelCorrection      the requester withdraws an open request.
 *
 * `businessId`, `userId` and `sessionId` are always the session's — never from the request. Values never reach a log.
 */

import bcrypt from "bcrypt";

// The auth plane is reached ONLY through modules already on its approved surface (CI-2a / AST-4): the password hash
// as login reads it (google-link.ts readAccountCredentials) and the session list (session-directory.ts listSessions).
import { readAccountCredentials } from "@/lib/auth/google-link";
import { listSessions } from "@/lib/auth/session-directory";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  correctionCodeFromDbError,
  type CorrectionKind,
  type NormalizedCorrection,
} from "@/lib/legal-identity/correction";

export const RECENT_SIGN_IN_MINUTES = 10;

export function isLegalIdentityCorrectionEnabled(): boolean {
  return process.env.LEGAL_IDENTITY_CORRECTION_ENABLED === "true";
}

export type VerificationMethod = "PASSWORD" | "RECENT_SIGN_IN";
export type CorrectionStatus = "PENDING" | "APPLIED" | "REJECTED" | "CANCELLED" | "STALE";

export type CorrectionRequestView = {
  id: number;
  kind: CorrectionKind;
  status: CorrectionStatus;
  current: { businessKind: string; legalName: string | null; taxId: string | null };
  requested: { businessKind: string; legalName: string | null; taxId: string | null };
  reason: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type CorrectionState = {
  /** The confirmed identity, or null when the business has none confirmed (then it edits its details directly). */
  identity: { businessKind: string; legalName: string; taxId: string } | null;
  verification: VerificationMethod;
  requests: CorrectionRequestView[];
};

export class CorrectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "CorrectionError";
    this.code = code;
    this.status = status;
  }
}

/** Which re-verification this user needs: a password account re-enters it; a Google-only account signs in again. */
export async function verificationMethodFor(userId: number): Promise<VerificationMethod> {
  const u = await readAccountCredentials(userId);
  return u?.password ? "PASSWORD" : "RECENT_SIGN_IN";
}

export async function readCorrectionState(businessId: number, userId: number): Promise<CorrectionState> {
  const [verification, data] = await Promise.all([
    verificationMethodFor(userId),
    tenantTx(businessId, async (tx) => ({
      profile: await tx.businessProfile.findUnique({
        where: { businessId },
        select: { billingBusinessKind: true, billingLegalName: true, billingTaxId: true, legalIdentityConfirmedAt: true },
      }),
      requests: await tx.legalIdentityCorrectionRequest.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    })),
  ]);
  const p = data.profile;
  const identity =
    p && p.legalIdentityConfirmedAt && p.billingBusinessKind && p.billingLegalName && p.billingTaxId
      ? { businessKind: p.billingBusinessKind, legalName: p.billingLegalName, taxId: p.billingTaxId }
      : null;
  return {
    identity,
    verification,
    requests: data.requests.map((r) => ({
      id: r.id,
      kind: r.kind as CorrectionKind,
      status: r.status as CorrectionStatus,
      current: { businessKind: r.currentBusinessKind, legalName: r.currentLegalName, taxId: r.currentTaxId },
      requested: { businessKind: r.requestedBusinessKind, legalName: r.requestedLegalName, taxId: r.requestedTaxId },
      reason: r.reason,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    })),
  };
}

/**
 * Re-verify the requester now. PASSWORD: the account's own password, compared with its hash on the auth plane.
 * RECENT_SIGN_IN (no password): THIS session must have been signed in within RECENT_SIGN_IN_MINUTES — the session
 * row's createdAt is the sign-in time (refresh rotates secrets, not the row).
 */
export async function verifyRequester(
  userId: number,
  sessionId: string | null,
  password: unknown,
  now: Date = new Date()
): Promise<{ method: VerificationMethod; verifiedAt: Date }> {
  const u = await readAccountCredentials(userId);
  if (!u) throw new CorrectionError("NOT_ALLOWED", 403);
  if (u.password) {
    if (typeof password !== "string" || password.length === 0) throw new CorrectionError("PASSWORD_REQUIRED", 400);
    if (!(await bcrypt.compare(password, u.password))) throw new CorrectionError("WRONG_PASSWORD", 403);
    return { method: "PASSWORD", verifiedAt: now };
  }
  if (!sessionId) throw new CorrectionError("SIGN_IN_AGAIN", 403);
  // THIS session (the user own list — another account session can never match), active, signed in recently.
  const sessions = await listSessions({ userId, currentSessionId: sessionId, now });
  const s = sessions.find((x) => x.current);
  if (!s || s.status !== "active" || now.getTime() - new Date(s.createdAt).getTime() > RECENT_SIGN_IN_MINUTES * 60_000) {
    throw new CorrectionError("SIGN_IN_AGAIN", 403);
  }
  return { method: "RECENT_SIGN_IN", verifiedAt: now };
}

export async function submitCorrection(
  businessId: number,
  userId: number,
  c: NormalizedCorrection,
  v: { method: VerificationMethod; verifiedAt: Date }
): Promise<number> {
  try {
    return await tenantTx(businessId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: number }[]>`SELECT public.legal_identity_correction_request(
        ${userId}::integer, ${c.kind}, ${c.requestedBusinessKind}, ${c.requestedLegalName}, ${c.requestedTaxId},
        ${c.reason}, true, ${v.method}, ${v.verifiedAt}::timestamptz) AS id`;
      return Number(rows[0]?.id);
    });
  } catch (error) {
    const code = correctionCodeFromDbError(error);
    if (code === "CORRECTION_ALREADY_OPEN") throw new CorrectionError(code, 409);
    if (code === "IDENTITY_NOT_CONFIRMED") throw new CorrectionError(code, 409);
    if (code === "NOT_ALLOWED") throw new CorrectionError(code, 403);
    if (code) throw new CorrectionError(code, 400);
    throw error;
  }
}

export async function cancelCorrection(businessId: number, userId: number, requestId: number): Promise<"CANCELLED" | "NOT_FOUND" | "NOT_PENDING"> {
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<{ r: string }[]>`SELECT public.legal_identity_correction_cancel(${userId}::integer, ${requestId}::integer) AS r`;
    const r = rows[0]?.r;
    return r === "CANCELLED" || r === "NOT_PENDING" ? r : "NOT_FOUND";
  });
}
