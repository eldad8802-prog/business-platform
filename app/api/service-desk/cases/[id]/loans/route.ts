import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { lendItem, listLoans } from "@/lib/services/service-desk/case-extras.service";

type Ctx = { params: Promise<{ id: string }> };

/** GET — replacement items lent on this case (decision 5: a reminder, never a block). available=false until A7 is applied. */
export async function GET(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await listLoans(principal.businessId, positiveId((await context.params).id))));
}

/** POST { itemName, note? } + Idempotency-Key — lend an item. */
export async function POST(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await lendItem(principal, id, { itemName: b.itemName, note: b.note }, { idempotencyKey: key }));
  });
}
