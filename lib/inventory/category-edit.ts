import { inventoryTextKey, normalizeInventoryText } from "@/lib/inventory/normalize";

/**
 * What the product edit sheet sends as `categoryId` on save.
 *
 * - `keep`: the field still shows the item's own category → send its id unchanged
 *   (no lookup, no create), even when the category list failed to load.
 * - `clear`: the owner emptied the field → send null.
 * - `existing`: the owner typed another category that already exists → its id.
 * - `create`: the owner typed a new name → create it, then send the new id.
 *
 * An item with no category and an empty field resolves to `clear` (null → null,
 * no change). Matching is case- and whitespace-insensitive, like the create form.
 */
export type CategorySaveDecision =
  | { kind: "keep"; id: number }
  | { kind: "clear" }
  | { kind: "existing"; id: number }
  | { kind: "create"; name: string };

export function decideCategoryOnSave(
  formName: string,
  item: { categoryId?: number | null; category?: { id: number; name: string } | null },
  categories: ReadonlyArray<{ id: number; name: string }>
): CategorySaveDecision {
  const normalized = normalizeInventoryText(formName);
  if (!normalized) return { kind: "clear" };

  const key = inventoryTextKey(normalized);
  const currentId = item.category?.id ?? item.categoryId ?? null;
  if (item.category && currentId != null && inventoryTextKey(item.category.name) === key) {
    return { kind: "keep", id: currentId };
  }

  const existing = categories.find((c) => inventoryTextKey(c.name) === key);
  if (existing) return { kind: "existing", id: existing.id };
  return { kind: "create", name: normalized };
}
