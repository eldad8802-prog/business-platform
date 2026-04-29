import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InventoryMovementReason } from "@prisma/client";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { createPendingMatch } from "@/lib/services/inventory/pending-match.service";

// 🔐 זה key זמני - בהמשך נכניס ל-DB
const POS_SECRET = "POS_SECRET_123";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

type POSSaleItem = {
  sku?: string | null;
  barcode?: string | null;
  name?: string | null;
  quantity: number;
};

export async function POST(request: NextRequest) {
  try {
    // 🔐 אימות חיבור קופה
    const key = request.headers.get("x-pos-key");

    if (!key || key !== POS_SECRET) {
      return unauthorized();
    }

    const body = await request.json();

    const { externalSaleId, source = "POS", businessId, items } = body;

    if (!externalSaleId || !businessId || !Array.isArray(items)) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // 🛑 מניעת כפילות (רק אם כבר עובדה בפועל)
    const existingProcessedSale = await prisma.inventoryExternalSale.findUnique({
      where: {
        businessId_externalSaleId: {
          businessId,
          externalSaleId,
        },
      },
    });

    if (existingProcessedSale) {
      return NextResponse.json({
        success: true,
        skipped: true,
        message: "Sale already processed",
      });
    }

    const validItems: POSSaleItem[] = items
      .map((item: POSSaleItem) => ({
        sku: item.sku ?? null,
        barcode: item.barcode ?? null,
        name: item.name ?? null,
        quantity: Number(item.quantity),
      }))
      .filter((item: POSSaleItem) => item.quantity > 0);

    if (validItems.length === 0) {
      return NextResponse.json(
        { error: "Sale has no valid items" },
        { status: 400 }
      );
    }

    const matchedItems: {
      itemId: number;
      quantity: number;
      sku: string | null;
      barcode: string | null;
      name: string | null;
    }[] = [];

    const unmatchedItems: {
      sku: string | null;
      barcode: string | null;
      name: string | null;
      quantity: number;
    }[] = [];

    for (const item of validItems) {
      let inventoryItem = null;

      if (item.sku) {
        inventoryItem = await prisma.inventoryItem.findFirst({
          where: {
            businessId,
            sku: item.sku,
            isActive: true,
          },
        });
      }

      if (!inventoryItem && item.barcode) {
        inventoryItem = await prisma.inventoryItem.findFirst({
          where: {
            businessId,
            barcode: item.barcode,
            isActive: true,
          },
        });
      }

      if (!inventoryItem) {
        unmatchedItems.push({
          sku: item.sku ?? null,
          barcode: item.barcode ?? null,
          name: item.name ?? null,
          quantity: item.quantity,
        });

        continue;
      }

      matchedItems.push({
        itemId: inventoryItem.id,
        quantity: item.quantity,
        sku: item.sku ?? null,
        barcode: item.barcode ?? null,
        name: item.name ?? null,
      });
    }

    // ❗ אם יש אפילו פריט אחד לא מזוהה → הכל עובר ל-PENDING
    if (unmatchedItems.length > 0) {
      const firstUnmatched = unmatchedItems[0];

      const pendingMatch = await createPendingMatch({
        businessId,
        externalSaleId,
        metadata: {
          externalSaleId,
          sku: firstUnmatched.sku,
          barcode: firstUnmatched.barcode,
          name: firstUnmatched.name,
          quantity: unmatchedItems.reduce(
            (sum, item) => sum + item.quantity,
            0
          ),
          source,
          unmatchedItems,
          allItems: validItems.map((item) => ({
            sku: item.sku ?? null,
            barcode: item.barcode ?? null,
            name: item.name ?? null,
            quantity: item.quantity,
          })),
        },
      });

      return NextResponse.json({
        success: true,
        pending: true,
        message: "Sale contains unmatched items and was moved to pending",
        pendingMatch,
      });
    }

    // 📦 אם הכל תואם → מבצעים movement רגיל
    const movements = [];

    for (const matchedItem of matchedItems) {
      const movement = await inventoryService.removeStock({
        businessId,
        itemId: matchedItem.itemId,
        quantityDelta: matchedItem.quantity,
        reason: InventoryMovementReason.SALE,
      });

      movements.push(movement);
    }

    // 💾 רק אחרי עיבוד מלא
    await prisma.inventoryExternalSale.create({
      data: {
        businessId,
        externalSaleId,
        source,
      },
    });

    return NextResponse.json({
      success: true,
      pending: false,
      movements,
    });
  } catch (err) {
    console.error("POS SALE ERROR:", err);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}