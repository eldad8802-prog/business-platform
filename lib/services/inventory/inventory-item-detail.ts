/**
 * The one shape of a single inventory item as the product card reads it, for
 * GET /api/inventory/items/[id] and the PATCH response alike. The edit sheet
 * fills its form from this payload and sends the category back on save, so a
 * payload without `category` silently clears it (audit 2026-11-03, ב4).
 */
export const INVENTORY_ITEM_DETAIL_INCLUDE = {
  alerts: {
    where: { isResolved: false },
    orderBy: { createdAt: "desc" as const },
  },
  category: true,
} as const;
