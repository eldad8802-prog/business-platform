import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const conversations = await prisma.conversation.findMany({
  where: {
    businessId: user.businessId,
  },
  orderBy: {
    updatedAt: "desc",
  },
  include: {
    customer: true,
    lead: true,
  },
});

    return NextResponse.json(
      {
        success: true,
        conversations,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("GET /api/conversations error:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch conversations",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const conversation = await prisma.conversation.create({
      data: {
        businessId: user.businessId,
        customerId: body.customerId ?? null,
        leadId: body.leadId ?? null,
        channel: body.channel ?? "WHATSAPP",
        status: "OPEN",
        currentStage: "NEW",
        startedAt: new Date(),
      },
      include: {
        customer: true,
        lead: true,
      },
    });

    return NextResponse.json(
      {
        success: true,
        conversation,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("POST /api/conversations error:", error);

    return NextResponse.json(
      {
        error: "Failed to create conversation",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}