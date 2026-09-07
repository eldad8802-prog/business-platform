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

    // CUTOVER-2A: the ownership check and the write belong in ONE tenant
    // transaction. Split across the global client they carry no
    // `app.current_business_id`, and under the restricted runtime the check would
    // silently find nothing — turning "closed successfully" into a 404 for rows the
    // tenant actually owns.
    const updated = await tenantTx(user.businessId, async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: {
          id: conversationId,
          businessId: user.businessId,
        },
      });
      if (!conversation) return null;

      return tx.conversation.update({
        where: { id: conversationId },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
        },
      });
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    // AFTER the close has committed. The sibling close route does the same for
    // the same reason: a closed conversation is no longer waiting, and a
    // notification left open would point at something nobody can answer.
    // `tenantTx` closed its context with its transaction, so it is re-entered.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      syncInboxWaitingNotifications(user.businessId, conversationId, new Date())
    );

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