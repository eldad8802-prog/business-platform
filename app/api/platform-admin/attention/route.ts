import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { getPlatformAdminAttention } from "@/lib/services/platform-admin/platform-attention.service";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const attention = await getPlatformAdminAttention();

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.ATTENTION_VIEWED,
      targetType: "SYSTEM",
      metadata: { itemCount: attention.items.length },
      req,
    });

    return NextResponse.json(attention, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
