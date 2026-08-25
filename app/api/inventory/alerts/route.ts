import { NextRequest, NextResponse } from "next/server";
import { InventoryAlertType } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const typeParam = request.nextUrl.searchParams.get("type");
    const isResolvedParam = request.nextUrl.searchParams.get("isResolved");

    const where: {
      businessId: number;
      type?: InventoryAlertType;
      isResolved?: boolean;
    } = {
      businessId: user.businessId,
    };

    if (
      typeParam &&
      Object.values(InventoryAlertType).includes(typeParam as InventoryAlertType)
    ) {
      where.type = typeParam as InventoryAlertType;
    }

    if (isResolvedParam === "true") {
      where.isResolved = true;
    }

    if (isResolvedParam === "false") {
      where.isResolved = false;
    }

    const alerts = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.inventoryAlert.findMany({
      where,
      orderBy: {
        createdAt: "desc",
      },
      include: {
        item: {
          select: {
            id: true,
            name: true,
            currentQuantity: true,
            imageUrl: true,
            sku: true,
            barcode: true,
          },
        },
      },
          })
        )
    );

    return NextResponse.json({
      success: true,
      alerts,
    });
  } catch (error) {
    console.error("Inventory alerts route error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}