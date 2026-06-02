import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
import {
  listPlatformBusinesses,
  parseListPlatformBusinessesQuery,
} from "@/lib/services/platform-admin/platform-businesses.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { searchParams } = new URL(req.url);
    const query = parseListPlatformBusinessesQuery(searchParams);
    const result = await listPlatformBusinesses(query);

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.BUSINESSES_LIST_VIEWED,
      targetType: "SYSTEM",
      metadata: {
        page: query.page,
        limit: query.limit,
        total: result.pagination.total,
      },
      req,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
