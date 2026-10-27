import { rotateBookingLink } from "@/lib/services/booking/booking-admin.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** POST — a new link id; the old link stops working at once (a shared link that leaked). */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await rotateBookingLink(principal, await jsonBody(req))));
}
