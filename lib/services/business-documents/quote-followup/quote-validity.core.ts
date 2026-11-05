/**
 * ר1 — which quotes need the owner's attention because their validity ends.
 * Pure: no DB, no clock (the caller passes "today" in Israel time).
 *
 * Daily Tasks spec §4 row S08 "תוקף הצעת מחיר": a QUOTE that was not converted and
 * whose validUntil is within 3 days or already past. Closed when it is converted,
 * when the date moves (a new cycle), or when the owner marks it "לא רלוונטי".
 *
 * Excluded, always: a quote referenced by ANY ServiceQuote row (every version,
 * including superseded / withdrawn) — service-case quotes belong to the service
 * desk only. This is an internal reminder for the owner; nothing is ever sent
 * to a customer.
 */
import { addCalendarDays, daysBetweenDayKeys, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

export const QUOTE_VALIDITY_WINDOW_DAYS = 3;

export type QuoteValidityRow = {
  id: number;
  validUntil: Date | null;
  convertedToInvoiceId: number | null;
  documentNumberFormatted: string | null;
  customerNameSnapshot: string | null;
  updatedAt: Date;
};

export type QuoteValidityItem = {
  id: number;
  validDay: JerusalemDayKey;
  /** Days from today to the last valid day: negative when already expired. */
  daysLeft: number;
  state: "EXPIRES_SOON" | "EXPIRED";
  numberFormatted: string | null;
  customerName: string | null;
  updatedAt: Date;
};

/** The last day a quote is valid, in Israel time. */
export function validDayOf(validUntil: Date): JerusalemDayKey {
  return jerusalemDayKey(validUntil);
}

/** The upper bound for a database pre-filter: anything valid until after this instant is out of the window. */
export function windowEndInstant(today: JerusalemDayKey): Date {
  // End of the last day in the window, in UTC terms generous enough for Israel's offset (+2 / +3).
  const last = addCalendarDays(today, QUOTE_VALIDITY_WINDOW_DAYS + 1);
  return new Date(`${last}T00:00:00.000Z`);
}

export function selectQuoteValidityItems(rows: QuoteValidityRow[], serviceOwnedIds: ReadonlySet<number>, today: JerusalemDayKey): QuoteValidityItem[] {
  const out: QuoteValidityItem[] = [];
  for (const r of rows) {
    if (!r.validUntil) continue;
    if (r.convertedToInvoiceId !== null) continue;
    if (serviceOwnedIds.has(r.id)) continue;
    const validDay = validDayOf(r.validUntil);
    const daysLeft = daysBetweenDayKeys(today, validDay);
    if (daysLeft > QUOTE_VALIDITY_WINDOW_DAYS) continue;
    out.push({
      id: r.id,
      validDay,
      daysLeft,
      state: daysLeft < 0 ? "EXPIRED" : "EXPIRES_SOON",
      numberFormatted: r.documentNumberFormatted,
      customerName: r.customerNameSnapshot,
      updatedAt: r.updatedAt,
    });
  }
  // Soonest first; ties by id.
  return out.sort((a, b) => (a.validDay === b.validDay ? a.id - b.id : a.validDay < b.validDay ? -1 : 1));
}
