/**
 * POST /api/platform-admin/subscriptions/quotas/preview — { metric, tier, quota }: how many customers on that tier are
 * already above the proposed quota in their current period. Read-only: the impact BEFORE a change is approved.
 */
import { NextRequest } from "next/server";

import { adminRead } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { previewQuotaChange } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return adminRead(req, () => previewQuotaChange(body.metric, body.tier, body.quota));
}
