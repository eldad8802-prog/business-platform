import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getUploadsOverview } from "@/lib/money-uploads/uploads-overview.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * GET — the העלאת דוחות וקבצים screen (/money/uploads): where the bank card routes, what was brought in lately,
 * and what needs a look. READ-ONLY. The business comes from the session, never from the request; 401 without
 * one; anything unexpected is a 500 with no detail.
 */
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const overview = await getUploadsOverview(user.businessId);
    return NextResponse.json(overview, { headers: NO_STORE });
  } catch (e) {
    console.error("[money-uploads] overview failed", e instanceof Error ? e.name : "unknown");
    return NextResponse.json({ error: "INTERNAL" }, { status: 500, headers: NO_STORE });
  }
}
