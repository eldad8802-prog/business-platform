import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
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

    const found = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const conversation = await tx.conversation.findFirst({
            where: {
              id: conversationId,
              businessId: user.businessId,
            },
            select: { id: true, status: true },
          });

          if (!conversation) return false;

          const now = new Date();

          await tx.replySuggestion.updateMany({
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

          // Tenant-scoped atomic transition (no id-only update).
          await tx.conversation.updateMany({
            where: { id: conversationId, businessId: user.businessId },
            data: {
              outcomeReason: HUMAN_TAKEOVER_OUTCOME_REASON,
            },
          });
          return true;
        })
    );

    if (!found) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

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
