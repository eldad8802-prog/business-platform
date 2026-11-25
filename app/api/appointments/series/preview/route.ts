import { previewSeries } from "@/lib/services/appointment/appointment-series.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** POST — read-only: which days a series request would book and which it would skip (taken / closed). Writes nothing. */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await previewSeries(principal, await jsonBody(req))));
}
