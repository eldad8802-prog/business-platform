import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { chooseAfterSaleResolution } from "@/lib/services/service-desk/service-case.service";

/**
 * POST { resolution: "REPAIR" | "RETURN_ORIGINAL" | "CREDIT", expectedVersion } + Idempotency-Key — M1 T7: how an
 * after-sale case ends, chosen once; the resolution's transitions run and are journaled in the same transaction.
 * EXCHANGE is refused (EXCHANGE_NEEDS_INVENTORY) until the inventory contract exists.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await chooseAfterSaleResolution(principal, id, { resolution: b.resolution, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
