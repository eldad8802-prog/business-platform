import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { assertExternalWorkOpen, runExternalWorkAction } from "@/lib/services/service-desk/external-work.service";

/** POST { action: { type, … }, expectedVersion } + Idempotency-Key — progress / expected date / cost on a work. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ workId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertExternalWorkOpen();
    const id = positiveId((await context.params).workId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await runExternalWorkAction(principal, id, { action: b.action, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
