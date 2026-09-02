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
 *
 * # IMPORT CONTRACT — evidence
 *
 * `inventoryService.createItemWithInitialStock` accepts: `name`, `unitType`,
 * `supplierName`, `initialQuantity`, `minimumQuantity`, `reorderPoint`,
 * `costPerUnit`, `sellPricePerUnit`, `sku`, `barcode`, `imageUrl`, `categoryId`.
 *
 * TWO required fields, from two different sources:
 *  - `name` — the service throws
 *    `InventoryValidationError("Item name is required")` on a blank name.
 *  - `unitType` — the service passes it straight to a NOT NULL column that has
 *    no default, and the items route's `parseInventoryUnitType` throws
 *    "unitType is required". A quantity means nothing without its unit.
 *
 * "קטגוריה" is EXPORTABLE (joined as a name) but NOT importable: the service
 * takes a `categoryId`, an internal key. Accepting a category NAME would mean
 * resolving-or-creating categories during import — an I-6 decision, not
 * something a template should quietly imply.
 *
 * "עלות רכישה אחרונה" / "תאריך רכישה אחרונה" are derived from purchase history,
 * and "פעיל" is lifecycle. None are create inputs.
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

/** The owner-facing unit vocabulary, in the enum's own order. */
const UNIT_TYPE_VALUES = Object.values(UNIT_TYPE_LABELS);

/**
 * Order below is the SHIPPED export order and must not be rearranged — the
 * cell projection in `readPage` is positional.
 */
const COLUMNS = [
  {
    header: "שם פריט",
    type: "text",
    width: 30,
    exportable: true,
    importable: true,
    required: true,
    help: "שם הפריט כפי שתזהו אותו. שדה חובה.",
    example: "חלב 3% ליטר",
  },
  {
    header: "מק״ט",
    type: "text",
    width: 16,
    exportable: true,
    importable: true,
    help: "מזהה פנימי שלכם לפריט. טקסט חופשי.",
    example: "MILK-3-1L",
  },
  {
    header: "ברקוד",
    type: "text",
    width: 18,
    exportable: true,
    importable: true,
    help: "ברקוד המוצר, ספרות בלבד. שמרו את העמודה כטקסט כדי לא לאבד אפסים מובילים.",
    example: "7290000000001",
  },
  {
    header: "קטגוריה",
    type: "text",
    width: 18,
    exportable: true,
    importable: false,
  },
  {
    header: "יחידת מידה",
    type: "text",
    width: 14,
    exportable: true,
    importable: true,
    required: true,
    allowedValues: UNIT_TYPE_VALUES,
    help: "אחד מהערכים המותרים בלבד. שדה חובה — כמות בלי יחידה אינה אומרת דבר.",
    example: "ליטר",
  },
  {
    header: "ספק",
    type: "text",
    width: 22,
    exportable: true,
    importable: true,
    help: "שם הספק, טקסט חופשי.",
    example: "תנובה",
  },
  {
    header: "כמות במלאי",
    type: "number",
    width: 14,
    exportable: true,
    importable: true,
    help: "הכמות שיש עכשיו. אם יישאר ריק — ייקלט 0.",
    example: "24",
  },
  {
    header: "כמות מינימום",
    type: "number",
    width: 14,
    exportable: true,
    importable: true,
    help: "הכמות שמתחתיה תרצו לקבל התראה.",
    example: "6",
  },
  {
    header: "נקודת הזמנה",
    type: "number",
    width: 14,
    exportable: true,
    importable: true,
    help: "הכמות שבה כדאי להזמין מחדש מהספק.",
    example: "10",
  },
  {
    header: "עלות ליחידה",
    type: "currency",
    width: 14,
    exportable: true,
    importable: true,
    help: "כמה עולה לכם פריט אחד, בשקלים. מספר בלבד, בלי ₪.",
    example: "4.9",
  },
  {
    header: "מחיר מכירה",
    type: "currency",
    width: 14,
    exportable: true,
    importable: true,
    help: "המחיר ללקוח, בשקלים. מספר בלבד, בלי ₪.",
    example: "7.5",
  },
  {
    header: "עלות רכישה אחרונה",
    type: "currency",
    width: 18,
    exportable: true,
    importable: false,
  },
  {
    header: "תאריך רכישה אחרונה",
    type: "date",
    width: 18,
    exportable: true,
    importable: false,
  },
  { header: "פעיל", type: "text", width: 10, exportable: true, importable: false },
  {
    header: "נוצר בתאריך",
    type: "date",
    width: 14,
    exportable: true,
    importable: false,
  },
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
