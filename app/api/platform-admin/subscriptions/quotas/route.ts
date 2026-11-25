/**
 * GET   /api/platform-admin/subscriptions/quotas — the quota matrix (metric × tier), modes, opening values, unit costs.
 * PATCH /api/platform-admin/subscriptions/quotas — { metric, tier, quota, reason } changes one quota;
 *                                                  { metric, mode, reason } changes one metric's mode (OFF / SHADOW /
 *                                                  ENFORCE — effective only up to the server ceiling USAGE_QUOTA_MODE).
 * No deploy needed; every change is versioned, logged and audited in the database.
 */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { adminRead, adminWrite } from "@/lib/services/platform-admin/subscriptions-admin-http";
import { loadQuotaMatrix, setQuotaPolicy, setUsageMode } from "@/lib/services/platform-admin/subscriptions-admin.service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  return adminRead(auth.id, () => loadQuotaMatrix());
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePlatformAdminOrResponse(req);
  if (auth instanceof NextResponse) return auth;
  return adminWrite(req, auth.id, (adminId, body) => ("mode" in body ? setUsageMode(adminId, body) : setQuotaPolicy(adminId, body)));
}
