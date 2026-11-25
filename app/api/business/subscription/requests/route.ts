import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { getCurrentUser } from "@/lib/auth";
import { isSubscriptionPlan, PREMIUM_COMMERCIALLY_OPEN } from "@/lib/services/subscriptions/plan-catalog";
import { isQuotaMetric } from "@/lib/services/subscriptions/usage/usage-metrics";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

/**
 * POST /api/business/subscription/requests — "I'm interested" (decision 14) and "I need more" (quota increase).
 *   { kind: "PLAN", requestedPlan: "BASIC" | "ADVANCED" }       — Premium is not open commercially ("בקרוב")
 *   { kind: "QUOTA", metric: <quota metric>, note?: string }
 * No payment, no plan change: the request reaches the admin console, which assigns the plan or the quota manually.
 * One open request per subject — a repeated click answers the same open request (200), never a second one.
 * Session only; the business comes from the session (the database policy refuses any other business).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400, headers: NO_STORE });
  }
  const kind = body.kind;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  let requestedPlan: string | null = null;
  let metric: string | null = null;
  if (kind === "PLAN") {
    if (!isSubscriptionPlan(body.requestedPlan)) return NextResponse.json({ error: "INVALID_PLAN" }, { status: 400, headers: NO_STORE });
    if (body.requestedPlan === "PREMIUM" && !PREMIUM_COMMERCIALLY_OPEN) {
      return NextResponse.json({ error: "PREMIUM_NOT_OPEN" }, { status: 409, headers: NO_STORE });
    }
    requestedPlan = body.requestedPlan;
  } else if (kind === "QUOTA") {
    if (!isQuotaMetric(body.metric)) return NextResponse.json({ error: "INVALID_METRIC" }, { status: 400, headers: NO_STORE });
    metric = body.metric;
  } else {
    return NextResponse.json({ error: "INVALID_KIND" }, { status: 400, headers: NO_STORE });
  }

  const businessId = user.businessId;
  try {
    const id = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: bigint }[]>`
          INSERT INTO "PlatformSubscriptionRequest" ("businessId", "kind", "requestedPlan", "metric", "note", "createdByUserId")
          VALUES (${businessId}, ${kind}, ${requestedPlan}, ${metric}, ${note}, ${user.id}) RETURNING "id"`;
        return rows[0]!.id.toString();
      }),
    );
    return NextResponse.json({ requestId: id, created: true }, { status: 201, headers: NO_STORE });
  } catch (error) {
    // The partial unique index: an open request for the same subject already exists — the same request, not a new one.
    if (
      (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2010")) ||
      (error instanceof Error && /unique|23505/i.test(error.message))
    ) {
      return NextResponse.json({ created: false, alreadyOpen: true }, { status: 200, headers: NO_STORE });
    }
    console.error("[subscription] request failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "REQUEST_FAILED" }, { status: 500, headers: NO_STORE });
  }
}
