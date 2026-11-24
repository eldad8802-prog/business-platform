/** GET /api/platform-admin/subscriptions/requests?status=OPEN|HANDLED|DISMISSED — plan-interest and quota requests. */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { listSubscriptionRequests } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  const s = req.nextUrl.searchParams.get("status");
  const status = s === "HANDLED" || s === "DISMISSED" ? s : "OPEN";
  return adminRead(auth.id, async () => ({ requests: await listSubscriptionRequests(status) }));
}
