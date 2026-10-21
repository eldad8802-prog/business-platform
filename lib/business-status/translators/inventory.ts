import type { InventoryAlertType } from "@prisma/client";

import type { Translator } from "@/lib/i18n/translate";

import type { InventoryAlertRaw } from "../loaders";
import { STATUS_HE_T } from "../i18n";
import { severityFromInventoryAlertType } from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

function titleForAlert(type: InventoryAlertType, itemName: string | null, t: Translator): string {
  switch (type) {
    case "CRITICAL_STOCK":
      return itemName
        ? t("insights.status.inventory.criticalItem", { item: itemName })
        : t("insights.status.inventory.critical");
    case "LOW_STOCK":
      return itemName ? t("insights.status.inventory.lowItem", { item: itemName }) : t("insights.status.inventory.low");
    case "UNMATCHED_POS_PRODUCT":
      return t("insights.status.inventory.unmatchedPos");
    case "SUSPICIOUS_CORRECTION":
      return itemName
        ? t("insights.status.inventory.suspiciousItem", { item: itemName })
        : t("insights.status.inventory.suspicious");
    default:
      return t("insights.status.inventory.generic");
  }
}

export function translateInventoryAlerts(
  rows: InventoryAlertRaw[],
  t: Translator = STATUS_HE_T
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
      title: titleForAlert(type, a.itemName, t),
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
        label: t("insights.status.inventory.openInventory"),
        href: "/inventory",
      },
      sourceEngine: "inventory-alerts",
      blocking,
      relatedRefs: related,
      // The language-independent kind behind the title (Home tells stock alerts apart by it).
      inventoryAlertType: type,
      priorityReferenceDate: a.createdAt,
    };
  });
}
