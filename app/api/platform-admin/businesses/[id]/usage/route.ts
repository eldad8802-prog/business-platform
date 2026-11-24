/**
 * GET /api/platform-admin/businesses/:id/usage — one business's quotas, usage, adjustments, history, recent units
 * (identifiers and amounts only, never document content) and estimated cost.
 */
import { NextRequest } from "next/server";

import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { loadBusinessUsageAdmin } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminRead(req, () => loadBusinessUsageAdmin(id));
}
