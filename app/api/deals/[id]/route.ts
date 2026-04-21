import { NextResponse } from "next/server";
import {
  PrismaClient,
  CollaborationDealStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

export async function PATCH(request: Request) {
  try {
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

    const existingDeal = await prisma.collaborationDeal.findUnique({
      where: { id: dealId },
    });

    if (!existingDeal) {
      return NextResponse.json(
        { error: "Deal not found", dealId },
        { status: 404 }
      );
    }

    const updatedDeal = await prisma.collaborationDeal.update({
      where: { id: dealId },
      data: { status },
    });

    await prisma.learningEvent.create({
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