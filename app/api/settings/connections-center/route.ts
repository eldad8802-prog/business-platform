/**
 * GET /api/settings/connections-center — every connection of the business, grouped by what it
 * means, with its state, last activity, what it provides and what needs the owner.
 * See lib/services/connections/connections-center.service.ts.
 *
 * Read-only: it connects, refreshes and changes nothing. The business is the
 * session's; nothing in the request can name another one.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadConnectionsCenter } from "@/lib/services/connections/connections-center.service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const center = await loadConnectionsCenter({ businessId: user.businessId, userId: user.id });

    return NextResponse.json(center, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("CONNECTIONS_CENTER_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
