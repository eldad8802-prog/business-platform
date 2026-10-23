/**
 * POST /api/platform-admin/passkeys/{id}/revoke — remove one of this admin's
 * own passkeys (revokedAt; nothing is deleted). FULL guard. Audited.
 */
import { NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { revokePasskey } from "@/lib/auth/admin-passkey.service";
import {
  NO_STORE,
  passkeyFailure,
  passkeyUnavailableResponse,
} from "@/lib/auth/admin-passkey-http";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;
  // Changing a factor needs a step-up from the last few minutes, not just a live one.
  const stale = freshStepUpRefusal(req, gate.id);
  if (stale) return stale;

  const { id } = await context.params;
  const passkeyId = Number(id);
  if (!Number.isInteger(passkeyId) || passkeyId <= 0) {
    return NextResponse.json({ error: "Invalid passkey id" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await revokePasskey(gate.id, passkeyId);
    if (!result.ok) {
      return NextResponse.json({ error: "Passkey not found" }, { status: 404, headers: NO_STORE });
    }
    await logPlatformAuditEvent({
      actorUserId: gate.id,
      action: PLATFORM_AUDIT_ACTIONS.PASSKEY_REVOKED,
      targetType: "USER",
      targetId: String(gate.id),
      metadata: { passkeyId, label: result.label ?? null },
      req,
    });
    return NextResponse.json({ revoked: true }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return passkeyUnavailableResponse(error) ?? passkeyFailure("ADMIN_PASSKEY_REVOKE_ERROR", error);
  }
}
