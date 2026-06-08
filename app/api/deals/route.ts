import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

const prisma = new PrismaClient();

// 📌 GET deals
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const deals = await prisma.collaborationDeal.findMany({
      where: { businessId: user.businessId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(deals);
  } catch (error) {
    console.error("GET /api/deals error:", error);

    return NextResponse.json(
      { error: "Failed to fetch deals" },
      { status: 500 }
    );
  }
}