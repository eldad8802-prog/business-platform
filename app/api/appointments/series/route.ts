import { createSeries } from "@/lib/services/appointment/appointment-series.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/**
 * POST — the owner books a recurring series (G5): weekly or bi-weekly, ending after N occurrences or on a date (never
 * open-ended). Occurrences on taken time or closed days are skipped and listed. Idempotency-Key required.
 */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const key = idempotencyKeyOf(req);
    const result = await createSeries(principal, { idempotencyKey: key }, await jsonBody(req));
    return json(result, result.replayed ? 200 : 201);
  });
}
