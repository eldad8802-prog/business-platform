import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { dailyTasksEnabled } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — stop push to this browser: { endpoint }. The row stays (the runtime has no removal privilege); it is
 * marked revoked and the dispatcher never addresses it again. Only the session's business is touched.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Push serves task reminders only: while daily_tasks is off for the business, it does not exist.
    if (!(await dailyTasksEnabled(user.businessId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const b = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
    if (!endpoint || endpoint.length > 1024) return NextResponse.json({ error: "INVALID_ENDPOINT" }, { status: 400 });
    const businessId = user.businessId;
    const n = await tenantTx(businessId, (tx) =>
      tx.pushSubscription.updateMany({ where: { businessId, endpoint, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
    return NextResponse.json({ ok: true, revoked: n.count });
  } catch {
    console.error("[push] revoke failed");
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
