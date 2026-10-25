import { changeStatus } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST — confirm, complete, no-show or cancel, through the single lifecycle. Idempotency-Key required. */
export async function POST(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    return json(await changeStatus(principal, { idempotencyKey: key }, id, await jsonBody(req)));
  });
}
