import { markArrived } from "@/lib/services/appointment/appointment-arrival.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST — the customer has arrived (ARRIVED): stamps the actual start. Idempotency-Key required. */
export async function POST(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    return json(await markArrived(principal, { idempotencyKey: key }, id, await jsonBody(req)));
  });
}
