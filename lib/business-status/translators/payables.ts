import type { Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
import { daysBetweenDayKeys, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import type { PayableInstallmentRaw } from "../loaders";
import { STATUS_HE_T, statusMoney } from "../i18n";
import { severityPayablesDueSoon, severityPayablesOverdue } from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

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
function inDaysPhrase(days: number, t: Translator): string {
  if (days <= 0) return t("insights.status.payables.today");
  if (days === 1) return t("insights.status.payables.tomorrow");
  return t("insights.status.payables.inDays", { days });
}

function latePhrase(days: number, t: Translator): string {
  if (days <= 0) return t("insights.status.payables.duePassed");
  if (days === 1) return t("insights.status.payables.lateOneDay");
  return t("insights.status.payables.lateDays", { days });
}

/**
 * A partially-paid installment states BOTH numbers. "3,000 out of 5,000" is a different fact from
 * "5,000 unpaid", and collapsing them would misrepresent what the owner still owes.
 */
function amountSummary(row: PayableInstallmentRaw, t: Translator, locale: Locale): string {
  const total = statusMoney(row.scheduledAmount, row.currency, locale);
  if (row.allocatedAmount > 0) {
    const paid = statusMoney(row.allocatedAmount, row.currency, locale);
    return t("insights.status.payables.paidOf", { paid, total });
  }
  return t("insights.status.payables.amount", { amount: total });
}

export function translatePayablesOverdue(
  rows: PayableInstallmentRaw[],
  now: Date,
  t: Translator = STATUS_HE_T,
  locale: Locale = "he"
): BusinessStatusItemBuild[] {
  return rows.map((row) => {
    const late = calendarDaysBetween(now, row.dueAt);
    return {
      itemId: `payables:overdue:${row.id}`,
      domain: "payables",
      semanticCategory: "ACTION_REQUIRED",
      title: t("insights.status.payables.overdueTitle"),
      summary: [
        row.payeeName?.trim() ? t("insights.status.payables.payee", { name: row.payeeName.trim() }) : row.commitmentTitle,
        amountSummary(row, t, locale),
        latePhrase(late, t),
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
        label: t("insights.status.payables.openCommitment"),
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
  now: Date,
  t: Translator = STATUS_HE_T,
  locale: Locale = "he"
): BusinessStatusItemBuild[] {
  return rows.map((row) => {
    const inDays = calendarDaysBetween(row.dueAt, now);
    return {
      itemId: `payables:due_soon:${row.id}`,
      domain: "payables",
      // Not ACTION_REQUIRED: nothing is wrong yet. Saying "you must act" about a payment that is not
      // due would train the owner to discount the list, which costs more than the warning is worth.
      semanticCategory: "WARNING",
      title: t("insights.status.payables.dueSoonTitle"),
      summary: [
        row.payeeName?.trim() ? t("insights.status.payables.payee", { name: row.payeeName.trim() }) : row.commitmentTitle,
        amountSummary(row, t, locale),
        inDaysPhrase(inDays, t),
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
        label: t("insights.status.payables.openCommitment"),
        href: `/payables`,
      },
      sourceEngine: "payables-schedule",
      blocking: false,
      moneyImpactBand: "medium",
      priorityReferenceDate: row.dueAt,
    };
  });
}
