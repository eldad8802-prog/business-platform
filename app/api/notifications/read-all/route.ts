import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { markAllNotificationsRead } from "@/lib/notifications/notification-read.service";

/**
 * Clear the badge.
 *
 * Included rather than deferred because a centre without it makes the owner tap
 * every item to get back to zero, which is the opposite of the five-minutes-a-
 * day promise. It is also the safest possible bulk write: the same predicate
 * the badge counts, scoped to the caller's business, setting one timestamp.
 *
 * It cannot reach resolved history or a dismissed item, and it resolves
 * nothing — the problems stay open, the owner has simply seen them.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const changed = await markAllNotificationsRead(user.businessId, new Date());

    return NextResponse.json({ ok: true, changed });
  } catch (error: unknown) {
    console.error("POST /api/notifications/read-all error:", error);

    return NextResponse.json(
      { error: "Failed to mark notifications read" },
      { status: 500 },
    );
  }
}
