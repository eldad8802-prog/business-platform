import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { linkBillingDocument } from "@/lib/services/service-desk/case-charge.service";

/**
 * POST { billingDocumentId, role: "CHARGE" | "STANDALONE_PAYMENT", expectedVersion } + Idempotency-Key — link a billing
 * document of this business to the case. Journaled (billing.linked). Billing itself is only read.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await linkBillingDocument(principal, id, { billingDocumentId: b.billingDocumentId, role: b.role, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
