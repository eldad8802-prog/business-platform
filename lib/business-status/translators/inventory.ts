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
      // IDENTITY: the inventory ITEM, not the alert row.
      //
      // An InventoryAlert row is an EPISODE. The domain never reuses a resolved
      // one: recovery closes alert #1 and a later drop mints alert #2. Keying
      // identity on the row therefore made every flicker a brand-new fact, so a
      // stock level oscillating around its threshold re-notified on each dip —
      // which is precisely what the Notification schema says must not happen
      // ("a condition that flickers must not re-notify each time it returns").
      //
      // The logical condition is what the owner actually experiences: THIS item
      // is critically low. That identity is businessId + item + alert type, and
      // it is the same triple the inventory service itself uses to decide
      // whether an alert is already open. Episodes stay in InventoryAlert;
      // identity points at the thing the episodes are about.
      //
      // Fallback: alerts with no item (UNMATCHED_POS_PRODUCT carries a
      // pendingMatchId instead) keep the row identity. No collision is possible
      // — the two live in different entityRef.type namespaces.
      entityRef:
        a.itemId != null
          ? { type: "inventory_item", id: a.itemId }
          : { type: "inventory_alert", id: a.id },
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
