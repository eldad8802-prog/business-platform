/**
 * POST /api/platform-admin/businesses/:id/usage/adjustments — { metric, kind: ADD | OVERRIDE, amount, endsAt?, reason }:
 * an addition to the plan's quota, or a special quota, for this business. Audited in the same statement.
 */
import { NextRequest } from "next/server";

import { adminWrite } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { addQuotaAdjustment } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminWrite(req, (adminId, body) => addQuotaAdjustment(adminId, id, body));
}
