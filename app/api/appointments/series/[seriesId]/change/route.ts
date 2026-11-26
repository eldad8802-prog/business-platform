import { changeSeries } from "@/lib/services/appointment/appointment-series.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ seriesId: string }> };

/** POST — cancel or move "this occurrence" or "this and following" of a series. Idempotency-Key required. */
export async function POST(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const seriesId = positiveId((await params).seriesId);
    const key = idempotencyKeyOf(req);
    return json(await changeSeries(principal, { idempotencyKey: key }, seriesId, await jsonBody(req)));
  });
}
