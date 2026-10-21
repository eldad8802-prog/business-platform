import type { Translator } from "@/lib/i18n/translate";

import type { SupplierDraftRaw } from "../loaders";
import { STATUS_HE_T } from "../i18n";
import type { BusinessStatusItemBuild } from "../types";

export function translateSupplierPurchasesPending(
  rows: SupplierDraftRaw[],
  t: Translator = STATUS_HE_T
): BusinessStatusItemBuild[] {
  return rows.map((d) => {
    const supplier = d.supplierName?.trim() || t("insights.status.supplier.noSupplier");

    return {
      itemId: `supplier:draft:${d.id}`,
      domain: "supplier",
      semanticCategory: "ACTION_REQUIRED",
      title: t("insights.status.supplier.title", { supplier }),
      summary: [
        t("insights.status.supplier.lines", { count: d.lineCount }),
        d.externalOrderId ? t("insights.status.supplier.externalOrder", { id: d.externalOrderId }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      severity: "MEDIUM",
      entityRef: { type: "supplier_purchase_draft", id: d.id },
      state: "open",
      createdAt: d.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: t("insights.status.supplier.openPending"),
        href: "/inventory/supplier-purchases/pending",
      },
      sourceEngine: "supplier-purchases",
      blocking: true,
      priorityReferenceDate: d.createdAt,
    };
  });
}
