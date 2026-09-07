import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { markNotificationRead } from "@/lib/notifications/notification-read.service";

/**
 * Mark one notification read.
 *
 * Consumption state only. It does not resolve the notification, does not touch
 * the cooldown anchor or the dedupe key, creates no delivery row, and runs
 * neither the policy nor business-status. The owner having seen a problem is
 * not the same as the problem being over.
 *
 * The id comes from the path and the tenant from the session; the two are
 * combined in the update predicate, so another business's id matches no row.
 * A repeat is a no-op rather than a moved timestamp.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(request);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const notificationId = Number(id);

    if (!Number.isInteger(notificationId) || notificationId < 1) {
      return NextResponse.json({ error: "Invalid notification id" }, { status: 400 });
    }

    const result = await markNotificationRead(user.businessId, notificationId, new Date());

    // An id that is not this tenant's is indistinguishable from one that does
    // not exist. That is deliberate: a 403 here would confirm the row exists.
    if (!result.found) {
      return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, changed: result.changed });
  } catch (error: unknown) {
    console.error("POST /api/notifications/[id]/read error:", error);

    return NextResponse.json(
      { error: "Failed to mark notification read" },
      { status: 500 },
    );
  }
}
