import type { NormalizedSupplierOrder } from "./types";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";

type CreateSupplierPurchaseDraftInput = Parameters<typeof createSupplierPurchaseDraft>[0];

export type SupplierOrderToDraftAdapterResult =
  | { valid: true; input: CreateSupplierPurchaseDraftInput }
  | { valid: false; reason: string };

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toOptionalDateLike(value: unknown): Date | string | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return value;
  return null;
}

function toPositiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function mapNormalizedSupplierOrderToDraftInput(params: {
  businessId: number;
  createdByUserId: number | null;
  order: NormalizedSupplierOrder;
}): SupplierOrderToDraftAdapterResult {
  const { businessId, createdByUserId, order } = params;

  const supplierName =
    toOptionalString(order.supplierName) ?? "Unknown Supplier";

  const externalOrderId = toOptionalString(order.externalOrderId);

  const source =
    toOptionalString((order as any)?.source) ??
    toOptionalString((order as any)?.connectorType) ??
    "CSV";

  const orderDate =
    toOptionalDateLike((order as any)?.createdAt) ??
    toOptionalDateLike(order.orderDate);

  const lines = (order.lines || [])
    .map((line) => {
      const quantity = toPositiveNumber(line.quantity);
      if (!quantity) return null;

      return {
        rawName: toOptionalString((line as any)?.rawName) ?? line.productName ?? null,
        sku: toOptionalString(line.sku),
        barcode: toOptionalString(line.barcode),
        quantity,
        unitType: (line.unitType as any) ?? null,
      };
    })
    .filter(Boolean) as CreateSupplierPurchaseDraftInput["lines"];

  if (!lines.length) {
    return { valid: false, reason: "No valid order lines" };
  }

  return {
    valid: true,
    input: {
      businessId,
      createdByUserId,
      supplierName,
      externalOrderId,
      source,
      orderDate,
      lines,
    },
  };
}

