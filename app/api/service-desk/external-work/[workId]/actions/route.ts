import {
  idempotencyKeyOf, json, jsonBody, positiveId, SERVICE_DESK_JSON_BODY_MAX_BYTES, serviceDeskRateLimit, serviceDeskRoute,
} from "@/lib/services/service-desk/service-desk-http";
import { assertExternalWorkOpen, runExternalWorkAction } from "@/lib/services/service-desk/external-work.service";

/** POST { action: { type, … }, expectedVersion } + Idempotency-Key — progress / expected date / cost on a work. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ workId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertExternalWorkOpen();
    const limited = await serviceDeskRateLimit("SERVICE_DESK_PARTS_WRITE", principal);
    if (limited) return limited;
    const id = positiveId((await context.params).workId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req, SERVICE_DESK_JSON_BODY_MAX_BYTES);
    return json(await runExternalWorkAction(principal, id, { action: b.action, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
