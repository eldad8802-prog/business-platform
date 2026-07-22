/**
 * Pure previous-calendar-month computation on a `YYYY-MM` string. Extracted from
 * the `summaryOnly` handler in app/api/documents/inbox/route.ts — behavior-
 * equivalent to the previous inline arithmetic, including the January → previous
 * December-of-last-year rollover.
 *
 * Assumes a valid `YYYY-MM` (the caller only invokes it after the month has
 * already passed `jerusalemMonthUtcHalfOpen` validation).
 */
export function previousYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}`;
}
