import type { MessageKey, Translator } from "@/lib/i18n/translate";
import { documentsHe } from "@/lib/i18n/messages/areas/documents";

/**
 * Display label for a stored category value (presentation only).
 *
 * The stored value (`fuel`, `rent`, …) is a stable key from lib/constants/categories.ts and is never
 * translated; only its label is. The Hebrew labels in `documents.categories` are byte-identical to
 * `CATEGORY_MAP`, so Hebrew output does not change. An unknown / free-text value is shown as-is.
 */
export function isKnownCategory(value: string | null | undefined): boolean {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(documentsHe.categories, value);
}

export function categoryLabel(t: Translator, value: string | null | undefined): string {
  if (!value) return "";
  return isKnownCategory(value) ? t(`documents.categories.${value}` as MessageKey) : value;
}
