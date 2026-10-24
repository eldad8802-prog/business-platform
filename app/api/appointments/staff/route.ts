import { createStaff, listStaff } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — the business's staff members (without login), with the services each performs. */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json({ staff: await listStaff(principal) }));
}

/** POST — add a staff member (a name on the calendar; no account, no permission). */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json({ staffMember: await createStaff(principal, await jsonBody(req)) }, 201));
}
