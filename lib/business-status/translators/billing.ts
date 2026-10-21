import type { Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";

import type { BillingDocRaw } from "../loaders";
import { STATUS_HE_T, statusMoney } from "../i18n";
import {
  severityBillingPdfFailed,
  severityBillingPendingReview,
} from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

export function translateBillingPendingReview(
  rows: BillingDocRaw[],
  t: Translator = STATUS_HE_T,
  locale: Locale = "he"
): BusinessStatusItemBuild[] {
  return rows.map((doc) => {
    const totalLabel = statusMoney(doc.totalAmount, doc.currency, locale);
    const customer = doc.customerNameSnapshot?.trim() || null;

    return {
      itemId: `billing:pending_review:${doc.id}`,
      domain: "billing",
      semanticCategory: "ACTION_REQUIRED",
      title: t("insights.status.billing.pendingReviewTitle"),
      summary: [
        customer ? t("insights.status.billing.customer", { name: customer }) : null,
        totalLabel ? t("insights.status.billing.amount", { amount: totalLabel }) : null,
        doc.documentNumberFormatted
          ? t("insights.status.billing.number", { number: doc.documentNumberFormatted })
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
      severity: severityBillingPendingReview(),
      entityRef: { type: "billing_document", id: doc.id },
      state: "open",
      createdAt: doc.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: t("insights.status.billing.openInvoice"),
        href: `/billing/${doc.id}`,
      },
      sourceEngine: "billing-review",
      blocking: true,
      moneyImpactBand: "medium",
      priorityReferenceDate: doc.createdAt,
    };
  });
}

export function translateBillingPdfFailed(
  rows: BillingDocRaw[],
  t: Translator = STATUS_HE_T
): BusinessStatusItemBuild[] {
  return rows.map((doc) => {
    const customer = doc.customerNameSnapshot?.trim() || null;
    const err = doc.pdfRenderError?.trim();

    return {
      itemId: `billing:pdf_failed:${doc.id}`,
      domain: "billing",
      semanticCategory: "FAILURE_EVENT",
      title: t("insights.status.billing.pdfFailedTitle"),
      summary: [
        customer ? t("insights.status.billing.customer", { name: customer }) : null,
        err ? t("insights.status.billing.error", { error: err }) : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
      severity: severityBillingPdfFailed(),
      entityRef: { type: "billing_document", id: doc.id },
      state: "open",
      createdAt: doc.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: t("insights.status.billing.openInvoice"),
        href: `/billing/${doc.id}`,
      },
      sourceEngine: "billing-pdf",
      blocking: true,
      moneyImpactBand: "medium",
      priorityReferenceDate: doc.createdAt,
    };
  });
}
