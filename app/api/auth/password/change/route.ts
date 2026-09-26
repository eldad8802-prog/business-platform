/**
 * POST /api/auth/password/change — change the password while signed in.
 *
 * Body: { currentPassword: string, newPassword: string }
 *
 * The current password IS the step-up: nothing here is reachable with a bearer
 * token alone. On success:
 *   - the user's token generation moves (conditionally — a concurrent change
 *     loses cleanly), which kills every access token and every refresh session
 *     minted before this instant, on every device;
 *   - every session row is marked revoked (explicit state, not implied);
 *   - THIS device receives a fresh session and token at the new generation, so
 *     the person who just changed their password is not signed out by it.
 *
 * Rate-limited per user and per address, fail-closed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { authRequiredResponse, getAuthContext, signAuthToken } from "@/lib/auth";
import { authThrottleResponse, verifyPassword } from "@/lib/auth/credential-check";
import { checkNewPassword } from "@/lib/auth/password-policy";
import { hashNewPassword, writePasswordHash } from "@/lib/auth/password-write";
import { setRefreshCookie } from "@/lib/auth/refresh-cookie";
import {
  CREDENTIAL_REVOKED_REASON,
  advanceTokenGeneration,
  issueSession,
  loadCredentialSubjectById,
  revokeAllSessions,
} from "@/lib/auth/session-directory";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getClientIp } from "@/lib/security/rate-limit";

const NO_STORE = { "cache-control": "no-store" };

export async function handlePasswordChange(req: Request): Promise<NextResponse> {
  try {
    const context = await getAuthContext(req);
    if (context === null) return authRequiredResponse(req);

    const rl = await checkRateLimit({
      bucket: "AUTH_PASSWORD_CHANGE",
      user: context.user.id,
      ip: getClientIp(req),
    });
    if (!rl.allowed) return authThrottleResponse(rl);

    const body = (await req.json().catch(() => null)) as
      | { currentPassword?: unknown; newPassword?: unknown }
      | null;
    if (typeof body?.currentPassword !== "string" || body.currentPassword.length === 0) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE });
    }

    const subject = await loadCredentialSubjectById(context.user.id);
    const currentOk = await verifyPassword(body.currentPassword, subject?.passwordHash ?? null);
    if (!subject || !currentOk || subject.quarantined) {
      return NextResponse.json(
        { error: "Current password is incorrect", code: "CURRENT_PASSWORD_INVALID" },
        { status: 403, headers: NO_STORE }
      );
    }

    const policy = checkNewPassword(body.newPassword, { email: subject.email });
    if (!policy.ok) {
      return NextResponse.json(
        { error: policy.message, code: "PASSWORD_POLICY", reason: policy.reason, field: "newPassword" },
        { status: 400, headers: NO_STORE }
      );
    }
    const newPassword = body.newPassword as string;
    if (newPassword === body.currentPassword) {
      return NextResponse.json(
        { error: "הסיסמה החדשה זהה לסיסמה הנוכחית", code: "PASSWORD_UNCHANGED", field: "newPassword" },
        { status: 400, headers: NO_STORE }
      );
    }

    const newHash = await hashNewPassword(newPassword);

    // 1. Generation first, conditionally on the generation this request was
    //    authenticated under. A concurrent change (or a logout) wins; this one
    //    is refused without touching anything.
    const advanced = await advanceTokenGeneration(subject.id, context.user.tokenVersion);
    if (!advanced) {
      return NextResponse.json(
        { error: "Session changed, sign in again", code: "SESSION_SUPERSEDED" },
        { status: 409, headers: NO_STORE }
      );
    }
    const newGeneration = context.user.tokenVersion + 1;

    // 2. The hash (runtime plane — see lib/auth/password-write.ts for why the
    //    order is the security property).
    await writePasswordHash(subject.id, newHash);

    // 3. Every session row says what happened. Failure here does not undo the
    //    change: the generation move already killed them.
    try {
      const revoked = await revokeAllSessions(subject.id, CREDENTIAL_REVOKED_REASON.PASSWORD_CHANGED);
      console.log(JSON.stringify({ event: "password_changed", userId: subject.id, revoked }));
    } catch (error) {
      console.error("PASSWORD_CHANGE_REVOKE_ERROR:", error instanceof Error ? error.name : "UnknownError");
    }

    // 4. This device continues, on a fresh session at the new generation.
    const now = new Date();
    const session = await issueSession({
      userId: subject.id,
      tokenVersion: newGeneration,
      userAgent: req.headers.get("user-agent"),
      now,
    });
    const res = NextResponse.json(
      { success: true, token: signAuthToken(subject.id, newGeneration, session.sessionId) },
      { headers: NO_STORE }
    );
    setRefreshCookie(res, session.credential, { now, absoluteExpiresAt: session.absoluteExpiresAt });
    return res;
  } catch (error) {
    console.error("PASSWORD_CHANGE_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handlePasswordChange(req);
}
