import { getSeries } from "@/lib/services/appointment/appointment-series.service";
import { appointmentsRoute, json, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ seriesId: string }> };

/** GET — one series of this business: its rule, its occurrences and the days skipped when it was booked. */
export async function GET(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => json(await getSeries(principal, positiveId((await params).seriesId))));
}
