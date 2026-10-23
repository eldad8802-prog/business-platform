/**
 * POST /api/platform-admin/passkeys/auth/verify — finish a passkey step-up and
 * mint the same short-lived elevation a TOTP code mints.
 *
 * Identity-only guard (see /mfa/verify). Rate-limited per admin, on a budget of
 * its own, so neither factor can be used to exhaust the other. Every success
 * and every refusal is audited.
 */
import { NextResponse } from "next/server";
import { requirePlatformAdminIdentityOrResponse } from "@/lib/auth/platform-admin";
import { finishPasskeyAuthentication } from "@/lib/auth/admin-passkey.service";
import {
  NO_STORE,
  passkeyFailure,
  passkeyUnavailableResponse,
} from "@/lib/auth/admin-passkey-http";
import {
  ADMIN_ELEVATION_TTL_SECONDS,
  issueAdminElevation,
} from "@/lib/auth/platform-admin-elevation";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminIdentityOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  const rl = await consumeRateLimit({
    key: `admin:passkey:verify:${gate.id}`,
    limit: 10,
    windowMs: 5 * 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly.", code: "RATE_LIMITED" },
      { status: 429, headers: NO_STORE }
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { challengeToken?: unknown; response?: unknown }
    | null;
  if (!body || typeof body.response !== "object" || body.response === null) {
    return NextResponse.json({ error: "Missing passkey response" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await finishPasskeyAuthentication({
      userId: gate.id,
      challengeToken: body.challengeToken,
      response: body.response,
    });
    if (!result.ok) {
      await logPlatformAuditEvent({
        actorUserId: gate.id,
        action: PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED,
        targetType: "USER",
        targetId: String(gate.id),
        metadata: { method: "passkey", reason: result.reason },
        req,
      });
      return NextResponse.json(
        { error: "Verification failed", code: result.reason },
        { status: 401, headers: NO_STORE }
      );
    }
    await logPlatformAuditEvent({
      actorUserId: gate.id,
      action: PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED,
      targetType: "USER",
      targetId: String(gate.id),
      metadata: { method: "passkey", passkeyId: result.passkeyId },
      req,
    });
    return NextResponse.json(
      {
        elevation: issueAdminElevation(gate.id),
        expiresInSeconds: ADMIN_ELEVATION_TTL_SECONDS,
        via: "passkey",
      },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return (
      passkeyUnavailableResponse(error) ?? passkeyFailure("ADMIN_PASSKEY_AUTH_VERIFY_ERROR", error)
    );
  }
}
