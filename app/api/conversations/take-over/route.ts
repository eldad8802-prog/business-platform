import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { HUMAN_TAKEOVER_OUTCOME_REASON } from "@/lib/features/conversation/bot-control";

const PENDING_BOT_DRAFT_STATUSES = ["GENERATED", "SHOWN", "SELECTED"] as const;

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const conversationId = Number(body.conversationId);
    if (!conversationId || !Number.isFinite(conversationId)) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        businessId: user.businessId,
      },
      select: { id: true, status: true },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const now = new Date();

    await prisma.replySuggestion.updateMany({
      where: {
        businessId: user.businessId,
        conversationId,
        suggestionType: "STARTER_BOT_DRAFT",
        status: { in: [...PENDING_BOT_DRAFT_STATUSES] },
      },
      data: {
        status: "DISMISSED",
        dismissedAt: now,
      },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        outcomeReason: HUMAN_TAKEOVER_OUTCOME_REASON,
      },
    });

    return NextResponse.json({
      success: true,
      conversationId,
      humanTakeover: true,
    });
  } catch (error) {
    console.error("POST /api/conversations/take-over error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
