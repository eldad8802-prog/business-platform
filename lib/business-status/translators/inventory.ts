import type { InventoryAlertType } from "@prisma/client";

import type { InventoryAlertRaw } from "../loaders";
import { severityFromInventoryAlertType } from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

function titleForAlert(type: InventoryAlertType, itemName: string | null): string {
  switch (type) {
    case "CRITICAL_STOCK":
      return itemName
        ? `מלאי קריטי — ${itemName}`
        : "מלאי קריטי";
    case "LOW_STOCK":
      return itemName ? `מלאי נמוך — ${itemName}` : "מלאי נמוך";
    case "UNMATCHED_POS_PRODUCT":
      return "מוצר POS לא מזוהה במלאי";
    case "SUSPICIOUS_CORRECTION":
      return itemName
        ? `תיקון מלאי חשוד — ${itemName}`
        : "תיקון מלאי חשוד";
    default:
      return "התראת מלאי";
  }
}

export function translateInventoryAlerts(
  rows: InventoryAlertRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((a) => {
    const type = a.type as InventoryAlertType;
    const severity = severityFromInventoryAlertType(type);
    const blocking =
      type === "CRITICAL_STOCK" ||
      type === "UNMATCHED_POS_PRODUCT" ||
      type === "SUSPICIOUS_CORRECTION";

    const related =
      a.itemId != null
        ? [{ type: "inventory_item" as const, id: a.itemId }]
        : undefined;

    return {
      itemId: `inventory:alert:${a.id}`,
      domain: "inventory",
      semanticCategory: severity === "CRITICAL" ? "ALERT" : "WARNING",
      title: titleForAlert(type, a.itemName),
      summary: a.message ?? null,
      severity,
      entityRef: { type: "inventory_alert", id: a.id },
      state: "open",
      createdAt: a.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח מלאי",
        href: "/inventory",
      },
      sourceEngine: "inventory-alerts",
      blocking,
      relatedRefs: related,
      priorityReferenceDate: a.createdAt,
    };
  });
}
