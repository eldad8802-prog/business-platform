import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { getPlatformAdminBusinessDetail } from "@/lib/services/platform-admin/platform-business-detail.service";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

function parseBusinessId(raw: string): number {
  const id = Number(raw);
  if (!id || Number.isNaN(id) || !Number.isInteger(id) || id <= 0) {
    throw new ValidationError("Invalid business id");
  }
  return id;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { id } = await context.params;
    const businessId = parseBusinessId(id);
    const detail = await getPlatformAdminBusinessDetail(businessId);

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED,
      targetType: "BUSINESS",
      targetId: String(businessId),
      metadata: { businessName: detail.business.name },
      req,
    });

    return NextResponse.json(detail, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
