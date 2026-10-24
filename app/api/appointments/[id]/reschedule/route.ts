import { moveAppointment } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST — move an appointment (time, length, staff lane). Overlap is refused (SLOT_CONFLICT). Idempotency-Key required. */
export async function POST(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    return json(await moveAppointment(principal, { idempotencyKey: key }, id, await jsonBody(req)));
  });
}
