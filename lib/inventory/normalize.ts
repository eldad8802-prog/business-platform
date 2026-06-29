/**
 * Lightweight text normalization for inventory free-text fields (supplier name,
 * category name). Trims and collapses internal whitespace so trivial variants
 * like "קוקה  קולה " and "קוקה קולה" don't become separate values.
 *
 * Deliberately minimal — this is duplicate-prevention hygiene, NOT supplier
 * identity resolution / Party binding (out of scope for this round).
 */
export function normalizeInventoryText(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

/** Case + whitespace insensitive key for matching existing values. */
export function inventoryTextKey(value: string | null | undefined): string {
  return normalizeInventoryText(value).toLowerCase();
}
