import type { SupplierDraftRaw } from "../loaders";
import type { BusinessStatusItemBuild } from "../types";

export function translateSupplierPurchasesPending(
  rows: SupplierDraftRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((d) => {
    const supplier = d.supplierName?.trim() || "ספק לא צוין";

    return {
      itemId: `supplier:draft:${d.id}`,
      domain: "supplier",
      semanticCategory: "ACTION_REQUIRED",
      title: `רכש מספק ממתין לאישור — ${supplier}`,
      summary: [
        `${d.lineCount} שורות בהזמנה`,
        d.externalOrderId ? `הזמנה חיצונית: ${d.externalOrderId}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      severity: "MEDIUM",
      entityRef: { type: "supplier_purchase_draft", id: d.id },
      state: "open",
      createdAt: d.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח רכש ממתין",
        href: "/inventory/supplier-purchases/pending",
      },
      sourceEngine: "supplier-purchases",
      blocking: true,
      priorityReferenceDate: d.createdAt,
    };
  });
}
