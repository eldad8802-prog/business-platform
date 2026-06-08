/**
 * POST /api/integrations/whatsapp/connection/disconnect
 *
 * Owner-initiated disconnect. Flips the connection's status to
 * `DISCONNECTED` and wipes the encrypted token blob so it cannot be
 * revived without re-seeding. The row itself is preserved as an audit
 * artifact of the `phoneNumberId` → `businessId` binding.
 *
 * Returns `404` if no connection exists for the caller's business
 * (idempotent — calling disconnect with no connection is not an error
 * state, just no-op).
 */

import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { disconnectByBusinessId } from "@/lib/services/integrations/whatsapp/connection.service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
    }

  try {
    const connection = await disconnectByBusinessId(user.businessId);
    if (!connection) {
      return NextResponse.json(
        { connection: null, disconnected: false, reason: "no_connection" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { connection, disconnected: true },
      { status: 200 }
    );
  } catch (err) {
    console.error("[whatsapp-connection-disconnect]", err);
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 }
    );
  }
}
