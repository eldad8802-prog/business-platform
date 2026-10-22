/**
 * Business Status — interface-language support for the translators.
 *
 * Every translator takes an optional `t` (and `locale` where it formats money). Without them the output is
 * the Hebrew it always was: the Hebrew dictionary (lib/i18n/messages/areas/insights.ts) holds the strings
 * verbatim, and Hebrew money keeps its legacy "1,500 ILS" form.
 */
import type { Locale } from "@/lib/i18n/config";
import { formatAmount } from "@/lib/i18n/format";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";

export const STATUS_HE_T: Translator = createTranslator(he);

/** Hebrew: `${n.toLocaleString("he-IL")} ${currency}` exactly as before. Other locales: lib/i18n/format. "" when not a number. */
export function statusMoney(amount: { toString(): string } | number, currency: string, locale: Locale = "he"): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  if (locale === "he") return `${n.toLocaleString("he-IL")} ${currency}`;
  return formatAmount(n, currency, { locale });
}
