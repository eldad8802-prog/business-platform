/**
 * Inventory export descriptor.
 *
 * The category is exported as its NAME, joined from `InventoryCategory` —
 * `categoryId` is an internal key and means nothing in a spreadsheet.
 *
 * Excluded: `id`, `businessId`, `categoryId` (internal keys), `updatedAt`
 * (technical timestamp), and `imageUrl` (an internal storage path, not a
 * business fact; it is unusable outside Dubiz and leaks the object layout).
 *
 * Money columns are typed `currency` so they carry the shekel format, and
 * quantities are `number` rather than `integer` — the unit vocabulary includes
 * ML / GRAM / KG / LITER, where a fractional quantity is normal.
 */

import { InventoryUnitType } from "@prisma/client";
import type { TenantTx } from "@/lib/tenant/transaction";
import type {
  ExportDomainDescriptor,
  ExportPage,
} from "@/lib/data-transfer/export/export-domain.types";
import {
  date,
  label,
  num,
  text,
  yesNo,
} from "@/lib/data-transfer/export/export-values";

/**
 * Hebrew unit labels.
 *
 * The identical map exists privately inside
 * `components/inventory/product-detail-view.tsx`. It is repeated (not imported)
 * because that is a React component module and this is server-side export code
 * — importing it would drag the component graph into a data path. The strings
 * are kept character-identical so the export reads exactly like the product
 * screen. Consolidating the two into a shared inventory vocabulary is a
 * separate, UI-touching change.
 */
const UNIT_TYPE_LABELS: Record<InventoryUnitType, string> = {
  UNIT: "יחידה",
  ML: 'מ"ל',
  GRAM: "גרם",
  KG: "ק״ג",
  LITER: "ליטר",
  BOX: "מארז",
};

const COLUMNS = [
  { header: "שם פריט", type: "text", width: 30 },
  { header: "מק״ט", type: "text", width: 16 },
  { header: "ברקוד", type: "text", width: 18 },
  { header: "קטגוריה", type: "text", width: 18 },
  { header: "יחידת מידה", type: "text", width: 14 },
  { header: "ספק", type: "text", width: 22 },
  { header: "כמות במלאי", type: "number", width: 14 },
  { header: "כמות מינימום", type: "number", width: 14 },
  { header: "נקודת הזמנה", type: "number", width: 14 },
  { header: "עלות ליחידה", type: "currency", width: 14 },
  { header: "מחיר מכירה", type: "currency", width: 14 },
  { header: "עלות רכישה אחרונה", type: "currency", width: 18 },
  { header: "תאריך רכישה אחרונה", type: "date", width: 18 },
  { header: "פעיל", type: "text", width: 10 },
  { header: "נוצר בתאריך", type: "date", width: 14 },
] as const;

export const inventoryExportDescriptor: ExportDomainDescriptor = {
  id: "inventory",
  sheetName: "מלאי",
  fileSlug: "inventory",
  columns: COLUMNS,

  async readPage(
    tx: TenantTx,
    businessId: number,
    afterId: number,
    take: number
  ): Promise<ExportPage> {
    const rows = await tx.inventoryItem.findMany({
      where: { businessId, id: { gt: afterId } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        name: true,
        sku: true,
        barcode: true,
        unitType: true,
        supplierName: true,
        currentQuantity: true,
        minimumQuantity: true,
        reorderPoint: true,
        costPerUnit: true,
        sellPricePerUnit: true,
        lastPurchaseCost: true,
        lastPurchaseCostAt: true,
        isActive: true,
        createdAt: true,
        category: { select: { name: true } },
      },
    });

    return {
      cells: rows.map((r) => [
        text(r.name),
        text(r.sku),
        text(r.barcode),
        text(r.category?.name ?? null),
        label(r.unitType, UNIT_TYPE_LABELS),
        text(r.supplierName),
        num(r.currentQuantity),
        num(r.minimumQuantity),
        num(r.reorderPoint),
        num(r.costPerUnit),
        num(r.sellPricePerUnit),
        num(r.lastPurchaseCost),
        date(r.lastPurchaseCostAt),
        yesNo(r.isActive),
        date(r.createdAt),
      ]),
      lastId: rows.length > 0 ? rows[rows.length - 1].id : null,
    };
  },
};
