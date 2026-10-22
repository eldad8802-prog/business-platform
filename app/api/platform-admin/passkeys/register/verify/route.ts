/**
 * POST /api/platform-admin/passkeys/register/verify — finish adding a passkey.
 * FULL guard. Body: { challengeToken, response, label }. Audited.
 */
import { NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { finishPasskeyRegistration } from "@/lib/auth/admin-passkey.service";
import {
  NO_STORE,
  passkeyFailure,
  passkeyUnavailableResponse,
} from "@/lib/auth/admin-passkey-http";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;
  // Changing a factor needs a step-up from the last few minutes, not just a live one.
  const stale = freshStepUpRefusal(req, gate.id);
  if (stale) return stale;

  const body = (await req.json().catch(() => null)) as
    | { challengeToken?: unknown; response?: unknown; label?: unknown }
    | null;
  if (!body || typeof body.response !== "object" || body.response === null) {
    return NextResponse.json({ error: "Missing passkey response" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await finishPasskeyRegistration({
      userId: gate.id,
      challengeToken: body.challengeToken,
      response: body.response,
      label: body.label,
    });
    if (!result.ok) {
      const status = result.reason === "duplicate" || result.reason === "too_many" ? 409 : 400;
      return NextResponse.json(
        { error: "Could not add the passkey", code: result.reason },
        { status, headers: NO_STORE }
      );
    }
    await logPlatformAuditEvent({
      actorUserId: gate.id,
      action: PLATFORM_AUDIT_ACTIONS.PASSKEY_REGISTERED,
      targetType: "USER",
      targetId: String(gate.id),
      metadata: {
        passkeyId: result.passkey.id,
        label: result.passkey.label,
        deviceType: result.passkey.deviceType,
      },
      req,
    });
    return NextResponse.json({ passkey: result.passkey }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return (
      passkeyUnavailableResponse(error) ??
      passkeyFailure("ADMIN_PASSKEY_REGISTER_VERIFY_ERROR", error)
    );
  }
}
