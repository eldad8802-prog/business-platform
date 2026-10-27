import { getBookingSettings, updateBookingSettings } from "@/lib/services/booking/booking-admin.service";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — the business's public booking settings, its services and staff as the public sees them, the platform state. */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await getBookingSettings(principal)));
}

/** PUT — the owner's own choices (D2, D8–D11); expectedVersion refuses a stale screen. */
export async function PUT(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => json(await updateBookingSettings(principal, await jsonBody(req))));
}
