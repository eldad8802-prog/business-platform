import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await context.params;
    const conversationId = Number(id);

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        businessId: user.businessId,
      },
    });

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      conversation: updated,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        error: "Failed to close conversation",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}