/**
 * Which HTML template produced a receipt's PDF, from the pdfTemplateVersion recorded when it was produced.
 * The A0-pinned BILLING_PDF_TEMPLATE_VERSION ("billing-v1") is unchanged; only a receipt rendered by today's (#1108)
 * HTML template records a distinct value, so that every produced receipt PDF names the template that made it.
 */
import type { BillingPdfHtmlTemplate } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import { BILLING_PDF_TEMPLATE_VERSION } from "@/lib/services/billing/pdf/billing-pdf-template";

/** Recorded for a receipt produced by today's (#1108) HTML template. */
export const RECEIPT_CURRENT_HTML_TEMPLATE_VERSION = `${BILLING_PDF_TEMPLATE_VERSION}-receipt2-html`;
/** Recorded for every HTML receipt produced before #1108 (the template frozen as receipt-v1). */
export const RECEIPT_V1_HTML_TEMPLATE_VERSION = `${BILLING_PDF_TEMPLATE_VERSION}-html`;

export function receiptHtmlTemplateForVersion(version: string | null): BillingPdfHtmlTemplate | null {
  if (version === RECEIPT_V1_HTML_TEMPLATE_VERSION) return "receipt-v1";
  if (version === RECEIPT_CURRENT_HTML_TEMPLATE_VERSION) return "current";
  return null;
}
