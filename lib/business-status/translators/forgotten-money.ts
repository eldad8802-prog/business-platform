import { daysBetweenDayKeys, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import type { StaleBillingDraftRaw, StalePaymentLinkRaw } from "../loaders";
import { severityForgottenMoney } from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

function money(amount: { toString(): string }, currency: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? `${n.toLocaleString("he-IL")} ${currency}` : "";
}

function ageDays(then: Date, now: Date): number {
  return Math.abs(daysBetweenDayKeys(jerusalemDayKey(then), jerusalemDayKey(now)));
}

/**
 * An invoice that was started and never issued.
 *
 * Phrased as a question, not an accusation. The owner may have abandoned it on purpose, and a fact
 * layer that implies otherwise is wrong about the one thing it is supposed to be right about.
 */
export function translateBillingStaleDrafts(
  rows: StaleBillingDraftRaw[],
  now: Date
): BusinessStatusItemBuild[] {
  return rows.map((row) => ({
    itemId: `billing:stale_draft:${row.id}`,
    domain: "billing",
    semanticCategory: "WARNING",
    title: "טיוטת חשבונית שלא הונפקה",
    summary: [
      row.customerName?.trim() ? `לקוח: ${row.customerName.trim()}` : null,
      money(row.totalAmount, row.currency) ? `סכום: ${money(row.totalAmount, row.currency)}` : null,
      `נוצרה לפני ${ageDays(row.createdAt, now)} ימים`,
    ]
      .filter(Boolean)
      .join(" · "),
    severity: severityForgottenMoney(ageDays(row.createdAt, now)),
    entityRef: { type: "billing_document", id: row.id },
    state: "open",
    createdAt: row.createdAt.toISOString(),
    primaryAction: { kind: "navigate", label: "פתח טיוטה", href: `/billing/${row.id}` },
    sourceEngine: "billing-draft-age",
    blocking: false,
    moneyImpactBand: "medium",
    priorityReferenceDate: row.createdAt,
  }));
}

/** A payment link that was sent and never used. Still PENDING — not failed, not expired. */
export function translateStalePaymentLinks(
  rows: StalePaymentLinkRaw[],
  now: Date
): BusinessStatusItemBuild[] {
  return rows.map((row) => ({
    itemId: `billing:stale_payment_link:${row.id}`,
    domain: "billing",
    semanticCategory: "WARNING",
    title: "בקשת תשלום שממתינה",
    summary: [
      money(row.amount, row.currency) ? `סכום: ${money(row.amount, row.currency)}` : null,
      `נשלחה לפני ${ageDays(row.createdAt, now)} ימים`,
      "טרם שולמה",
    ]
      .filter(Boolean)
      .join(" · "),
    severity: severityForgottenMoney(ageDays(row.createdAt, now)),
    entityRef: { type: "payment_request", id: row.id },
    relatedRefs: row.customerId ? [{ type: "customer", id: row.customerId }] : undefined,
    state: "open",
    createdAt: row.createdAt.toISOString(),
    primaryAction: { kind: "navigate", label: "פתח גבייה", href: `/collection` },
    sourceEngine: "payment-link-age",
    blocking: false,
    moneyImpactBand: "medium",
    priorityReferenceDate: row.createdAt,
  }));
}
