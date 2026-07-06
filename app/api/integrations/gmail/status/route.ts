import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const connections = await prisma.emailConnection.findMany({
      where: {
        businessId: user.businessId,
        provider: "gmail",
      },
      select: {
        id: true,
        emailAddress: true,
        status: true,
        lastSyncedAt: true,
      },
      orderBy: { id: "desc" },
    });

    // Backward-compatible summary fields: the first still-connected account.
    // IntegrationStatusCards and the current single-account import flow read
    // `connected` / `emailAddress`; the new `connections` array powers the
    // multi-account management UI.
    const primary = connections.find((c) => c.status === "connected") ?? null;

    return NextResponse.json({
      success: true,
      connected: Boolean(primary),
      emailAddress: primary?.emailAddress ?? undefined,
      status: primary?.status,
      lastSyncedAt: primary?.lastSyncedAt,
      connections,
    });
  } catch (error) {
    console.error("GMAIL_STATUS_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
