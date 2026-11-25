/**
 * POST /api/platform-admin/subscriptions/requests/:requestId — { status: HANDLED | DISMISSED, note? }. Assigning the
 * plan itself is the business's subscription PATCH (stage B path); this closes the request, audited.
 */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { adminWrite } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { resolveSubscriptionRequest } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ requestId: string }> }) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  const { requestId } = await context.params;
  return adminWrite(req, auth.id, (adminId, body) => resolveSubscriptionRequest(adminId, requestId, body));
}
