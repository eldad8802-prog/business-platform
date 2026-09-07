import { NextResponse } from "next/server";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { runWithTenantContext } from "@/lib/tenant/context";
import { syncInboxWaitingNotifications } from "@/lib/notifications/inbox-waiting-notifications";
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

    // AFTER the close has committed. Closing a conversation ends the wait just
    // as answering it does, so this path has to reconcile too — otherwise a
    // notification would stay open pointing at a conversation nobody can reply
    // to any more. `tenantTx` closed its context with its transaction, so the
    // context is re-entered here; the writer refuses to run without a
    // server-derived tenant.
    //
    // It cannot affect the response: the close is already durable and the sync
    // swallows its own errors and returns them as data.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      syncInboxWaitingNotifications(user.businessId, conversationId, new Date())
    );

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