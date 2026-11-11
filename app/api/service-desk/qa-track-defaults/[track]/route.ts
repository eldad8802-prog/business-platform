import { idempotencyKeyOf, json, jsonBody, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { setQaTrackDefault } from "@/lib/services/service-desk/qa-track-defaults.service";

/**
 * PUT { listId: number | null, expectedRevision } + Idempotency-Key — the track's default QA list (an ACTIVE list of the
 * business) or none. Cases opened later on the track name the list's CURRENT version; existing cases never change.
 * Appended to the defaults journal (ServiceQaTrackDefault, the next revision).
 */
export async function PUT(req: Request, context: { params: Promise<{ track: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const track = (await context.params).track;
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const r = await setQaTrackDefault(principal, track, { listId: b.listId, expectedRevision: b.expectedRevision }, { idempotencyKey: key });
    return json(r);
  });
}
