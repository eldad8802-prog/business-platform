import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InventoryMovementReason } from "@prisma/client";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { createPendingMatch } from "@/lib/services/inventory/pending-match.service";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";

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
    // 🔐 POS key auth — per-business API key lookup.
    const rawKey = request.headers.get("x-pos-key");

    if (!rawKey) {
      return unauthorized();
    }

    const keyHash = sha256Hex(Buffer.from(rawKey, "utf8"));

    let businessId: number;
    let source: string;
    let apiKeyId: number | null = null;

    const dbKey = await prisma.pOSApiKey.findUnique({
      where: { keyHash },
      select: { id: true, businessId: true, source: true, active: true },
    });

    if (dbKey && dbKey.active) {
      // Per-business key found — source is locked to the key, not the request body.
      businessId = dbKey.businessId;
      source = dbKey.source;
      apiKeyId = dbKey.id;
    } else {
      // Fallback: legacy single-tenant env vars. Allows existing deployments to
      // keep working while per-business key rollout is in progress.
      const envSecret = process.env.POS_INGEST_SECRET?.trim();
      const envBusinessId = Number(process.env.POS_INGEST_BUSINESS_ID);

      if (
        !envSecret ||
        rawKey !== envSecret ||
        !envBusinessId ||
        Number.isNaN(envBusinessId)
      ) {
        return unauthorized();
      }

      businessId = envBusinessId;
      source = "POS";
    }

    const ip = getClientIp(request);
    const ipLimit = consumeRateLimit({
      key: `inventory:pos:sale:ip:${ip}`,
      limit: 120,
      windowMs: 60_000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const businessLimit = consumeRateLimit({
      key: `inventory:pos:sale:business:${businessId}`,
      limit: 600,
      windowMs: 60_000,
    });
    if (!businessLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    // Fire-and-forget lastUsedAt — does not block the ingest flow.
    if (apiKeyId !== null) {
      prisma.pOSApiKey
        .update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }

    const body = await request.json();

    const { externalSaleId, items } = body;

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
      // Step 1: POSProductMapping — human-verified mapping takes priority.
      // Single OR query avoids separate sku/barcode round-trips.
      if (item.sku || item.barcode) {
        const posOrConditions: { sku?: string; barcode?: string }[] = [];
        if (item.sku) posOrConditions.push({ sku: item.sku });
        if (item.barcode) posOrConditions.push({ barcode: item.barcode });

        const mapping = await prisma.pOSProductMapping.findFirst({
          where: { businessId, source, OR: posOrConditions },
          select: { itemId: true },
        });

        if (mapping) {
          matchedItems.push({
            itemId: mapping.itemId,
            quantity: item.quantity,
            sku: item.sku ?? null,
            barcode: item.barcode ?? null,
            name: item.name ?? null,
          });
          continue;
        }
      }

      // Step 2: InventoryItem direct lookup — fallback when no mapping exists yet.
      let inventoryItem = null;

      if (item.sku) {
        inventoryItem = await prisma.inventoryItem.findFirst({
          where: { businessId, sku: item.sku, isActive: true },
        });
      }

      if (!inventoryItem && item.barcode) {
        inventoryItem = await prisma.inventoryItem.findFirst({
          where: { businessId, barcode: item.barcode, isActive: true },
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