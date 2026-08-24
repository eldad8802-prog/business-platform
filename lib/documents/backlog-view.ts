/**
 * Pure helpers for the Documents inbox "backlog vs. selected month" UI (F-21).
 *
 * The inbox shows one month at a time (its main count + Financial Pulse are
 * month-scoped, by design). The backlog — total needs_review across all time —
 * is a separate concept. These helpers reconcile the two so the screen never
 * shows "0 this month" without disclosing (and offering a path to) older
 * pending documents.
 */

/** Whether older-month backlog exists beyond the selected month, and how much. */
export function computeOlderBacklog(input: {
  totalPending: number;
  monthPending: number;
}): { show: boolean; olderCount: number } {
  const total = Math.max(0, Math.floor(input.totalPending));
  const month = Math.max(0, Math.floor(input.monthPending));
  const olderCount = Math.max(0, total - month);
  return { show: olderCount > 0, olderCount };
}

/**
 * Where the "show older documents" affordance should jump: the newest month
 * that has pending documents and is not the currently selected month. Returns
 * null when there is no other pending month.
 * `pendingMonths` is expected newest-first (YYYY-MM).
 */
export function pickBacklogCtaMonth(
  pendingMonths: string[],
  selectedMonth: string
): string | null {
  for (const m of pendingMonths) {
    if (m !== selectedMonth) return m;
  }
  return null;
}

/**
 * Options for the month selector: the current month is always selectable (so
 * the default view is reachable even at zero), unioned with every month that
 * has a pending backlog. Newest-first, de-duplicated.
 */
export function buildMonthOptions(
  currentMonth: string,
  pendingMonths: string[]
): string[] {
  const set = new Set<string>([currentMonth, ...pendingMonths]);
  return Array.from(set).sort().reverse();
}

/** Month-scoped empty-state copy — never a bare global claim. */
export function emptyMonthCopy(monthName: string): string {
  const name = monthName.trim();
  return name
    ? `אין מסמכים שממתינים לאימות ב${name}`
    : "אין מסמכים שממתינים לאימות בחודש הנבחר";
}
