/** POST /api/platform-admin/businesses/:id/usage/adjustments/:adjustmentId — { reason }: end an adjustment early. */
import { NextRequest } from "next/server";

import { adminWrite } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { revokeQuotaAdjustment } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ adjustmentId: string }> }) {
  const { adjustmentId } = await context.params;
  return adminWrite(req, (adminId, body) => revokeQuotaAdjustment(adminId, adjustmentId, body));
}
