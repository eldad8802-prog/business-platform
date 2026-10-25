import { updateDetails } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** PATCH — title, notes, location, customer. Time moves through /reschedule. Idempotency-Key required. */
export async function PATCH(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    return json(await updateDetails(principal, { idempotencyKey: key }, id, await jsonBody(req)));
  });
}
