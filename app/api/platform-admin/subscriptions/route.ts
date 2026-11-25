/** GET /api/platform-admin/subscriptions — every business, its subscription state, open requests and unusual usage. */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { loadSubscriptionsOverview } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  return adminRead(auth.id, () => loadSubscriptionsOverview());
}
