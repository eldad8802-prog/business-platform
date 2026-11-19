import { reviseQuote } from "@/lib/services/service-desk/quote.service";
import { renderBillingQuote } from "@/lib/services/service-desk/quote-render";
import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** POST { billingDocumentId, replacesVersion, expectedVersion } + Idempotency-Key — replace the SENT version with the next one (1.3c, ז-1 A). */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await reviseQuote(principal, id, { billingDocumentId: b.billingDocumentId, replacesVersion: b.replacesVersion, expectedVersion: b.expectedVersion }, { idempotencyKey: key }, { render: renderBillingQuote }));
  });
}
