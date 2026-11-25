/**
 * GET /api/platform-admin/businesses/:id/usage — one business's quotas, usage, adjustments, history, recent units
 * (identifiers and amounts only, never document content) and estimated cost.
 */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { loadBusinessUsageAdmin } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await context.params;
  return adminRead(auth.id, () => loadBusinessUsageAdmin(id));
}
