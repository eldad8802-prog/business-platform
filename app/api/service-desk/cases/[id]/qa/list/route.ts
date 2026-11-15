import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { chooseCaseQaList } from "@/lib/services/service-desk/qa-lists.service";

/**
 * PUT { listId: number | null, expectedVersion } + Idempotency-Key — the case is checked against the CURRENT version of
 * that QA list of the business (null: its built-in template, as before). Before QA is passed; not where the track has no
 * QA. Resets the case's QA completion. Journaled (qa.list_chosen). No list is ever required.
 */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await chooseCaseQaList(principal, id, { listId: b.listId, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
