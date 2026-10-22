import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
import { getPlatformAdminHome } from "@/lib/services/platform-admin/platform-home.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/platform-admin/home — the Admin Control Center home figures (A1).
 * Read-only, admin + MFA. Reads on the admin plane; a missing plane answers
 * 503 ADMIN_DATA_PLANE_UNAVAILABLE rather than a misleading zero.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const home = await getPlatformAdminHome();

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.HOME_VIEWED,
      targetType: "SYSTEM",
      req,
    });

    return NextResponse.json(home, {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleError(error);
  }
}
