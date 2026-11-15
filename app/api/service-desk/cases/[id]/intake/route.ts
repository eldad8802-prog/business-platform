import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getIntake } from "@/lib/services/service-desk/intake.service";
import { recordIntake } from "@/lib/services/service-desk/service-case.service";

/**
 * PUT { conditionNote, accessoriesNote, conditionRecorded, accessoriesRecorded, expectedVersion } + Idempotency-Key — the
 * intake data (no signature, no PDF). Journaled (P4): which fields changed, never the text. Without the P4 journal in the
 * database the service answers NOT_AVAILABLE_UNTIL_AUDIT and writes nothing.
 */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await recordIntake(principal, id, {
      conditionNote: b.conditionNote, accessoriesNote: b.accessoriesNote, conditionRecorded: b.conditionRecorded,
      accessoriesRecorded: b.accessoriesRecorded, expectedVersion: b.expectedVersion,
    }, { idempotencyKey: key }));
  });
}

/** GET — the intake view (1.3b): data, the frozen approved texts, photos (metadata) and the intake journal steps. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    return json(await getIntake(principal.businessId, id));
  });
}
