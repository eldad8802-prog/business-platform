import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";
import { CsvSupplierConnector } from "@/lib/services/supplier-connectors/csv/csv-supplier.connector";
import { mapNormalizedSupplierOrderToDraftInput } from "@/lib/services/supplier-connectors/supplier-order-to-draft.adapter";
import { SupplierPurchaseDraftStatus } from "@prisma/client";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';

export const runtime = "nodejs";

function handleInventoryError(error: unknown) {
  if (error instanceof InventoryUnauthorizedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof InventoryNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (
    error instanceof InventoryValidationError ||
    error instanceof NegativeInventoryError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof InventoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof Error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Supplier CSV import route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function normalizeText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveDraftSource(order: {
  connectorType: string;
  raw?: unknown;
}): string {
  const raw = order.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const fromRaw =
      typeof rec.source === "string" ? normalizeText(rec.source) : null;
    if (fromRaw) return fromRaw;
  }

  const ct = normalizeText(order.connectorType);
  if (ct && ct !== "CSV") return ct;

  return "CSV";
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);

    const userLimit = await consumeRateLimit({
      key: `inventory:supplier-purchases:import:csv:user:${user.id}`,
      limit: 5,
      windowMs: 60 * 60_000,
    });
    if (!userLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const businessLimit = await consumeRateLimit({
      key: `inventory:supplier-purchases:import:csv:business:${user.businessId}`,
      limit: 20,
      windowMs: 24 * 60 * 60_000,
    });
    if (!businessLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing CSV file" }, { status: 400 });
    }

    const csvText = await file.text();

    if (!csvText || !csvText.trim()) {
      return NextResponse.json({ error: "CSV file is empty" }, { status: 400 });
    }

    const connector = new CsvSupplierConnector();
    const orders = connector.parseCsvTextToOrders(csvText);

    const draftsCreated: Array<{
      draftId: number;
      externalOrderId: string | null;
      supplierName: string | null;
    }> = [];

    const skippedOrders: Array<{
      externalOrderId: string | null;
      supplierName: string | null;
      draftId: number;
    }> = [];

    const invalidOrders: Array<{
      orderId: string;
      reason: string;
    }> = [];

    const warnings: string[] = [];

    for (const order of orders) {
      const draftSource = resolveDraftSource(order);

      const mapped = mapNormalizedSupplierOrderToDraftInput({
        businessId: user.businessId,
        createdByUserId: user.id,
        order: {
          ...order,
          connectorType: draftSource,
        },
      });

      if (!mapped.valid) {
        invalidOrders.push({
          orderId: order.orderId,
          reason: mapped.reason,
        });
        continue;
      }

      const input = mapped.input;
      const externalOrderId = normalizeText(input.externalOrderId ?? null);

      if (!externalOrderId) {
        warnings.push(
          `Order ${order.orderId}: missing externalOrderId; skipping strong dedupe`
        );
      } else {
        const existing = await prisma.supplierPurchaseDraft.findFirst({
          where: {
            businessId: user.businessId,
            source: input.source ?? "CSV",
            externalOrderId,
            status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
          },
          select: { id: true },
        });

        if (existing) {
          skippedOrders.push({
            externalOrderId,
            supplierName: input.supplierName ?? null,
            draftId: existing.id,
          });
          continue;
        }
      }

      const result = await createSupplierPurchaseDraft(input);

      draftsCreated.push({
        draftId: result.draft.id,
        externalOrderId: externalOrderId,
        supplierName: input.supplierName ?? null,
      });
    }

    return NextResponse.json(
      {
        success: true,
        draftsCreated,
        skippedOrders,
        invalidOrders,
        warnings,
        previewSummary: {
          ordersParsed: orders.length,
          draftsCreated: draftsCreated.length,
          skippedOrders: skippedOrders.length,
          invalidOrders: invalidOrders.length,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return handleInventoryError(error);
  }
}
