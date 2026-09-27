/**
 * POST /api/auth/step-up — re-prove the password, receive a 5-minute,
 * single-use token for ONE destructive action (see lib/auth/step-up.ts).
 *
 * Body: { password: string, action: "account.delete" | "sessions.revoke_others" }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { authThrottleResponse, verifyPassword } from "@/lib/auth/credential-check";
import { loadCredentialSubjectById } from "@/lib/auth/session-directory";
import { STEP_UP_TTL_SECONDS, isStepUpAction, issueStepUpToken } from "@/lib/auth/step-up";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getClientIp } from "@/lib/security/rate-limit";

const NO_STORE = { "cache-control": "no-store" };

export async function handleStepUp(req: Request): Promise<NextResponse> {
  try {
    const context = await getAuthContext(req);
    if (context === null) return authRequiredResponse(req);

    const rl = await checkRateLimit({
      bucket: "AUTH_STEP_UP",
      user: context.user.id,
      ip: getClientIp(req),
    });
    if (!rl.allowed) return authThrottleResponse(rl);

    const body = (await req.json().catch(() => null)) as { password?: unknown; action?: unknown } | null;
    if (typeof body?.password !== "string" || body.password.length === 0 || !isStepUpAction(body.action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE });
    }

    if (context.sessionId === null) {
      // A pre-rollout token cannot be bound to a device. One refresh fixes it.
      return NextResponse.json(
        { error: "Refresh required", code: "SESSION_UNIDENTIFIED" },
        { status: 409, headers: NO_STORE }
      );
    }

    const subject = await loadCredentialSubjectById(context.user.id);
    const ok = await verifyPassword(body.password, subject?.passwordHash ?? null);
    if (!subject || !ok || subject.quarantined || subject.tokenVersion !== context.user.tokenVersion) {
      return NextResponse.json(
        { error: "Incorrect password", code: "STEP_UP_DENIED" },
        { status: 403, headers: NO_STORE }
      );
    }

    const token = issueStepUpToken(
      { userId: subject.id, sessionId: context.sessionId, tokenVersion: subject.tokenVersion },
      body.action
    );
    return NextResponse.json(
      { stepUpToken: token, action: body.action, expiresInSeconds: STEP_UP_TTL_SECONDS },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error("STEP_UP_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleStepUp(req);
}
