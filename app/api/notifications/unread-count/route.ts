import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { countUnread } from "@/lib/notifications/notification-read.service";

/**
 * The badge. Separate from the list so polling it costs one indexed count and
 * carries no rows, and it uses the same predicate as the list's own
 * `unreadCount`, so the two can never disagree.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({ unreadCount: await countUnread(user.businessId) });
  } catch (error: unknown) {
    console.error("GET /api/notifications/unread-count error:", error);

    return NextResponse.json(
      { error: "Failed to count notifications" },
      { status: 500 },
    );
  }
}
