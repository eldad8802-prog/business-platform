import { listQuotes, sendQuote } from "@/lib/services/service-desk/quote.service";
import { renderBillingQuote } from "@/lib/services/service-desk/quote-render";
import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** GET — the case's quote versions, oldest first (1.3c). */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    return json(await listQuotes(principal.businessId, id));
  });
}

/** POST { billingDocumentId, expectedVersion } + Idempotency-Key — send the billing QUOTE as the case's next version (frozen copy). */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await sendQuote(principal, id, { billingDocumentId: b.billingDocumentId, expectedVersion: b.expectedVersion }, { idempotencyKey: key }, { render: renderBillingQuote }));
  });
}
