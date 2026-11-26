import { closeDayRange, removeDayRange } from "@/lib/services/appointment/appointment-daily-use.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/**
 * POST — whole days from–to closed (vacation, a closure of several days) for the business or one staff member: one
 * special day per day, one transaction, at most 62 days. `dryRun: true` answers the counts only (the preview). The
 * answer counts the active appointments on those days — a warning; nothing is cancelled.
 */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const out = await closeDayRange(principal, await jsonBody(req));
    return json(out, out.dryRun ? 200 : 201);
  });
}

/** DELETE — every special day of the scope inside from–to is withdrawn (kept as history). Body like POST. */
export async function DELETE(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await removeDayRange(principal, await jsonBody(req))));
}
