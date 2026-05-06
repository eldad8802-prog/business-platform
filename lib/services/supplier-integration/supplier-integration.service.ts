import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import { fetchSupplierOrders } from "./supplier-fetch.service";
import { mapSupplierOrderToDraftInput } from "./supplier-mapper.service";

export async function ingestSupplierOrders(params: {
  businessId: number;
  createdByUserId?: number | null;
  source?: string | null;
}) {
  const orders = await fetchSupplierOrders();

  const results = [];

  for (const order of orders) {
    const input = mapSupplierOrderToDraftInput(order, {
      businessId: params.businessId,
      createdByUserId: params.createdByUserId ?? null,
      source: params.source ?? null,
    });

    const result = await createSupplierPurchaseDraft(input);
    results.push(result);
  }

  return {
    success: true,
    count: results.length,
    results,
  };
}

