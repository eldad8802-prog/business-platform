import { addException } from "@/lib/services/appointment/appointment-config.service";
import { readHoursImpact } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/**
 * POST — a day closed (whole or part) or opened with special hours, for the business or one staff member. The answer
 * also says how many live future appointments now fall outside the hours (G20 — information only).
 */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const exception = await addException(principal, await jsonBody(req));
    return json({ exception, impact: await readHoursImpact(principal, { staffMemberId: exception.staffMemberId }) }, 201);
  });
}
