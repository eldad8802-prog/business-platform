import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { setQaListArchived } from "@/lib/services/service-desk/qa-lists.service";

/**
 * PUT { expectedRevision, archived: boolean } + Idempotency-Key — archive a QA list (no longer offered to cases; the cases
 * that name it keep their version and results) or restore it. Journaled (ARCHIVE / RESTORE). A list is never deleted.
 */
export async function PUT(req: Request, context: { params: Promise<{ listId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).listId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await setQaListArchived(principal, id, { expectedRevision: b.expectedRevision, archived: b.archived }, { idempotencyKey: key }));
  });
}
