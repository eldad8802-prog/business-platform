import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { assertExternalWorkOpen, listExternalWork, sendToExternal } from "@/lib/services/service-desk/external-work.service";

/** GET — the case's supplier works and their journals. Closed until 1.3b (EXTERNAL_WORK_OPEN). */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    assertExternalWorkOpen();
    return json(await listExternalWork(principal.businessId, positiveId((await context.params).id)));
  });
}

/** POST { expectedVersion, supplierId, sendReason, … } + Idempotency-Key — send the item to a supplier. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertExternalWorkOpen();
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await sendToExternal(principal, id, {
      expectedVersion: b.expectedVersion, supplierId: b.supplierId, sendReason: b.sendReason, requestedWork: b.requestedWork,
      conditionAtSend: b.conditionAtSend, operationalNote: b.operationalNote, supplierReference: b.supplierReference, expectedBackOn: b.expectedBackOn,
    }, { idempotencyKey: key }));
  });
}
