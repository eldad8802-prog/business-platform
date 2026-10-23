import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
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

    // Reads run on the admin plane (SELECT-only); the append runs on the
    // runtime's reviewed INSERT — see logPlatformAuditEvent.
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
          filterKind: query.kind ?? "all",
          filterBusinessId: query.businessId ?? null,
        },
        req,
      }
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
