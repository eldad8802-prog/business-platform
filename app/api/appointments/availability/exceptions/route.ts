import { addException } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** POST — a day closed (whole or part) or opened with special hours, for the business or one staff member. */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json({ exception: await addException(principal, await jsonBody(req)) }, 201));
}
