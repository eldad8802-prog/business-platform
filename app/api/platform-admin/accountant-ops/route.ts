import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { getAccountantOps } from "@/lib/services/platform-admin/accountant-ops.service";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

/**
 * GET — the accountant package monitoring page (G5 milestone 1): open and recently resolved alerts, the latest
 * sweep and monitor runs, and the switches. Platform admin with a current step-up (the canonical guard); the read
 * runs on the admin plane (SELECT only) and every view is audited.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const result = await getAccountantOps();

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.ACCOUNTANT_OPS_VIEWED,
      targetType: "SYSTEM",
      metadata: result.available
        ? { available: true, openAlerts: result.openAlerts.length, sweepRuns: result.sweepRuns.length }
        : { available: false },
      req,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
