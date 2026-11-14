import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { unlinkBillingDocument } from "@/lib/services/service-desk/case-charge.service";

/**
 * POST { billingDocumentId, reason, expectedVersion } + Idempotency-Key — unlink the document's active link from the case,
 * with the owner's reason (kept in the link row, never the journal). Journaled (billing.unlinked).
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await unlinkBillingDocument(principal, id, { billingDocumentId: b.billingDocumentId, reason: b.reason, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
