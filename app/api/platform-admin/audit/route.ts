import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { getPrismaAdmin } from "@/lib/prisma-admin";
import { handleError } from "@/lib/handle-error";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
import {
  listPlatformAuditEvents,
  parseListPlatformAuditQuery,
} from "@/lib/services/platform-admin/platform-audit-list.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { searchParams } = new URL(req.url);
    const query = parseListPlatformAuditQuery(searchParams);
    const result = await listPlatformAuditEvents(query);

    // Migrated route (D2/P7-W2-GATE): the audit append runs as the admin role
    // — the one approved admin write. No tenant-Prisma fallback on this path.
    await logPlatformAuditEvent(
      {
        actorUserId: auth.id,
        action: PLATFORM_AUDIT_ACTIONS.AUDIT_VIEWED,
        targetType: "SYSTEM",
        metadata: {
          page: query.page,
          limit: query.limit,
          total: result.pagination.total,
          filterAction: query.action ?? null,
          filterActorUserId: query.actorUserId ?? null,
        },
        req,
      },
      { db: getPrismaAdmin() }
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
