import { correctStatus } from "@/lib/services/appointment/appointment-arrival.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** POST — correct a wrongly set final status (STATUS_CORRECTED), with a closed reason. Idempotency-Key required. */
export async function POST(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    return json(await correctStatus(principal, { idempotencyKey: key }, id, await jsonBody(req)));
  });
}
