import type { BillingDocRaw } from "../loaders";
import {
  severityBillingPdfFailed,
  severityBillingPendingReview,
} from "../severity-map";
import type { BusinessStatusItemBuild } from "../types";

function formatMoney(amount: BillingDocRaw["totalAmount"], currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString("he-IL")} ${currency}`;
}

export function translateBillingPendingReview(
  rows: BillingDocRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((doc) => {
    const totalLabel = formatMoney(doc.totalAmount, doc.currency);
    const customer = doc.customerNameSnapshot?.trim() || null;

    return {
      itemId: `billing:pending_review:${doc.id}`,
      domain: "billing",
      semanticCategory: "ACTION_REQUIRED",
      title: "חשבונית ממתינה לאישור פנימי",
      summary: [
        customer ? `לקוח: ${customer}` : null,
        totalLabel ? `סכום: ${totalLabel}` : null,
        doc.documentNumberFormatted
          ? `מספר: ${doc.documentNumberFormatted}`
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
        label: "פתח חשבונית",
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
  rows: BillingDocRaw[]
): BusinessStatusItemBuild[] {
  return rows.map((doc) => {
    const customer = doc.customerNameSnapshot?.trim() || null;
    const err = doc.pdfRenderError?.trim();

    return {
      itemId: `billing:pdf_failed:${doc.id}`,
      domain: "billing",
      semanticCategory: "FAILURE_EVENT",
      title: "הפקת PDF לחשבונית נכשלה",
      summary: [
        customer ? `לקוח: ${customer}` : null,
        err ? `שגיאה: ${err}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
      severity: severityBillingPdfFailed(),
      entityRef: { type: "billing_document", id: doc.id },
      state: "open",
      createdAt: doc.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: "פתח חשבונית",
        href: `/billing/${doc.id}`,
      },
      sourceEngine: "billing-pdf",
      blocking: true,
      moneyImpactBand: "medium",
      priorityReferenceDate: doc.createdAt,
    };
  });
}
