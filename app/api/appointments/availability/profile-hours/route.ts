import { syncProfileOpeningHours } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/**
 * POST — G19: the owner's one tap "לעדכן גם את שעות הפתיחה בפרופיל העסק" after saving the calendar hours. Writes the
 * business's weekly hours, as Hebrew text built on the server, into the profile's opening hours. Nothing else.
 */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await syncProfileOpeningHours(principal)));
}
