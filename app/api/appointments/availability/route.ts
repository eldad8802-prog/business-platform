import { getAvailability, replaceWeeklyRules } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, jsonBody, queryOf } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — weekly hours and exceptions of the business (default) or of one staff member (?staffMemberId=). */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const q = queryOf(req);
    return json(await getAvailability(principal, { staffMemberId: q.staffMemberId, fromDay: q.fromDay }));
  });
}

/** PUT — the whole weekly schedule of one scope; the previous set is marked removed. */
export async function PUT(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json({ rules: await replaceWeeklyRules(principal, await jsonBody(req)) }));
}
