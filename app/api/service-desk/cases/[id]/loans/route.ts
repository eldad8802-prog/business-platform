import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { lendLoaner, listCaseLoans } from "@/lib/services/service-desk/loans.service";

/** GET — the case's loans (temporary replacement items) and their journals. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await listCaseLoans(principal.businessId, positiveId((await context.params).id))));
}

/**
 * POST { itemName, itemIdentifier?, inventoryItemId?, conditionAtLend, lendNote?, expectedReturnOn?, exceptionReason? } +
 * Idempotency-Key — lend an item to the case's customer. exceptionReason only when the case is OPEN / SCHEDULED / READY.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await lendLoaner(principal, id, {
      itemName: b.itemName, itemIdentifier: b.itemIdentifier, inventoryItemId: b.inventoryItemId, conditionAtLend: b.conditionAtLend,
      lendNote: b.lendNote, expectedReturnOn: b.expectedReturnOn, exceptionReason: b.exceptionReason,
    }, { idempotencyKey: key }));
  });
}
