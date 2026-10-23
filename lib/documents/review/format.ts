import { DEFAULT_LOCALE, intlTag, type Locale } from "@/lib/i18n/config";

/** Number only (no currency symbol). Hebrew: identical to the previous `he-IL` output. */
export function formatAmountDisplay(n: number, locale: Locale = DEFAULT_LOCALE): string {
  return n.toLocaleString(intlTag(locale), { maximumFractionDigits: 2 });
}

export function formatDateShort(iso: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(intlTag(locale));
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
