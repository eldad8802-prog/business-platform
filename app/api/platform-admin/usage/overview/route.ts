import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
import { getPlatformUsageOverview } from "@/lib/services/platform-admin/platform-usage-overview.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const overview = await getPlatformUsageOverview();

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.USAGE_OVERVIEW_VIEWED,
      targetType: "SYSTEM",
      req,
    });

    return NextResponse.json(overview, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
