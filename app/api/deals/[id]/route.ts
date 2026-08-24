import { NextResponse } from "next/server";
import { CollaborationDealStatus } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function PATCH(request: Request) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const pathnameParts = url.pathname.split("/");
    const dealId = pathnameParts[pathnameParts.length - 1];

    if (!dealId) {
      return NextResponse.json(
        { error: "Missing deal id" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { action } = body;

    let status: CollaborationDealStatus;
    let eventType: string;

    if (action === "ACCEPT") {
      status = CollaborationDealStatus.ACCEPTED;
      eventType = "DEAL_ACCEPTED";
    } else if (action === "DISMISS") {
      status = CollaborationDealStatus.DISMISSED;
      eventType = "DEAL_DISMISSED";
    } else {
      return NextResponse.json(
        { error: "Invalid action" },
        { status: 400 }
      );
    }

    // One tenant transaction: the status write carries the businessId predicate
    // itself (updateMany — no id-only mutation), and the learning event lands
    // atomically with it.
    const updatedDeal = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const existingDeal = await tx.collaborationDeal.findFirst({
            where: { id: dealId, businessId: user.businessId },
          });

          if (!existingDeal) {
            return null;
          }

          await tx.collaborationDeal.updateMany({
            where: { id: dealId, businessId: user.businessId },
            data: { status },
          });

          await tx.learningEvent.create({
            data: {
              businessId: existingDeal.businessId,
              eventType,
              entityType: "COLLABORATION_DEAL",
              entityId: null,
              payload: {
                dealId: existingDeal.id,
                title: existingDeal.title,
                partnerType: existingDeal.partnerType,
                actionType: existingDeal.actionType,
                estimatedValue: existingDeal.estimatedValue,
                matchScore: existingDeal.matchScore,
                priority: existingDeal.priority,
                sourceType: existingDeal.sourceType,
                newStatus: status,
              },
            },
          });

          return tx.collaborationDeal.findFirst({
            where: { id: dealId, businessId: user.businessId },
          });
        })
    );

    if (!updatedDeal) {
      return NextResponse.json(
        { error: "Deal not found", dealId },
        { status: 404 }
      );
    }

    return NextResponse.json(updatedDeal);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to update deal",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}