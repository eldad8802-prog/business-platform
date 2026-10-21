/**
 * Presentation-only formatting helpers for the Documents home screen.
 * No data-layer coupling — pure string/number formatting shared by the
 * container page and the Pulse card.
 */
import { DEFAULT_LOCALE, intlTag, type Locale } from "@/lib/i18n/config";
import { formatAmount } from "@/lib/i18n/format";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";

/** Hebrew keeps its historical Intl currency pattern byte-for-byte; other locales use the shared formatter. */
export function formatMoney(n: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (locale !== "he") return formatAmount(n, "ILS", { locale });
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ש"ח`;
  }
}

export function monthLabel(raw: string, locale: Locale = DEFAULT_LOCALE, t?: Translator): string {
  if (!raw) return (t ?? createTranslator(he))("documents.home.noMonth");
  const [year, month] = raw.split("-");
  if (!year || !month) return raw;
  const d = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(intlTag(locale), { month: "long", year: "numeric" });
}

export function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
