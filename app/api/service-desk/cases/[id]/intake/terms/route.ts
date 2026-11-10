import { presentTerms } from "@/lib/services/service-desk/intake.service";
import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/**
 * POST { expectedVersion } + Idempotency-Key — freeze the business's active terms and statutory notice for this case
 * (1.3b). Only LEGALLY_APPROVED texts are accepted (the database refuses any other); refused otherwise, nothing written.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await presentTerms(principal, id, { expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
