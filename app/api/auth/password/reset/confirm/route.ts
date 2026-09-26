/**
 * POST /api/auth/password/reset/confirm — set a new password with a reset token.
 *
 * Body: { token: string, newPassword: string }
 *
 * Refuses EVERY token while no delivery provider is configured (fail-closed:
 * a token that could not have been delivered must not be usable).
 *
 * On success the token is consumed by moving the generation conditionally on
 * the generation it was issued at — single winner under concurrency — then the
 * hash is written and every session revoked. No session is issued: the owner
 * signs in with the new password.
 *
 * One refusal shape for every token failure (unknown, expired, used, stale).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { authThrottleResponse } from "@/lib/auth/credential-check";
import { checkNewPassword } from "@/lib/auth/password-policy";
import {
  passwordFingerprint,
  readPasswordResetToken,
  resolvePasswordResetSender,
} from "@/lib/auth/password-reset";
import { hashNewPassword, writePasswordHash } from "@/lib/auth/password-write";
import {
  CREDENTIAL_REVOKED_REASON,
  advanceTokenGeneration,
  loadCredentialSubjectById,
  revokeAllSessions,
} from "@/lib/auth/session-directory";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getClientIp } from "@/lib/security/rate-limit";

const NO_STORE = { "cache-control": "no-store" };

function invalidToken(): NextResponse {
  return NextResponse.json(
    { error: "הקישור לאיפוס אינו תקף או שפג תוקפו", code: "RESET_TOKEN_INVALID" },
    { status: 400, headers: NO_STORE }
  );
}

export type ResetConfirmDeps = { senderConfigured: boolean };

export async function handleResetConfirm(
  req: Request,
  deps: ResetConfirmDeps = { senderConfigured: resolvePasswordResetSender().configured }
): Promise<NextResponse> {
  try {
    const rl = await checkRateLimit({ bucket: "AUTH_PASSWORD_RESET_CONFIRM", ip: getClientIp(req) });
    if (!rl.allowed) return authThrottleResponse(rl);

    const body = (await req.json().catch(() => null)) as { token?: unknown; newPassword?: unknown } | null;
    if (!deps.senderConfigured) return invalidToken();

    const claims = readPasswordResetToken(body?.token);
    if (!claims) return invalidToken();

    const subject = await loadCredentialSubjectById(claims.userId);
    if (
      !subject ||
      subject.quarantined ||
      subject.tokenVersion !== claims.tokenVersion ||
      passwordFingerprint(subject.passwordHash) !== claims.fingerprint
    ) {
      return invalidToken();
    }

    const policy = checkNewPassword(body?.newPassword, { email: subject.email });
    if (!policy.ok) {
      // Token untouched: the owner can correct the password and resubmit.
      return NextResponse.json(
        { error: policy.message, code: "PASSWORD_POLICY", reason: policy.reason, field: "newPassword" },
        { status: 400, headers: NO_STORE }
      );
    }
    const newHash = await hashNewPassword(body!.newPassword as string);

    // The consume. Exactly one concurrent confirm can match the generation.
    if (!(await advanceTokenGeneration(subject.id, claims.tokenVersion))) return invalidToken();

    await writePasswordHash(subject.id, newHash);
    try {
      const revoked = await revokeAllSessions(subject.id, CREDENTIAL_REVOKED_REASON.PASSWORD_RESET);
      console.log(JSON.stringify({ event: "password_reset_completed", userId: subject.id, revoked }));
    } catch (error) {
      console.error("PASSWORD_RESET_REVOKE_ERROR:", error instanceof Error ? error.name : "UnknownError");
    }
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (error) {
    console.error("PASSWORD_RESET_CONFIRM_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleResetConfirm(req);
}
