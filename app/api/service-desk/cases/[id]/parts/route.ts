import {
  idempotencyKeyOf, json, jsonBody, positiveId, SERVICE_DESK_JSON_BODY_MAX_BYTES, serviceDeskRateLimit, serviceDeskRoute,
} from "@/lib/services/service-desk/service-desk-http";
import { addCasePart, assertPartsApiOpen, listParts } from "@/lib/services/service-desk/parts.service";

/** GET — the case's part lines and their journals. Closed until 1.3b (PARTS_API_OPEN). */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    assertPartsApiOpen();
    const limited = await serviceDeskRateLimit("SERVICE_DESK_PARTS_READ", principal);
    if (limited) return limited;
    return json(await listParts(principal.businessId, positiveId((await context.params).id)));
  });
}

/** POST { source, inventoryItemId?, name, sku?, quantity, unitType?, customerUnitPriceAgorot? } + Idempotency-Key — add a line. No stock moves. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertPartsApiOpen();
    const limited = await serviceDeskRateLimit("SERVICE_DESK_PARTS_WRITE", principal);
    if (limited) return limited;
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req, SERVICE_DESK_JSON_BODY_MAX_BYTES);
    return json(await addCasePart(principal, id, {
      source: b.source, inventoryItemId: b.inventoryItemId, name: b.name, sku: b.sku, quantity: b.quantity, unitType: b.unitType,
      customerUnitPriceAgorot: b.customerUnitPriceAgorot,
    }, { idempotencyKey: key }));
  });
}
