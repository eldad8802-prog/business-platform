/**
 * POST /api/platform-admin/mfa/replace/confirm — prove a code from the NEW
 * authenticator, then swap it in atomically.
 *
 * FULL guard plus a step-up from the last 5 minutes. The swap is one update that
 * matches only while the old seed is still stored, so the envelope is single use.
 * From that moment the old authenticator and the old recovery codes stop working;
 * the new recovery codes are returned EXACTLY ONCE. Audited.
 */
import { NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { confirmAdminMfaReplacement } from "@/lib/auth/admin-mfa.service";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(req: Request) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;
  const stale = freshStepUpRefusal(req, gate.id);
  if (stale) return stale;

  const body = (await req.json().catch(() => null)) as { code?: unknown; replacementToken?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code || typeof body?.replacementToken !== "string") {
    return NextResponse.json({ error: "Missing code" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await confirmAdminMfaReplacement(gate.id, body.replacementToken, code);
    if (!result.ok) {
      const status = result.reason === "invalid_code" ? 401 : 409;
      return NextResponse.json({ error: "Could not replace", code: result.reason }, { status, headers: NO_STORE });
    }

    await logPlatformAuditEvent({
      actorUserId: gate.id,
      action: PLATFORM_AUDIT_ACTIONS.MFA_REPLACED,
      targetType: "USER",
      targetId: String(gate.id),
      req,
    });

    return NextResponse.json(
      { replaced: true, recoveryCodes: result.recoveryCodes },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    console.error("ADMIN_MFA_REPLACE_CONFIRM_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Replacement failed" }, { status: 500 });
  }
}
