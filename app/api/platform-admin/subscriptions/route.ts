/** GET /api/platform-admin/subscriptions — every business, its subscription state, open requests and unusual usage. */
import { NextRequest } from "next/server";

import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { loadSubscriptionsOverview } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return adminRead(req, () => loadSubscriptionsOverview());
}
