import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { addCasePart, assertPartsApiOpen, listParts } from "@/lib/services/service-desk/parts.service";

/** GET — the case's part lines and their journals. Closed until 1.3b (PARTS_API_OPEN). */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    assertPartsApiOpen();
    return json(await listParts(principal.businessId, positiveId((await context.params).id)));
  });
}

/** POST { source, inventoryItemId?, name, sku?, quantity, unitType?, customerUnitPriceAgorot? } + Idempotency-Key — add a line. No stock moves. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertPartsApiOpen();
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await addCasePart(principal, id, {
      source: b.source, inventoryItemId: b.inventoryItemId, name: b.name, sku: b.sku, quantity: b.quantity, unitType: b.unitType,
      customerUnitPriceAgorot: b.customerUnitPriceAgorot,
    }, { idempotencyKey: key }));
  });
}
