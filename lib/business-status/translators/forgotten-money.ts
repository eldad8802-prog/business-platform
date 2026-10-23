import type { Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
import { daysBetweenDayKeys, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import type { StaleBillingDraftRaw, StalePaymentLinkRaw } from "../loaders";
import { STATUS_HE_T, statusMoney } from "../i18n";
import { severityForgottenMoney } from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

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
  now: Date,
  t: Translator = STATUS_HE_T,
  locale: Locale = "he"
): BusinessStatusItemBuild[] {
  return rows.map((row) => ({
    itemId: `billing:stale_draft:${row.id}`,
    domain: "billing",
    semanticCategory: "WARNING",
    title: t("insights.status.billing.staleDraftTitle"),
    summary: [
      row.customerName?.trim() ? t("insights.status.billing.customer", { name: row.customerName.trim() }) : null,
      statusMoney(row.totalAmount, row.currency, locale)
        ? t("insights.status.billing.amount", { amount: statusMoney(row.totalAmount, row.currency, locale) })
        : null,
      t("insights.status.billing.createdDaysAgo", { days: ageDays(row.createdAt, now) }),
    ]
      .filter(Boolean)
      .join(" · "),
    severity: severityForgottenMoney(ageDays(row.createdAt, now)),
    entityRef: { type: "billing_document", id: row.id },
    state: "open",
    createdAt: row.createdAt.toISOString(),
    primaryAction: { kind: "navigate", label: t("insights.status.billing.openDraft"), href: `/billing/${row.id}` },
    sourceEngine: "billing-draft-age",
    blocking: false,
    moneyImpactBand: "medium",
    priorityReferenceDate: row.createdAt,
  }));
}

/** A payment link that was sent and never used. Still PENDING — not failed, not expired. */
export function translateStalePaymentLinks(
  rows: StalePaymentLinkRaw[],
  now: Date,
  t: Translator = STATUS_HE_T,
  locale: Locale = "he"
): BusinessStatusItemBuild[] {
  return rows.map((row) => ({
    itemId: `billing:stale_payment_link:${row.id}`,
    domain: "billing",
    semanticCategory: "WARNING",
    title: t("insights.status.billing.staleLinkTitle"),
    summary: [
      statusMoney(row.amount, row.currency, locale)
        ? t("insights.status.billing.amount", { amount: statusMoney(row.amount, row.currency, locale) })
        : null,
      t("insights.status.billing.sentDaysAgo", { days: ageDays(row.createdAt, now) }),
      t("insights.status.billing.notPaidYet"),
    ]
      .filter(Boolean)
      .join(" · "),
    severity: severityForgottenMoney(ageDays(row.createdAt, now)),
    entityRef: { type: "payment_request", id: row.id },
    relatedRefs: row.customerId ? [{ type: "customer", id: row.customerId }] : undefined,
    state: "open",
    createdAt: row.createdAt.toISOString(),
    primaryAction: { kind: "navigate", label: t("insights.status.billing.openCollection"), href: `/collection` },
    sourceEngine: "payment-link-age",
    blocking: false,
    moneyImpactBand: "medium",
    priorityReferenceDate: row.createdAt,
  }));
}
