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

    if (!conversationId || Number.isNaN(conversationId)) {
      return NextResponse.json(
        { error: "Invalid conversation id" },
        { status: 400 }
      );
    }

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

    const updatedConversation = await prisma.conversation.update({
      where: {
        id: conversationId,
      },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      conversation: updatedConversation,
    });
  } catch (error: any) {
    console.error("POST /api/conversation/[id]/close error:", error);

    return NextResponse.json(
      {
        error: "Failed to close conversation",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}