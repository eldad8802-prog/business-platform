import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { runCaseAction } from "@/lib/services/service-desk/service-case.service";

/** POST { action: { type, … }, expectedVersion } + Idempotency-Key — one state-machine action on the case. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await runCaseAction(principal, id, { action: b.action, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
