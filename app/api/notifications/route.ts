import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import {
  clampLimit,
  listNotifications,
} from "@/lib/notifications/notification-read.service";

/**
 * The notification centre's list.
 *
 * Read-only in the strict sense: it creates no business fact, marks nothing
 * read, and never runs the policy or the writer. Opening the centre must not
 * change what the centre says.
 *
 * `unreadCount` rides along so a phone renders its header in one request.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = clampLimit(searchParams.get("limit"));

    const cursorRaw = searchParams.get("cursor");
    let cursor: number | null = null;
    if (cursorRaw !== null && cursorRaw !== "") {
      const parsed = Number(cursorRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
      }
      cursor = parsed;
    }

    // The tenant is the caller's own business, taken from the session. No
    // businessId is read from the query or the body anywhere in this route.
    const page = await listNotifications(user.businessId, {
      limit,
      cursor,
      unreadOnly: searchParams.get("unreadOnly") === "true",
    });

    return NextResponse.json(page);
  } catch (error: unknown) {
    console.error("GET /api/notifications error:", error);

    return NextResponse.json(
      { error: "Failed to load notifications" },
      { status: 500 },
    );
  }
}
