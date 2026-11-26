import { applySetup, getSetupState } from "@/lib/services/appointment/calendar-setup.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — whether the calendar still needs its first-time setup (no weekly hours and no services). */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await getSetupState(principal)));
}

/** POST — the setup wizard's answers; each part is written only while it is still empty (never overwrites). */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await applySetup(principal, await jsonBody(req))));
}
