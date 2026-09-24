import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InventoryMovementReason } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";
import { createPendingMatch } from "@/lib/services/inventory/pending-match.service";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { secretsEqual } from "@/lib/security/constant-time";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { MAX_LIST, MAX_STRING } from "@/lib/sensors/sensor.contract";
import type { Prisma } from "@prisma/client";

function clip(value: unknown): string {
  const s = String(value);
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
}

/**
 * Evidence of what this POS delivery did. The caller is an external system
 * authenticated by its key, so actor and source are both INTEGRATION.
 */
function recordPosSaleSensor(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    entityId: number | null;
    externalSaleId: unknown;
    posSource: string;
    movementIds: number[];
    lineCount: number;
    outcome: "APPLIED" | "HELD_FOR_MATCH";
  }
) {
  const saleId = clip(input.externalSaleId);
  return recordSensor(
    {
      businessId: input.businessId,
      sensor: "POS_SALE_INGESTED",
      entityId: input.entityId,
      actor: { type: "INTEGRATION" },
      source: "INTEGRATION",
      payload: {
        externalSaleId: saleId,
        posSource: clip(input.posSource),
        movementIds: input.movementIds.slice(0, MAX_LIST),
        lineCount: input.lineCount,
        outcome: input.outcome,
      },
      // Outcome-scoped: a sale held for matching can later be redelivered and
      // applied in full (no ExternalSale row exists while it is held), and that
      // second, different occurrence must not be swallowed by the first's key.
      // Keyed on a hash of the FULL external id: the payload copy is clipped to 100 characters, and two
      // ids sharing a 100-character prefix must not collapse into one fact.
      idempotencyKey: `pos-sale:${sha256Hex(Buffer.from(String(input.externalSaleId), "utf8"))}:${input.outcome === "APPLIED" ? "applied" : "held"}`,
    },
    { tx }
  );
}

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
    // L-11: the per-address limiter runs BEFORE key authentication, so it also
    // caps guessing of the key (it used to run only after a key was accepted).
    const ip = getClientIp(request);
    const ipLimit = await consumeRateLimit({
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
        // L-11: constant-time (was `!==`).
        !secretsEqual(rawKey, envSecret) ||
        !envBusinessId ||
        Number.isNaN(envBusinessId)
      ) {
        return unauthorized();
      }

      businessId = envBusinessId;
      source = "POS";
    }

    const businessLimit = await consumeRateLimit({
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

    // D2/P7 Wave 3: the trusted, server-resolved businessId (POSApiKey row /
    // env fallback — never the request body) becomes the explicit tenant
    // context, and the WHOLE ingest (dedup, matching, movements/pending,
    // external-sale record) runs atomically on one GUC-carrying transaction.
    const outcome = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(
        async (tx) => {
    // 🛑 מניעת כפילות (רק אם כבר עובדה בפועל)
    const existingProcessedSale = await tx.inventoryExternalSale.findUnique({
      where: {
        businessId_externalSaleId: {
          businessId,
          externalSaleId,
        },
      },
    });

    if (existingProcessedSale) {
      return { kind: "skipped" as const };
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

        const mapping = await tx.pOSProductMapping.findFirst({
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
        inventoryItem = await tx.inventoryItem.findFirst({
          where: { businessId, sku: item.sku, isActive: true },
        });
      }

      if (!inventoryItem && item.barcode) {
        inventoryItem = await tx.inventoryItem.findFirst({
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

      const pendingMatch = await createPendingMatch(
        {
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
        },
        { tx }
      );

      await recordPosSaleSensor(tx, {
        businessId,
        entityId: null,
        externalSaleId,
        posSource: source,
        movementIds: [],
        lineCount: validItems.length,
        outcome: "HELD_FOR_MATCH",
      });

      return { kind: "pending" as const, pendingMatch };
    }

    // 📦 אם הכל תואם → מבצעים movement רגיל
    const movements = [];

    for (const matchedItem of matchedItems) {
      const movement = await inventoryService.removeStock(
        {
          businessId,
          itemId: matchedItem.itemId,
          quantityDelta: matchedItem.quantity,
          reason: InventoryMovementReason.SALE,
        },
        { tx }
      );

      movements.push(movement);
    }

    // 💾 רק אחרי עיבוד מלא — אטומי עם התנועות
    const externalSale = await tx.inventoryExternalSale.create({
      data: {
        businessId,
        externalSaleId,
        source,
      },
    });

    await recordPosSaleSensor(tx, {
      businessId,
      entityId: externalSale.id,
      externalSaleId,
      posSource: source,
      movementIds: movements.map((m) => m.id),
      lineCount: validItems.length,
      outcome: "APPLIED",
    });

    return { kind: "processed" as const, movements };
        },
        { timeoutMs: 20_000 }
      )
    );

    // AFTER the whole POS ingest transaction has committed. One sync per
    // request, not per line: the reconciliation covers the entire inventory
    // domain for this business, so a multi-item sale needs exactly one call.
    //
    // Run for every outcome, including `skipped`. A duplicate delivery changes
    // nothing in the domain, so the reconciliation is a no-op write-wise — but
    // it is also the moment to recover a notification that a previously
    // swallowed failure never wrote. One indexed read is a fair price for that.
    //
    // The tenant is the server-resolved businessId from the POS key, the same
    // identity the transaction ran under; the request body never influences it.
    // Context is re-entered because the one above closed with the transaction.
    //
    // It cannot change the response: the sale is durable by now, and the sync
    // absorbs its own errors and returns them as data rather than throwing.
    await runWithTenantContext({ businessId }, () =>
      syncInventoryAlertNotifications(businessId, new Date())
    );

    if (outcome.kind === "skipped") {
      return NextResponse.json({
        success: true,
        skipped: true,
        message: "Sale already processed",
      });
    }

    if (outcome.kind === "pending") {
      return NextResponse.json({
        success: true,
        pending: true,
        message: "Sale contains unmatched items and was moved to pending",
        pendingMatch: outcome.pendingMatch,
      });
    }

    return NextResponse.json({
      success: true,
      pending: false,
      movements: outcome.movements,
    });
  } catch (err) {
    console.error("POS SALE ERROR:", err);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}