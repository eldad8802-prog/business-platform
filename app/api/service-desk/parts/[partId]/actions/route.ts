import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { assertPartsApiOpen, runPartAction } from "@/lib/services/service-desk/parts.service";

/** POST { action: { type: RESERVE | RELEASE | SET_PRICE | CANCEL, … }, expectedVersion } + Idempotency-Key. No stock moves. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ partId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertPartsApiOpen();
    const id = positiveId((await context.params).partId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await runPartAction(principal, id, { action: b.action, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
