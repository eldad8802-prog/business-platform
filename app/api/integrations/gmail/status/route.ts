import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const connection = await prisma.emailConnection.findFirst({
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

    if (!connection || connection.status !== "connected") {
      return NextResponse.json({
        success: true,
        connected: false,
      });
    }

    return NextResponse.json({
      success: true,
      connected: true,
      emailAddress: connection.emailAddress,
      status: connection.status,
      lastSyncedAt: connection.lastSyncedAt,
    });
  } catch (error) {
    console.error("GMAIL_STATUS_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

