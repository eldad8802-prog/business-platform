export const SUPPLIER_PURCHASE_ORDER_DRAFT_KEY =
  "inventory:supplierPurchases:newDraft:v1";

export type SupplierPurchaseOrderDraftV1 = {
  version: 1;
  savedAt: string;
  /**
   * Entity-FK of the chosen Supplier, when the owner picked a real one.
   * Optional so a v1 draft written before this field existed still restores.
   */
  supplierId?: number | null;
  supplierName: string;
  order: Record<number, number>;
  unitCosts?: Record<number, number | null>;
  categoryId: string;
  itemId: string;
  quantity: string;
};

export function readSupplierPurchaseOrderDraft(): SupplierPurchaseOrderDraftV1 | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SUPPLIER_PURCHASE_ORDER_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SupplierPurchaseOrderDraftV1;
    if (!parsed || parsed.version !== 1) return null;
    if (typeof parsed.supplierName !== "string") return null;
    if (
      parsed.supplierId != null &&
      (typeof parsed.supplierId !== "number" ||
        !Number.isInteger(parsed.supplierId))
    ) {
      return null;
    }
    if (!parsed.order || typeof parsed.order !== "object") return null;
    if (
      parsed.unitCosts != null &&
      (typeof parsed.unitCosts !== "object" || Array.isArray(parsed.unitCosts))
    ) {
      return null;
    }
    if (typeof parsed.categoryId !== "string") return null;
    if (typeof parsed.itemId !== "string") return null;
    if (typeof parsed.quantity !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSupplierPurchaseOrderDraft(
  draft: Omit<SupplierPurchaseOrderDraftV1, "version" | "savedAt">
) {
  if (typeof window === "undefined") return;
  const payload: SupplierPurchaseOrderDraftV1 = {
    version: 1,
    savedAt: new Date().toISOString(),
    ...draft,
  };
  localStorage.setItem(
    SUPPLIER_PURCHASE_ORDER_DRAFT_KEY,
    JSON.stringify(payload)
  );
}

export function clearSupplierPurchaseOrderDraft() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SUPPLIER_PURCHASE_ORDER_DRAFT_KEY);
}
