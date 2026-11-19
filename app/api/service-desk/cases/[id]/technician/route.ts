import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { assignTechnician } from "@/lib/services/service-desk/service-case.service";

/**
 * PUT { staffMemberId: number | null, expectedVersion } + Idempotency-Key — assign an existing technician of the business,
 * or none (the owner handles it). Journaled (P4): the change and its audit event in one transaction. Without the P4 journal
 * in the database the service answers NOT_AVAILABLE_UNTIL_AUDIT and writes nothing.
 */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await assignTechnician(principal, id, { staffMemberId: b.staffMemberId, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
