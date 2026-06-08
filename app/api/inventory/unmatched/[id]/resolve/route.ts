import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  rejectPendingMatch,
  resolvePendingMatchWithExistingItem,
  resolvePendingMatchWithNewItem,
} from "@/lib/services/inventory/pending-match.service";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(request);

    if (!user) {
      return authRequiredResponse(request);
    }

    if (!user.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const pendingMatchId = Number(id);

    if (!pendingMatchId || Number.isNaN(pendingMatchId)) {
      return NextResponse.json(
        { error: "Invalid pending match id" },
        { status: 400 }
      );
    }

    const body = await request.json();

    if (body.action === "LINK_EXISTING") {
      const itemId = Number(body.itemId);

      if (!itemId || Number.isNaN(itemId)) {
        return NextResponse.json(
          { error: "itemId is required" },
          { status: 400 }
        );
      }

      const result = await resolvePendingMatchWithExistingItem({
        pendingMatchId,
        businessId: user.businessId,
        userId: user.id,
        itemId,
      });

      return NextResponse.json(result);
    }

    if (body.action === "CREATE_NEW") {
      if (!body.itemData?.name || !body.itemData?.unitType) {
        return NextResponse.json(
          { error: "itemData.name and itemData.unitType are required" },
          { status: 400 }
        );
      }

      const result = await resolvePendingMatchWithNewItem({
        pendingMatchId,
        businessId: user.businessId,
        userId: user.id,
        itemData: {
          name: body.itemData.name,
          unitType: body.itemData.unitType,
          minimumQuantity: body.itemData.minimumQuantity,
          reorderPoint: body.itemData.reorderPoint,
          costPerUnit: body.itemData.costPerUnit,
          sellPricePerUnit: body.itemData.sellPricePerUnit,
          sku: body.itemData.sku ?? null,
          barcode: body.itemData.barcode ?? null,
        },
      });

      return NextResponse.json(result);
    }

    if (body.action === "REJECT") {
      const result = await rejectPendingMatch({
        pendingMatchId,
        businessId: user.businessId,
        userId: user.id,
      });

      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: "Invalid resolve action" },
      { status: 400 }
    );
  } catch (error) {
    console.error("POST /api/inventory/unmatched/[id]/resolve error:", error);

    return NextResponse.json(
      { error: "Failed to resolve pending match" },
      { status: 500 }
    );
  }
}