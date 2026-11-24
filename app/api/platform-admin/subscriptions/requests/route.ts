/** GET /api/platform-admin/subscriptions/requests?status=OPEN|HANDLED|DISMISSED — plan-interest and quota requests. */
import { NextRequest } from "next/server";

import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { listSubscriptionRequests } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams.get("status");
  const status = s === "HANDLED" || s === "DISMISSED" ? s : "OPEN";
  return adminRead(req, async () => ({ requests: await listSubscriptionRequests(status) }));
}
