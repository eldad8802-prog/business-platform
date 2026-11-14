/**
 * Service Desk 1.3c — the quote renderer the send / revise routes inject into quote.service: the billing module's own
 * on-demand quote PDF (lib/services/billing/quote-pdf.service.ts getOrRenderQuotePdf), called as is — billing code is
 * only imported, never changed. Kept in its own module so only the two routes that render carry the browser bundle
 * (next.config.ts outputFileTracingIncludes + scripts/ci/pdf-route-tracing-guard.mjs); the decision, list and PDF routes
 * import quote.service alone.
 */
import { getOrRenderQuotePdf } from "@/lib/services/billing/quote-pdf.service";

import type { QuoteRenderer } from "./quote.service";

export const renderBillingQuote: QuoteRenderer = async (input) => {
  const r = await getOrRenderQuotePdf({ businessId: input.businessId, billingDocumentId: input.billingDocumentId, actorUserId: input.actorUserId });
  return { buffer: r.buffer };
};
