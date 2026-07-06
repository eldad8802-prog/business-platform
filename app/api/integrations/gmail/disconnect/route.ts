/**
 * POST /api/integrations/gmail/disconnect
 *
 * Owner-initiated disconnect of one Gmail connection (by `connectionId`).
 * Flips the connection to `revoked` and deletes its OAuthToken; the
 * EmailConnection row and its import history are preserved. Scoped to the
 * caller's business. Returns `404` when the connection is not found for this
 * business (idempotent).
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { disconnectGmailConnection } from "@/lib/services/integrations/gmail/gmail-connection.service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = (await req.json().catch(() => null)) as { connectionId?: unknown } | null;
  const connectionId =
    typeof json?.connectionId === "number" ? json.connectionId : Number(json?.connectionId);

  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: "Missing/invalid connectionId" }, { status: 400 });
  }

  try {
    const connection = await disconnectGmailConnection({
      businessId: user.businessId,
      connectionId,
    });
    if (!connection) {
      return NextResponse.json(
        { disconnected: false, reason: "no_connection" },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, disconnected: true, connection });
  } catch (error) {
    console.error("GMAIL_DISCONNECT_ERROR:", error);
    return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
