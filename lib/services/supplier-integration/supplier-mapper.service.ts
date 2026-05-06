import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import type { SupplierOrder } from "./supplier-fetch.service";

export type CreateSupplierPurchaseDraftInput = Parameters<
  typeof createSupplierPurchaseDraft
>[0];

export function mapSupplierOrderToDraftInput(
  order: SupplierOrder,
  base: Pick<
    CreateSupplierPurchaseDraftInput,
    "businessId" | "createdByUserId" | "source"
  >
): CreateSupplierPurchaseDraftInput {
  return {
    businessId: base.businessId,
    createdByUserId: base.createdByUserId ?? null,
    source: base.source ?? order.source ?? "MOCK",
    supplierName: order.supplierName ?? null,
    externalOrderId: order.externalOrderId ?? null,
    orderDate: order.orderDate ?? null,
    lines: (order.lines || []).map((line) => ({
      rawName: line.rawName ?? null,
      sku: line.sku ?? null,
      barcode: line.barcode ?? null,
      quantity: line.quantity,
      unitType: (line.unitType as any) ?? null,
    })),
  };
}

