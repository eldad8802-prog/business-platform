/**
 * GET /api/settings/connections-summary — how many of the business's
 * connections are live, by the same states the Connections screen shows.
 * See lib/services/connections/connections-summary.service.ts.
 *
 * Read-only: it connects, refreshes and changes nothing. The business is the
 * session's; nothing in the request can name another one.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadConnectionsSummary } from "@/lib/services/connections/connections-summary.service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const summary = await loadConnectionsSummary({ businessId: user.businessId, userId: user.id });

    return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("CONNECTIONS_SUMMARY_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
