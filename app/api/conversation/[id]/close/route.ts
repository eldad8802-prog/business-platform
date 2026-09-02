import { NextResponse } from "next/server";
import { tenantTx } from "@/lib/tenant/tenant-tx";
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

    // CUTOVER-2A: ownership check + write in ONE tenant transaction (see the
    // sibling route). A context-less check returns nothing under FORCE RLS, which
    // would read as "not found" for a row the tenant owns.
    const updatedConversation = await tenantTx(user.businessId, async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: {
          id: conversationId,
          businessId: user.businessId,
        },
      });
      if (!conversation) return null;

      return tx.conversation.update({
        where: {
          id: conversationId,
        },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
        },
      });
    });

    if (!updatedConversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

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