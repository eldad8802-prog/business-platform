/** POST /api/platform-admin/businesses/:id/usage/adjustments/:adjustmentId — { reason }: end an adjustment early. */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { adminWrite } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { revokeQuotaAdjustment } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ adjustmentId: string }> }) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  const { adjustmentId } = await context.params;
  return adminWrite(req, auth.id, (adminId, body) => revokeQuotaAdjustment(adminId, adjustmentId, body));
}
