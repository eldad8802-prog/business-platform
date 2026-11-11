import { decideQuote } from "@/lib/services/service-desk/quote.service";
import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** POST { decision: "APPROVE" | "REJECT", method: "PHONE" | "IN_PERSON", expectedVersion } + Idempotency-Key — the owner records the customer's answer (1.3c). */
export async function POST(req: Request, context: { params: Promise<{ id: string; version: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const params = await context.params;
    const id = positiveId(params.id);
    const version = positiveId(params.version);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await decideQuote(principal, id, version, { decision: b.decision, method: b.method, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
