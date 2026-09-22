import { daysBetweenDayKeys, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import type { PayableInstallmentRaw } from "../loaders";
import { severityPayablesDueSoon, severityPayablesOverdue } from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

function formatMoney(amount: PayableInstallmentRaw["scheduledAmount"], currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString("he-IL")} ${currency}`;
}

/**
 * Whole CALENDAR days in Israel time, via the same helper collections uses.
 *
 * Elapsed-milliseconds arithmetic gets this wrong in the way an owner would notice: a payment due at
 * midnight on the 24th, read at 10:00 on the 22nd, is 38 hours away — which floors to 1 and would be
 * announced as "tomorrow" when it is in fact the day after. "Today" has to mean the same thing here
 * as it does everywhere else in the product.
 */
function calendarDaysBetween(a: Date, b: Date): number {
  return Math.abs(daysBetweenDayKeys(jerusalemDayKey(a), jerusalemDayKey(b)));
}

/** Hebrew that reads like Hebrew: "1 ימים" is not a sentence anyone would write. */
function inDaysPhrase(days: number): string {
  if (days <= 0) return "היום";
  if (days === 1) return "מחר";
  return `בעוד ${days} ימים`;
}

function latePhrase(days: number): string {
  if (days <= 0) return "מועד התשלום חלף";
  if (days === 1) return "באיחור יום אחד";
  return `באיחור ${days} ימים`;
}

/**
 * A partially-paid installment states BOTH numbers. "3,000 out of 5,000" is a different fact from
 * "5,000 unpaid", and collapsing them would misrepresent what the owner still owes.
 */
function amountSummary(row: PayableInstallmentRaw): string {
  const total = formatMoney(row.scheduledAmount, row.currency);
  if (row.allocatedAmount > 0) {
    const paid = `${row.allocatedAmount.toLocaleString("he-IL")} ${row.currency}`;
    return `שולם ${paid} מתוך ${total}`;
  }
  return `סכום: ${total}`;
}

export function translatePayablesOverdue(
  rows: PayableInstallmentRaw[],
  now: Date
): BusinessStatusItemBuild[] {
  return rows.map((row) => {
    const late = calendarDaysBetween(now, row.dueAt);
    return {
      itemId: `payables:overdue:${row.id}`,
      domain: "payables",
      semanticCategory: "ACTION_REQUIRED",
      title: "תשלום שעבר את מועדו",
      summary: [
        row.payeeName?.trim() ? `למי: ${row.payeeName.trim()}` : row.commitmentTitle,
        amountSummary(row),
        latePhrase(late),
      ]
        .filter(Boolean)
        .join(" · "),
      severity: severityPayablesOverdue(late),
      entityRef: { type: "installment", id: row.id },
      relatedRefs: [{ type: "commitment", id: row.commitmentId }],
      state: "open",
      createdAt: row.dueAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח התחייבות",
        href: `/payables`,
      },
      sourceEngine: "payables-schedule",
      blocking: true,
      moneyImpactBand: "high",
      // Priority is anchored on the DUE DATE, not on when the row was created: an installment written
      // months ago that came due yesterday is urgent today, and one written today for next year is not.
      priorityReferenceDate: row.dueAt,
    };
  });
}

export function translatePayablesDueSoon(
  rows: PayableInstallmentRaw[],
  now: Date
): BusinessStatusItemBuild[] {
  return rows.map((row) => {
    const inDays = calendarDaysBetween(row.dueAt, now);
    return {
      itemId: `payables:due_soon:${row.id}`,
      domain: "payables",
      // Not ACTION_REQUIRED: nothing is wrong yet. Saying "you must act" about a payment that is not
      // due would train the owner to discount the list, which costs more than the warning is worth.
      semanticCategory: "WARNING",
      title: "תשלום מתקרב",
      summary: [
        row.payeeName?.trim() ? `למי: ${row.payeeName.trim()}` : row.commitmentTitle,
        amountSummary(row),
        inDaysPhrase(inDays),
      ]
        .filter(Boolean)
        .join(" · "),
      severity: severityPayablesDueSoon(inDays),
      entityRef: { type: "installment", id: row.id },
      relatedRefs: [{ type: "commitment", id: row.commitmentId }],
      state: "open",
      createdAt: row.dueAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח התחייבות",
        href: `/payables`,
      },
      sourceEngine: "payables-schedule",
      blocking: false,
      moneyImpactBand: "medium",
      priorityReferenceDate: row.dueAt,
    };
  });
}
