import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { getPrismaAdmin } from "@/lib/prisma-admin";
import { handleError } from "@/lib/handle-error";
import {
  PLATFORM_AUDIT_ACTIONS,
} from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
import { getPlatformAdminOverview } from "@/lib/services/platform-admin/platform-overview.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const overview = await getPlatformAdminOverview();

    // Migrated route (D2/P7 Wave 2): overview reads + the audit append run as
    // the admin role — no tenant-Prisma fallback on this path.
    await logPlatformAuditEvent(
      {
        actorUserId: auth.id,
        action: PLATFORM_AUDIT_ACTIONS.OVERVIEW_VIEWED,
        targetType: "SYSTEM",
        req,
      },
      { db: getPrismaAdmin() }
    );

    return NextResponse.json(overview, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
