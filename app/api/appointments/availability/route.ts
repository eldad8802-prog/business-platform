import { getAvailability, replaceWeeklyRules } from "@/lib/services/appointment/appointment-config.service";
import { readHoursImpact } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, json, jsonBody, queryOf } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — weekly hours and exceptions of the business (default) or of one staff member (?staffMemberId=). */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const q = queryOf(req);
    return json(await getAvailability(principal, { staffMemberId: q.staffMemberId, fromDay: q.fromDay }));
  });
}

/**
 * PUT — the whole weekly schedule of one scope; the previous set is marked removed. The answer also says how many
 * live future appointments now fall outside the hours (G20 — information only, nothing is cancelled).
 */
export async function PUT(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const body = (await jsonBody(req)) as { staffMemberId?: unknown; rules?: unknown };
    const rules = await replaceWeeklyRules(principal, body);
    // replaceWeeklyRules validated the scope: a positive id (number or digits), or the business.
    const raw = body.staffMemberId;
    const staffMemberId = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
    return json({ rules, impact: await readHoursImpact(principal, { staffMemberId }) });
  });
}
